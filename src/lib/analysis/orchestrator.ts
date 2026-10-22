import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { calculateCost } from '@/lib/orchestrator/pricing'
import { InsufficientCreditError, InvalidApiKeyError, ProviderError, RateLimitError } from '@/lib/ai/types'
import { estimateTokens } from '@/lib/orchestrator/context-budget'
import { AnalysisFormatError, PromptTooLargeError, completeJson, type JsonCompletion } from './llm'
import {
  PER_CALL_TOKEN_CAP,
  MAX_RUN_TOTAL_CHARS,
  largestLimit,
  loadAnalystPool,
  orderPool,
  outputBudgetFor,
  partCharsFor,
  planWave,
  type PoolMember,
  type PoolPrefer,
} from './team-pool'
import { REVIEW_SYSTEM_PROMPT, buildReviewPrompt, limitationTitleForDrop, parseVerdicts } from './team-review'
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
import {
  FINDINGS_SYSTEM_PROMPT,
  buildFindingsPrompt,
  findingsSystemPrompt,
  processFindings,
  type ProcessedFindings,
  type PromptItem,
  type RunOutput,
} from './findings'

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

const LOCK_SECONDS = 150
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
  config: SessionConfig | null
}

/** สถานะการสรุปผลแบบทีม (หลาย agent ช่วยกันอ่านผลเครื่องมือคนละชุด) — อยู่ใน config เพื่อทำต่อได้หลังหยุดกลางทาง */
export interface AnalysisState {
  /** ส่วน (part) ของผลเครื่องมือที่สรุปแล้วในรอบนี้ — รูปแบบ `${runId}:${เลขส่วน}` */
  done: string[]
  /** ความยาวต่อส่วน (ตัวอักษร) ที่ใช้หั่นผลในรอบนี้ — เก็บไว้เพื่อให้ขอบเขตส่วนเหมือนเดิมทุก step */
  part_chars: number
  /** ข้อเสนอขอเครื่องมือเพิ่มจากทุกชุด (ยังไม่ผ่าน parsePlan) */
  needs_more: unknown[]
  reviewed: boolean
  wave: number
}

export interface SessionConfig {
  rounds?: number
  reanalyze?: boolean
  /** ทีมที่ผู้ใช้เลือก (ไม่มี = ทีมแรกที่มี agent) */
  team_id?: string | null
  /** เพดานคำขอที่เรียนรู้จาก error ของ provider ต่อ agent (token) */
  agent_limits?: Record<string, number>
  analysis?: AnalysisState
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

  // 1) ต้องมีทีมนักวิเคราะห์ (agent ในทีม AI ทั้งทีม) และมีไฟล์ต้นทาง
  const poolRes = await loadAnalystPool(admin, session)
  if (!poolRes.ok) return { state: 'blocked', message: poolRes.message }
  const pool = poolRes.members

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
  if (tasks.length === 0) return planStep(admin, session, pool, sources)

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
  // config.analysis = กำลังสรุปผลแบบทีมค้างอยู่ (ทำต่อจากเดิม)
  if ((findingCount ?? 0) === 0 || session.config?.reanalyze || session.config?.analysis) {
    return analyzeStep(admin, session, pool, sources)
  }

  await admin.from('analysis_sessions').update({ status: 'completed' }).eq('id', sid)
  return { state: 'done', message: 'วิเคราะห์เสร็จสิ้น' }
}

// ---------------------------------------------------------------------------
// ตัวช่วยเรียกโมเดลของ "ทีม": ตรวจงบ → ลองสมาชิกตามลำดับ → บันทึก token/ค่าใช้จ่ายของตัวที่ถูกเรียกจริง → ส่งต่อตัวถัดไปเมื่อพลาด
//   คำขอใหญ่เกินเพดานของตัวนั้น → จำเพดานที่เรียนรู้ไว้ แล้วส่งต่อตัวที่ใหญ่กว่า
//   rate limit / ตอบผิดรูปแบบ / provider error → ส่งต่อตัวอื่นในทีม
//   key ผิด / เครดิตหมด → ข้ามตัวนั้น (ถ้าทั้งทีมพังแบบนี้ค่อยหยุดงานและบอกผู้ใช้)
// ---------------------------------------------------------------------------
export interface CallOpts {
  keepStatus?: boolean
  /** บทบาทที่เหมาะกับงาน (ลำดับตัวที่จะลองก่อน) */
  prefer?: PoolPrefer
  /** สมาชิกที่ถูกมอบหมายงานนี้ไว้ก่อน (ตัวอื่นเป็นตัวสำรอง) */
  first?: PoolMember
}

