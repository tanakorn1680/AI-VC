import { requireUser } from '@/lib/supabase/auth'
import { apiError, apiOk, parseBody } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { CANCELLABLE_STATUSES, SESSION_COLUMNS, type AnalysisSession } from '@/lib/analysis/types'
import { countChildren } from '@/lib/analysis/queries'
import { removeSessionObjects } from '@/lib/analysis/storage'
import { parseUpdateSession } from '@/lib/analysis/validation'
import { createAdminClient } from '@/lib/supabase/admin'

type Ctx = { params: Promise<{ id: string }> }

const NOT_FOUND_MSG = 'ไม่พบงานวิเคราะห์นี้'

export async function GET(_req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  // ไม่แยกแยะ "ไม่มีอยู่จริง" กับ "ไม่ใช่ของคุณ" เพื่อไม่ให้เดา id ได้
  if (!isValidUUID(id)) return apiError('NOT_FOUND', NOT_FOUND_MSG)

  const { data, error } = await auth.supabase
    .from('analysis_sessions')
    .select(SESSION_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  if (error) {
    console.error('[analysis] get failed:', error.message)
    return apiError('INTERNAL_ERROR', 'โหลดงานวิเคราะห์ไม่สำเร็จ')
  }
  if (!data) return apiError('NOT_FOUND', NOT_FOUND_MSG)

  const counts = await countChildren(auth.supabase, id)
  return apiOk({ session: data as unknown as AnalysisSession, counts })
}

// แก้ชื่อ/เป้าหมาย หรือยกเลิกงาน (สถานะอื่นเป็นของระบบ — DB trigger บังคับซ้ำ)
export async function PATCH(req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  if (!isValidUUID(id)) return apiError('NOT_FOUND', NOT_FOUND_MSG)

  const [body, bodyErr] = await parseBody(req)
  if (bodyErr) return bodyErr
  const parsed = parseUpdateSession(body)
  if (!parsed.ok) return apiError('BAD_REQUEST', parsed.message)
  const { title, goal, cancel, analyst_agent_id, analyst_team_id, token_budget } = parsed.value

  const { data: current, error: readErr } = await auth.supabase
    .from('analysis_sessions')
    .select('id, status')
    .eq('id', id)
    .maybeSingle()
  if (readErr) {
    console.error('[analysis] patch read failed:', readErr.message)
    return apiError('INTERNAL_ERROR', 'แก้ไขงานวิเคราะห์ไม่สำเร็จ')
  }
  if (!current) return apiError('NOT_FOUND', NOT_FOUND_MSG)

  if (cancel && !CANCELLABLE_STATUSES.includes(current.status)) {
    return apiError('BAD_REQUEST', 'งานนี้อยู่ในสถานะที่ยกเลิกไม่ได้')
  }

  // agent ต้องเป็นของผู้ใช้ (RLS ของ agents กรองให้เห็นเฉพาะ project ของตัวเอง) — server ตรวจซ้ำตอนใช้งานจริงอีกชั้น
  if (analyst_agent_id) {
    const { data: agent } = await auth.supabase.from('agents').select('id').eq('id', analyst_agent_id).maybeSingle()
    if (!agent) return apiError('BAD_REQUEST', 'ไม่พบ agent ที่เลือก')
  }

  // ทีมที่ใช้วิเคราะห์: ต้องเป็นทีมของผู้ใช้ (RLS) แล้วเก็บใน config (คอลัมน์ที่ผู้ใช้เขียนตรงไม่ได้ จึงเขียนผ่านฝั่งเซิร์ฟเวอร์)
  if (analyst_team_id !== undefined) {
    if (analyst_team_id) {
      const { data: team } = await auth.supabase.from('teams').select('id').eq('id', analyst_team_id).maybeSingle()
      if (!team) return apiError('BAD_REQUEST', 'ไม่พบทีมที่เลือก')
    }
    const admin = createAdminClient()
    const { data: row } = await admin
      .from('analysis_sessions')
      .select('config')
      .eq('id', id)
      .eq('owner_id', auth.user.id)
      .maybeSingle()
    if (!row) return apiError('NOT_FOUND', NOT_FOUND_MSG)
    const config = { ...((row as { config?: Record<string, unknown> | null }).config ?? {}), team_id: analyst_team_id }
    const { error: cfgErr } = await admin.from('analysis_sessions').update({ config }).eq('id', id).eq('owner_id', auth.user.id)
    if (cfgErr) {
      console.error('[analysis] patch team failed:', cfgErr.message)
      return apiError('INTERNAL_ERROR', 'บันทึกทีมไม่สำเร็จ')
    }
    // เปลี่ยนทีมแล้วเพดานที่เรียนรู้ของ agent เดิมไม่เกี่ยวข้อง แต่เก็บไว้ได้ (ผูกกับ agent id)
  }

  const patch: Record<string, string | number | null> = {}
  if (title !== undefined) patch.title = title
  if (goal !== undefined) patch.goal = goal
  if (analyst_agent_id !== undefined) patch.analyst_agent_id = analyst_agent_id
  if (token_budget !== undefined) patch.token_budget = token_budget
  if (cancel) patch.status = 'cancelled'

  if (Object.keys(patch).length === 0) {
    const { data: unchanged } = await auth.supabase.from('analysis_sessions').select(SESSION_COLUMNS).eq('id', id).maybeSingle()
    if (!unchanged) return apiError('NOT_FOUND', NOT_FOUND_MSG)
    return apiOk({ session: unchanged as unknown as AnalysisSession })
  }

  let query = auth.supabase.from('analysis_sessions').update(patch).eq('id', id)
  // กันแข่งกับระบบ: ยกเลิกได้เฉพาะถ้ายังอยู่ในสถานะที่ยกเลิกได้ ณ ตอนเขียนจริง
  if (cancel) query = query.in('status', [...CANCELLABLE_STATUSES])

  const { data, error } = await query.select(SESSION_COLUMNS).maybeSingle()
  if (error) {
    console.error('[analysis] patch failed:', error.message)
    return apiError('INTERNAL_ERROR', 'แก้ไขงานวิเคราะห์ไม่สำเร็จ')
  }
  if (!data) return apiError('BAD_REQUEST', 'สถานะงานเปลี่ยนไปแล้ว กรุณาโหลดใหม่')

  return apiOk({ session: data as unknown as AnalysisSession })
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  if (!isValidUUID(id)) return apiError('NOT_FOUND', NOT_FOUND_MSG)

  const { data, error } = await auth.supabase
    .from('analysis_sessions')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) {
    console.error('[analysis] delete failed:', error.message)
    return apiError('INTERNAL_ERROR', 'ลบงานวิเคราะห์ไม่สำเร็จ')
  }
  if (!data || data.length === 0) return apiError('NOT_FOUND', NOT_FOUND_MSG)

  // แถวใน DB ถูกลบ (cascade) แล้ว: ล้างไฟล์ในที่เก็บตาม ล้มเหลวไม่ทำให้การลบงานล้ม
  try {
    await removeSessionObjects(id)
  } catch (e) {
    console.error('[analysis] remove session objects failed:', (e as Error).message)
  }

  return apiOk({ deleted: true })
}
