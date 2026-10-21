import { requireUser } from '@/lib/supabase/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiOk, apiError, parseBody } from '@/lib/utils/api'
import { isValidUUID, sanitizeShort } from '@/lib/utils/sanitize'

type Ctx = { params: Promise<{ teamId: string; agentId: string }> }

/** ลบ AI ออกจากทีม — key ใน Vault ถูกลบตามอัตโนมัติ (trigger ใน 0004) ถ้าลบหัวหน้าทีม ตัวที่อยู่มานานสุดจะรับตำแหน่งต่อ */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { teamId, agentId } = await params
  if (!isValidUUID(teamId) || !isValidUUID(agentId)) return apiError('BAD_REQUEST', 'id ไม่ถูกต้อง')

  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  // RLS: ลบได้เฉพาะ agent ในทีมของตัวเอง — task ที่ผูกอยู่จะถูก set null (ดู schema)
  const { error } = await auth.supabase.from('agents').delete().eq('id', agentId).eq('team_id', teamId)
  if (error) return apiError('FORBIDDEN', 'ลบไม่ได้: ' + error.message)

  const { data: rest } = await auth.supabase
    .from('agents')
    .select('id, role')
    .eq('team_id', teamId)
    .order('created_at', { ascending: true })
  const left = (rest ?? []) as unknown as Array<{ id: string; role: string }>
  if (left.length > 0 && !left.some((a) => a.role === 'manager')) {
    await auth.supabase.from('agents').update({ role: 'manager' }).eq('id', left[0]!.id).eq('team_id', teamId)
  }
  return apiOk({ ok: true })
}

/**
 * แก้ AI ตัวหนึ่ง — ส่งเฉพาะช่องที่ต้องการเปลี่ยน
 * { name?, duty?, model?, api_key? (เปลี่ยน key), make_lead? (ตั้งเป็นหัวหน้าทีม), can_write_files?, kind? ('worker'|'reviewer') }
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const { teamId, agentId } = await params
  if (!isValidUUID(teamId) || !isValidUUID(agentId)) return apiError('BAD_REQUEST', 'id ไม่ถูกต้อง')

  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const [body, err] = await parseBody<{
    name?: unknown; duty?: unknown; model?: unknown; api_key?: unknown; make_lead?: unknown; can_write_files?: unknown; kind?: unknown
  }>(req)
  if (err) return err

  // ยืนยันว่า agent นี้อยู่ในทีมของผู้ใช้ (ผ่าน RLS) ก่อนทำอะไรต่อ
  const { data: found } = await auth.supabase.from('agents').select('id, role').eq('id', agentId).eq('team_id', teamId).maybeSingle()
  if (!found) return apiError('NOT_FOUND', 'ไม่พบ AI ตัวนี้')
  const currentRole = (found as { role: string }).role

  const update: Record<string, unknown> = {}
  if (body.name !== undefined) {
    const name = sanitizeShort(body.name, 100)
    if (!name) return apiError('BAD_REQUEST', 'ชื่อต้องไม่ว่าง')
    update.name = name
  }
  if (body.duty !== undefined) update.duty = sanitizeShort(body.duty, 300)
  if (body.model !== undefined) {
    const model = sanitizeShort(body.model, 100)
    if (!model) return apiError('BAD_REQUEST', 'โมเดลต้องไม่ว่าง')
    update.model = model
  }
  if (body.can_write_files !== undefined) {
    if (typeof body.can_write_files !== 'boolean') return apiError('BAD_REQUEST', 'can_write_files ต้องเป็น true หรือ false')
    update.allowed_tools = body.can_write_files ? ['read_file', 'write_file'] : ['read_file']
  }
  if (body.kind !== undefined) {
    if (body.kind !== 'worker' && body.kind !== 'reviewer') return apiError('BAD_REQUEST', 'kind ต้องเป็น worker หรือ reviewer')
    if (currentRole === 'manager') return apiError('BAD_REQUEST', 'หัวหน้าทีมเป็นผู้ประสานงาน เปลี่ยนเป็นผู้ตรวจไม่ได้ — ตั้งคนอื่นเป็นหัวหน้าก่อน')
    update.role = body.kind === 'reviewer' ? 'reviewer' : 'custom'
  }

  let newKey: string | null = null
  if (body.api_key !== undefined) {
    newKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    if (newKey.length < 8 || newKey.length > 500) return apiError('BAD_REQUEST', 'API key ความยาวไม่สมเหตุสมผล')
  }
  if (Object.keys(update).length === 0 && newKey === null && body.make_lead !== true) {
    return apiError('BAD_REQUEST', 'ไม่มีอะไรให้แก้')
  }

  if (Object.keys(update).length > 0) {
    const { error } = await auth.supabase.from('agents').update(update).eq('id', agentId).eq('team_id', teamId)
    if (error) {
      if (error.code === '23505') return apiError('BAD_REQUEST', 'มี AI ชื่อนี้ในทีมแล้ว ตั้งชื่ออื่น')
      return apiError('FORBIDDEN', 'แก้ไม่ได้: ' + error.message)
    }
  }

  if (body.make_lead === true) {
    // หัวหน้าทีมมีได้คนเดียว: ปลดคนเดิมก่อน แล้วตั้งคนใหม่
    await auth.supabase.from('agents').update({ role: 'custom' }).eq('team_id', teamId).eq('role', 'manager')
    const { error } = await auth.supabase.from('agents').update({ role: 'manager' }).eq('id', agentId).eq('team_id', teamId)
    if (error) return apiError('FORBIDDEN', 'ตั้งหัวหน้าทีมไม่ได้: ' + error.message)
  }

  if (newKey !== null) {
    const { error } = await createAdminClient().rpc('set_agent_key', { p_agent_id: agentId, p_key: newKey })
    if (error) return apiError('INTERNAL_ERROR', `เก็บ API key ไม่สำเร็จ: ${error.message}`)
  }

  return apiOk({ ok: true })
}