export type ModelCall =
  | { ok: true; result: JsonCompletion; agent: PoolMember }
  | { ok: false; outcome: StepOutcome }

// เขียน session ทีละคำสั่งตามลำดับ (เรียกโมเดลขนานกันได้ แต่ยอด token/config ต้องไม่เขียนทับกันเอง)
const writeChains = new WeakMap<SessionRow, Promise<unknown>>()
function enqueueSessionWrite(admin: SupabaseClient, session: SessionRow, build: () => Record<string, unknown>) {
  const prev = writeChains.get(session) ?? Promise.resolve()
  const next = prev
    .then(() => admin.from('analysis_sessions').update(build()).eq('id', session.id))
    .then(() => undefined, () => undefined)
  writeChains.set(session, next)
  return next
}

/** แก้ config ใน memory แล้วเขียนลง DB (ใช้ค่าล่าสุด ณ ตอนเขียนจริง) */
export async function saveConfig(
  admin: SupabaseClient,
  session: SessionRow,
  patch: Partial<SessionConfig>,
  extra: Record<string, unknown> = {}
) {
  session.config = { ...(session.config ?? {}), ...patch }
  await enqueueSessionWrite(admin, session, () => ({ ...extra, config: session.config }))
}

/** เรียนรู้เพดานคำขอจริงของ agent จาก error ของ provider (เผื่อ 5% กันส่วนต่างการนับ token) */
async function learnLimit(admin: SupabaseClient, session: SessionRow, m: PoolMember, limit: number) {
  const next = Math.max(2_000, Math.floor(limit * 0.95))
  m.inputLimit = next
  await saveConfig(admin, session, { agent_limits: { ...(session.config?.agent_limits ?? {}), [m.id]: next } })
}

const TRANSIENT_STATUS = new Set([500, 502, 503, 504, 529])

const labelOf = (m: PoolMember) => `${m.name} · ${m.provider}/${m.model}`

