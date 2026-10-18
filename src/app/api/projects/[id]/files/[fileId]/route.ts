import { requireUser } from '@/lib/supabase/auth'
import { apiOk, apiError, parseBody } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { normalizeFilePath } from '@/lib/files/path'

/** GET ?version=<uuid> — เนื้อหาไฟล์ (เวอร์ชันปัจจุบัน หรือเวอร์ชันที่ระบุ) + ประวัติเวอร์ชัน */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id, fileId } = await params
  if (!isValidUUID(id) || !isValidUUID(fileId)) return apiError('BAD_REQUEST', 'id ไม่ถูกต้อง')

  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { data: file } = await auth.supabase
    .from('files')
    .select('id, path, current_version_id')
    .eq('id', fileId)
    .eq('project_id', id)
    .is('deleted_at', null)
    .maybeSingle()
  const f = file as { id: string; path: string; current_version_id: string | null } | null
  if (!f) return apiError('NOT_FOUND', 'ไม่พบไฟล์')

  const requested = new URL(req.url).searchParams.get('version')
  if (requested !== null && !isValidUUID(requested)) return apiError('BAD_REQUEST', 'version ไม่ถูกต้อง')
  const versionId = requested ?? f.current_version_id

  const { data: versionRows } = await auth.supabase
    .from('file_versions')
    .select('id, created_at, created_by')
    .eq('file_id', fileId)
    .order('created_at', { ascending: false })
    .limit(50)
  const versions = (versionRows ?? []) as Array<{ id: string; created_at: string; created_by: string | null }>

  // ชื่อ agent ที่เขียนแต่ละเวอร์ชัน (null = ผู้ใช้เขียนเอง)
  const agentIds = [...new Set(versions.map((v) => v.created_by).filter((a): a is string => !!a))]
  const agentNames = new Map<string, string>()
  if (agentIds.length > 0) {
    const { data: agents } = await auth.supabase.from('agents').select('id, name').in('id', agentIds)
    for (const a of (agents ?? []) as Array<{ id: string; name: string }>) agentNames.set(a.id, a.name)
  }

  let content = ''
  if (versionId) {
    const { data: v } = await auth.supabase
      .from('file_versions')
      .select('content')
      .eq('id', versionId)
      .eq('file_id', fileId)
      .maybeSingle()
    if (!v) return apiError('NOT_FOUND', 'ไม่พบเวอร์ชันนี้')
    content = (v as { content: string }).content
  }

  return apiOk({
    file: { id: f.id, path: f.path, current_version_id: f.current_version_id },
    version_id: versionId,
    content,
    versions: versions.map((v) => ({
      id: v.id,
      created_at: v.created_at,
      author: v.created_by ? agentNames.get(v.created_by) ?? 'agent (ถูกลบแล้ว)' : 'คุณ',
    })),
  })
}

/** ลบแบบ soft delete (ประวัติเวอร์ชันยังอยู่ในฐานข้อมูล แต่ path นี้ว่างให้สร้างใหม่ได้) */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id, fileId } = await params
  if (!isValidUUID(id) || !isValidUUID(fileId)) return apiError('BAD_REQUEST', 'id ไม่ถูกต้อง')

  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { error } = await auth.supabase
    .from('files')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', fileId)
    .eq('project_id', id)
  if (error) return apiError('FORBIDDEN', 'ลบไม่ได้: ' + error.message)

  return apiOk({ ok: true })
}

/** เปลี่ยนชื่อ/path ของไฟล์ (ประวัติเวอร์ชันยังอยู่กับไฟล์เดิม) */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  const { id, fileId } = await params
  if (!isValidUUID(id) || !isValidUUID(fileId)) return apiError('BAD_REQUEST', 'id ไม่ถูกต้อง')

  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const [body, err] = await parseBody<{ path: string }>(req)
  if (err) return err
  const check = normalizeFilePath(body.path)
  if (!check.ok) return apiError('BAD_REQUEST', check.error)

  // RLS (files_all_owner) ปฏิเสธเองถ้า project ไม่ใช่ของผู้ใช้ — ไม่มีแถวที่แก้ได้ = ไม่พบ
  const { data, error } = await auth.supabase
    .from('files')
    .update({ path: check.path })
    .eq('id', fileId)
    .eq('project_id', id)
    .is('deleted_at', null)
    .select('id, path')
    .maybeSingle()
  if (error) {
    // unique index files_project_path_uniq: path นี้มีไฟล์อื่นใช้อยู่แล้ว
    if (error.code === '23505') return apiError('BAD_REQUEST', 'มีไฟล์ชื่อนี้อยู่แล้วในโฟลเดอร์เดียวกัน')
    return apiError('FORBIDDEN', 'เปลี่ยนชื่อไม่ได้: ' + error.message)
  }
  if (!data) return apiError('NOT_FOUND', 'ไม่พบไฟล์')

  return apiOk({ file: data })
}
