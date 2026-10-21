import type { SupabaseClient } from '@supabase/supabase-js'
import { getAdapter } from '../ai/registry'
import { completeWithRetry } from '../ai/retry'
import { resolveAgentKey } from '../ai/agent-key'
import { loadTeam, pickLead } from './lead'
import { refreshProjectMemory, type RefreshResult } from './memory'

/**
 * รีเฟรชความจำโปรเจกต์ด้วยหัวหน้าทีมของทีมที่ระบุ (ใช้ key ของหัวหน้า)
 * คืน null ถ้าทำไม่ได้ (ทีมไม่มี AI / ไม่มี key) — ผู้เรียกไม่ต้องล้มตาม เพราะเป็นงานเสริม
 */
export async function refreshMemoryWithTeamLead(
  admin: SupabaseClient,
  p: { projectId: string; teamId: string; ownerId: string; force?: boolean }
): Promise<RefreshResult | null> {
  const team = await loadTeam(admin, p.teamId)
  const lead = pickLead(team)
  if (!lead) return null
  const apiKey = await resolveAgentKey(admin, lead, p.ownerId)
  if (!apiKey) return null
  const adapter = getAdapter(lead.provider)
  return refreshProjectMemory({
    admin,
    complete: (req) => completeWithRetry(adapter, req, { rateLimitWaitMaxSeconds: 20 }),
    project: { id: p.projectId },
    model: { provider: lead.provider, model: lead.model, base_url: lead.base_url },
    apiKey,
    force: p.force,
  })
}
