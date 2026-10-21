import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveAgentKey } from '@/lib/ai/agent-key'
import type { AnalystAgent } from './security'

/**
 * ทีมนักวิเคราะห์ของ Reverse Engineering — ใช้ "ทีม AI" กลาง (teams/agents) ทั้งทีมพร้อมกัน ไม่ต้องเลือกทีละตัว
 *
 *   - ทุก agent ในทีมที่มี API key เป็นสมาชิกของ pool
 *   - แต่ละสมาชิกมี "เพดานคำขอ" (prompt + max_tokens) — เดาจาก provider/โมเดลก่อน แล้วเรียนรู้จาก error จริงของ provider
 *     (เช่น Groq แพ็กเกจฟรี 8,000) เก็บไว้ที่ analysis_sessions.config.agent_limits
 *   - งานใหญ่ถูกแบ่งเป็นชุดย่อย (shard) ให้พอดีกับเพดานของแต่ละตัว แล้วรันขนานกัน; ตัวที่เล็กรับชุดเล็ก ตัวที่ใหญ่รับชุดใหญ่
 *   - ถ้าตัวหนึ่งชนเพดาน/โควตาเต็ม/key พัง ระบบส่งต่อให้ตัวอื่นในทีมอัตโนมัติ (ดู callModel ใน orchestrator.ts)
 */

export type PoolRole = 'manager' | 'reviewer' | 'custom'

export interface PoolMember extends AnalystAgent {
  role: PoolRole
  /** เพดานรวมของคำขอหนึ่งครั้ง (prompt + max_tokens) เป็น token โดยประมาณ */
  inputLimit: number
}

export type PoolPrefer = 'lead' | 'reviewer' | 'large'

/** เพดาน context ต่อคำขอที่ใช้จริง — ต่อให้โมเดลรับได้เป็นล้าน ก็ไม่ป้อนเกินนี้ (ยิ่งยาว คุณภาพยิ่งลด) */
export const PER_CALL_TOKEN_CAP = 60_000
export const MAX_SHARD_CHARS = 40_000
export const MAX_RUN_CHARS = 12_000
const MIN_SLICE_CHARS = 1_500
const MIN_SHARD_CHARS = 2_500
export const MAX_PARALLEL = 4
const CHARS_PER_TOKEN = 3

/**
 * เดาเพดานคำขอของ agent จาก provider/โมเดล (ตั้งแบบระมัดระวัง) — ค่าจริงจะถูกเรียนรู้จาก error ของ provider
 * Groq: แพ็กเกจฟรีจำกัดต่อคำขอราว 6,000–12,000 โทเคนและนับ max_tokens รวมด้วย จึงเริ่มที่ค่าต่ำ
 */
export function guessRequestLimit(provider: string, model: string): number {
  const m = model.toLowerCase()
  switch (provider) {
    case 'groq':
      return /\b8b\b|8b-|instant/.test(m) ? 6_000 : 8_000
    case 'google':
      return 200_000
    case 'anthropic':
      return 150_000
    case 'openai':
      if (/gpt-3\.5/.test(m)) return 12_000
      return /gpt-4o|gpt-4\.1|gpt-5|^o\d/.test(m) ? 100_000 : 40_000
    case 'xai':
      return 100_000
    case 'deepseek':
      return 60_000
    case 'mistral':
      return 28_000
    default:
      return 24_000 // openrouter / together / zai / custom — ไม่ทราบรุ่นจริง
  }
}

export function memberLimit(provider: string, model: string, id: string, learned?: Record<string, number> | null): number {
  const v = learned?.[id]
  return typeof v === 'number' && v >= 1_000 ? v : guessRequestLimit(provider, model)
}

export type PoolResult =
  | { ok: true; teamId: string; teamName: string; members: PoolMember[]; skipped: string[] }
  | { ok: false; message: string }

interface PoolSession {
  owner_id: string
  analyst_agent_id: string | null
  config: { team_id?: string | null; agent_limits?: Record<string, number> } | null
}

