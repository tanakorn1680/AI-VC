import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * ทีม AI กลาง: agent เป็นของ "ทีม" ไม่ใช่ของโปรเจกต์ ใช้ได้ทุกโปรเจกต์ แต่ทีมหนึ่งประจำได้ทีละ 1 โปรเจกต์
 * (ล็อกที่ DB: teams.active_project_id + ฟังก์ชัน acquire_team/release_team — ดู migration 0010)
 */

export const TEAM_MIGRATION_HINT =
  'ฐานข้อมูลยังไม่รองรับทีมกลาง — เปิด Supabase > SQL Editor แล้วรันไฟล์ supabase/migrations/0010_shared_teams.sql หนึ่งครั้ง'

export const DEFAULT_TEAM_NAME = 'ทีมหลัก'

export interface TeamRow {
  id: string
  name: string
  active_project_id: string | null
  created_at: string
}

/** ทีมของผู้ใช้ทั้งหมด (เก่า → ใหม่) ผ่าน client ของผู้ใช้ (RLS) */
export async function listTeams(client: SupabaseClient): Promise<TeamRow[]> {
  const { data, error } = await client
    .from('teams')
    .select('id, name, active_project_id, created_at')
    .order('created_at', { ascending: true })
  if (error) {
    if (/teams|relation|schema cache/i.test(error.message)) throw new Error(TEAM_MIGRATION_HINT)
    throw new Error(error.message)
  }
  return (data ?? []) as unknown as TeamRow[]
}

/** ผู้ใช้ทุกคนมีทีมหลักตั้งแต่สมัคร (migration 0010) — ฟังก์ชันนี้กันกรณีตกหล่น (เช่นลบทีมหมดแล้ว) */
export async function ensureDefaultTeam(client: SupabaseClient, userId: string): Promise<TeamRow[]> {
  const teams = await listTeams(client)
  if (teams.length > 0) return teams
  const { error } = await client.from('teams').insert({ owner_id: userId, name: DEFAULT_TEAM_NAME })
  if (error && error.code !== '23505') throw new Error(error.message)
  return listTeams(client)
}

/**
 * ทีมที่ใช้กับโปรเจกต์นี้: ทีมที่ถือโปรเจกต์อยู่ → ทีมที่ผู้ใช้เลือกไว้ (projects.team_id) → ทีมแรกของผู้ใช้
 * preferTeamId ใช้ตอนผู้ใช้เลือกทีมเอง (ต้องเป็นของผู้ใช้เท่านั้น)
 */
export async function resolveProjectTeam(
  client: SupabaseClient,
  userId: string,
  project: { id: string; team_id?: string | null },
  preferTeamId?: string | null
): Promise<{ team: TeamRow; teams: TeamRow[] }> {
  const teams = await ensureDefaultTeam(client, userId)
  if (preferTeamId) {
    const picked = teams.find((t) => t.id === preferTeamId)
    if (!picked) throw new Error('ไม่พบทีมที่เลือก')
    return { team: picked, teams }
  }
  const team =
    teams.find((t) => t.active_project_id === project.id) ??
    teams.find((t) => t.id === project.team_id) ??
    teams[0]
  if (!team) throw new Error('ไม่พบทีม')
  return { team, teams }
}

// ---------------------------------------------------------------------------
// ล็อก 1 โปรเจกต์ต่อทีม
// ---------------------------------------------------------------------------
export type AcquireResult =
  | { ok: true; changed: boolean; previousProjectId: string | null }
  | { ok: false; reason: string; message: string }

