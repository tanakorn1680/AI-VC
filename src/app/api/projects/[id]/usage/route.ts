import { requireUser } from '@/lib/supabase/auth'
import { apiOk, apiError } from '@/lib/utils/api'
import { isValidUUID } from '@/lib/utils/sanitize'

interface UsageRow {
  provider: string
  model: string
  tokens_in: number
  tokens_out: number
  created_at: string
  // many-to-one embed: supabase-js คืนเป็น object เดียว (หรือ null ถ้า task ถูกลบ/ไม่มี task)
  tasks: { assigned_agent: string | null } | null
}

const PAGE = 1000
const MAX_PAGES = 20 // เพดาน 20,000 แถวต่อครั้ง กัน request หนักเกินไป

/** สรุปการใช้ token ของ project: ยอดรวม + แยกตาม AI (agent) — ไม่คิดเงิน */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isValidUUID(id)) return apiError('BAD_REQUEST', 'project id ไม่ถูกต้อง')

  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  // ดึงทุกแถว (แบ่งหน้า) เพื่อให้ยอดรวมครบ ไม่ใช่แค่ 200 แถวล่าสุด
  const rows: UsageRow[] = []
  let truncated = false
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await auth.supabase
      .from('usage')
      .select('provider, model, tokens_in, tokens_out, created_at, tasks(assigned_agent)')
      .eq('project_id', id)
      .order('created_at', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE - 1)
    if (error) return apiError('INTERNAL_ERROR', error.message)
    const batch = (data ?? []) as unknown as UsageRow[]
    rows.push(...batch)
    if (batch.length < PAGE) break
    if (page === MAX_PAGES - 1) truncated = true
  }

  const { data: agentRows } = await auth.supabase
    .from('agents')
    .select('id, name, provider, model')
  const agents = (agentRows ?? []) as Array<{ id: string; name: string; provider: string; model: string }>
  const agentById = new Map(agents.map((a) => [a.id, a]))

  interface Group {
    key: string
    name: string
    provider: string
    model: string
    requests: number
    tokens_in: number
    tokens_out: number
  }
  const groups = new Map<string, Group>()
  const total = { requests: 0, tokens_in: 0, tokens_out: 0, tokens: 0 }

  for (const r of rows) {
    const agentId = r.tasks?.assigned_agent ?? null
    const agent = agentId ? agentById.get(agentId) : undefined
    // แถวที่ไม่มี task = การวางแผนของ Manager; มี task แต่ agent ถูกลบแล้ว = แยกกลุ่มต่างหาก
    const key = r.tasks ? (agent ? `agent:${agent.id}` : 'agent:deleted') : `planning:${r.provider}/${r.model}`
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        name: r.tasks ? (agent ? agent.name : 'agent ที่ถูกลบแล้ว') : 'วางแผนงาน (Manager)',
        provider: agent?.provider ?? r.provider,
        model: agent?.model ?? r.model,
        requests: 0,
        tokens_in: 0,
        tokens_out: 0,
      }
      groups.set(key, g)
    }
    g.requests += 1
    g.tokens_in += r.tokens_in
    g.tokens_out += r.tokens_out
    total.requests += 1
    total.tokens_in += r.tokens_in
    total.tokens_out += r.tokens_out
  }
  total.tokens = total.tokens_in + total.tokens_out

  const byAgent = [...groups.values()]
    .map((g) => ({ ...g, tokens: g.tokens_in + g.tokens_out }))
    .sort((a, b) => b.tokens - a.tokens)

  const recent = rows.slice(0, 20).map((r) => ({
    provider: r.provider,
    model: r.model,
    tokens_in: r.tokens_in,
    tokens_out: r.tokens_out,
    created_at: r.created_at,
  }))

  return apiOk({ total, by_agent: byAgent, recent, truncated })
}
