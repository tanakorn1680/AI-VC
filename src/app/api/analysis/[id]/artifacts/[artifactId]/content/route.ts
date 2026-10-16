import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/supabase/auth'
import { apiError } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { downloadObject } from '@/lib/analysis/storage'

type Ctx = { params: Promise<{ id: string; artifactId: string }> }

// เปิดอ่านเฉพาะผลลัพธ์ของเครื่องมือ (JSON ที่ระบบสร้างเอง) — ไม่ส่งไฟล์ต้นทางของผู้ใช้กลับออกไป
export async function GET(_req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id, artifactId } = await params
  if (!isValidUUID(id) || !isValidUUID(artifactId)) return apiError('NOT_FOUND', 'ไม่พบไฟล์นี้')

  const { data: artifact } = await auth.supabase
    .from('analysis_artifacts')
    .select('storage_path, kind')
    .eq('id', artifactId)
    .eq('session_id', id)
    .maybeSingle()
  if (!artifact || artifact.kind !== 'tool_output') return apiError('NOT_FOUND', 'ไม่พบไฟล์นี้')

  try {
    const bytes = await downloadObject(artifact.storage_path, 3 * 1024 * 1024)
    return new NextResponse(bytes as BodyInit, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    })
  } catch (e) {
    console.error('[analysis] read output failed:', (e as Error).message)
    return apiError('INTERNAL_ERROR', 'อ่านผลลัพธ์ไม่สำเร็จ')
  }
}
