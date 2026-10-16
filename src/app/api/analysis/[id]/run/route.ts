import { requireUser } from '@/lib/supabase/auth'
import { apiError, apiOk } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { advanceSession } from '@/lib/analysis/orchestrator'

type Ctx = { params: Promise<{ id: string }> }

// วิเคราะห์ต่อ "หนึ่ง step" (วางแผน / รันเครื่องมือหนึ่งงาน / สรุปผล) แล้วคืนสถานะให้ผู้เรียกเรียกซ้ำ
// สถานะอยู่ใน DB ทั้งหมด จึงปิดหน้าแล้วกลับมาทำต่อได้
export const maxDuration = 60

export async function POST(_req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  if (!isValidUUID(id)) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')

  // ตรวจเจ้าของผ่าน RLS ก่อนเข้า orchestrator (ซึ่งใช้ service role และกรอง owner_id ซ้ำ)
  const { data: session } = await auth.supabase.from('analysis_sessions').select('id').eq('id', id).maybeSingle()
  if (!session) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')

  return apiOk(await advanceSession(id, auth.user.id))
}
