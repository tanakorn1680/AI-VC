import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { calculateCost } from '@/lib/orchestrator/pricing'
import { InsufficientCreditError, InvalidApiKeyError, RateLimitError } from '@/lib/ai/types'
import { AnalysisFormatError, completeJson, type JsonCompletion } from './llm'
import { loadAnalyst, type AnalystAgent } from './security'
import { getRegistry, supportsKind } from './tool-registry'
import type { DetectedKind } from './tool-adapter'
import { runTool } from './tool-runner'
import { downloadObject } from './storage'
import {
  MAX_PLAN_TASKS,
  MAX_TOTAL_TASKS,
  PLAN_SYSTEM_PROMPT,
  buildPlanPrompt,
  parsePlan,
  type PlanArtifact,
  type PlannedTask,
} from './planner'
import type { ArtifactKind } from './types'
import { FINDINGS_SYSTEM_PROMPT, buildFindingsPrompt, processFindings, type RunOutput } from './findings'

/**
 * Orchestrator ของ Reverse Engineering Mode — ทำงานทีละ "step" แล้วคืนผลให้ผู้เรียกเรียกซ้ำ
 *   วางแผน → เรียกเครื่องมือทีละงาน → ตรวจผล/เก็บหลักฐาน → สรุปข้อค้นพบ
 * สถานะทั้งหมดอยู่ใน DB (ไม่มีสถานะในหน่วยความจำ) จึงหยุดแล้วทำต่อจากเดิมได้เสมอ
 *
 * หลักความปลอดภัย:
 *   - AI เลือกได้เฉพาะ tool_id ที่ผ่าน Registry และ artifact_id ที่อยู่ในงานนี้ (ตรวจทุกครั้งใน parsePlan)
 *   - ไม่มีเส้นทางให้ AI สั่งคำสั่งระบบ / รันโค้ดอิสระ
 *   - หลักฐานและระดับความเชื่อมั่นตัดสินโดยระบบ (evidence.ts) ไม่ใช่โมเดล
 *   - API key ใช้เรียก provider เท่านั้น ไม่ส่งต่อไปเครื่องมือ
 *   - ทุก query ด้วย service role กรอง session_id/owner_id เสมอ (ผู้เรียกต้องผ่าน RLS มาก่อน)
 */

export type StepOutcome =
  | { state: 'continue'; message: string }
  | { state: 'waiting'; message: string; retryAfterSeconds: number }
  | { state: 'done'; message: string }
  | { state: 'blocked'; message: string }
  | { state: 'busy'; message: string }
  | { state: 'error'; message: string }

const LOCK_SECONDS = 90
const STALE_TASK_MS = 3 * 60 * 1000
const MAX_EXTRA_ROUNDS = 1

export interface SessionRow {
  id: string
  owner_id: string
  goal: string
  status: string
  analyst_agent_id: string | null
  token_budget: number
  tokens_in: number
  tokens_out: number
  cost_usd: number
  config: { rounds?: number; reanalyze?: boolean } | null
}

interface TaskRow {
  id: string
  title: string
  status: string
  depends_on: string[]
  input: { tool_id?: string; artifact_id?: string }
  attempts: number
  max_attempts: number
  started_at: string | null
}

interface ArtifactRow {
  id: string
  name: string
  size_bytes: number
  sha256: string
  kind: ArtifactKind
  storage_path: string
  metadata: { detected_kind?: string; detected_label?: string }
}

export async function advanceSession(sessionId: string, ownerId: string): Promise<StepOutcome> {
  const admin = createAdminClient()

  const { data: sessionData } = await admin
    .from('analysis_sessions')
    .select('id, owner_id, goal, status, analyst_agent_id, token_budget, tokens_in, tokens_out, cost_usd, config')
    .eq('id', sessionId)
    .eq('owner_id', ownerId)
    .maybeSingle()
  if (!sessionData) return { state: 'error', message: 'ไม่พบงานวิเคราะห์นี้' }
  const session = sessionData as unknown as SessionRow

  if (session.status === 'cancelled') return { state: 'blocked', message: 'งานนี้ถูกยกเลิกแล้ว' }
  if (session.status === 'completed') return { state: 'done', message: 'งานนี้วิเคราะห์เสร็จแล้ว' }

  const leased = await withSessionLease(admin, sessionId, async () => {
    try {
      return await runStep(admin, session)
    } catch (e) {
      console.error('[analysis] step crashed:', (e as Error).message)
      return { state: 'error', message: 'เกิดข้อผิดพลาดภายในระหว่างวิเคราะห์ กรุณาลองใหม่' } as StepOutcome
    }
  })
  if (!leased.ok) return { state: 'busy', message: 'มี step อื่นของงานนี้กำลังทำงานอยู่' }
  return leased.value
}

