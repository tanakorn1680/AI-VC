import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { ANALYSIS_BUCKET } from './limits'

/**
 * เข้าถึงที่เก็บ Artifact ด้วย service role — ผู้เรียกต้องตรวจเจ้าของงานผ่าน client ของผู้ใช้ (RLS) มาก่อนเสมอ
 * path ถูกสร้างฝั่ง server เท่านั้น: `<sessionId>/<objectId>` (ไม่รับชื่อไฟล์จาก browser มาเป็น path)
 */
export function buildObjectPath(sessionId: string, objectId: string): string {
  return `${sessionId}/${objectId}`
}

export async function createSignedUpload(path: string) {
  const { data, error } = await createAdminClient()
    .storage.from(ANALYSIS_BUCKET)
    .createSignedUploadUrl(path)
  if (error || !data) throw new Error(error?.message ?? 'createSignedUploadUrl failed')
  return data // { signedUrl, token, path }
}

/** ดาวน์โหลดทั้งไฟล์เข้าหน่วยความจำ — ปฏิเสธถ้าเกิน maxBytes */
export async function downloadObject(path: string, maxBytes: number): Promise<Uint8Array> {
  const { data, error } = await createAdminClient().storage.from(ANALYSIS_BUCKET).download(path)
  if (error || !data) throw new Error(error?.message ?? 'download failed')
  if (data.size > maxBytes) throw new Error(`ไฟล์ใหญ่เกินเพดาน ${maxBytes} ไบต์`)
  return new Uint8Array(await data.arrayBuffer())
}

export async function uploadObject(path: string, body: Uint8Array, contentType: string) {
  const { error } = await createAdminClient()
    .storage.from(ANALYSIS_BUCKET)
    .upload(path, body, { contentType, upsert: false })
  if (error) throw new Error(error.message)
}

export async function removeObject(path: string): Promise<void> {
  await createAdminClient().storage.from(ANALYSIS_BUCKET).remove([path])
}

/**
 * ลบไฟล์ทั้งหมดของงาน (รวมไฟล์ที่อัปโหลดแล้วแต่ยังไม่ finalize) — เรียกหลังลบงานสำเร็จ
 * ทำแบบ best-effort: ล้มเหลวไม่ทำให้การลบงานล้ม แต่คืนจำนวนที่ลบได้เพื่อบันทึก log
 */
export async function removeSessionObjects(sessionId: string): Promise<number> {
  const bucket = createAdminClient().storage.from(ANALYSIS_BUCKET)
  let removed = 0
  for (let round = 0; round < 20; round++) {
    const { data, error } = await bucket.list(sessionId, { limit: 100 })
    if (error || !data || data.length === 0) break
    const paths = data.map((o) => `${sessionId}/${o.name}`)
    const { error: rmErr } = await bucket.remove(paths)
    if (rmErr) throw new Error(rmErr.message)
    removed += paths.length
  }
  return removed
}
