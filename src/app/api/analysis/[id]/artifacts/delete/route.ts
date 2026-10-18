import { requireUser } from '@/lib/supabase/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiError, apiOk, parseBody } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { removeObject } from '@/lib/analysis/storage'

type Ctx = { params: Promise<{ id: string }> }

const MAX_BATCH = 50

/**
 * ลบ artifact (หนึ่งหรือหลายรายการ) — ลบได้เฉพาะรายการที่ไม่ทำให้ผลวิเคราะห์เสียหาย:
 *   - artifact ที่ถูกอ้างเป็นหลักฐาน (evidence) ลบไม่ได้
 *   - ไฟล์ต้นทางที่เคยถูกเครื่องมือวิเคราะห์แล้วลบไม่ได้ (ข้อค้นพบอ้างอิงผลของมันอยู่) ถ้าต้องการล้างทั้งหมดให้ลบทั้งงาน
 * ผู้ใช้เขียนตาราง artifacts เองไม่ได้ จึงตรวจสิทธิ์ผ่าน RLS ก่อนแล้วลบด้วย service role โดยกรอง session_id เสมอ
 */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  if (!isValidUUID(id)) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')

  const [body, bodyErr] = await parseBody<{ artifact_ids?: unknown }>(req)
  if (bodyErr) return bodyErr
  const ids = Array.isArray(body.artifact_ids) ? [...new Set(body.artifact_ids)] : []
  if (ids.length === 0 || ids.length > MAX_BATCH || !ids.every((x): x is string => isValidUUID(x))) {
    return apiError('BAD_REQUEST', `ระบุรายการที่จะลบ 1–${MAX_BATCH} รายการ`)
  }

  const { data: session } = await auth.supabase.from('analysis_sessions').select('id').eq('id', id).maybeSingle()
  if (!session) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')

  const { data: rows } = await auth.supabase
    .from('analysis_artifacts')
    .select('id, kind, storage_path')
    .eq('session_id', id)
    .in('id', ids)
  const found = (rows ?? []) as { id: string; kind: string; storage_path: string }[]

  const [{ data: evData }, { data: runData }] = await Promise.all([
    auth.supabase.from('analysis_evidence').select('artifact_id').eq('session_id', id).in('artifact_id', ids),
    auth.supabase.from('analysis_tool_runs').select('input').eq('session_id', id).limit(500),
  ])
  const evidenced = new Set(((evData ?? []) as { artifact_id: string | null }[]).map((e) => e.artifact_id))
  const analyzed = new Set(
    ((runData ?? []) as { input: { artifact_id?: string } | null }[]).map((r) => r.input?.artifact_id)
  )

  const skipped: { id: string; reason: string }[] = []
  const allowed: typeof found = []
  for (const requested of ids as string[]) {
    const a = found.find((f) => f.id === requested)
    if (!a) skipped.push({ id: requested, reason: 'ไม่พบรายการนี้' })
    else if (evidenced.has(a.id)) skipped.push({ id: a.id, reason: 'ถูกอ้างเป็นหลักฐานของข้อค้นพบ ลบไม่ได้' })
    else if (a.kind === 'source' && analyzed.has(a.id)) {
      skipped.push({ id: a.id, reason: 'ไฟล์นี้ถูกวิเคราะห์แล้ว ลบไม่ได้ (ลบทั้งงานเพื่อล้างทั้งหมด)' })
    } else allowed.push(a)
  }

  if (allowed.length > 0) {
    const { error } = await createAdminClient()
      .from('analysis_artifacts')
      .delete()
      .eq('session_id', id)
      .in('id', allowed.map((a) => a.id))
    if (error) {
      console.error('[analysis] delete artifacts failed:', error.message)
      return apiError('INTERNAL_ERROR', 'ลบไม่สำเร็จ (อาจมีหลักฐานเพิ่งอ้างถึงรายการนี้) กรุณาลองใหม่')
    }
    // แถวใน DB ถูกลบแล้ว: ล้างไฟล์ในที่เก็บตาม (best-effort)
    await Promise.all(allowed.map((a) => removeObject(a.storage_path).catch(() => undefined)))
  }

  return apiOk({ deleted: allowed.length, skipped })
}
