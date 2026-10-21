import { requireUser } from '@/lib/supabase/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiOk, apiError, parseBody } from '@/lib/utils/api'
import { cleanChatText, isValidUUID } from '@/lib/utils/sanitize'
import { InvalidApiKeyError, InsufficientCreditError, RateLimitError } from '@/lib/ai/types'
import { BUDGET } from '@/lib/orchestrator/context-budget'
import { loadMemory, loadUnsummarized, resetMemory, saveBriefByUser, totalTokens } from '@/lib/orchestrator/memory'
import { refreshMemoryWithTeamLead } from '@/lib/orchestrator/memory-run'
import { resolveProjectTeam } from '@/lib/team/team'

export const maxDuration = 90

async function ownedProject(id: string) {
  const auth = await requireUser()
  if (!auth) return { error: apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน') } as const
  const { data } = await auth.supabase.from('projects').select('id, team_id').eq('id', id).maybeSingle()
  if (!data) return { error: apiError('NOT_FOUND', 'ไม่พบโปรเจกต์นี้') } as const
  return { auth, project: data as { id: string; team_id: string | null } } as const
}

/** ความจำของโปรเจกต์ + ปริมาณแชทที่ยังไม่ถูกสรุป (เทียบกับงบ) */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isValidUUID(id)) return apiError('BAD_REQUEST', 'project id ไม่ถูกต้อง')
  const r = await ownedProject(id)
  if ('error' in r) return r.error

  const admin = createAdminClient()
  const mem = await loadMemory(admin, id)
  const rows = await loadUnsummarized(admin, id, mem.summarized_through)
  return apiOk({
    brief: mem.brief,
    refresh_count: mem.refresh_count,
    last_refreshed_at: mem.last_refreshed_at,
    pending_messages: rows.length,
    pending_tokens: totalTokens(rows),
    refresh_trigger_tokens: BUDGET.refreshTriggerTokens,
    brief_max_chars: BUDGET.briefMaxChars,
  })
}

/** POST { action: 'refresh' | 'save' | 'reset', brief? } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isValidUUID(id)) return apiError('BAD_REQUEST', 'project id ไม่ถูกต้อง')
  const r = await ownedProject(id)
  if ('error' in r) return r.error

  const [body, err] = await parseBody<{ action?: unknown; brief?: unknown }>(req)
  if (err) return err
  const admin = createAdminClient()

  try {
    if (body.action === 'save') {
      const brief = cleanChatText(body.brief, BUDGET.briefMaxChars)
      await saveBriefByUser(admin, id, brief)
      return apiOk({ ok: true })
    }
    if (body.action === 'reset') {
      await resetMemory(admin, id)
      return apiOk({ ok: true })
    }
    if (body.action === 'refresh') {
      const { team } = await resolveProjectTeam(r.auth.supabase, r.auth.user.id, r.project)
      const res = await refreshMemoryWithTeamLead(admin, { projectId: id, teamId: team.id, ownerId: r.auth.user.id, force: true })
      if (res === null) return apiError('BAD_REQUEST', 'ทีมนี้ยังไม่มี AI หรือหัวหน้าทีมยังไม่มี API key — เพิ่มที่แท็บ Agents')
      return apiOk({ ok: true, refreshed: res.refreshed, folded: res.folded })
    }
    return apiError('BAD_REQUEST', 'action ต้องเป็น refresh, save หรือ reset')
  } catch (e) {
    if (e instanceof InvalidApiKeyError) return apiError('BAD_REQUEST', 'API key ของหัวหน้าทีมใช้ไม่ได้ — เปลี่ยนที่แท็บ Agents')
    if (e instanceof InsufficientCreditError) return apiError('BAD_REQUEST', 'เครดิตหรือโควตาของหัวหน้าทีมหมด')
    if (e instanceof RateLimitError) return apiError('RATE_LIMITED', 'ผู้ให้บริการจำกัดความถี่การใช้งาน รอสักครู่แล้วลองใหม่')
    return apiError('INTERNAL_ERROR', e instanceof Error ? e.message : 'ทำรายการไม่สำเร็จ')
  }
}