/**
 * lease กันงานซ้อนกันบน session เดียว (เปิดหลายแท็บ / กดซ้ำ): ได้ lease เท่านั้นจึงทำต่อ
 * lease หมดอายุเองใน LOCK_SECONDS กันค้างเมื่อ function ถูกตัดกลางทาง
 */
export async function withSessionLease<T>(
  admin: SupabaseClient,
  sessionId: string,
  fn: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  const nowIso = new Date().toISOString()
  const { data: leased } = await admin
    .from('analysis_sessions')
    .update({ step_lock_until: new Date(Date.now() + LOCK_SECONDS * 1000).toISOString() })
    .eq('id', sessionId)
    .or(`step_lock_until.is.null,step_lock_until.lt.${nowIso}`)
    .select('id')
  if (!leased || leased.length === 0) return { ok: false }

  try {
    return { ok: true, value: await fn() }
  } finally {
    await admin.from('analysis_sessions').update({ step_lock_until: null }).eq('id', sessionId)
  }
}

async function runStep(admin: SupabaseClient, session: SessionRow): Promise<StepOutcome> {
  const sid = session.id

  // 1) ต้องมีนักวิเคราะห์ และมีไฟล์ต้นทาง
  const analyst = await loadAnalyst(admin, session.analyst_agent_id, session.owner_id)
  if (!analyst.ok) return { state: 'blocked', message: analyst.message }

  const { data: artData } = await admin
    .from('analysis_artifacts')
    .select('id, name, size_bytes, sha256, kind, storage_path, metadata')
    .eq('session_id', sid)
    .eq('kind', 'source')
    .order('created_at', { ascending: true })
  const sources = (artData ?? []) as unknown as ArtifactRow[]
  if (sources.length === 0) return { state: 'blocked', message: 'ต้องอัปโหลดไฟล์ต้นทางที่แท็บ Artifacts ก่อน' }

  // 2) กู้งานที่ค้าง (function ถูกตัดกลางทาง): ลองใหม่ถ้ายังมีสิทธิ์ ไม่งั้นถือว่าล้มเหลว
  const staleBefore = new Date(Date.now() - STALE_TASK_MS).toISOString()
  const { data: stale } = await admin
    .from('analysis_tasks')
    .select('id, attempts, max_attempts')
    .eq('session_id', sid)
    .eq('status', 'running')
    .lt('started_at', staleBefore)
  for (const t of (stale ?? []) as { id: string; attempts: number; max_attempts: number }[]) {
    await admin
      .from('analysis_tasks')
      .update(t.attempts < t.max_attempts
        ? { status: 'pending' }
        : { status: 'failed', error: 'งานค้างเกินเวลาที่กำหนด', completed_at: new Date().toISOString() })
      .eq('id', t.id)
      .eq('session_id', sid)
  }

  const { data: taskData } = await admin
    .from('analysis_tasks')
    .select('id, title, status, depends_on, input, attempts, max_attempts, started_at')
    .eq('session_id', sid)
    .order('created_at', { ascending: true })
  const tasks = (taskData ?? []) as unknown as TaskRow[]

  // เริ่ม/ทำต่อ: ล้างสถานะหยุดเดิม (failed / awaiting_tools / draft) กลับเป็นกำลังทำงาน
  const activeStatus = tasks.length === 0 ? 'planning' : 'running'
  if (session.status !== activeStatus) {
    await admin.from('analysis_sessions').update({ status: activeStatus, last_error: null }).eq('id', sid)
  } else {
    await admin.from('analysis_sessions').update({ last_error: null }).eq('id', sid)
  }

  // 3) เลือก step ถัดไป
  if (tasks.length === 0) return planStep(admin, session, analyst.agent, sources)

  const byId = new Map(tasks.map((t) => [t.id, t]))
  // งานที่ต้องรอ dependency ซึ่งล้มเหลว/ถูกยกเลิก จะไม่มีวันรันได้ → ยกเลิกตาม
  for (const t of tasks.filter((x) => x.status === 'pending')) {
    if (t.depends_on.some((d) => ['failed', 'cancelled'].includes(byId.get(d)?.status ?? 'cancelled'))) {
      await admin.from('analysis_tasks')
        .update({ status: 'cancelled', error: 'งานที่ต้องรอก่อนหน้าไม่สำเร็จ', completed_at: new Date().toISOString() })
        .eq('id', t.id).eq('session_id', sid)
      t.status = 'cancelled'
    }
  }

  const next = tasks.find(
    (t) => t.status === 'pending' && t.depends_on.every((d) => byId.get(d)?.status === 'completed')
  )
  if (next) return execStep(admin, session, next, sources)

  if (tasks.some((t) => t.status === 'pending' || t.status === 'running')) {
    return { state: 'busy', message: 'มีงานค้างที่ยังรอ dependency' }
  }

  // ไม่มีงานค้างแล้ว: วิเคราะห์สรุป (ครั้งแรก หรือหลังเพิ่มงานรอบเสริม)
  const { count: findingCount } = await admin
    .from('analysis_findings')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', sid)
  if ((findingCount ?? 0) === 0 || session.config?.reanalyze) {
    return analyzeStep(admin, session, analyst.agent, sources)
  }

  await admin.from('analysis_sessions').update({ status: 'completed' }).eq('id', sid)
  return { state: 'done', message: 'วิเคราะห์เสร็จสิ้น' }
}

