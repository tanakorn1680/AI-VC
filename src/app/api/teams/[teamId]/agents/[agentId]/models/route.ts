import { requireUser } from '@/lib/supabase/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiOk, apiError } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'
import { resolveAgentKey } from '@/lib/ai/agent-key'
import { listModels, ListModelsError } from '@/lib/ai/list-models'

/** รายชื่อโมเดลที่ key ของ agent ตัวนี้ใช้ได้ — ใช้ตอนเปลี่ยนโมเดล (key ไม่ถูกส่งกลับไปที่ browser) */
export async function GET(_req: Request, { params }: { params: Promise<{ teamId: string; agentId: string }> }) {
  const { teamId, agentId } = await params
  if (!isValidUUID(teamId) || !isValidUUID(agentId)) return apiError('BAD_REQUEST', 'id ไม่ถูกต้อง')

  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const { data } = await auth.supabase
    .from('agents')
    .select('id, provider, base_url')
    .eq('id', agentId)
    .eq('team_id', teamId)
    .maybeSingle()
  const agent = data as { id: string; provider: string; base_url: string | null } | null
  if (!agent) return apiError('NOT_FOUND', 'ไม่พบ AI ตัวนี้')

  const apiKey = await resolveAgentKey(createAdminClient(), agent, auth.user.id)
  if (!apiKey) return apiError('BAD_REQUEST', 'AI ตัวนี้ยังไม่มี API key')

  try {
    const { models, source } = await listModels(agent.provider, apiKey, agent.base_url)
    return apiOk({ models, source })
  } catch (e) {
    if (e instanceof ListModelsError) return apiError(e.kind === 'upstream' ? 'INTERNAL_ERROR' : 'BAD_REQUEST', e.message)
    return apiError('INTERNAL_ERROR', 'ดึงรายชื่อรุ่นไม่สำเร็จ')
  }
}