/**
 * ทีมที่ใช้วิเคราะห์: ที่ผู้ใช้เลือกไว้ (config.team_id) → ทีมของ agent เดิมที่เคยเลือก (งานเก่า) → ทีมแรกที่มี agent
 * ตรวจเจ้าของทีมทุกครั้ง (ใช้ service role) — key ใช้เรียก provider อย่างเดียว ไม่เขียนลง DB/log
 */
export async function loadAnalystPool(admin: SupabaseClient, session: PoolSession): Promise<PoolResult> {
  const ownerId = session.owner_id
  const { data: teamData } = await admin
    .from('teams')
    .select('id, name, owner_id, created_at')
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: true })
  const teams = (teamData ?? []) as unknown as { id: string; name: string }[]
  if (teams.length === 0) return { ok: false, message: 'ยังไม่มีทีม AI — สร้างทีมและเพิ่ม agent ที่เมนู "ทีม AI" ก่อน' }

  let teamId: string | null = session.config?.team_id ?? null
  if (teamId && !teams.some((t) => t.id === teamId)) teamId = null // ทีมถูกลบ/ไม่ใช่ของเรา → เลือกอัตโนมัติ

  if (!teamId && session.analyst_agent_id) {
    const { data: legacy } = await admin.from('agents').select('team_id').eq('id', session.analyst_agent_id).maybeSingle()
    const tid = (legacy as { team_id?: string } | null)?.team_id
    if (tid && teams.some((t) => t.id === tid)) teamId = tid
  }
  if (!teamId) {
    const { data: owned } = await admin.from('agents').select('team_id').in('team_id', teams.map((t) => t.id))
    const withAgents = new Set(((owned ?? []) as { team_id: string }[]).map((r) => r.team_id))
    teamId = teams.find((t) => withAgents.has(t.id))?.id ?? teams[0].id
  }
  const team = teams.find((t) => t.id === teamId)!

  const { data: agentData } = await admin
    .from('agents')
    .select('id, name, provider, model, base_url, max_tokens, role')
    .eq('team_id', team.id)
    .order('created_at', { ascending: true })
  const agents = (agentData ?? []) as unknown as {
    id: string; name: string; provider: string; model: string
    base_url: string | null; max_tokens: number | null; role: string
  }[]
  if (agents.length === 0) {
    return { ok: false, message: `ทีม "${team.name}" ยังไม่มี AI agent — เพิ่มที่เมนู "ทีม AI" ก่อน` }
  }

  const keys = await Promise.all(agents.map((a) => resolveAgentKey(admin, { id: a.id, provider: a.provider }, ownerId)))
  const members: PoolMember[] = []
  const skipped: string[] = []
  agents.forEach((a, i) => {
    const apiKey = keys[i]
    if (!apiKey) {
      skipped.push(a.name)
      return
    }
    members.push({
      id: a.id, name: a.name, provider: a.provider, model: a.model, base_url: a.base_url, max_tokens: a.max_tokens, apiKey,
      role: a.role === 'manager' || a.role === 'reviewer' ? a.role : 'custom',
      inputLimit: memberLimit(a.provider, a.model, a.id, session.config?.agent_limits),
    })
  })
  if (members.length === 0) {
    return { ok: false, message: `agent ในทีม "${team.name}" ยังไม่มี API key — เพิ่ม key ที่เมนู "ทีม AI" ก่อน` }
  }
  return { ok: true, teamId: team.id, teamName: team.name, members, skipped }
}

const ROLE_RANK: Record<PoolPrefer, Record<PoolRole, number>> = {
  lead: { manager: 0, custom: 1, reviewer: 2 },
  reviewer: { reviewer: 0, custom: 1, manager: 2 },
  large: { manager: 0, custom: 0, reviewer: 0 },
}

/**
 * ลำดับสมาชิกที่จะลองเรียก: ตัวที่ระบุก่อน (ถ้ามี) → ตามบทบาทที่เหมาะกับงาน → ตัวที่รับคำขอได้ใหญ่กว่าก่อน
 * (ตัวที่ใหญ่กว่าเป็นตัวสำรองเมื่อตัวแรกชนเพดาน)
 */
