import { requireUser } from '@/lib/supabase/auth'
import { apiError, apiOk, parseBody } from '@/lib/utils/api'
import { isValidUUID, sanitizeShort } from '@/lib/utils/sanitize'
import { MAX_ARTIFACTS_PER_SESSION, MAX_ARTIFACT_BYTES } from '@/lib/analysis/limits'
import { buildObjectPath, createSignedUpload } from '@/lib/analysis/storage'

type Ctx = { params: Promise<{ id: string }> }

// ขั้นที่ 1 ของการนำเข้าไฟล์: ตรวจสิทธิ์/ขนาด แล้วออก signed upload URL ให้ browser อัปโหลดตรงเข้าที่เก็บ
// (ไม่ส่งไฟล์ผ่าน Vercel เพราะ request body จำกัดแค่ ~4.5 MB)
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  if (!isValidUUID(id)) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')

  const [body, bodyErr] = await parseBody<{ name?: unknown; size?: unknown }>(req)
  if (bodyErr) return bodyErr

  const name = sanitizeShort(body.name, 300)
  if (!name) return apiError('BAD_REQUEST', 'ชื่อไฟล์ไม่ถูกต้อง')
  const size = body.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1) {
    return apiError('BAD_REQUEST', 'ขนาดไฟล์ไม่ถูกต้อง')
  }
  if (size > MAX_ARTIFACT_BYTES) {
    return apiError('BAD_REQUEST', `ไฟล์ใหญ่เกิน ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB`)
  }

  // ตรวจเจ้าของผ่าน RLS: ไม่ใช่เจ้าของจะไม่เห็นแถว
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

  const objectId = crypto.randomUUID()
  try {
    const signed = await createSignedUpload(buildObjectPath(id, objectId))
    return apiOk({ object_id: objectId, path: signed.path, token: signed.token })
  } catch (e) {
    console.error('[analysis] signed upload failed:', (e as Error).message)
    return apiError('INTERNAL_ERROR', 'เตรียมการอัปโหลดไม่สำเร็จ (ตรวจว่ารัน migration 0006 แล้ว)')
  }
}