export async function callModel(
  admin: SupabaseClient,
  session: SessionRow,
  pool: PoolMember[],
  prompt: { system: string; user: string; maxTokens: number },
  opts: CallOpts = {}
): Promise<ModelCall> {
  const used = session.tokens_in + session.tokens_out
  if (used >= session.token_budget) {
    const message = `ใช้ token ครบงบที่ตั้งไว้ (${used.toLocaleString('en-US')} / ${session.token_budget.toLocaleString('en-US')}) เพิ่มงบแล้วกดทำต่อได้`
    if (!opts.keepStatus) {
      await admin.from('analysis_sessions').update({ status: 'failed', last_error: message }).eq('id', session.id)
    }
    return { ok: false, outcome: { state: 'blocked', message } }
  }

  const record = async (m: PoolMember, tokensIn: number, tokensOut: number) => {
    const cost = await calculateCost(admin, m.provider, m.model, tokensIn, tokensOut).catch(() => 0)
    session.tokens_in += tokensIn
    session.tokens_out += tokensOut
    session.cost_usd = Number(session.cost_usd) + cost
    await enqueueSessionWrite(admin, session, () => ({
      tokens_in: session.tokens_in, tokens_out: session.tokens_out, cost_usd: session.cost_usd,
    }))
  }

  // ประมาณขนาด prompt (เผื่อ 10% เพราะนับ token แบบประมาณ)
  const need = Math.ceil((estimateTokens(prompt.system) + estimateTokens(prompt.user)) * 1.1)
  let waitSeconds: number | null = null
  let fatal: string | null = null
  let lastError: string | null = null
  let tooBig = 0
  let transient = false

  for (const m of orderPool(pool, opts.prefer ?? 'lead', opts.first)) {
    const room = m.inputLimit - need // ที่เหลือให้คำตอบ (รวม headroom ของรุ่นที่คิดก่อนตอบ)
    const maxTokens = Math.min(prompt.maxTokens, m.max_tokens ?? prompt.maxTokens, room - 100)
    if (maxTokens < 1024) {
      tooBig++
      continue
    }
    try {
      const result = await completeJson(m, { ...prompt, maxTokens, outputCap: room })
      await record(m, result.tokensIn, result.tokensOut)
      return { ok: true, result, agent: m }
    } catch (e) {
      if (e instanceof AnalysisFormatError) {
        const t = e as AnalysisFormatError & { tokensIn?: number; tokensOut?: number }
        await record(m, t.tokensIn ?? 0, t.tokensOut ?? 0) // token ถูกใช้ไปจริงแม้ตอบผิดรูปแบบ
        lastError = `โมเดลตอบผิดรูปแบบ [${labelOf(m)}]`
      } else if (e instanceof PromptTooLargeError) {
        await learnLimit(admin, session, m, e.limit ?? Math.floor(need * 0.7))
        tooBig++
      } else if (e instanceof InvalidApiKeyError || e instanceof InsufficientCreditError) {
        fatal = `${(e as Error).message} [${labelOf(m)}]`
      } else if (e instanceof RateLimitError) {
        const w = Math.min(Math.max(e.retryAfterSeconds ?? 20, 5), 120)
        waitSeconds = waitSeconds === null ? w : Math.min(waitSeconds, w)
      } else if (e instanceof ProviderError && e.status !== undefined && TRANSIENT_STATUS.has(e.status)) {
        // provider ไม่ว่างชั่วคราว (เช่น Gemini 503 "high demand") — หายเองได้ จึงรอแล้วลองใหม่ ไม่ใช่ข้อผิดพลาดถาวร
        transient = true
        waitSeconds = waitSeconds === null ? 15 : Math.min(waitSeconds, 15)
      } else {
        console.error('[analysis] model call failed:', (e as Error).message)
        lastError = `เรียก AI ไม่สำเร็จ [${labelOf(m)}]: ${(e as Error).message}`
      }
    }
  }

  // ทุกตัวในทีมพลาด — เลือกข้อความที่ช่วยผู้ใช้ตัดสินใจได้มากสุด
  if (waitSeconds !== null) {
    const message = transient
      ? `AI provider ไม่ว่างชั่วคราว (503/ผู้ใช้หนาแน่น) ระบบจะลองใหม่อัตโนมัติ${pool.length < 2 ? ' — เพิ่ม agent จากค่ายอื่นในทีมเป็นตัวสำรองได้' : ''}`
      : 'โควตา AI ของทีมเต็มชั่วคราว ระบบจะลองใหม่อัตโนมัติ'
    return { ok: false, outcome: { state: 'waiting', message, retryAfterSeconds: waitSeconds } }
  }
  if (fatal && !lastError && tooBig === 0) {
    if (!opts.keepStatus) {
      await admin.from('analysis_sessions').update({ status: 'failed', last_error: fatal.slice(0, 1000) }).eq('id', session.id)
    }
    return { ok: false, outcome: { state: 'blocked', message: fatal } }
  }
  if (!lastError && tooBig > 0) {
    return {
      ok: false,
      outcome: {
        state: 'error',
        message:
          `ไม่มี agent ในทีมที่รับคำขอขนาดนี้ได้ (ต้องใช้ราว ${need.toLocaleString('en-US')} โทเคน แต่ตัวที่ใหญ่สุดรับได้ ${largestLimit(pool).toLocaleString('en-US')}) — ` +
          'เพิ่ม agent ที่ใช้โมเดล context ใหญ่ (เช่น Gemini / Claude) เข้าทีมที่เมนู "ทีม AI"',
      },
    }
  }
  return { ok: false, outcome: { state: 'error', message: (lastError ?? fatal ?? 'เรียก AI ไม่สำเร็จ').slice(0, 700) } }
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
// PLAN: ผู้นำทีม (manager) วางแผนอย่างเดียว ไม่ลงมือวิเคราะห์เอง
// ---------------------------------------------------------------------------
async function planStep(
  admin: SupabaseClient,
  session: SessionRow,
  pool: PoolMember[],
  sources: ArtifactRow[]
): Promise<StepOutcome> {
  const artifacts = toPlanArtifacts(sources)
  const registry = await getRegistry()
  const tools = registry.filter(
    (t) => t.ready && artifacts.some((a) => supportsKind(t, a.detected_kind as DetectedKind))
  )
  if (tools.length === 0) {
    const message = 'ยังไม่มีเครื่องมือที่พร้อมใช้งานและรองรับไฟล์ที่อัปโหลด จึงวางแผนวิเคราะห์ไม่ได้'
    await admin.from('analysis_sessions').update({ status: 'awaiting_tools', last_error: message }).eq('id', session.id)
    return { state: 'blocked', message }
  }

  const called = await callModel(
    admin,
    session,
    pool,
    { system: PLAN_SYSTEM_PROMPT, user: buildPlanPrompt(session.goal, artifacts, tools), maxTokens: 3000 },
    { prefer: 'lead' }
  )
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
    message: `${called.agent.name} วางแผนแล้ว ${tasks.length} งาน${dropped ? ` (ตัดงานที่ไม่ผ่านการตรวจ ${dropped} งาน)` : ''}`,
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
// ANALYZE (ทีม): แบ่งผลเครื่องมือเป็นชุดย่อยตามความจุของ agent แต่ละตัว ให้หลายตัวอ่านขนานกัน
//   → ตรวจหลักฐานโดยระบบ → ผู้ตรวจทานอ่านข้อค้นพบรวม → (ถ้าจำเป็น) ขอเครื่องมือเพิ่มอีกหนึ่งรอบ
// ทำทีละ "รอบ (wave)" ต่อหนึ่ง step; ความคืบหน้าอยู่ใน config.analysis จึงหยุดแล้วทำต่อได้
// ---------------------------------------------------------------------------
const NEEDS_MORE_CAP = 10

/** ตัดช่องว่าง/การเยื้องของ JSON ออก (ประหยัด token ราว 30%) — ใช้ข้อความนี้ทั้งส่งให้โมเดลและตรวจหลักฐาน */
function compactJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return text
  }
}
const CONF_RANK: Record<string, number> = { unverified: 0, low: 1, medium: 2, high: 3 }

