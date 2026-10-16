import { requireUser } from '@/lib/supabase/auth'
import { apiError, apiOk } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { getRegistry } from '@/lib/analysis/tool-registry'

type Ctx = { params: Promise<{ id: string }> }

// เครื่องมือที่พร้อมใช้งานจริง ณ ตอนนี้ (ผลจาก probe ไม่ใช่รายชื่อที่ประกาศไว้ล่วงหน้า)
export async function GET(_req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  if (!isValidUUID(id)) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')
  const { data } = await auth.supabase.from('analysis_sessions').select('id').eq('id', id).maybeSingle()
  if (!data) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')

  return apiOk({ tools: await getRegistry() })
}
