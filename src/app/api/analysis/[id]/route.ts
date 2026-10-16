import { requireUser } from '@/lib/supabase/auth'
import { apiError, apiOk, parseBody } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { CANCELLABLE_STATUSES, SESSION_COLUMNS, type AnalysisSession } from '@/lib/analysis/types'
import { countChildren } from '@/lib/analysis/queries'
import { parseUpdateSession } from '@/lib/analysis/validation'

type Ctx = { params: Promise<{ id: string }> }

const NOT_FOUND_MSG = 'ไม่พบงานวิเคราะห์นี้'

export async function GET(_req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  // ไม่แยกแยะ "ไม่มีอยู่จริง" กับ "ไม่ใช่ของคุณ" เพื่อไม่ให้เดา id ได้
  if (!isValidUUID(id)) return apiError('NOT_FOUND', NOT_FOUND_MSG)

  const { data, error } = await auth.supabase
    .from('analysis_sessions')
    .select(SESSION_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  if (error) {
    console.error('[analysis] get failed:', error.message)
    return apiError('INTERNAL_ERROR', 'โหลดงานวิเคราะห์ไม่สำเร็จ')
  }
  if (!data) return apiError('NOT_FOUND', NOT_FOUND_MSG)

  const counts = await countChildren(auth.supabase, id)
  return apiOk({ session: data as unknown as AnalysisSession, counts })
}

// แก้ชื่อ/เป้าหมาย หรือยกเลิกงาน (สถานะอื่นเป็นของระบบ — DB trigger บังคับซ้ำ)
export async function PATCH(req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  if (!isValidUUID(id)) return apiError('NOT_FOUND', NOT_FOUND_MSG)

  const [body, bodyErr] = await parseBody(req)
  if (bodyErr) return bodyErr
  const parsed = parseUpdateSession(body)
  if (!parsed.ok) return apiError('BAD_REQUEST', parsed.message)
  const { title, goal, cancel } = parsed.value

  const { data: current, error: readErr } = await auth.supabase
    .from('analysis_sessions')
    .select('id, status')
    .eq('id', id)
    .maybeSingle()
  if (readErr) {
    console.error('[analysis] patch read failed:', readErr.message)
    return apiError('INTERNAL_ERROR', 'แก้ไขงานวิเคราะห์ไม่สำเร็จ')
  }
  if (!current) return apiError('NOT_FOUND', NOT_FOUND_MSG)

  if (cancel && !CANCELLABLE_STATUSES.includes(current.status)) {
    return apiError('BAD_REQUEST', 'งานนี้อยู่ในสถานะที่ยกเลิกไม่ได้')
  }

  const patch: Record<string, string> = {}
  if (title !== undefined) patch.title = title
  if (goal !== undefined) patch.goal = goal
  if (cancel) patch.status = 'cancelled'

  let query = auth.supabase.from('analysis_sessions').update(patch).eq('id', id)
  // กันแข่งกับระบบ: ยกเลิกได้เฉพาะถ้ายังอยู่ในสถานะที่ยกเลิกได้ ณ ตอนเขียนจริง
  if (cancel) query = query.in('status', [...CANCELLABLE_STATUSES])

  const { data, error } = await query.select(SESSION_COLUMNS).maybeSingle()
  if (error) {
    console.error('[analysis] patch failed:', error.message)
    return apiError('INTERNAL_ERROR', 'แก้ไขงานวิเคราะห์ไม่สำเร็จ')
  }
  if (!data) return apiError('BAD_REQUEST', 'สถานะงานเปลี่ยนไปแล้ว กรุณาโหลดใหม่')

  return apiOk({ session: data as unknown as AnalysisSession })
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  if (!isValidUUID(id)) return apiError('NOT_FOUND', NOT_FOUND_MSG)

  const { data, error } = await auth.supabase
    .from('analysis_sessions')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) {
    console.error('[analysis] delete failed:', error.message)
    return apiError('INTERNAL_ERROR', 'ลบงานวิเคราะห์ไม่สำเร็จ')
  }
  if (!data || data.length === 0) return apiError('NOT_FOUND', NOT_FOUND_MSG)

  return apiOk({ deleted: true })
}
