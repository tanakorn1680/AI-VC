import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdapter } from '../ai/registry'
import { completeWithRetry } from '../ai/retry'
import { extractFiles } from '../files/extract'
import { saveFileVersion } from '../files/save'
import { InvalidApiKeyError, InsufficientCreditError, RateLimitError } from '../ai/types'
import { resolveAgentKey } from '../ai/agent-key'
import { composeWorkerPrompt, splitSummary } from './lead-plan'
import { clip } from './context-budget'
import { buildTaskContext } from './context-builder'
import { calculateCost } from './pricing'
import { enqueueTask } from './queue'

/** ทีมของ agent ไม่ได้ประจำโปรเจกต์นี้ (กติกา 1 โปรเจกต์ต่อทีม) — รอเฉย ๆ ไม่มีวันสำเร็จ จึงไม่ retry อัตโนมัติ */
class TeamNotAssignedError extends Error {}

interface TaskRow {
  id: string
  project_id: string
  title: string
  description: string
  depends_on: string[]
  assigned_agent: string | null
  /** แผนงานใส่ไฟล์ที่งานนี้ต้องอ่านไว้ที่นี่ ({ files: [...] }) */
  input?: { files?: unknown } | null
  /** claim_task คืนแถวหลังเพิ่ม attempts แล้ว */
  attempts?: number
}

// rate limit: รอแล้วลองใหม่ได้มากกว่า max_attempts ปกติ เพราะไม่ใช่ความผิดของ task
// ไม่จำกัดจำนวนครั้งด้วยตัวเลขคงที่อีกต่อไป (ดู RATE_LIMIT_MAX_WAIT_SECONDS) — attempts ยังนับไว้
// ใช้โชว์ในข้อความสถานะเฉยๆ ไม่ใช้ตัดสินใจเลิก retry แล้ว เพราะผู้ใช้ต้องการให้รอจนกว่าโควตาจะคืนเสมอ
const RATE_LIMIT_MAX_ATTEMPTS = Number.POSITIVE_INFINITY
// provider บอกให้รอนานกว่านี้ถือว่าผิดปกติเกินจริง (ไม่ใช่แค่โควตารายวัน) จึงยอมแพ้
// ตั้งไว้ 24 ชม. เพราะโควตารายวันของทุก provider ที่รองรับอยู่รีเซ็ตภายใน 24 ชม.เสมอ
// (ยาวกว่านี้แปลว่า provider คืนค่าผิดปกติ ไม่ใช่โควตารายวันปกติ) Vercel Queue รองรับ delay ได้ถึง 7 วัน
// จึงไม่ใช่ข้อจำกัดทางเทคนิค — นี่คือการตัดสินใจเรื่อง UX ล้วนๆ
const RATE_LIMIT_MAX_WAIT_SECONDS = 24 * 60 * 60

/**
 * ประมวลผล Task เดียวให้จบ: claim → เรียก AI → บันทึกผล → enqueue task ถัดไปที่พร้อม
 * เขียนเป็นฟังก์ชันแยกจาก route handler เพื่อให้เทสต์ได้และเรียกซ้ำจากที่อื่นได้ถ้าจำเป็น
 *
 * ทุกอย่างที่ "ตัดสินใจร่วมกับ Worker ตัวอื่น" (claim, complete, fail) ทำผ่าน RPC
 * แบบ atomic ในฝั่ง Postgres — ที่นี่แค่เรียกเรียงลำดับ ไม่ทำ business logic เอง
 */
