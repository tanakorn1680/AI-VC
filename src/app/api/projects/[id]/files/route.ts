import { requireUser } from '@/lib/supabase/auth'
import { apiOk, apiError, parseBody } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { normalizeFilePath, MAX_FILE_CHARS } from '@/lib/files/path'
import { saveFileVersion } from '@/lib/files/save'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isValidUUID(id)) return apiError('BAD_REQUEST', 'project id ไม่ถูกต้อง')

  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  // RLS กรองให้เองว่าเป็นเจ้าของ project หรือไม่
  const { data: files, error } = await auth.supabase
    .from('files')
    .select('id, path, current_version_id, created_at')
    .eq('project_id', id)
    .is('deleted_at', null)
    .order('path', { ascending: true })
  if (error) return apiError('INTERNAL_ERROR', error.message)

  const rows = (files ?? []) as Array<{ id: string; path: string; current_version_id: string | null; created_at: string }>
  const versionIds = rows.map((f) => f.current_version_id).filter((v): v is string => !!v)

  // เวลาอัปเดตล่าสุดและขนาด = ของเวอร์ชันปัจจุบัน
  const updatedAt = new Map<string, string>()
  const sizeOf = new Map<string, number>()
  if (versionIds.length > 0) {
    type VersionRow = { id: string; created_at: string; size_bytes?: number | null }
    let versions: VersionRow[] | null = null
    const withSize = await auth.supabase.from('file_versions').select('id, created_at, size_bytes').in('id', versionIds)
    if (withSize.error) {
      // ยังไม่ได้รัน migration 0009 (ไม่มีคอลัมน์ size_bytes): ใช้แบบเดิม ไม่แสดงขนาด
      const basic = await auth.supabase.from('file_versions').select('id, created_at').in('id', versionIds)
      versions = (basic.data ?? []) as VersionRow[]
    } else {
      versions = (withSize.data ?? []) as VersionRow[]
    }
    for (const v of versions) {
      updatedAt.set(v.id, v.created_at)
      if (typeof v.size_bytes === 'number') sizeOf.set(v.id, v.size_bytes)
    }
  }

  return apiOk({
    files: rows.map((f) => ({
      id: f.id,
      path: f.path,
      updated_at: (f.current_version_id && updatedAt.get(f.current_version_id)) || f.created_at,
      size_bytes: (f.current_version_id && sizeOf.get(f.current_version_id)) ?? null,
    })),
  })
}

/** สร้างไฟล์ใหม่ หรือบันทึกเป็นเวอร์ชันใหม่ถ้า path นี้มีอยู่แล้ว */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isValidUUID(id)) return apiError('BAD_REQUEST', 'project id ไม่ถูกต้อง')

  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const [body, err] = await parseBody<{ path: string; content: string }>(req)
  if (err) return err

  const check = normalizeFilePath(body.path)
  if (!check.ok) return apiError('BAD_REQUEST', check.error)
  if (typeof body.content !== 'string') return apiError('BAD_REQUEST', 'content ต้องเป็นข้อความ')
  if (body.content.length > MAX_FILE_CHARS) {
    return apiError('BAD_REQUEST', `ไฟล์ใหญ่เกิน ${MAX_FILE_CHARS} ตัวอักษร`)
  }

  // ใช้ client ของผู้ใช้ — RLS ปฏิเสธเองถ้า project ไม่ใช่ของผู้ใช้
  const result = await saveFileVersion(auth.supabase, {
    projectId: id,
    path: check.path,
    content: body.content,
  })
  if (!result.ok) return apiError('FORBIDDEN', result.error)

  return apiOk({ file: { id: result.fileId }, version_id: result.versionId, created: result.created }, 201)
}
