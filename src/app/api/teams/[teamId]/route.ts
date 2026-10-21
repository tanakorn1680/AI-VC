import { requireUser } from '@/lib/supabase/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiOk, apiError, parseBody } from '@/lib/utils/api'
import { isValidUUID, sanitizeShort } from '@/lib/utils/sanitize'
import { releaseTeam } from '@/lib/team/team'

type Ctx = { params: Promise<{ teamId: string }> }

/** เปลี่ยนชื่อทีม */
export async function PATCH(req: Request, { params }: Ctx) {
  const { teamId } = await params
  if (!isValidUUID(teamId)) return apiError('BAD_REQUEST', 'team id ไม่ถูกต้อง')
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const [body, err] = await parseBody<{ name?: unknown }>(req)
  if (err) return err
  const name = sanitizeShort(body.name, 100)
  if (!name) return apiError('BAD_REQUEST', 'ชื่อทีมต้องไม่ว่าง')

  const { data, error } = await auth.supabase.from('teams').update({ name }).eq('id', teamId).select('id').maybeSingle()
  if (error) {
    if (error.code === '23505') return apiError('BAD_REQUEST', `มีทีมชื่อ "${name}" แล้ว ตั้งชื่ออื่น`)
    return apiError('FORBIDDEN', 'แก้ไม่ได้: ' + error.message)
  }
  if (!data) return apiError('NOT_FOUND', 'ไม่พบทีมนี้')
  return apiOk({ ok: true })
}

/** ลบทีม — AI ทั้งหมดในทีมและ API key ของมันถูกลบด้วย; ลบไม่ได้ถ้าทีมยังมีงานค้างอยู่ */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { teamId } = await params
  if (!isValidUUID(teamId)) return apiError('BAD_REQUEST', 'team id ไม่ถูกต้อง')
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { data: found } = await auth.supabase.from('teams').select('id').eq('id', teamId).maybeSingle()
  if (!found) return apiError('NOT_FOUND', 'ไม่พบทีมนี้')

  const released = await releaseTeam(createAdminClient(), teamId)
  if (!released.ok) return apiError('CONFLICT', released.message)

  const { error } = await auth.supabase.from('teams').delete().eq('id', teamId)
  if (error) return apiError('FORBIDDEN', 'ลบไม่ได้: ' + error.message)
  return apiOk({ ok: true })
}