// ---------------------------------------------------------------------------
// ตัวช่วยเรียกโมเดล: ตรวจงบ → เรียก → บันทึก token/ค่าใช้จ่าย → จัดการ error ของ provider
// ---------------------------------------------------------------------------
export async function callModel(
  admin: SupabaseClient,
  session: SessionRow,
  analyst: AnalystAgent,
  prompt: { system: string; user: string; maxTokens: number },
  opts: { keepStatus?: boolean } = {}
): Promise<{ ok: true; result: JsonCompletion } | { ok: false; outcome: StepOutcome }> {
  const used = session.tokens_in + session.tokens_out
  if (used >= session.token_budget) {
    const message = `ใช้ token ครบงบที่ตั้งไว้ (${used.toLocaleString('en-US')} / ${session.token_budget.toLocaleString('en-US')}) เพิ่มงบแล้วกดทำต่อได้`
    if (!opts.keepStatus) {
      await admin.from('analysis_sessions').update({ status: 'failed', last_error: message }).eq('id', session.id)
    }
    return { ok: false, outcome: { state: 'blocked', message } }
  }

  const record = async (tokensIn: number, tokensOut: number) => {
    const cost = await calculateCost(admin, analyst.provider, analyst.model, tokensIn, tokensOut).catch(() => 0)
    session.tokens_in += tokensIn
    session.tokens_out += tokensOut
    session.cost_usd = Number(session.cost_usd) + cost
    await admin.from('analysis_sessions')
      .update({ tokens_in: session.tokens_in, tokens_out: session.tokens_out, cost_usd: session.cost_usd })
      .eq('id', session.id)
  }

  try {
    const result = await completeJson(analyst, prompt)
    await record(result.tokensIn, result.tokensOut)
    return { ok: true, result }
  } catch (e) {
    if (e instanceof AnalysisFormatError) {
      const t = e as AnalysisFormatError & { tokensIn?: number; tokensOut?: number }
      await record(t.tokensIn ?? 0, t.tokensOut ?? 0) // token ถูกใช้ไปจริงแม้ตอบผิดรูปแบบ
      return { ok: false, outcome: { state: 'error', message: 'โมเดลตอบผิดรูปแบบ ลองใหม่อีกครั้ง หรือเปลี่ยนไปใช้โมเดลอื่น' } }
    }
    if (e instanceof InvalidApiKeyError || e instanceof InsufficientCreditError) {
      const message = (e as Error).message
      if (!opts.keepStatus) {
        await admin.from('analysis_sessions').update({ status: 'failed', last_error: message.slice(0, 1000) }).eq('id', session.id)
      }
      return { ok: false, outcome: { state: 'blocked', message } }
    }
    if (e instanceof RateLimitError) {
      const wait = Math.min(Math.max(e.retryAfterSeconds ?? 20, 5), 120)
      return { ok: false, outcome: { state: 'waiting', message: 'โควตา AI เต็มชั่วคราว ระบบจะลองใหม่อัตโนมัติ', retryAfterSeconds: wait } }
    }
    console.error('[analysis] model call failed:', (e as Error).message)
    return { ok: false, outcome: { state: 'error', message: `เรียก AI ไม่สำเร็จ: ${(e as Error).message}`.slice(0, 400) } }
  }
}

