import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { callModel, withSessionLease, type SessionRow } from './orchestrator'
import { loadAnalystPool } from './team-pool'
import { buildReportMarkdown, loadSnapshot, supportedFindings } from './report'
import { SPEC_SYSTEM_PROMPT, buildSpecMarkdown, buildSpecPrompt, processSpec } from './spec'
import { REPORT_COLUMNS, type AnalysisReport, type ReportKind } from './types'

export type CreateReportResult =
  | { ok: true; report: AnalysisReport }
  | { ok: false; status: 400 | 404 | 409 | 500; message: string }

async function insertReport(
  sessionId: string,
  kind: ReportKind,
  build: (version: number) => { content: string; meta: Record<string, unknown> }
): Promise<CreateReportResult> {
  const admin = createAdminClient()
  const { data: last } = await admin
    .from('analysis_reports')
    .select('version')
    .eq('session_id', sessionId)
    .eq('kind', kind)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  const version = ((last as { version: number } | null)?.version ?? 0) + 1
  const { content, meta } = build(version)

  const { data, error } = await admin
    .from('analysis_reports')
    .insert({ session_id: sessionId, kind, version, status: 'final', content, meta })
    .select(REPORT_COLUMNS)
    .single()
  if (error || !data) {
    if (error?.code === '23505') return { ok: false, status: 409, message: 'มีการสร้างเอกสารพร้อมกัน กรุณาลองใหม่' }
    console.error('[analysis] insert report failed:', error?.message)
    return { ok: false, status: 500, message: 'บันทึกเอกสารไม่สำเร็จ' }
  }
  return { ok: true, report: data as unknown as AnalysisReport }
}

/**
 * สร้างรายงาน/ข้อกำหนดของงานที่วิเคราะห์เสร็จแล้ว
 * อ่านข้อมูลผ่าน client ของผู้ใช้ (RLS) แล้วเขียนผ่าน service role ซึ่งกรอง session_id ที่ตรวจสิทธิ์แล้วเสมอ
 */
export async function createReport(args: {
  supabase: SupabaseClient
  sessionId: string
  ownerId: string
  kind: ReportKind
}): Promise<CreateReportResult> {
  const { supabase, sessionId, ownerId, kind } = args

  const snap = await loadSnapshot(supabase, sessionId)
  if (!snap) return { ok: false, status: 404, message: 'ไม่พบงานวิเคราะห์นี้' }
  if (snap.session.status !== 'completed') {
    return { ok: false, status: 400, message: 'ต้องวิเคราะห์ให้เสร็จก่อนจึงจะสร้างเอกสารได้' }
  }
  const nowIso = new Date().toISOString()

  if (kind === 'report') {
    if (snap.findings.length === 0 && snap.limitations.length === 0) {
      return { ok: false, status: 400, message: 'ยังไม่มีข้อค้นพบหรือข้อจำกัดให้สรุปเป็นรายงาน' }
    }
    return insertReport(sessionId, 'report', (version) => ({
      content: buildReportMarkdown(snap, version, nowIso),
      meta: { findings: snap.findings.length, limitations: snap.limitations.length, evidence: snap.evidence.length },
    }))
  }

  // ข้อกำหนด: ใช้ได้เฉพาะข้อค้นพบที่มีหลักฐานรองรับ
  const supported = supportedFindings(snap)
  if (supported.length === 0) {
    return { ok: false, status: 400, message: 'ยังไม่มีข้อค้นพบที่มีหลักฐานเพียงพอสำหรับสร้างข้อกำหนด' }
  }

  const admin = createAdminClient()
  const { data: row } = await admin
    .from('analysis_sessions')
    .select('id, owner_id, goal, status, analyst_agent_id, token_budget, tokens_in, tokens_out, cost_usd, config')
    .eq('id', sessionId)
    .eq('owner_id', ownerId)
    .maybeSingle()
  if (!row) return { ok: false, status: 404, message: 'ไม่พบงานวิเคราะห์นี้' }
  const session = row as unknown as SessionRow

  const poolRes = await loadAnalystPool(admin, session)
  if (!poolRes.ok) return { ok: false, status: 400, message: poolRes.message }

  const leased = await withSessionLease(admin, sessionId, async (): Promise<CreateReportResult> => {
    // keepStatus: งบหมด/key ผิดไม่ทำให้งานที่เสร็จแล้วกลายเป็น failed
    const called = await callModel(
      admin,
      session,
      poolRes.members,
      { system: SPEC_SYSTEM_PROMPT, user: buildSpecPrompt(snap, supported), maxTokens: 5000 },
      { keepStatus: true, prefer: 'large' }
    )
    if (!called.ok) {
      const o = called.outcome
      return { ok: false, status: o.state === 'error' ? 500 : 400, message: o.message }
    }

    const meta = processSpec(called.result.value, supported)
    if (meta.requirements.length === 0) {
      return {
        ok: false,
        status: 400,
        message: 'AI ไม่สามารถเสนอข้อกำหนดที่อ้างหลักฐานได้ (ข้อเสนอทั้งหมดไม่ผ่านการตรวจ) ลองใหม่อีกครั้ง',
      }
    }
    return insertReport(sessionId, 'specification', (version) => ({
      content: buildSpecMarkdown(snap, meta, version, nowIso),
      meta: meta as unknown as Record<string, unknown>,
    }))
  })
  if (!leased.ok) return { ok: false, status: 409, message: 'มีงานอื่นของ session นี้กำลังทำงานอยู่ กรุณารอสักครู่' }
  return leased.value
}
