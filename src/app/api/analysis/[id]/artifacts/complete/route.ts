import { createHash } from 'node:crypto'
import { requireUser } from '@/lib/supabase/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiError, apiOk, parseBody } from '@/lib/utils/api'
import { isValidUUID, sanitizeShort } from '@/lib/utils/sanitize'
import { MAX_ARTIFACTS_PER_SESSION, MAX_ARTIFACT_BYTES } from '@/lib/analysis/limits'
import { buildObjectPath, downloadObject, removeObject } from '@/lib/analysis/storage'
import { identifyBytes } from '@/lib/analysis/tools/file-identify'
import { ARTIFACT_COLUMNS, type AnalysisArtifact } from '@/lib/analysis/types'

type Ctx = { params: Promise<{ id: string }> }

export const maxDuration = 30

// ขั้นที่ 2: server อ่านไฟล์ที่อัปโหลดจริง คำนวณ hash และตรวจชนิดจาก magic bytes เอง
// (ไม่เชื่อชนิด/ขนาดที่ browser แจ้ง) แล้วจึงลงทะเบียนเป็น artifact
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  if (!isValidUUID(id)) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')

  const [body, bodyErr] = await parseBody<{ object_id?: unknown; name?: unknown }>(req)
  if (bodyErr) return bodyErr
  if (typeof body.object_id !== 'string' || !isValidUUID(body.object_id)) {
    return apiError('BAD_REQUEST', 'รหัสไฟล์ไม่ถูกต้อง')
  }
  const name = sanitizeShort(body.name, 300)
  if (!name) return apiError('BAD_REQUEST', 'ชื่อไฟล์ไม่ถูกต้อง')

  const { data: session } = await auth.supabase
    .from('analysis_sessions')
    .select('id, status')
    .eq('id', id)
    .maybeSingle()
  if (!session) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')
  if (session.status === 'cancelled') return apiError('BAD_REQUEST', 'งานที่ยกเลิกแล้วเพิ่มไฟล์ไม่ได้')

  const { count } = await auth.supabase
    .from('analysis_artifacts')
    .select('id', { count: 'exact', head: true })
    .eq('session_id', id)
  if ((count ?? 0) >= MAX_ARTIFACTS_PER_SESSION) {
    return apiError('BAD_REQUEST', `งานนี้มีไฟล์ครบ ${MAX_ARTIFACTS_PER_SESSION} รายการแล้ว`)
  }

  // path สร้างจาก id งานที่ตรวจสิทธิ์แล้ว + object_id เท่านั้น จึงชี้ไปไฟล์ของงานอื่นไม่ได้
  const path = buildObjectPath(id, body.object_id)

  let bytes: Uint8Array
  try {
    bytes = await downloadObject(path, MAX_ARTIFACT_BYTES)
  } catch {
    await removeObject(path).catch(() => undefined) // ถ้าเกินเพดานให้ล้างไฟล์ทิ้งด้วย
    return apiError('BAD_REQUEST', 'ไม่พบไฟล์ที่อัปโหลด หรือไฟล์ใหญ่เกินเพดาน')
  }
  if (bytes.length === 0) {
    await removeObject(path).catch(() => undefined)
    return apiError('BAD_REQUEST', 'ไฟล์ว่างเปล่า')
  }

  const ident = identifyBytes(bytes)
  const { data, error } = await createAdminClient()
    .from('analysis_artifacts')
    .insert({
      session_id: id,
      kind: 'source',
      name,
      storage_path: path,
      size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      metadata: { detected_kind: ident.kind, detected_label: ident.label },
    })
    .select(ARTIFACT_COLUMNS)
    .single()
  if (error || !data) {
    if (error?.code === '23505') return apiError('BAD_REQUEST', 'ไฟล์นี้ลงทะเบียนไปแล้ว')
    console.error('[analysis] register artifact failed:', error?.message)
    await removeObject(path).catch(() => undefined)
    return apiError('INTERNAL_ERROR', 'บันทึกไฟล์ไม่สำเร็จ')
  }

  return apiOk({ artifact: data as unknown as AnalysisArtifact }, 201)
}