const toPlanArtifacts = (sources: ArtifactRow[]): PlanArtifact[] =>
  sources.map((a) => ({
    id: a.id,
    name: a.name,
    size_bytes: a.size_bytes,
    detected_kind: a.metadata.detected_kind ?? 'unknown',
    detected_label: a.metadata.detected_label ?? '',
  }))

async function insertTasks(admin: SupabaseClient, sessionId: string, planned: PlannedTask[]) {
  const ids = planned.map(() => randomUUID())
  const rows = planned.map((p, i) => ({
    id: ids[i],
    session_id: sessionId,
    title: p.title,
    description: p.description,
    success_criteria: p.successCriteria,
    depends_on: p.dependsOnIndex.map((d) => ids[d]),
    priority: i,
    input: { tool_id: p.toolId, artifact_id: p.artifactId },
  }))
  const { error } = await admin.from('analysis_tasks').insert(rows)
  if (error) throw new Error(`insert tasks: ${error.message}`)
}

// ---------------------------------------------------------------------------
// PLAN
// ---------------------------------------------------------------------------
async function planStep(
  admin: SupabaseClient,
  session: SessionRow,
  analyst: AnalystAgent,
  sources: ArtifactRow[]
): Promise<StepOutcome> {
  const artifacts = toPlanArtifacts(sources)
  const registry = await getRegistry()
  const tools = registry.filter(
    (t) => t.ready && artifacts.some((a) => supportsKind(t, a.detected_kind as DetectedKind))
  )
  if (tools.length === 0) {
    const message = 'ยังไม่มีเครื่องมือที่พร้อมใช้งานและรองรับไฟล์ที่อัปโหลด จึงยังวางแผนวิเคราะห์ไม่ได้'
    await admin.from('analysis_sessions').update({ status: 'awaiting_tools', last_error: message }).eq('id', session.id)
    return { state: 'blocked', message }
  }

  const called = await callModel(admin, session, analyst, {
    system: PLAN_SYSTEM_PROMPT,
    user: buildPlanPrompt(session.goal, artifacts, tools),
    maxTokens: 3000,
  })
  if (!called.ok) return called.outcome

  const { tasks, dropped } = parsePlan(called.result.value.tasks, {
    artifacts,
    tools,
    existingPairs: new Set(),
    maxTasks: MAX_PLAN_TASKS,
  })
  if (tasks.length === 0) {
    return { state: 'error', message: 'แผนจากโมเดลไม่ผ่านการตรวจ (ไม่มีงานที่ใช้เครื่องมือและไฟล์ที่ถูกต้อง) ลองใหม่อีกครั้ง' }
  }

  await insertTasks(admin, session.id, tasks)
  await admin.from('analysis_sessions').update({ status: 'running' }).eq('id', session.id)
  return {
    state: 'continue',
    message: `วางแผนแล้ว ${tasks.length} งาน${dropped ? ` (ตัดงานที่ไม่ผ่านการตรวจ ${dropped} งาน)` : ''}`,
  }
}

