import { after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/supabase/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiOk, apiError, parseBody } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { acquireTeam, listTeamAgents, resolveProjectTeam, type TeamRow } from '@/lib/team/team'
import { refreshMemoryWithTeamLead } from '@/lib/orchestrator/memory-run'

export const maxDuration = 60

type Lock =
  | { state: 'held' }
  | { state: 'free' }
  /** ทีมนี้กำลังประจำโปรเจกต์อื่นอยู่ */
  | { state: 'elsewhere'; project_id: string; project_name: string; busy: boolean }

async function projectInfo(
  supabase: SupabaseClient,
  ids: string[]
): Promise<{ names: Map<string, string>; busy: Set<string> }> {
  if (ids.length === 0) return { names: new Map(), busy: new Set() }
  const [{ data: projects }, { data: tasks }] = await Promise.all([
    supabase.from('projects').select('id, name').in('id', ids),
    supabase.from('tasks').select('project_id').in('project_id', ids).in('status', ['pending', 'running']),
  ])
  return {
    names: new Map(((projects ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name])),
    busy: new Set(((tasks ?? []) as Array<{ project_id: string }>).map((t) => t.project_id)),
  }
}

function lockFor(team: TeamRow, projectId: string, info: { names: Map<string, string>; busy: Set<string> }): Lock {
  if (team.active_project_id === projectId) return { state: 'held' }
  if (!team.active_project_id) return { state: 'free' }
  return {
    state: 'elsewhere',
    project_id: team.active_project_id,
    project_name: info.names.get(team.active_project_id) ?? '-',
    busy: info.busy.has(team.active_project_id),
  }
}

/** ทีมของโปรเจกต์นี้ + AI ในทีม + สถานะล็อก (1 โปรเจกต์ต่อทีม) */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isValidUUID(id)) return apiError('BAD_REQUEST', 'project id ไม่ถูกต้อง')
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { data: project } = await auth.supabase.from('projects').select('id, team_id').eq('id', id).maybeSingle()
  if (!project) return apiError('NOT_FOUND', 'ไม่พบโปรเจกต์นี้')

  try {
    const { team, teams } = await resolveProjectTeam(auth.supabase, auth.user.id, project as { id: string; team_id: string | null })
    const activeIds = [...new Set(teams.map((t) => t.active_project_id).filter((x): x is string => !!x))]
    const [agents, info] = await Promise.all([listTeamAgents(auth.supabase, team.id), projectInfo(auth.supabase, activeIds)])

    // ทีมอื่นที่ถือโปรเจกต์นี้อยู่ (กรณีผู้ใช้เลือกทีมอื่นไว้ก่อน)
    const holder = teams.find((t) => t.active_project_id === id && t.id !== team.id)
    return apiOk({
      team: { id: team.id, name: team.name },
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        active_project_id: t.active_project_id,
        active_project_name: t.active_project_id ? (info.names.get(t.active_project_id) ?? '-') : null,
        busy: t.active_project_id ? info.busy.has(t.active_project_id) : false,
      })),
      agents,
      lock: lockFor(team, id, info),
      held_by_other: holder ? { id: holder.id, name: holder.name } : null,
    })
  } catch (e) {
    return apiError('INTERNAL_ERROR', e instanceof Error ? e.message : 'โหลดทีมไม่สำเร็จ')
  }
}

/**
 * ให้ทีมเข้าประจำโปรเจกต์นี้ (ปุ่ม "ให้ทีมมาทำโปรเจกต์นี้" / เปลี่ยนทีม)
 * body: { team_id? } — ไม่ส่ง = ทีมที่ใช้อยู่ของโปรเจกต์
 * ทีมกำลังทำงานค้างในโปรเจกต์อื่นอยู่ → 409 (ต้องรอหรือยกเลิกงานก่อน)
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isValidUUID(id)) return apiError('BAD_REQUEST', 'project id ไม่ถูกต้อง')
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const [body, err] = await parseBody<{ team_id?: unknown }>(req)
  if (err) return err
  const preferred = body.team_id === undefined || body.team_id === null ? null : body.team_id
  if (preferred !== null && !isValidUUID(preferred)) return apiError('BAD_REQUEST', 'team_id ไม่ถูกต้อง')

  const { data: project } = await auth.supabase.from('projects').select('id, team_id').eq('id', id).maybeSingle()
  if (!project) return apiError('NOT_FOUND', 'ไม่พบโปรเจกต์นี้')

  try {
    const { team } = await resolveProjectTeam(auth.supabase, auth.user.id, project as { id: string; team_id: string | null }, preferred)
    const admin = createAdminClient()
    const r = await acquireTeam(admin, team.id, id)
    if (!r.ok) return apiError(r.reason === 'error' ? 'INTERNAL_ERROR' : 'CONFLICT', r.message)

    // ย้ายทีมมาจากโปรเจกต์อื่น: สรุปความจำของโปรเจกต์เดิมให้กระชับก่อนทีมจากไป (ทำหลังตอบ ไม่ทำให้ผู้ใช้รอ)
    if (r.changed && r.previousProjectId) {
      const prev = r.previousProjectId
      after(async () => {
        try {
          await refreshMemoryWithTeamLead(admin, { projectId: prev, teamId: team.id, ownerId: auth.user.id, force: true })
        } catch (e) {
          console.error('[team] สรุปความจำโปรเจกต์เดิมไม่สำเร็จ:', e instanceof Error ? e.message : e)
        }
      })
    }
    return apiOk({ ok: true, team: { id: team.id, name: team.name }, changed: r.changed })
  } catch (e) {
    return apiError('INTERNAL_ERROR', e instanceof Error ? e.message : 'เปลี่ยนทีมไม่สำเร็จ')
  }
}