interface PartItem extends PromptItem {
  key: string
  len: number
}

async function analyzeStep(
  admin: SupabaseClient,
  session: SessionRow,
  pool: PoolMember[],
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
        fullText: compactJson(new TextDecoder().decode(bytes)),
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

  // เริ่มรอบสรุปใหม่: ล้างผลเดิมครั้งเดียว (ถ้ารอบนี้ค้างอยู่แล้ว ทำต่อจากที่ค้าง)
  let state = session.config?.analysis
  if (!state) {
    await admin.from('analysis_findings').delete().eq('session_id', sid)
    const fixedTokens = estimateTokens(FINDINGS_SYSTEM_PROMPT) + estimateTokens(session.goal) + 600
    state = { done: [], part_chars: partCharsFor(pool, fixedTokens), needs_more: [], reviewed: false, wave: 0 }
    await saveConfig(admin, session, { analysis: state })
  }

  // หั่นผลที่ยาวเป็นหลายส่วน (ไม่เกิน MAX_PARTS_PER_RUN) ให้ agent หลายตัวอ่านคนละส่วนพร้อมกัน
  const partChars = state.part_chars || 12_000
  const doneSet = new Set(state.done)
  const remaining: PartItem[] = []
  for (const o of outputs) {
    const total = Math.max(1, Math.ceil(o.fullText.length / partChars))
    const parts = Math.min(total, Math.max(1, Math.ceil(MAX_RUN_TOTAL_CHARS / partChars))) // เพดานรวมต่อ run คุมค่า token
    for (let i = 0; i < parts; i++) {
      if (doneSet.has(`${o.runId}:${i}`)) continue
      remaining.push({
        run: o, part: i, parts, key: `${o.runId}:${i}`,
        start: i * partChars, end: Math.min((i + 1) * partChars, o.fullText.length),
        cut: i === parts - 1 && total > parts,
        len: Math.min((i + 1) * partChars, o.fullText.length) - i * partChars,
      })
    }
  }
  if (remaining.length > 0) return analyzeWave(admin, session, pool, sources, remaining, state)
  return finalizeAnalysis(admin, session, pool, sources, state)
}

/** ข้อมูลที่ใช้ตัดสินว่ายังมี artifact ที่ไม่ถูกตรวจด้วยเครื่องมือที่รองรับหรือไม่ */
async function loadCoverage(admin: SupabaseClient, sid: string, sources: ArtifactRow[]) {
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
  return { registry, tasksPairs, artifacts, uninspected }
}

