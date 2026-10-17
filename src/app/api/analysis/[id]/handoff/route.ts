import { requireUser } from '@/lib/supabase/auth'
import { apiError, apiOk, parseBody } from '@/lib/utils/api'
import { isValidUUID, sanitizeShort } from '@/lib/utils/sanitize'
import { handoffSpecification, type HandoffTarget } from '@/lib/analysis/handoff'

type Ctx = { params: Promise<{ id: string }> }

// ส่งข้อกำหนดทางเทคนิคไปโปรเจกต์ใหม่หรือโปรเจกต์เดิมของผู้ใช้ — ไม่ย้ายประวัติหรือไฟล์ทั้งชุดอัตโนมัติ
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  if (!isValidUUID(id)) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')

  const [body, bodyErr] = await parseBody<{
    report_id?: unknown; mode?: unknown; name?: unknown; project_id?: unknown; include_evidence?: unknown
  }>(req)
  if (bodyErr) return bodyErr

  if (typeof body.report_id !== 'string' || !isValidUUID(body.report_id)) {
    return apiError('BAD_REQUEST', 'รหัสข้อกำหนดไม่ถูกต้อง')
  }

  let target: HandoffTarget
  if (body.mode === 'new') {
    const name = sanitizeShort(body.name, 200)
    if (!name) return apiError('BAD_REQUEST', 'กรุณาตั้งชื่อโปรเจกต์ใหม่')
    target = { mode: 'new', name }
  } else if (body.mode === 'existing') {
    if (typeof body.project_id !== 'string' || !isValidUUID(body.project_id)) {
      return apiError('BAD_REQUEST', 'กรุณาเลือกโปรเจกต์ปลายทาง')
    }
    target = { mode: 'existing', projectId: body.project_id }
  } else {
    return apiError('BAD_REQUEST', 'รูปแบบการส่งต่อไม่ถูกต้อง')
  }

  const result = await handoffSpecification({
    supabase: auth.supabase,
    userId: auth.user.id,
    sessionId: id,
    reportId: body.report_id,
    target,
    includeEvidence: body.include_evidence === true,
  })
  if (!result.ok) {
    return apiError(result.status === 404 ? 'NOT_FOUND' : result.status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST', result.message)
  }
  return apiOk({ project_id: result.projectId, files: result.files })
}