export async function processTask(admin: SupabaseClient, taskId: string): Promise<void> {
  const { data: claimed, error: claimError } = await admin.rpc('claim_task', { p_task_id: taskId })
  if (claimError) throw claimError
  const task = (claimed as TaskRow[] | null)?.[0]
  if (!task) return // มีคน claim ไปแล้ว หรือยังไม่พร้อม (dependency/concurrency/budget) — จบเงียบ ๆ

  try {
    if (!task.assigned_agent) {
      throw new Error('Task นี้ไม่มี agent ผูกอยู่ — ผู้ใช้ต้องเลือก agent ก่อน')
    }

    interface AgentRow { id: string; name: string; role: string; team_id: string; duty?: string | null; provider: string; model: string; system_prompt: string; max_tokens: number | null; base_url: string | null; allowed_tools: string[] | null }
    const agentRes = await admin
      .from('agents')
      .select('id, name, role, team_id, duty, provider, model, system_prompt, max_tokens, base_url, allowed_tools')
      .eq('id', task.assigned_agent)
      .single()
    const agent = agentRes.data as unknown as AgentRow | null
    if (agentRes.error || !agent) throw new Error('หา agent ที่ผูกกับ task นี้ไม่เจอ')

    // กติกา 1 โปรเจกต์ต่อทีม: ทำงานได้เฉพาะเมื่อทีมของ agent ประจำโปรเจกต์นี้อยู่ (acquire_team ตอนคุย/เริ่มแผน/retry)
    const { data: holder } = await admin
      .from('teams')
      .select('id')
      .eq('id', agent.team_id)
      .eq('active_project_id', task.project_id)
      .maybeSingle()
    if (!holder) {
      throw new TeamNotAssignedError('ทีมของ AI ตัวนี้ไม่ได้ประจำโปรเจกต์นี้ (กำลังทำโปรเจกต์อื่น) — กด "ลองใหม่" ที่แท็บ Tasks เมื่อทีมว่าง')
    }

    interface ProjectRow { owner_id: string; max_tokens_per_task: number }
    const { data: project, error: projectError } = await admin
      .from<ProjectRow>('projects')
      .select('owner_id, max_tokens_per_task')
      .eq('id', task.project_id)
      .single()
    if (projectError || !project) throw new Error('หา project ของ task นี้ไม่เจอ')

    const apiKey = await resolveAgentKey(admin, agent, project.owner_id)
    if (!apiKey) {
      throw new InvalidApiKeyError(`${agent.name} ยังไม่มี API key — เพิ่มที่แท็บ Agents`)
    }

    // สิทธิ์ของ agent บังคับที่ฝั่ง Backend นี้เท่านั้น (allowed_tools ใน DB) ไม่เชื่อสิ่งที่โมเดลบอกเอง
    const canReadFiles = agent.allowed_tools?.includes('read_file') ?? false
    const canWriteFiles = agent.allowed_tools?.includes('write_file') ?? false

    // อ่านเนื้อหาไฟล์เฉพาะที่แผนระบุว่างานนี้ต้องใช้ (คุม token) ส่วนที่เหลือเห็นแค่ชื่อ
    const rawFiles = task.input?.files
    const wantedFiles = Array.isArray(rawFiles) ? rawFiles.filter((f): f is string => typeof f === 'string') : []
    const isReviewer = agent.role === 'reviewer'
    const contextPrompt = await buildTaskContext(admin, task, { includeFiles: canReadFiles, files: wantedFiles, reviewer: isReviewer })
    const adapter = getAdapter(agent.provider)

    const result = await completeWithRetry(adapter, {
      apiKey,
      model: agent.model,
      systemPrompt: composeWorkerPrompt({
        name: agent.name,
        duty: agent.duty ?? '',
        systemPrompt: agent.system_prompt,
        canWriteFiles,
        isReviewer,
      }),
      userPrompt: contextPrompt,
      maxTokens: agent.max_tokens ?? project?.max_tokens_per_task ?? 4096,
      baseUrl: agent.base_url ?? undefined,
    })

    // summary สำหรับส่งต่อ Task ถัดไป: ใช้บล็อก <summary> ที่ agent เขียนเอง (ครบประเด็นกว่าการตัดข้อความดิบ)
    // ถ้าโมเดลไม่ตามรูปแบบ → fallback ตัดข้อความ 800 ตัวอักษร
    // ไฟล์ที่ agent ส่งมา (<file path="...">) แยกออกจากข้อความ — summary/แชทใช้ข้อความที่แทนบล็อกไฟล์ด้วย [ไฟล์ path]
    // เพื่อไม่ให้โค้ดทั้งก้อนไหลไปกิน token ของ task ถัดไป (task ถัดไปอ่านตัวไฟล์ได้จาก read_file)
    const { body: bodyText, summary: tagged } = splitSummary(result.text)
    const extracted = canWriteFiles
      ? extractFiles(bodyText)
      : { files: [], text: bodyText, skipped: [] as string[] }
    const shownText = extracted.text
    const summary = tagged ? clip(tagged, 600) : clip(shownText, 800)

    const cost = await calculateCost(admin, agent.provider, agent.model, result.tokensIn, result.tokensOut)

    const { error: completeError } = await admin.rpc('complete_task', {
      p_task_id: task.id,
      p_output: result.text,
      p_summary: summary,
      p_tokens_in: result.tokensIn,
      p_tokens_out: result.tokensOut,
      p_provider: agent.provider,
      p_model: agent.model,
      p_cost_usd: cost,
    })
    if (completeError) throw completeError

    // แสดงผลลัพธ์ของ task ในแชท (เดิมเก็บแค่ใน task_results ทำให้ผู้ใช้ไม่เห็นคำตอบ)
    // insert ไม่ throw — ถ้าพลาดก็แค่ไม่แสดงในแชท ไม่ทำให้ task ที่เสร็จแล้วกลายเป็น failed
    // บันทึกไฟล์หลัง complete_task สำเร็จเท่านั้น (ถ้า task ถูก retry จะไม่สร้างเวอร์ชันซ้ำ)
    // ไฟล์พลาดไม่ทำให้ task ล้ม — บอกผู้ใช้ในแชทแทน
    const savedPaths: string[] = []
    const failures: string[] = [...extracted.skipped]
    for (const f of extracted.files.slice(0, 20)) {
      const saved = await saveFileVersion(admin, {
        projectId: task.project_id,
        path: f.path,
        content: f.content,
        agentId: task.assigned_agent,
      })
      if (saved.ok) savedPaths.push(f.path)
      else failures.push(`${f.path}: ${saved.error}`)
    }
    if (extracted.files.length > 20) failures.push(`เกิน 20 ไฟล์ต่อ task — ข้ามไฟล์ที่เหลือ ${extracted.files.length - 20} ไฟล์`)

    const notes = [
      savedPaths.length ? `บันทึกไฟล์แล้ว (ดูในแท็บ Files): ${savedPaths.join(', ')}` : '',
      failures.length ? `บันทึกไฟล์ไม่สำเร็จ:\n${failures.join('\n')}` : '',
    ].filter(Boolean)

    await admin.from('messages').insert({
      project_id: task.project_id,
      role: 'assistant',
      content: [`${task.title}\n\n${shownText}`, ...notes].join('\n\n'),
      task_id: task.id,
    })

    await enqueueReadyTasks(admin, task.project_id)
  } catch (err) {
    await handleTaskFailure(admin, task, err)
  }
}

