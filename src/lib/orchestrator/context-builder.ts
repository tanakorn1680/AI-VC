import type { SupabaseClient } from '@supabase/supabase-js'
import { extractFiles } from '../files/extract'
import { BUDGET, clip, estimateTokens, remainingChars } from './context-budget'
import { loadMemory } from './memory'

/**
 * สร้าง Context เฉพาะของ Task เดียว — ส่งเฉพาะสิ่งที่งานนี้ต้องใช้ และทุกส่วนมีเพดานตาม BUDGET (context-budget.ts)
 *   1) คำสั่งของโปรเจกต์ (ตัดความยาว)   2) ความจำโปรเจกต์ (brief ส่วนต้น)   3) ใบสั่งงาน
 *   4) สรุป (<summary>) ของงานที่ depends_on — ผู้ตรวจได้เห็นผลงานจริงของงานที่ตรวจด้วย
 *   5) ไฟล์: ส่งเนื้อหาเฉพาะที่แผนระบุ ส่วนที่เหลือส่งแค่ชื่อ และเนื้อหาไฟล์ใช้ได้ไม่เกินงบ token ที่เหลือ
 * ไม่ส่ง: ประวัติแชท, งานของ agent อื่นที่ไม่เกี่ยวข้อง
 */
export async function buildTaskContext(
  admin: SupabaseClient,
  task: { id: string; project_id: string; title: string; description: string; depends_on: string[] },
  opts: {
    includeFiles?: boolean
    /** path ของไฟล์ที่ต้องส่งเนื้อหา (ที่เหลือส่งแค่ชื่อ) */
    files?: string[]
    /** true = คนทำเป็นผู้ตรวจ ให้เห็นผลงานจริงของงานที่ depends_on (ไม่ใช่แค่สรุป) */
    reviewer?: boolean
  } = {}
): Promise<string> {
  const [{ data: project }, mem] = await Promise.all([
    admin.from('projects').select('instructions').eq('id', task.project_id).single(),
    loadMemory(admin, task.project_id),
  ])
  const instructions = clip(((project as { instructions?: string | null } | null)?.instructions ?? '').trim(), BUDGET.instructionsChars)
  const brief = clip(mem.brief.trim(), BUDGET.briefForWorkerChars)

  let dependencySection = ''
  if (task.depends_on.length > 0) {
    const { data: results } = await admin
      .from('task_results')
      .select('task_id, summary, output, tasks!inner(title)')
      .in('task_id', task.depends_on)
    const rows = (results ?? []) as unknown as Array<{
      summary: string
      output: string
      tasks: { title: string } | { title: string }[]
    }>

    let summaryBudget = BUDGET.dependencyTotalChars
    let outputBudget = BUDGET.reviewerOutputTotalChars
    const blocks: string[] = []
    for (const r of rows) {
      const t = Array.isArray(r.tasks) ? r.tasks[0] : r.tasks
      const title = t?.title ?? 'งานก่อนหน้า'
      const summary = clip(r.summary ?? '', Math.min(BUDGET.dependencySummaryChars, summaryBudget))
      summaryBudget -= summary.length
      let block = `### ผลจาก: ${title}\n${summary || '(ไม่มีสรุป)'}`
      if (opts.reviewer && outputBudget > 0) {
        // เนื้อหาไฟล์ถูกแทนด้วย [ไฟล์ path] ผู้ตรวจอ่านตัวไฟล์จากรายการ files ของงานตรวจ
        const body = clip(extractFiles(r.output ?? '').text, Math.min(BUDGET.reviewerOutputPerDepChars, outputBudget))
        outputBudget -= body.length
        block += `\n\n#### ผลงานฉบับเต็มที่ต้องตรวจ\n${body}`
      }
      blocks.push(block)
    }
    dependencySection = blocks.join('\n\n')
  }

  const base = [
    instructions ? `## คำสั่งของโปรเจกต์\n${instructions}` : '',
    brief ? `## ความจำโปรเจกต์ (สรุปอัตโนมัติ)\n${brief}` : '',
    `## ใบสั่งงาน: ${task.title}\n${task.description}`,
    dependencySection ? `## ข้อมูลจากงานก่อนหน้า\n${dependencySection}` : '',
  ].filter(Boolean)

  // งบที่เหลือสำหรับเนื้อหาไฟล์ = เพดาน prompt ทั้งงาน − ส่วนอื่นที่ใช้ไปแล้ว
  const used = estimateTokens(base.join('\n\n'))
  const fileChars = Math.min(BUDGET.filesMaxCharsTotal, remainingChars(BUDGET.workerInputTokens, used))
  const filesSection = opts.includeFiles ? await buildFilesContext(admin, task.project_id, opts.files ?? [], fileChars) : ''

  return [...base, filesSection].filter(Boolean).join('\n\n')
}

const MAX_FILES_LISTED = 30

async function buildFilesContext(admin: SupabaseClient, projectId: string, wanted: string[], charBudget: number): Promise<string> {
  const { data: fileRows } = await admin
    .from('files')
    .select('id, path, current_version_id, created_at')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(MAX_FILES_LISTED)
  const listed = (fileRows ?? []) as unknown as Array<{ id: string; path: string; current_version_id: string | null }>

  // ไฟล์ที่ต้องอ่านเนื้อหา — ค้นตาม path ตรง ๆ (อาจเก่ากว่า 30 ไฟล์ล่าสุดที่แสดงชื่อ)
  const wantedRows = (
    await Promise.all(
      [...new Set(wanted)].slice(0, 8).map(async (path) => {
        const { data } = await admin
          .from('files')
          .select('id, path, current_version_id')
          .eq('project_id', projectId)
          .eq('path', path)
          .is('deleted_at', null)
          .maybeSingle()
        return data as { id: string; path: string; current_version_id: string | null } | null
      })
    )
  ).filter((r): r is { id: string; path: string; current_version_id: string | null } => !!r && !!r.current_version_id)

  if (listed.length === 0 && wantedRows.length === 0) return ''

  const contentByVersion = new Map<string, string>()
  if (wantedRows.length > 0) {
    const { data: versionRows } = await admin
      .from('file_versions')
      .select('id, content')
      .in('id', wantedRows.map((f) => f.current_version_id as string))
    for (const v of (versionRows ?? []) as unknown as Array<{ id: string; content: string }>) contentByVersion.set(v.id, v.content)
  }

  let budget = charBudget
  const blocks: string[] = []
  for (const f of wantedRows) {
    if (budget <= 0) break
    const full = contentByVersion.get(f.current_version_id as string) ?? ''
    const take = Math.min(full.length, BUDGET.filesMaxCharsPerFile, budget)
    budget -= take
    const truncated = take < full.length ? `\n… (ตัดเหลือ ${take} จาก ${full.length} ตัวอักษร)` : ''
    blocks.push(`### ${f.path}\n\`\`\`\n${full.slice(0, take)}${truncated}\n\`\`\``)
  }

  return [
    listed.length ? `## ไฟล์ในโปรเจกต์ (ชื่อเท่านั้น)\n${listed.map((f) => `- ${f.path}`).join('\n')}` : '',
    blocks.length ? `## เนื้อหาไฟล์ที่งานนี้ต้องใช้\n${blocks.join('\n\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}