/** เรียกด้วย admin client เท่านั้น — ผู้เรียกต้องตรวจสิทธิ์ทีม/โปรเจกต์ (ผ่าน RLS) มาก่อน */
export async function acquireTeam(admin: SupabaseClient, teamId: string, projectId: string): Promise<AcquireResult> {
  const { data, error } = await admin.rpc('acquire_team', { p_team_id: teamId, p_project_id: projectId })
  if (error) {
    const missing = /acquire_team|function|schema cache/i.test(error.message)
    return { ok: false, reason: 'error', message: missing ? TEAM_MIGRATION_HINT : error.message }
  }
  const r = (data ?? {}) as Record<string, unknown>
  if (r.ok === true) {
    return {
      ok: true,
      changed: r.changed === true,
      previousProjectId: typeof r.previous_project_id === 'string' ? r.previous_project_id : null,
    }
  }
  const reason = typeof r.reason === 'string' ? r.reason : 'error'
  if (reason === 'team_busy') {
    return {
      ok: false,
      reason,
      message: `ทีมนี้กำลังทำโปรเจกต์ "${String(r.project_name ?? '-')}" อยู่ — รอให้งานเสร็จหรือยกเลิกงานก่อน หรือเลือกทีมอื่นมาทำโปรเจกต์นี้`,
    }
  }
  if (reason === 'project_busy') {
    return {
      ok: false,
      reason,
      message: `โปรเจกต์นี้กำลังถูกทำโดยทีม "${String(r.team_name ?? '-')}" — รอให้งานเสร็จหรือยกเลิกงานก่อน`,
    }
  }
  if (reason === 'forbidden' || reason === 'no_team') return { ok: false, reason, message: 'ไม่พบทีมหรือโปรเจกต์นี้' }
  return { ok: false, reason, message: 'เข้าประจำโปรเจกต์ไม่สำเร็จ' }
}

export type ReleaseResult = { ok: true; releasedProjectId: string | null } | { ok: false; message: string }

export async function releaseTeam(admin: SupabaseClient, teamId: string): Promise<ReleaseResult> {
  const { data, error } = await admin.rpc('release_team', { p_team_id: teamId })
  if (error) return { ok: false, message: /release_team|function|schema cache/i.test(error.message) ? TEAM_MIGRATION_HINT : error.message }
  const r = (data ?? {}) as Record<string, unknown>
  if (r.ok === true) return { ok: true, releasedProjectId: typeof r.released_project_id === 'string' ? r.released_project_id : null }
  if (r.reason === 'team_busy') {
    return { ok: false, message: `ทีมยังมีงานค้างในโปรเจกต์ "${String(r.project_name ?? '-')}" — รอให้เสร็จหรือยกเลิกงานก่อน` }
  }
  return { ok: false, message: 'ไม่พบทีมนี้' }
}

// ---------------------------------------------------------------------------
// agent ของทีม (ส่งให้หน้าจอ — ไม่มี key)
// ---------------------------------------------------------------------------
export interface AgentView {
  id: string
  name: string
  provider: string
  model: string
  role: string
  duty: string
  key_last4: string | null
  key_source: 'agent' | 'shared' | 'none'
  base_url: string | null
  allowed_tools: string[]
}

export async function listTeamAgents(client: SupabaseClient, teamId: string): Promise<AgentView[]> {
  const { data, error } = await client
    .from('agents')
    .select('id, name, provider, model, role, allowed_tools, base_url, duty, key_last4')
    .eq('team_id', teamId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)

  // agent ที่สร้างก่อนระบบ key ต่อตัวใช้ key ร่วมตาม provider — บอกให้หน้าจอรู้ว่ายังมี key ใช้อยู่
  const { data: shared } = await client.from('api_credentials_safe').select('provider')
  const sharedProviders = new Set(((shared ?? []) as unknown as Array<{ provider: string }>).map((c) => c.provider))

  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((a) => ({
    id: a.id as string,
    name: a.name as string,
    provider: a.provider as string,
    model: a.model as string,
    role: a.role as string,
    duty: (a.duty as string | null) ?? '',
    key_last4: (a.key_last4 as string | null) ?? null,
    key_source: a.key_last4 ? 'agent' : sharedProviders.has(a.provider as string) ? 'shared' : 'none',
    base_url: (a.base_url as string | null) ?? null,
    allowed_tools: (a.allowed_tools as string[] | null) ?? [],
  }))
}

/** ชื่อเริ่มต้นของ agent จากชื่อโมเดล (ตัดส่วนหน้า provider/ และ :free ออก) ไม่ซ้ำกับชื่อที่มีอยู่ */
export function defaultAgentName(model: string, existing: string[]): string {
  const base = (model.split('/').pop() ?? model).replace(/:[a-z0-9_-]+$/i, '').slice(0, 90) || 'AI'
  const taken = new Set(existing.map((n) => n.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let i = 2; i < 100; i++) {
    const candidate = `${base} ${i}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base} ${Date.now() % 10000}`
}