async function handleTaskFailure(admin: SupabaseClient, task: TaskRow, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[worker] task ${task.id} ล้มเหลว:`, message)

  // key ผิด หรือเครดิตหมด: retry ไม่มีทางสำเร็จ ปิดเป็น failed ทันทีโดยไม่กินโควตา attempts เพิ่ม
  if (err instanceof InvalidApiKeyError || err instanceof InsufficientCreditError || err instanceof TeamNotAssignedError) {
    await admin
      .from<TaskRow>('tasks')
      .update({ status: 'failed', error: message, completed_at: new Date().toISOString() })
      .eq('id', task.id)
      .eq('status', 'running')
    await admin.rpc('cancel_blocked_tasks', { p_project_id: task.project_id })
    return
  }

  if (err instanceof RateLimitError) {
    const attempts = task.attempts ?? 1
    const asked = err.retryAfterSeconds
    const giveUp = (asked !== undefined && asked > RATE_LIMIT_MAX_WAIT_SECONDS) || attempts >= RATE_LIMIT_MAX_ATTEMPTS
    if (!giveUp) {
      // หน่วงตามที่ provider บอก (+2 วินาทีกันเผื่อ) ไม่งั้นรอเพิ่มทีละ 20 วินาที ผ่านคิว ไม่ได้นอนรอใน Worker
      const wait = Math.min(asked !== undefined ? asked + 2 : 20 * attempts, RATE_LIMIT_MAX_WAIT_SECONDS)
      const { data: requeued } = await admin
        .from('tasks')
        .update({
          status: 'pending',
          error: `โควตา AI เต็มชั่วคราว จะลองใหม่อัตโนมัติใน ~${wait} วินาที (ลองมาแล้ว ${attempts} ครั้ง จะรอจนกว่าโควตาจะคืน)\n${message}`.slice(0, 2000),
        })
        .eq('id', task.id)
        .eq('status', 'running')
        .select('id')
      if (requeued && (requeued as unknown[]).length > 0) {
        await enqueueTask({ taskId: task.id, projectId: task.project_id }, { delaySeconds: wait })
      }
      return
    }
    const finalMessage =
      asked !== undefined && asked > RATE_LIMIT_MAX_WAIT_SECONDS
        ? `โควตา AI หมด (provider ให้รอ ~${Math.round(asked / 60)} นาที) — ลองใหม่ภายหลัง หรือเปลี่ยนไปใช้ provider/รุ่นอื่น\n${message}`
        : message
    await admin
      .from('tasks')
      .update({ status: 'failed', error: finalMessage.slice(0, 2000), completed_at: new Date().toISOString() })
      .eq('id', task.id)
      .eq('status', 'running')
    await admin.rpc('cancel_blocked_tasks', { p_project_id: task.project_id })
    return
  }

  const { data: outcome } = await admin.rpc<'retry' | 'failed' | 'ignored'>('fail_task', { p_task_id: task.id, p_error: message })

  if (outcome === 'retry') {
    // rate limit: หน่วงก่อน enqueue ใหม่เล็กน้อยผ่าน delaySeconds ของ Vercel Queue
    await enqueueTask({ taskId: task.id, projectId: task.project_id })
  } else if (outcome === 'failed') {
    await admin.rpc('cancel_blocked_tasks', { p_project_id: task.project_id })
  }
}

/** หา task ที่ dependency ครบแล้วของ project นี้ แล้วส่งเข้าคิวทุกตัว (parallel ตามข้อ 7 ของสเปค) */
export async function enqueueReadyTasks(admin: SupabaseClient, projectId: string): Promise<void> {
  const { data: ready } = await admin.rpc<TaskRow[]>('ready_tasks', { p_project_id: projectId })
  for (const t of (ready as TaskRow[] | null) ?? []) {
    await enqueueTask({ taskId: t.id, projectId })
  }
}
