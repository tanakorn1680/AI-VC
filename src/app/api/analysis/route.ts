import { requireUser } from '@/lib/supabase/auth'
import { apiError, apiOk, parseBody } from '@/lib/utils/api'
import { SESSION_COLUMNS, type AnalysisSession } from '@/lib/analysis/types'
import { parseCreateSession } from '@/lib/analysis/validation'

// รายการงานวิเคราะห์ของผู้ใช้ที่ล็อกอิน — RLS กรองให้เห็นเฉพาะของตัวเอง
export async function GET() {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { data, error } = await auth.supabase
    .from('analysis_sessions')
    .select(SESSION_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) {
    console.error('[analysis] list failed:', error.message)
    return apiError('INTERNAL_ERROR', 'โหลดรายการงานวิเคราะห์ไม่สำเร็จ')
  }

  return apiOk({ sessions: (data ?? []) as unknown as AnalysisSession[] })
}

// สร้างงานวิเคราะห์ใหม่ — owner_id มาจาก session ที่ตรวจแล้ว ไม่รับจาก body
export async function POST(req: Request) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const [body, bodyErr] = await parseBody(req)
  if (bodyErr) return bodyErr

  const parsed = parseCreateSession(body)
  if (!parsed.ok) return apiError('BAD_REQUEST', parsed.message)

  const { data, error } = await auth.supabase
    .from('analysis_sessions')
    .insert({ owner_id: auth.user.id, ...parsed.value })
    .select(SESSION_COLUMNS)
    .single()
  if (error || !data) {
    console.error('[analysis] create failed:', error?.message)
    return apiError('INTERNAL_ERROR', 'สร้างงานวิเคราะห์ไม่สำเร็จ')
  }

  return apiOk({ session: data as unknown as AnalysisSession }, 201)
}