async function persistFindings(admin: SupabaseClient, sid: string, processed: ProcessedFindings) {
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
}

const OUTCOME_RANK: Record<StepOutcome['state'], number> = { blocked: 0, error: 1, waiting: 2, busy: 3, continue: 4, done: 5 }

async function analyzeWave(
  admin: SupabaseClient,
  session: SessionRow,
  pool: PoolMember[],
  sources: ArtifactRow[],
  remaining: PartItem[],
  state: AnalysisState
): Promise<StepOutcome> {
  const sid = session.id
  const first = state.wave === 0
  // ส่วนคงที่ของ prompt (กติกา + เป้าหมาย + โครง) ใช้คำนวณว่าเหลือที่ให้ข้อมูลเท่าไรในแต่ละตัว
  const fixedTokens = estimateTokens(FINDINGS_SYSTEM_PROMPT) + estimateTokens(session.goal) + 600

  const shards = planWave(remaining, pool, fixedTokens)
  if (shards.length === 0) {
    return {
      state: 'error',
      message:
        `ไม่มี agent ในทีมที่รับข้อมูลผลวิเคราะห์ได้พอ (ตัวที่ใหญ่สุดรับได้ราว ${largestLimit(pool).toLocaleString('en-US')} โทเคนต่อคำขอ) — ` +
        'เพิ่ม agent ที่ใช้โมเดล context ใหญ่ (เช่น Gemini / Claude) เข้าทีมที่เมนู "ทีม AI"',
    }
  }

  const uninspected = first ? (await loadCoverage(admin, sid, sources)).uninspected : []

  const results = await Promise.all(
    shards.map(async (shard, i) => {
      const parts = shard.items.map((x) => x.item)
      const items: PromptItem[] = shard.items.map((x) => ({
        run: x.item.run, part: x.item.part, parts: x.item.parts,
        start: x.item.start, end: Math.min(x.item.end, x.item.start + x.chars),
        cut: x.item.cut || x.chars < x.item.len,
      }))
      const maxOut = outputBudgetFor(shard.member.inputLimit)
      const maxFindings = Math.min(12, Math.max(3, Math.floor(maxOut / 450)))
      const user = buildFindingsPrompt(session.goal, items, i === 0 ? uninspected : [], {
        shardNote:
          `ข้อมูลนี้เป็นชุดย่อยที่ ${i + 1}/${shards.length} ของรอบนี้ — นักวิเคราะห์ท่านอื่นในทีมอ่านผลเครื่องมือส่วนที่เหลือ ` +
          'ให้สรุปเฉพาะสิ่งที่เห็นในชุดนี้ และไม่ต้องเขียนข้อจำกัดเรื่องข้อมูลที่ไม่ได้อยู่ในชุดนี้',
      })
      const called = await callModel(
        admin,
        session,
        pool,
        { system: findingsSystemPrompt(maxFindings), user, maxTokens: maxOut },
        { prefer: 'large', first: shard.member }
      )
      return { parts, called }
    })
  )

  const ok = results.filter((r): r is typeof r & { called: Extract<ModelCall, { ok: true }> } => r.called.ok)
  const failed = results.filter((r) => !r.called.ok)

  // บันทึกทีละชุด (ผลของชุดที่สำเร็จไม่หาย แม้ชุดอื่นพลาด — ชุดที่พลาดจะถูกลองใหม่ในรอบถัดไป)
  const parts: string[] = []
  let rejected = 0
  let findingTotal = 0
  let doneNow = 0
  for (const r of ok) {
    const runs = [...new Map(r.parts.map((p) => [p.run.runId, p.run])).values()]
    const processed = processFindings(r.called.result.value, runs)
    await persistFindings(admin, sid, processed)
    state.done.push(...r.parts.map((p) => p.key))
    doneNow += r.parts.length
    if (Array.isArray(processed.needsMore)) state.needs_more.push(...processed.needsMore.slice(0, 5))
    rejected += processed.findings.reduce((n, f) => n + f.rejectedEvidence, 0)
    findingTotal += processed.findings.length
    parts.push(`${r.called.agent.name} อ่าน ${r.parts.length} ส่วน`)
  }
  state.needs_more = state.needs_more.slice(0, NEEDS_MORE_CAP)
  if (ok.length > 0) {
    state.wave += 1
    await saveConfig(admin, session, { analysis: state })
  }

  if (ok.length === 0) {
    const worst = failed
      .map((r) => (r.called.ok ? null : r.called.outcome))
      .filter((o): o is StepOutcome => o !== null)
      .sort((a, b) => OUTCOME_RANK[a.state] - OUTCOME_RANK[b.state])[0]
    return worst ?? { state: 'error', message: 'สรุปผลไม่สำเร็จ' }
  }

  const left = remaining.length - doneNow
  return {
    state: 'continue',
    message:
      `ทีมช่วยกันสรุปพร้อมกัน ${ok.length} ชุด (${parts.join(' · ')}) ได้ข้อค้นพบ ${findingTotal} รายการ` +
      (rejected ? ` (ตัดหลักฐานที่ตรวจไม่ผ่าน ${rejected})` : '') +
      (left > 0 ? ` — เหลืออีก ${left} ส่วน` : '') +
      (failed.length ? ` — ${failed.length} ชุดจะลองใหม่` : ''),
  }
}

