import { requireUser } from '@/lib/supabase/auth'
import { apiOk, apiError, parseBody, requireFields } from '@/lib/utils/api'
import { sanitizeShort } from '@/lib/utils/sanitize'
import { ensureDefaultTeam } from '@/lib/team/team'

/** ทีมทั้งหมดของผู้ใช้ + จำนวน AI + โปรเจกต์ที่ทีมกำลังประจำอยู่ (และมีงานค้างหรือไม่) */
export async function GET() {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  try {
    const teams = await ensureDefaultTeam(auth.supabase, auth.user.id)

    const activeIds = teams.map((t) => t.active_project_id).filter((x): x is string => !!x)
    const [agentsRes, projectsRes, busyRes] = await Promise.all([
      auth.supabase.from('agents').select('team_id'),
      activeIds.length
        ? auth.supabase.from('projects').select('id, name').in('id', activeIds)
        : Promise.resolve({ data: [] as unknown[] }),
      activeIds.length
        ? auth.supabase.from('tasks').select('project_id').in('project_id', activeIds).in('status', ['pending', 'running'])
        : Promise.resolve({ data: [] as unknown[] }),
    ])

    const counts = new Map<string, number>()
    for (const a of (agentsRes.data ?? []) as unknown as Array<{ team_id: string }>) counts.set(a.team_id, (counts.get(a.team_id) ?? 0) + 1)
    const names = new Map(((projectsRes.data ?? []) as Array<{ id: string; name: string }>).map((p) => [p.id, p.name]))
    const busy = new Set(((busyRes.data ?? []) as Array<{ project_id: string }>).map((t) => t.project_id))

    return apiOk({
      teams: teams.map((t) => ({
        id: t.id,
        name: t.name,
        agent_count: counts.get(t.id) ?? 0,
        active_project: t.active_project_id
          ? { id: t.active_project_id, name: names.get(t.active_project_id) ?? '-', busy: busy.has(t.active_project_id) }
          : null,
      })),
    })
  } catch (e) {
    return apiError('INTERNAL_ERROR', e instanceof Error ? e.message : 'โหลดทีมไม่สำเร็จ')
  }
}

/** สร้างทีมใหม่ (ทีมละ 1 โปรเจกต์ต่อครั้ง — มีหลายทีมเพื่อทำหลายโปรเจกต์พร้อมกัน) */
export async function POST(req: Request) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const [body, err] = await parseBody<{ name?: unknown }>(req)
  if (err) return err
  const missing = requireFields(body, ['name'])
  if (missing) return missing
  const name = sanitizeShort(body.name, 100)
  if (!name) return apiError('BAD_REQUEST', 'ชื่อทีมต้องไม่ว่าง')

  const { data, error } = await auth.supabase
    .from('teams')
    .insert({ owner_id: auth.user.id, name })
    .select('id, name')
    .single()
  if (error) {
    if (error.code === '23505') return apiError('BAD_REQUEST', `มีทีมชื่อ "${name}" แล้ว ตั้งชื่ออื่น`)
    return apiError('INTERNAL_ERROR', /relation|teams/i.test(error.message) ? 'ฐานข้อมูลยังไม่รองรับทีมกลาง — รัน supabase/migrations/0010_shared_teams.sql' : error.message)
  }
  return apiOk({ team: data }, 201)
}
