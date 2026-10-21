import { requireUser } from '@/lib/supabase/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiOk, apiError, parseBody } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { startPlan, dismissPlan } from '@/lib/orchestrator/lead'
import { acquireTeam, resolveProjectTeam } from '@/lib/team/team'

export const maxDuration = 60

/** POST { action: 'start' | 'dismiss' } — ผู้ใช้ตัดสินใจกับแผนที่หัวหน้าทีมเสนอในแชท */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; messageId: string }> }) {
  const { id, messageId } = await params
  if (!isValidUUID(id) || !isValidUUID(messageId)) return apiError('BAD_REQUEST', 'id ไม่ถูกต้อง')

  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const [body, err] = await parseBody<{ action?: unknown }>(req)
  if (err) return err
  if (body.action !== 'start' && body.action !== 'dismiss') return apiError('BAD_REQUEST', 'action ต้องเป็น start หรือ dismiss')

  // ยืนยันว่าเป็นข้อความใน project ของผู้ใช้ (ผ่าน RLS) ก่อนใช้สิทธิ์ผู้ดูแลระบบ
  const { data: msg } = await auth.supabase.from('messages').select('id').eq('id', messageId).eq('project_id', id).maybeSingle()
  if (!msg) return apiError('NOT_FOUND', 'ไม่พบแผนนี้')

  const admin = createAdminClient()
  if (body.action === 'dismiss') {
    const ok = await dismissPlan(admin, id, messageId)
    return ok ? apiOk({ ok: true }) : apiError('BAD_REQUEST', 'แผนนี้ไม่ได้รอการยืนยันแล้ว')
  }

  const { data: project } = await auth.supabase.from('projects').select('budget_usd, spent_usd, team_id').eq('id', id).maybeSingle()
  const p = project as { budget_usd: number | null; spent_usd: number; team_id: string | null } | null
  if (p && p.budget_usd !== null && Number(p.spent_usd) >= Number(p.budget_usd)) {
    return apiError('BUDGET_EXCEEDED', 'ใช้งบของโปรเจกต์นี้ครบแล้ว — เพิ่มงบก่อนจึงจะเริ่มงานได้')
  }

  // กติกา 1 โปรเจกต์ต่อทีม: ทีมต้องประจำโปรเจกต์นี้ก่อนเริ่มงาน
  let teamId: string
  try {
    teamId = (await resolveProjectTeam(auth.supabase, auth.user.id, { id, team_id: p?.team_id ?? null })).team.id
  } catch (e) {
    return apiError('INTERNAL_ERROR', e instanceof Error ? e.message : 'โหลดทีมไม่สำเร็จ')
  }
  const acquired = await acquireTeam(admin, teamId, id)
  if (!acquired.ok) return apiError(acquired.reason === 'error' ? 'INTERNAL_ERROR' : 'CONFLICT', acquired.message)

  const r = await startPlan(admin, id, messageId, teamId)
  return r.ok ? apiOk({ ok: true, tasks: r.taskCount }) : apiError('BAD_REQUEST', r.error)
}
