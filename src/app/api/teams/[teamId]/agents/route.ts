import { requireUser } from '@/lib/supabase/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { apiOk, apiError, parseBody, requireFields } from '@/lib/utils/api'
import { sanitizeShort, isValidEnum, isValidUUID } from '@/lib/utils/sanitize'
import { PROVIDER_IDS, getProviderMeta, validateBaseUrl } from '@/lib/ai/providers'
import { defaultAgentName, listTeamAgents } from '@/lib/team/team'

const MIGRATION_HINT = 'ฐานข้อมูลยังไม่รองรับทีมกลาง — เปิด Supabase > SQL Editor แล้วรันไฟล์ supabase/migrations/0010_shared_teams.sql หนึ่งครั้ง'

type Ctx = { params: Promise<{ teamId: string }> }

/** AI ทั้งหมดของทีม (ใช้ร่วมกันทุกโปรเจกต์) */
export async function GET(_req: Request, { params }: Ctx) {
  const { teamId } = await params
  if (!isValidUUID(teamId)) return apiError('BAD_REQUEST', 'team id ไม่ถูกต้อง')
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  try {
    return apiOk({ agents: await listTeamAgents(auth.supabase, teamId) })
  } catch (e) {
    return apiError('INTERNAL_ERROR', e instanceof Error ? e.message : 'โหลด AI ไม่สำเร็จ')
  }
}

export async function POST(req: Request, { params }: Ctx) {
  const { teamId } = await params
  if (!isValidUUID(teamId)) return apiError('BAD_REQUEST', 'team id ไม่ถูกต้อง')
  const auth = await requireUser()
  if (!auth) return apiError('UNAUTHORIZED', 'ต้องล็อกอินก่อน')

  const [body, err] = await parseBody<{
    api_key: string; provider: string; model: string
    base_url?: string; name?: string; duty?: string
    can_write_files?: boolean
    /** worker = ผู้ทำงาน (ค่าเริ่มต้น), reviewer = ผู้ตรวจงานของคนอื่น (ตัวแรกของทีมเป็นหัวหน้าเสมอ) */
    kind?: string
    /** ราคาต่อ 1 ล้าน token (USD) — ไม่บังคับ ใช้คำนวณค่าใช้จ่าย/คุมงบ */
    price_in?: number; price_out?: number
  }>(req)
  if (err) return err
  const missing = requireFields(body, ['api_key', 'provider', 'model'])
  if (missing) return missing
  if (!isValidEnum(body.provider, PROVIDER_IDS)) return apiError('BAD_REQUEST', 'ผู้ให้บริการไม่ถูกต้อง')

  const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
  if (apiKey.length < 8 || apiKey.length > 500) return apiError('BAD_REQUEST', 'API key ความยาวไม่สมเหตุสมผล')
  const model = sanitizeShort(body.model, 100)
  if (!model) return apiError('BAD_REQUEST', 'ต้องเลือกโมเดล')

  let baseUrl: string | null = null
  if (getProviderMeta(body.provider)?.customBaseUrl) {
    const check = validateBaseUrl(body.base_url)
    if (!check.ok) return apiError('BAD_REQUEST', check.error)
    baseUrl = check.url
  }

  const hasPrice = (body.price_in !== undefined && body.price_in !== null) || (body.price_out !== undefined && body.price_out !== null)
  let priceIn = 0
  let priceOut = 0
  if (hasPrice) {
    priceIn = Number(body.price_in)
    priceOut = Number(body.price_out)
    if (![priceIn, priceOut].every((p) => Number.isFinite(p) && p >= 0 && p <= 100000)) {
      return apiError('BAD_REQUEST', 'ราคาต้องเป็นตัวเลข 0–100000 (USD ต่อ 1 ล้าน token) และต้องกรอกทั้งขาเข้าและขาออก')
    }
  }

  // ยืนยันว่าเป็นทีมของผู้ใช้ (RLS) แล้วดูชื่อที่มีอยู่ — agent ตัวแรกของทีมเป็นหัวหน้า (ผู้ประสานงาน) ตัวต่อ ๆ ไปเป็นสมาชิก
  const { data: team } = await auth.supabase.from('teams').select('id').eq('id', teamId).maybeSingle()
  if (!team) return apiError('NOT_FOUND', 'ไม่พบทีมนี้')
  const { data: existing, error: listError } = await auth.supabase.from('agents').select('name').eq('team_id', teamId)
  if (listError) return apiError('INTERNAL_ERROR', listError.message)
  const names = ((existing ?? []) as Array<{ name: string }>).map((a) => a.name)

  const requestedName = sanitizeShort(body.name, 100)
  const name = requestedName || defaultAgentName(model, names)
  const role = names.length === 0 ? 'manager' : body.kind === 'reviewer' ? 'reviewer' : 'custom'

  const { data: created, error } = await auth.supabase
    .from('agents')
    .insert({
      team_id: teamId,
      name,
      provider: body.provider,
      model,
      role,
      duty: sanitizeShort(body.duty, 300),
      system_prompt: '',
      base_url: baseUrl,
      allowed_tools: body.can_write_files === false ? ['read_file'] : ['read_file', 'write_file'],
    })
    .select('id')
    .single()
  if (error) {
    if (error.code === '23505') {
      return apiError('BAD_REQUEST', /one_lead/.test(error.message) ? 'ทีมนี้มีหัวหน้าอยู่แล้ว ลองใหม่อีกครั้ง' : `มี AI ชื่อ "${name}" ในทีมนี้แล้ว ตั้งชื่ออื่น`)
    }
    if (/team_id|teams/i.test(error.message)) return apiError('INTERNAL_ERROR', MIGRATION_HINT)
    return apiError('FORBIDDEN', error.message)
  }
  const agentId = (created as { id: string }).id

  // เก็บ key ของ agent ตัวนี้เข้า Vault — ถ้าเก็บไม่ได้ ไม่ทิ้ง agent ที่ไม่มี key ค้างไว้
  const admin = createAdminClient()
  const { error: keyError } = await admin.rpc('set_agent_key', { p_agent_id: agentId, p_key: apiKey })
  if (keyError) {
    await auth.supabase.from('agents').delete().eq('id', agentId)
    const missingFn = /set_agent_key|function|schema cache/i.test(keyError.message)
    return apiError('INTERNAL_ERROR', missingFn ? MIGRATION_HINT : `เก็บ API key ไม่สำเร็จ: ${keyError.message}`)
  }

  // ราคา: เพิ่มเฉพาะรุ่นที่ยังไม่มีราคา ไม่เขียนทับ (ตารางนี้ใช้ร่วมกันทุก project)
  let priceSaved = false
  if (hasPrice) {
    const { error: priceError } = await admin
      .from('model_prices')
      .upsert(
        { provider: body.provider, model, in_per_mtok: priceIn, out_per_mtok: priceOut },
        { onConflict: 'provider,model', ignoreDuplicates: true }
      )
    priceSaved = !priceError
  }

  return apiOk({ agent: { id: agentId, name, role }, price_saved: priceSaved }, 201)
}
