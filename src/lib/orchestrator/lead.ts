import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompletionRequest, CompletionResult } from '../ai/types'
import { enqueueReadyTasks } from './worker'
import { BUDGET } from './context-budget'
import { fitRecent, loadMemory, loadUnsummarized } from './memory'
import { recordChatUsage } from './usage'
import {
  buildLeadSystemPrompt,
  buildLeadUserPrompt,
  parseLeadOutput,
  validatePlan,
  type ChatLine,
  type StoredPlan,
  type TeamMember,
} from './lead-plan'

/** เพดาน token ของคำตอบหัวหน้าทีมต่อครั้ง (agent ตั้ง max_tokens เองได้) — แชทปกติสั้นอยู่แล้ว แผนต้องการที่มากกว่าเล็กน้อย */
export const LEAD_MAX_TOKENS = 2000
/** ดึงข้อความที่ยังไม่ถูกสรุปมาไม่เกินนี้ แล้วค่อยตัดให้พอดีงบ token (BUDGET.leadHistoryTokens) */
const HISTORY_FETCH = 60
const FILES_LISTED = 40
const TASKS_FOR_STATUS = 20

export interface TeamAgent extends TeamMember {
  base_url: string | null
  max_tokens: number | null
}

// ---------------------------------------------------------------------------
// ทีม
// ---------------------------------------------------------------------------
/** โหลด agent ของทีม (เรียงตามเวลาที่เพิ่ม) — agent เป็นของทีม ใช้ร่วมกันทุกโปรเจกต์ */
export async function loadTeam(client: SupabaseClient, teamId: string): Promise<TeamAgent[]> {
  const { data, error } = await client
    .from('agents')
    .select('id, name, role, provider, model, base_url, max_tokens, duty')
    .eq('team_id', teamId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return ((data ?? []) as unknown as Array<Omit<TeamAgent, 'duty'> & { duty?: string | null }>).map((r) => ({ ...r, duty: r.duty ?? '' }))
}

/** หัวหน้าทีม = agent ที่ role เป็น manager ตัวแรก ถ้าไม่มีใช้ตัวที่เพิ่มก่อนสุด */
export function pickLead<T extends { role: string }>(team: T[]): T | null {
  return team.find((m) => m.role === 'manager') ?? team[0] ?? null
}

// ---------------------------------------------------------------------------
// แผนงาน: เริ่ม / ยกเลิก
// ---------------------------------------------------------------------------
export type StartResult = { ok: true; taskCount: number } | { ok: false; error: string }

/** ลำดับสร้างงานที่ให้งานที่ต้องรอมาก่อนเสมอ (แผนผ่านการตรวจวงจรแล้ว) */
export function topoOrder(tasks: Array<{ depends_on: number[] }>): number[] {
  const order: number[] = []
  const done = new Set<number>()
  while (order.length < tasks.length) {
    let progressed = false
    for (const [i, t] of tasks.entries()) {
      if (done.has(i)) continue
      if (t.depends_on.every((d) => done.has(d))) {
        order.push(i)
        done.add(i)
        progressed = true
      }
    }
    if (!progressed) throw new Error('แผนมีงานที่รอกันเป็นวงกลม')
  }
  return order
}

/** teamId = ทีมที่ประจำโปรเจกต์นี้อยู่ (ผู้เรียกต้อง acquireTeam มาก่อนแล้ว) */
export async function startPlan(admin: SupabaseClient, projectId: string, messageId: string, teamId: string): Promise<StartResult> {
  const { data: msg } = await admin
    .from('messages')
    .select('id, plan, plan_status')
    .eq('id', messageId)
    .eq('project_id', projectId)
    .maybeSingle()
  const row = msg as { id: string; plan: StoredPlan | null; plan_status: string | null } | null
  if (!row || !row.plan) return { ok: false, error: 'ไม่พบแผนนี้' }
  if (row.plan_status === 'started') return { ok: false, error: 'แผนนี้เริ่มทำไปแล้ว' }
  if (row.plan_status !== 'pending') return { ok: false, error: 'แผนนี้ถูกยกเลิกไปแล้ว' }
  const plan = row.plan

  // จองแผนก่อนสร้างงาน (กันกดซ้ำ / เปิดสองแท็บ) — อัปเดตได้เฉพาะตอนที่ยัง pending
  const { data: claimed } = await admin
    .from('messages')
    .update({ plan_status: 'started' })
    .eq('id', messageId)
    .eq('plan_status', 'pending')
    .select('id')
  if (!claimed || (claimed as unknown[]).length === 0) return { ok: false, error: 'แผนนี้ถูกใช้ไปแล้ว' }

  const team = await loadTeam(admin, teamId)
  const lead = pickLead(team)
  const revert = async (created: string[]) => {
    if (created.length > 0) await admin.from('tasks').delete().in('id', created)
    await admin.from('messages').update({ plan_status: 'pending' }).eq('id', messageId)
  }
  if (!lead) {
    await revert([])
    return { ok: false, error: 'ทีมนี้ไม่มี AI แล้ว — เพิ่มที่แท็บ Agents ก่อน' }
  }

  const agentIds = new Set(team.map((m) => m.id))
  const created: string[] = []
  const idByIndex = new Map<number, string>()
  try {
    for (const i of topoOrder(plan.tasks)) {
      const t = plan.tasks[i]
      if (!t) continue
      const { data: inserted, error } = await admin
        .from('tasks')
        .insert({
          project_id: projectId,
          title: t.title,
          description: t.description,
          // agent ที่ถูกลบไประหว่างรอยืนยัน → ให้หัวหน้าทีมรับงานแทน
          assigned_agent: agentIds.has(t.agent_id) ? t.agent_id : lead.id,
          depends_on: t.depends_on.map((d) => idByIndex.get(d)).filter((x): x is string => !!x),
          status: 'pending',
          input: { files: t.files },
        })
        .select('id')
        .single()
      const id = (inserted as { id: string } | null)?.id
      if (error || !id) throw new Error(error?.message ?? 'สร้างงานไม่สำเร็จ')
      idByIndex.set(i, id)
      created.push(id)
    }
  } catch (e) {
    await revert(created)
    return { ok: false, error: e instanceof Error ? e.message : 'สร้างงานไม่สำเร็จ' }
  }

  try {
    await enqueueReadyTasks(admin, projectId)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    await admin.from('messages').insert({
      project_id: projectId,
      role: 'assistant',
      content: `สร้างงานแล้ว ${created.length} งาน แต่ส่งเข้าคิวไม่สำเร็จ: ${detail}\nเปิดแท็บ Tasks แล้วกด "ลองใหม่" ได้`,
    })
    return { ok: false, error: `ส่งงานเข้าคิวไม่สำเร็จ: ${detail}` }
  }

  await admin.from('messages').insert({
    project_id: projectId,
    role: 'assistant',
    content: `เริ่มทำงานตามแผนแล้ว ${created.length} งาน ผลงานจะทยอยขึ้นในแชทนี้`,
  })
  return { ok: true, taskCount: created.length }
}

export async function dismissPlan(admin: SupabaseClient, projectId: string, messageId: string): Promise<boolean> {
  const { data } = await admin
    .from('messages')
    .update({ plan_status: 'dismissed' })
    .eq('id', messageId)
    .eq('project_id', projectId)
    .eq('plan_status', 'pending')
    .select('id')
  return !!data && (data as unknown[]).length > 0
}

// ---------------------------------------------------------------------------
// คุยกับหัวหน้าทีม 1 รอบ
// ---------------------------------------------------------------------------
export interface LeadTurnInput {
  admin: SupabaseClient
  /** แยกเป็นพารามิเตอร์เพื่อให้ทดสอบโดยไม่เรียก AI จริง */
  complete: (req: CompletionRequest) => Promise<CompletionResult>
  project: { id: string; name: string; instructions: string; max_tasks_per_run: number }
  /** ทีมที่ประจำโปรเจกต์นี้ (acquireTeam แล้ว) */
  teamId: string
  team: TeamAgent[]
  lead: TeamAgent
  apiKey: string
  userMessage: string
  /** id ของข้อความผู้ใช้ที่เพิ่งบันทึก (ตัดออกจากประวัติ เพราะส่งแยกท้าย prompt อยู่แล้ว) */
  userMessageId: string
}

export interface LeadTurnResult {
  planProposed: boolean
  started: boolean
  taskCount: number
}

function summarizeTasks(rows: Array<{ title: string; status: string; error: string | null }>): string {
  const running = rows.filter((r) => r.status === 'running')
  const pending = rows.filter((r) => r.status === 'pending')
  const failed = rows.filter((r) => r.status === 'failed')
  const parts: string[] = []
  if (running.length) parts.push(`กำลังทำ ${running.length} งาน (${running.slice(0, 4).map((r) => r.title).join(', ')})`)
  if (pending.length) parts.push(`รอคิว ${pending.length} งาน`)
  if (failed.length) {
    parts.push(`ล้มเหลว ${failed.length} งาน (${failed.slice(0, 3).map((r) => `${r.title}: ${(r.error ?? '').slice(0, 80)}`).join('; ')})`)
  }
  return parts.join(' | ')
}

export async function runLeadTurn(i: LeadTurnInput): Promise<LeadTurnResult> {
  const { admin, project, team, lead } = i

  const [mem, pendRes, filesRes, tasksRes, pricesRes] = await Promise.all([
    loadMemory(admin, project.id),
    admin
      .from('messages')
      .select('id, plan')
      .eq('project_id', project.id)
      .eq('plan_status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from('files')
      .select('path')
      .eq('project_id', project.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(FILES_LISTED),
    admin
      .from('tasks')
      .select('title, status, error')
      .eq('project_id', project.id)
      .order('created_at', { ascending: false })
      .limit(TASKS_FOR_STATUS),
    admin
      .from('model_prices')
      .select('provider, model, in_per_mtok, out_per_mtok')
      .in('model', [...new Set(team.map((m) => m.model))]),
  ])

  // ประวัติแชท = เฉพาะส่วนที่ยังไม่ถูกสรุปลง brief และพอดีงบ token (ของเก่ากว่านั้นอยู่ใน brief แล้ว)
  const unsummarized = (await loadUnsummarized(admin, project.id, mem.summarized_through, HISTORY_FETCH + 1)).filter(
    (m) => m.id !== i.userMessageId
  )
  const history: ChatLine[] = fitRecent(unsummarized, BUDGET.leadHistoryTokens).map((m) => ({
    role: m.role,
    content: m.content,
    isTaskResult: !!m.task_id,
  }))

  const pendingRow = pendRes.error ? null : (pendRes.data as { id: string; plan: StoredPlan | null } | null)
  const pendingPlan = pendingRow?.plan ?? null

  const prices = new Map<string, string>()
  for (const p of (pricesRes.data ?? []) as Array<{ provider: string; model: string; in_per_mtok: number; out_per_mtok: number }>) {
    prices.set(`${p.provider}/${p.model}`, `$${Number(p.in_per_mtok)}/$${Number(p.out_per_mtok)} ต่อล้าน token`)
  }

  const filePaths = ((filesRes.data ?? []) as Array<{ path: string }>).map((f) => f.path)
  const systemPrompt = buildLeadSystemPrompt({
    lead,
    projectName: project.name,
    instructions: project.instructions,
    team,
    prices,
    filePaths,
    filesTotal: filePaths.length,
    pendingPlan,
    taskStatus: summarizeTasks((tasksRes.data ?? []) as Array<{ title: string; status: string; error: string | null }>),
    brief: mem.brief,
  })

  const result = await i.complete({
    apiKey: i.apiKey,
    model: lead.model,
    systemPrompt,
    userPrompt: buildLeadUserPrompt(history, i.userMessage),
    maxTokens: lead.max_tokens ?? LEAD_MAX_TOKENS,
    baseUrl: lead.base_url ?? undefined,
  })

  // ค่าใช้จ่ายของการคุย (รวมเข้า spent_usd ของ project) — บันทึกพลาดไม่ทำให้การคุยล้ม
  await recordChatUsage(admin, {
    projectId: project.id,
    provider: lead.provider,
    model: lead.model,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
  })

  const parsed = parseLeadOutput(result.text)
  let reply = parsed.reply
  let plan: StoredPlan | null = null
  if (parsed.planJson !== null) {
    const check = validatePlan(parsed.planJson, { team, lead, maxTasks: project.max_tasks_per_run })
    if (check.ok) plan = check.plan
    else reply += `\n\n(ระบบใช้แผนที่เสนอไม่ได้: ${check.error} — ลองขอให้วางแผนใหม่อีกครั้ง)`
  } else if (parsed.planError) {
    reply += `\n\n(${parsed.planError} — ลองขอให้วางแผนใหม่อีกครั้ง)`
  }
  if (!reply.trim()) reply = plan ? 'นี่คือแผนที่เสนอ ถ้าโอเคกดเริ่มทำได้เลย' : '(ไม่มีคำตอบ)'

  if (plan) {
    // แผนใหม่แทนที่แผนเก่าที่ยังรออยู่
    await admin.from('messages').update({ plan_status: 'dismissed' }).eq('project_id', project.id).eq('plan_status', 'pending')
    const { error } = await admin
      .from('messages')
      .insert({ project_id: project.id, role: 'assistant', content: reply, plan, plan_status: 'pending' })
    if (error) throw new Error(error.message)
  } else {
    const { error } = await admin.from('messages').insert({ project_id: project.id, role: 'assistant', content: reply })
    if (error) throw new Error(error.message)
  }

  // <start/> ใช้ได้เฉพาะตอนที่มีแผนรออยู่ และคำตอบนี้ไม่ได้เสนอแผนใหม่ (แผนใหม่ผู้ใช้ยังไม่เคยเห็น ต้องรอยืนยัน)
  let started = false
  let taskCount = 0
  if (parsed.start && !plan && pendingRow) {
    const r = await startPlan(admin, project.id, pendingRow.id, i.teamId)
    started = r.ok
    if (r.ok) taskCount = r.taskCount
    else await admin.from('messages').insert({ project_id: project.id, role: 'assistant', content: `เริ่มงานไม่ได้: ${r.error}` })
  }

  return { planProposed: !!plan, started, taskCount }
}