/** ตัดข้อค้นพบ/ข้อจำกัดที่ชื่อซ้ำกัน (จากหลายชุดย่อย) เก็บตัวที่ความเชื่อมั่นสูงสุด */
async function dedupeFindings(admin: SupabaseClient, sid: string): Promise<number> {
  const { data } = await admin
    .from('analysis_findings')
    .select('id, kind, title, confidence')
    .eq('session_id', sid)
    .order('created_at', { ascending: true })
  const rows = (data ?? []) as { id: string; kind: string; title: string; confidence: string }[]
  const best = new Map<string, { id: string; rank: number }>()
  const drop: string[] = []
  for (const r of rows) {
    const key = `${r.kind}:${r.title.trim().toLowerCase().replace(/\s+/g, ' ')}`
    const rank = CONF_RANK[r.confidence] ?? 0
    const cur = best.get(key)
    if (!cur) best.set(key, { id: r.id, rank })
    else if (rank > cur.rank) {
      drop.push(cur.id)
      best.set(key, { id: r.id, rank })
    } else drop.push(r.id)
  }
  if (drop.length > 0) await admin.from('analysis_findings').delete().eq('session_id', sid).in('id', drop)
  return drop.length
}

/** ผู้ตรวจทาน: agent ตัวอื่นอ่านข้อค้นพบรวมแล้วชี้ข้อที่เกินหลักฐาน/ซ้ำ — ลด/ตัดได้อย่างเดียว ล้มเหลวแล้วข้ามได้ ไม่ขวางงาน */
async function reviewFindings(
  admin: SupabaseClient,
  session: SessionRow,
  pool: PoolMember[]
): Promise<string | null> {
  const sid = session.id
  const { data } = await admin
    .from('analysis_findings')
    .select('id, title, statement, confidence')
    .eq('session_id', sid)
    .eq('kind', 'finding')
    .order('created_at', { ascending: true })
    .limit(40)
  const rows = (data ?? []) as { id: string; title: string; statement: string; confidence: string }[]
  if (rows.length < 2) return null

  const { data: evData } = await admin
    .from('analysis_evidence')
    .select('finding_id, excerpt')
    .eq('session_id', sid)
    .in('finding_id', rows.map((r) => r.id))
  const evBy = new Map<string, string[]>()
  for (const e of (evData ?? []) as { finding_id: string; excerpt: string }[]) {
    evBy.set(e.finding_id, [...(evBy.get(e.finding_id) ?? []), e.excerpt])
  }

  const reviewer = orderPool(pool, 'reviewer')[0]
  const room = Math.min(reviewer.inputLimit, PER_CALL_TOKEN_CAP) - 2000 - estimateTokens(REVIEW_SYSTEM_PROMPT) - 600
  const maxChars = Math.min(24_000, room * 3)
  if (maxChars < 3_000) return null

  const items = rows.map((r) => ({ title: r.title, statement: r.statement, confidence: r.confidence, evidence: evBy.get(r.id) ?? [] }))
  const { user, included } = buildReviewPrompt(session.goal, items, maxChars)
  const called = await callModel(
    admin,
    session,
    pool,
    { system: REVIEW_SYSTEM_PROMPT, user, maxTokens: 2000 },
    { keepStatus: true, prefer: 'reviewer', first: reviewer }
  )
  if (!called.ok) return null

  const v = parseVerdicts(called.result.value, included)
  const dropIds = new Set<string>()
  for (const i of v.drops.keys()) dropIds.add(rows[i].id)
  for (const [, dup] of v.duplicates) dropIds.add(rows[dup].id)
  const lowerIds = [...v.downgrades.keys()]
    .filter((i) => !dropIds.has(rows[i].id) && (CONF_RANK[rows[i].confidence] ?? 0) > CONF_RANK.low)
    .map((i) => rows[i].id)

  if (dropIds.size > 0) await admin.from('analysis_findings').delete().eq('session_id', sid).in('id', [...dropIds])
  if (lowerIds.length > 0) await admin.from('analysis_findings').update({ confidence: 'low' }).eq('session_id', sid).in('id', lowerIds)
  const notes = [...v.drops.entries()].slice(0, 5).map(([i, reason]) => ({
    session_id: sid,
    kind: 'limitation',
    title: limitationTitleForDrop(rows[i].title),
    statement: reason || 'ผู้ตรวจทานเห็นว่าข้อความนี้ไม่ได้รับการรองรับจากหลักฐาน',
    confidence: 'unverified',
  }))
  if (notes.length > 0) await admin.from('analysis_findings').insert(notes)

  return `${called.agent.name} ตรวจทาน: ตัด ${dropIds.size} ลดระดับ ${lowerIds.length}`
}