// ---------------------------------------------------------------------------
// EXEC: เรียกเครื่องมือจริงหนึ่งงาน
// ---------------------------------------------------------------------------
async function execStep(
  admin: SupabaseClient,
  session: SessionRow,
  task: TaskRow,
  sources: ArtifactRow[]
): Promise<StepOutcome> {
  const sid = session.id
  const toolId = task.input.tool_id ?? ''
  const artifact = sources.find((a) => a.id === task.input.artifact_id)

  const fail = async (error: string) => {
    await admin.from('analysis_tasks')
      .update({ status: 'failed', error: error.slice(0, 1000), completed_at: new Date().toISOString() })
      .eq('id', task.id).eq('session_id', sid)
  }
  if (!artifact) {
    await fail('ไม่พบไฟล์ที่งานนี้อ้างถึง')
    return { state: 'continue', message: `งาน "${task.title}" ล้มเหลว: ไม่พบไฟล์` }
  }

  await admin.from('analysis_tasks')
    .update({ status: 'running', attempts: task.attempts + 1, started_at: new Date().toISOString(), error: null })
    .eq('id', task.id).eq('session_id', sid)

  const outcome = await runTool({ sessionId: sid, artifact, toolId, taskId: task.id })

  if (outcome.ok) {
    await admin.from('analysis_tasks')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', task.id).eq('session_id', sid)
    return { state: 'continue', message: `เสร็จ: ${task.title}` }
  }

  // มี run อื่นของงานนี้ active อยู่ (ไม่ใช่ความผิดของ task) → คืนเป็นรอคิวแล้วให้ลองใหม่
  if (outcome.status === 409) {
    await admin.from('analysis_tasks').update({ status: 'pending' }).eq('id', task.id).eq('session_id', sid)
    return { state: 'busy', message: outcome.message }
  }
  await fail(outcome.message)
  return { state: 'continue', message: `งาน "${task.title}" ล้มเหลว: ${outcome.message}` }
}

