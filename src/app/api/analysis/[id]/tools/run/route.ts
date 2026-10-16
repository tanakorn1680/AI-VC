import { requireUser } from '@/lib/supabase/auth'
import { apiError, apiOk, parseBody } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { runTool } from '@/lib/analysis/tool-runner'

type Ctx = { params: Promise<{ id: string }> }

export const maxDuration = 30

export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { id } = await params
  if (!isValidUUID(id)) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')

  const [body, bodyErr] = await parseBody<{ tool_id?: unknown; artifact_id?: unknown }>(req)
  if (bodyErr) return bodyErr
  if (typeof body.tool_id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(body.tool_id)) {
    return apiError('BAD_REQUEST', 'รหัสเครื่องมือไม่ถูกต้อง')
  }
  if (typeof body.artifact_id !== 'string' || !isValidUUID(body.artifact_id)) {
    return apiError('BAD_REQUEST', 'รหัสไฟล์ไม่ถูกต้อง')
  }

  // ตรวจเจ้าของงานและเจ้าของไฟล์ผ่าน RLS (client ของผู้ใช้) ก่อนใช้ service role ใน runner
  const { data: session } = await auth.supabase
    .from('analysis_sessions')
    .select('id, status')
    .eq('id', id)
    .maybeSingle()
  if (!session) return apiError('NOT_FOUND', 'ไม่พบงานวิเคราะห์นี้')
  if (session.status === 'cancelled') return apiError('BAD_REQUEST', 'งานที่ยกเลิกแล้วรันเครื่องมือไม่ได้')

  const { data: artifact } = await auth.supabase
    .from('analysis_artifacts')
    .select('id, kind, name, sha256, metadata, size_bytes, storage_path')
    .eq('id', body.artifact_id)
    .eq('session_id', id)
    .maybeSingle()
  if (!artifact) return apiError('NOT_FOUND', 'ไม่พบไฟล์นี้ในงานวิเคราะห์')

  const outcome = await runTool({
    sessionId: id,
    artifact: artifact as Parameters<typeof runTool>[0]['artifact'],
    toolId: body.tool_id,
  })
  if (!outcome.ok) {
    const code = outcome.status === 404 ? 'NOT_FOUND' : outcome.status === 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'
    return apiError(code, outcome.message)
  }
  return apiOk({ run_id: outcome.runId, summary: outcome.summary, output_artifact_id: outcome.outputArtifactId })
}
