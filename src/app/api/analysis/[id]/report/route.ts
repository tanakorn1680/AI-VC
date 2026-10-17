import { requireUser } from '@/lib/supabase/auth'
import { apiError, apiOk, parseBody } from '@/lib/utils/api'
import { isValidEnum, isValidUUID } from '@/lib/utils/sanitize'
import { createReport } from '@/lib/analysis/report-service'
import { REPORT_KINDS } from '@/lib/analysis/types'

type Ctx = { params: Promise<{ id: string }> }

export const maxDuration = 60

// สร้างรายงาน (ประกอบจากข้อมูลจริง) หรือข้อกำหนดทางเทคนิค (AI แปลง แล้วระบบตรวจย้อนกลับ) เป็นเวอร์ชันใหม่
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  if (!isValidUUID(id)) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')

  const [body, bodyErr] = await parseBody<{ kind?: unknown }>(req)
  if (bodyErr) return bodyErr
  if (!isValidEnum(body.kind, REPORT_KINDS)) return apiError('BAD_REQUEST', 'ชนิดเอกสารไม่ถูกต้อง')

  const result = await createReport({ supabase: auth.supabase, sessionId: id, ownerId: auth.user.id, kind: body.kind })
  if (!result.ok) {
    return apiError(result.status === 404 ? 'NOT_FOUND' : result.status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', result.message)
  }
  return apiOk({ report_id: result.report.id, version: result.report.version }, 201)
}