export function orderPool(pool: PoolMember[], prefer: PoolPrefer, first?: PoolMember): PoolMember[] {
  const sorted = [...pool].sort(
    (a, b) => ROLE_RANK[prefer][a.role] - ROLE_RANK[prefer][b.role] || b.inputLimit - a.inputLimit
  )
  return first ? [first, ...sorted.filter((m) => m.id !== first.id)] : sorted
}

/** ขนาด max_tokens ของคำตอบที่เหมาะกับสมาชิกตัวนี้ (ตัวเล็กได้เพดานคำตอบเล็ก เหลือที่ให้ข้อมูลเข้า) */
export function outputBudgetFor(limit: number): number {
  return Math.min(6_000, Math.max(1_200, Math.floor(limit * 0.4)))
}

/** จำนวนตัวอักษรของผลเครื่องมือที่สมาชิกตัวนี้รับได้ในชุดเดียว เมื่อส่วนคงที่ของ prompt = fixedTokens */
export function shardCapChars(m: PoolMember, fixedTokens: number): number {
  const room = Math.min(m.inputLimit, PER_CALL_TOKEN_CAP) - outputBudgetFor(m.inputLimit) - fixedTokens - 300
  return Math.min(MAX_SHARD_CHARS, Math.max(0, room * CHARS_PER_TOKEN))
}

export interface Shard<T> {
  member: PoolMember
  capChars: number
  items: { item: T; chars: number }[]
}

/**
 * แบ่งงานให้สมาชิกที่ใช้ได้ (สูงสุด MAX_PARALLEL ตัว ทำขนานกัน) ตามความจุของแต่ละตัว
 * งานก้อนใหญ่ไปที่ตัวที่เหลือที่มากสุดก่อน (first-fit-decreasing) — ที่ไม่พอในรอบนี้ค้างไว้รอบถัดไป
 * คืน [] เมื่อไม่มีสมาชิกคนใดรับข้อมูลได้พอ
 */
export function planWave<T extends { len: number }>(
  items: T[],
  members: PoolMember[],
  fixedTokens: number,
  maxParallel = MAX_PARALLEL
): Shard<T>[] {
  const usable = members
    .map((m) => ({ m, cap: shardCapChars(m, fixedTokens) }))
    .filter((x) => x.cap >= MIN_SHARD_CHARS)
    .sort((a, b) => b.cap - a.cap)
    .slice(0, maxParallel)
  if (usable.length === 0) return []

  const shards = usable.map((u) => ({ member: u.m, capChars: u.cap, left: u.cap, items: [] as Shard<T>['items'] }))
  const sorted = [...items].sort((a, b) => Math.min(b.len, MAX_RUN_CHARS) - Math.min(a.len, MAX_RUN_CHARS))
  for (const it of sorted) {
    const want = Math.max(1, Math.min(it.len, MAX_RUN_CHARS))
    const byLeft = (a: { left: number }, b: { left: number }) => b.left - a.left
    let target = shards.filter((s) => s.left >= want).sort(byLeft)[0]
    let chars = want
    if (!target) {
      // ไม่มีตัวไหนรับครบ: ยอมตัดท้ายถ้ายังเหลือที่พอ (ผลเต็มยังใช้ตรวจหลักฐานเสมอ)
      target = shards.filter((s) => s.left >= MIN_SLICE_CHARS).sort(byLeft)[0]
      if (!target) continue
      chars = target.left
    }
    target.items.push({ item: it, chars })
    target.left -= chars
  }
  return shards.filter((s) => s.items.length > 0).map(({ member, capChars, items: its }) => ({ member, capChars, items: its }))
}

/** ใหญ่สุดในทีม (ไว้บอกผู้ใช้ตอนไม่มีตัวไหนรับได้) */
export function largestLimit(pool: PoolMember[]): number {
  return pool.reduce((n, m) => Math.max(n, m.inputLimit), 0)
}