// ---------------------------------------------------------------------------
// ANALYZE: สรุปข้อค้นพบ ตรวจหลักฐาน และ (ถ้าจำเป็น) ขอเครื่องมือเพิ่มอีกหนึ่งรอบ
// ---------------------------------------------------------------------------
async function analyzeStep(
  admin: SupabaseClient,
  session: SessionRow,
  analyst: AnalystAgent,
  sources: ArtifactRow[]
): Promise<StepOutcome> {
  const sid = session.id

  const { data: runData } = await admin
    .from('analysis_tool_runs')
    .select('id, tool_id, input, output_summary, created_at')
    .eq('session_id', sid)
    .eq('status', 'succeeded')
    .order('created_at', { ascending: true })
    .limit(50)
  const runs = (runData ?? []) as { id: string; tool_id: string; input: { artifact_id?: string }; output_summary: string }[]

  const { data: outData } = await admin
    .from('analysis_artifacts')
    .select('id, storage_path, produced_by_run_id')
    .eq('session_id', sid)
    .eq('kind', 'tool_output')
  const outByRun = new Map(
    ((outData ?? []) as { id: string; storage_path: string; produced_by_run_id: string | null }[])
      .filter((o) => o.produced_by_run_id)
      .map((o) => [o.produced_by_run_id as string, o])
  )

  const outputs: RunOutput[] = []
  for (const r of runs) {
    const out = outByRun.get(r.id)
    if (!out) continue
    try {
      const bytes = await downloadObject(out.storage_path, 3 * 1024 * 1024)
      outputs.push({
        runId: r.id,
        toolId: r.tool_id,
        artifactName: sources.find((a) => a.id === r.input.artifact_id)?.name ?? '(ไม่ทราบ)',
        outputArtifactId: out.id,
        fullText: new TextDecoder().decode(bytes),
        summary: r.output_summary,
      })
    } catch (e) {
      console.error('[analysis] read tool output failed:', (e as Error).message)
    }
  }

  if (outputs.length === 0) {
    const message = 'ไม่มีเครื่องมือใดรันสำเร็จ จึงไม่มีข้อมูลให้สรุป — ดูสาเหตุที่แท็บ Agents & Tools'
    await admin.from('analysis_sessions').update({ status: 'failed', last_error: message }).eq('id', sid)
    return { state: 'blocked', message }
  }

  // artifact ที่ยังไม่ถูกตรวจด้วยเครื่องมือที่รองรับ — ใช้ตัดสินว่าขอรอบเสริมได้หรือไม่
  const registry = await getRegistry()
  const tasksPairs = new Set<string>()
  const { data: allTasks } = await admin.from('analysis_tasks').select('input').eq('session_id', sid)
  for (const t of (allTasks ?? []) as { input: { tool_id?: string; artifact_id?: string } }[]) {
    tasksPairs.add(`${t.input.tool_id}:${t.input.artifact_id}`)
  }
  const artifacts = toPlanArtifacts(sources)
  const uninspected = artifacts.flatMap((a) =>
    registry
      .filter((t) => t.ready && supportsKind(t, a.detected_kind as DetectedKind) && !tasksPairs.has(`${t.id}:${a.id}`))
      .map((t) => ({ artifact_id: a.id, name: a.name, supported_tools: [t.id] }))
  )

  const called = await callModel(admin, session, analyst, {
    system: FINDINGS_SYSTEM_PROMPT,
    user: buildFindingsPrompt(session.goal, outputs, uninspected),
    maxTokens: 6000,
  })
  if (!called.ok) return called.outcome

  const processed = processFindings(called.result.value, outputs)

  // แทนที่ผลสรุปเดิมทั้งหมด (idempotent: step ที่ถูกรันซ้ำหลัง crash จะไม่สร้างข้อค้นพบซ้ำ)
  await admin.from('analysis_findings').delete().eq('session_id', sid)

  const findingRows = processed.findings.map((f) => ({ id: randomUUID(), f }))
  if (findingRows.length > 0) {
    const { error } = await admin.from('analysis_findings').insert(
      findingRows.map(({ id, f }) => ({
        id, session_id: sid, kind: 'finding', title: f.title, statement: f.statement, confidence: f.confidence,
      }))
    )
    if (error) throw new Error(`insert findings: ${error.message}`)
    const evidenceRows = findingRows.flatMap(({ id, f }) =>
      f.evidence.map((e) => ({
        session_id: sid, finding_id: id, artifact_id: e.artifactId, tool_run_id: e.toolRunId,
        locator: e.locator, excerpt: e.excerpt,
      }))
    )
    if (evidenceRows.length > 0) {
      const { error: evErr } = await admin.from('analysis_evidence').insert(evidenceRows)
      if (evErr) throw new Error(`insert evidence: ${evErr.message}`)
    }
  }
  if (processed.limitations.length > 0) {
    const { error } = await admin.from('analysis_findings').insert(
      processed.limitations.map((l) => ({
        session_id: sid, kind: 'limitation', title: l.title, statement: l.statement, confidence: 'unverified',
      }))
    )
    if (error) throw new Error(`insert limitations: ${error.message}`)
  }

  // รอบเสริม: อนุญาตเพิ่มงานได้เฉพาะคู่ tool+artifact ที่ยังไม่เคยรัน ภายในเพดานจำนวนงานและจำนวนรอบ
  const rounds = session.config?.rounds ?? 0
  const roomForTasks = remainingTaskSlots(tasksPairs.size)
  if (rounds < MAX_EXTRA_ROUNDS && roomForTasks > 0 && uninspected.length > 0) {
    const extra = parsePlan(processed.needsMore, {
      artifacts,
      tools: registry.filter((t) => t.ready),
      existingPairs: tasksPairs,
      maxTasks: roomForTasks,
    })
    if (extra.tasks.length > 0) {
      await insertTasks(admin, sid, extra.tasks)
      await admin.from('analysis_sessions')
        .update({ status: 'running', config: { ...(session.config ?? {}), rounds: rounds + 1, reanalyze: true } })
        .eq('id', sid)
      return { state: 'continue', message: `สรุปรอบแรกแล้ว ขอตรวจเพิ่ม ${extra.tasks.length} งาน` }
    }
  }

  await admin.from('analysis_sessions')
    .update({ status: 'completed', last_error: null, config: { ...(session.config ?? {}), reanalyze: false } })
    .eq('id', sid)
  const rejected = processed.findings.reduce((n, f) => n + f.rejectedEvidence, 0)
  return {
    state: 'done',
    message: `สรุปเสร็จ: ข้อค้นพบ ${processed.findings.length} รายการ ข้อจำกัด ${processed.limitations.length} รายการ${rejected ? ` (ตัดหลักฐานที่ตรวจไม่ผ่าน ${rejected} รายการ)` : ''}`,
  }
}

function remainingTaskSlots(existingTaskCount: number): number {
  return Math.max(0, MAX_TOTAL_TASKS - existingTaskCount)
}