async function finalizeAnalysis(
  admin: SupabaseClient,
  session: SessionRow,
  pool: PoolMember[],
  sources: ArtifactRow[],
  state: AnalysisState
): Promise<StepOutcome> {
  const sid = session.id
  await dedupeFindings(admin, sid)

  let reviewNote: string | null = null
  if (!state.reviewed) {
    try {
      reviewNote = await reviewFindings(admin, session, pool)
    } catch (e) {
      console.error('[analysis] review skipped:', (e as Error).message)
    }
    state.reviewed = true
    await saveConfig(admin, session, { analysis: state })
  }

  // รอบเสริม: อนุญาตเพิ่มงานได้เฉพาะคู่ tool+artifact ที่ยังไม่เคยรัน ภายในเพดานจำนวนงานและจำนวนรอบ
  const { registry, tasksPairs, artifacts, uninspected } = await loadCoverage(admin, sid, sources)
  const rounds = session.config?.rounds ?? 0
  const roomForTasks = remainingTaskSlots(tasksPairs.size)
  if (rounds < MAX_EXTRA_ROUNDS && roomForTasks > 0 && uninspected.length > 0 && state.needs_more.length > 0) {
    const extra = parsePlan(state.needs_more, {
      artifacts,
      tools: registry.filter((t) => t.ready),
      existingPairs: tasksPairs,
      maxTasks: roomForTasks,
    })
    if (extra.tasks.length > 0) {
      await insertTasks(admin, sid, extra.tasks)
      session.config = { ...(session.config ?? {}), rounds: rounds + 1, reanalyze: true, analysis: undefined }
      await enqueueSessionWrite(admin, session, () => ({ status: 'running', config: session.config }))
      return { state: 'continue', message: `สรุปรอบแรกแล้ว ขอตรวจเพิ่ม ${extra.tasks.length} งาน` }
    }
  }

  const [{ count: fCount }, { count: lCount }] = await Promise.all([
    admin.from('analysis_findings').select('id', { count: 'exact', head: true }).eq('session_id', sid).eq('kind', 'finding'),
    admin.from('analysis_findings').select('id', { count: 'exact', head: true }).eq('session_id', sid).eq('kind', 'limitation'),
  ])
  session.config = { ...(session.config ?? {}), reanalyze: false, analysis: undefined }
  await enqueueSessionWrite(admin, session, () => ({ status: 'completed', last_error: null, config: session.config }))
  return {
    state: 'done',
    message: `สรุปเสร็จ: ข้อค้นพบ ${fCount ?? 0} รายการ ข้อจำกัด ${lCount ?? 0} รายการ (ทีม ${pool.length} agent)${reviewNote ? ` · ${reviewNote}` : ''}`,
  }
}

function remainingTaskSlots(existingTaskCount: number): number {
  return Math.max(0, MAX_TOTAL_TASKS - existingTaskCount)
}
