import { requireUser } from '@/lib/supabase/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiOk, apiError } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { releaseTeam } from '@/lib/team/team'

/** พักทีม: ปล่อยโปรเจกต์ที่ทีมประจำอยู่ (ทำได้เมื่อไม่มีงานค้าง) เพื่อให้ทีมอื่นหรือโปรเจกต์อื่นใช้ต่อ */
export async function POST(_req: Request, { params }: { params: Promise<{ teamId: string }> }) {
  const { teamId } = await params
  if (!isValidUUID(teamId)) return apiError('BAD_REQUEST', 'team id ไม่ถูกต้อง')
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  // ยืนยันว่าเป็นทีมของผู้ใช้ (ผ่าน RLS) ก่อนใช้สิทธิ์ผู้ดูแลระบบ
  const { data: found } = await auth.supabase.from('teams').select('id').eq('id', teamId).maybeSingle()
  if (!found) return apiError('NOT_FOUND', 'ไม่พบทีมนี้')

  const r = await releaseTeam(createAdminClient(), teamId)
  return r.ok ? apiOk({ ok: true }) : apiError('CONFLICT', r.message)
}
