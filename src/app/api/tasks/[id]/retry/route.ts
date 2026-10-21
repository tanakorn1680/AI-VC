import { requireUser } from '@/lib/supabase/auth'
import { apiOk, apiError } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { enqueueTask } from '@/lib/orchestrator/queue'
import { createAdminClient } from '@/lib/supabase/admin'
import { acquireTeam, resolveProjectTeam } from '@/lib/team/team'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: taskId } = await params
  if (!isValidUUID(taskId)) return apiError('BAD_REQUEST', 'task id ไม่ถูกต้อง')

  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  // กติกา 1 โปรเจกต์ต่อทีม: ทีมของงานนี้ต้องประจำโปรเจกต์นี้ก่อนจึงจะทำต่อได้ (ถ้าทีมไปทำที่อื่นอยู่จะตอบ 409)
  const { data: row } = await auth.supabase
    .from('tasks')
    .select('project_id, assigned_agent')
    .eq('id', taskId)
    .maybeSingle()
  const t = row as { project_id: string; assigned_agent: string | null } | null
  if (!t) return apiError('NOT_FOUND', 'ไม่พบ task นี้')
  try {
    let teamId: string | null = null
    if (t.assigned_agent) {
      const { data: agent } = await auth.supabase.from('agents').select('team_id').eq('id', t.assigned_agent).maybeSingle()
      teamId = (agent as { team_id: string } | null)?.team_id ?? null
    }
    if (!teamId) {
      const { data: project } = await auth.supabase.from('projects').select('id, team_id').eq('id', t.project_id).maybeSingle()
      teamId = (await resolveProjectTeam(auth.supabase, auth.user.id, project as { id: string; team_id: string | null })).team.id
    }
    const acquired = await acquireTeam(createAdminClient(), teamId, t.project_id)
    if (!acquired.ok) return apiError(acquired.reason === 'error' ? 'INTERNAL_ERROR' : 'CONFLICT', acquired.message)
  } catch (e) {
    return apiError('INTERNAL_ERROR', e instanceof Error ? e.message : 'โหลดทีมไม่สำเร็จ')
  }

  // trigger tasks_status_guard อนุญาตแค่ failed/cancelled → pending และรีเซ็ต attempts ให้เอง
  // RLS กรองอยู่แล้วว่าต้องเป็นเจ้าของ project ของ task นี้
  const { data, error } = await auth.supabase
    .from<{ id: string; project_id: string }>('tasks')
    .update({ status: 'pending' })
    .eq('id', taskId)
    .select('id, project_id')
    .single()
  if (error || !data) return apiError('FORBIDDEN', 'retry ไม่ได้: ' + (error?.message ?? 'ไม่พบ task'))

  await enqueueTask({ taskId: data.id, projectId: data.project_id })

  // งานที่ถูก "ยกเลิกอัตโนมัติ" เพราะงานนี้ล้ม (และที่พึ่งพาต่อเป็นทอด ๆ) ให้กลับมา pending ด้วย
  // ไม่ต้อง enqueue — มันรอ dependency อยู่ และจะถูก enqueue เองเมื่องานนี้เสร็จ (enqueueReadyTasks)
  // งานที่ผู้ใช้กดยกเลิกเอง (error ไม่ใช่ข้อความอัตโนมัติ) จะไม่ถูกแตะ
  const { data: cancelled } = await auth.supabase
    .from('tasks')
    .select('id, depends_on, error')
    .eq('project_id', data.project_id)
    .eq('status', 'cancelled')
  const candidates = ((cancelled ?? []) as Array<{ id: string; depends_on: string[]; error: string | null }>)
    .filter((t) => t.error?.startsWith('ยกเลิกอัตโนมัติ'))
  const revive = new Set<string>([data.id])
  let grew = true
  while (grew) {
    grew = false
    for (const t of candidates) {
      if (!revive.has(t.id) && t.depends_on.some((d) => revive.has(d))) {
        revive.add(t.id)
        grew = true
      }
    }
  }
  revive.delete(data.id)
  if (revive.size > 0) {
    await auth.supabase.from('tasks').update({ status: 'pending' }).in('id', [...revive])
  }

  return apiOk({ ok: true, revived: revive.size })
}
