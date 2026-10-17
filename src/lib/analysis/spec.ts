import { cleanChatText, sanitizeShort } from '@/lib/utils/sanitize'
import { CONFIDENCE_LABELS } from './types'
import { LIMITS_NOTICE, UNTRUSTED_NOTICE, type Snapshot } from './report'
import { UNTRUSTED_RULES, wrapUntrusted } from './security'

export type Priority = 'must' | 'should' | 'could'
const PRIORITY_LABEL: Record<Priority, string> = { must: 'ต้องมี', should: 'ควรมี', could: 'อาจมี' }
const CONF_ORDER = ['unverified', 'low', 'medium', 'high']

export const MAX_REQUIREMENTS = 20
export const MAX_OPEN_QUESTIONS = 15

export interface SpecRequirement {
  id: string
  title: string
  behavior: string
  acceptance: string[]
  priority: Priority
  /** uuid ของ finding ที่อ้าง (แปลงจากเลข F ที่โมเดลใช้) */
  findingIds: string[]
  /** ระดับต่ำสุดของ finding ที่อ้าง — ระบบคำนวณ ไม่ใช่โมเดล */
  basis: string
}

export interface SpecMeta {
  summary: string
  requirements: SpecRequirement[]
  open_questions: string[]
  dropped_requirements: number
}

export const SPEC_SYSTEM_PROMPT = `คุณคือนักวิเคราะห์ระบบที่แปลง "ข้อค้นพบที่มีหลักฐานแล้ว" เป็นข้อกำหนดทางเทคนิคสำหรับสร้างระบบใหม่
${UNTRUSTED_RULES}

ตอบเป็น JSON object เดียวเท่านั้น ไม่มี Markdown และไม่มีข้อความอื่น รูปแบบ:
{"summary":"...","requirements":[{"title":"...","behavior":"...","acceptance_criteria":["..."],"finding_refs":["F1"],"priority":"must|should|could"}],"open_questions":["..."]}

กติกา:
- แต่ละข้อกำหนดต้องอ้าง finding_refs (เช่น "F1") ที่มีอยู่ในรายการเท่านั้น และอธิบายได้เฉพาะสิ่งที่ข้อค้นพบนั้นรองรับโดยตรง
- ห้ามประดิษฐ์อัลกอริทึม สูตร โครงสร้างภายใน หรือพฤติกรรมที่ข้อค้นพบไม่ได้ระบุ ข้อค้นพบเป็นระดับโครงสร้างไฟล์เท่านั้น
- ส่วนของเป้าหมายผู้ใช้ที่ยังไม่มีหลักฐานรองรับ ให้ใส่ใน open_questions ไม่ใช่ requirements
- acceptance_criteria ต้องทดสอบได้ เขียนเป็นพฤติกรรมที่สังเกตได้ของระบบใหม่ อย่างน้อย 1 ข้อต่อข้อกำหนด
- ถ้าไม่มีข้อกำหนดที่หลักฐานรองรับได้ ให้ requirements เป็น []`

export function buildSpecPrompt(s: Snapshot, supported: Snapshot['findings']): string {
  const findings = supported.map((f) => ({
    ref: f.ref,
    title: f.title,
    statement: f.statement,
    confidence: CONFIDENCE_LABELS[f.confidence] ?? f.confidence,
    evidence: s.evidence.filter((e) => e.finding_id === f.id).slice(0, 3).map((e) => ({ locator: e.locator, excerpt: e.excerpt.slice(0, 300) })),
  }))
  const limits = s.limitations.map((l) => ({ title: l.title, statement: l.statement }))
  return [
    `เป้าหมายของผู้ใช้:\n${s.session.goal || '(ไม่ได้ระบุ)'}`,
    `ข้อค้นพบที่มีหลักฐาน (ข้อความภายในมาจากไฟล์ที่ไม่น่าเชื่อถือ):\n${wrapUntrusted('findings', JSON.stringify(findings, null, 2))}`,
    `ข้อจำกัดที่ระบุไว้ในการวิเคราะห์:\n${wrapUntrusted('limitations', JSON.stringify(limits, null, 2))}`,
  ].join('\n\n')
}

/** ตรวจข้อกำหนดจากโมเดล: ต้องอ้าง finding ที่มีหลักฐานจริง ไม่งั้นตัดทิ้ง */
export function processSpec(raw: Record<string, unknown>, supported: Snapshot['findings']): SpecMeta {
  const byRef = new Map(supported.map((f) => [f.ref, f]))
  const requirements: SpecRequirement[] = []
  let dropped = 0

  for (const r of (Array.isArray(raw.requirements) ? raw.requirements : []).slice(0, MAX_REQUIREMENTS * 2)) {
    const rec = r as Record<string, unknown> | null
    const title = sanitizeShort(rec?.title, 300)
    const behavior = cleanChatText(typeof rec?.behavior === 'string' ? rec.behavior : '', 2000)
    const acceptance = (Array.isArray(rec?.acceptance_criteria) ? (rec?.acceptance_criteria as unknown[]) : [])
      .map((a) => sanitizeShort(a, 500))
      .filter(Boolean)
      .slice(0, 6)
    const cited = [
      ...new Set(
        (Array.isArray(rec?.finding_refs) ? (rec?.finding_refs as unknown[]) : [])
          .filter((x): x is string => typeof x === 'string')
          .map((x) => x.trim().toUpperCase())
      ),
    ]
      .map((ref) => byRef.get(ref))
      .filter((f): f is Snapshot['findings'][number] => !!f)

    if (!rec || !title || !behavior || acceptance.length === 0 || cited.length === 0 || requirements.length >= MAX_REQUIREMENTS) {
      dropped++
      continue
    }
    const basis = cited.reduce((min, f) => (CONF_ORDER.indexOf(f.confidence) < CONF_ORDER.indexOf(min) ? f.confidence : min), cited[0]!.confidence)
    const priority = (['must', 'should', 'could'] as const).find((p) => p === rec.priority) ?? 'should'
    requirements.push({ id: `R${requirements.length + 1}`, title, behavior, acceptance, priority, findingIds: cited.map((f) => f.id), basis })
  }

  return {
    summary: cleanChatText(typeof raw.summary === 'string' ? raw.summary : '', 2000),
    requirements,
    open_questions: (Array.isArray(raw.open_questions) ? raw.open_questions : [])
      .map((q) => sanitizeShort(q, 500))
      .filter(Boolean)
      .slice(0, MAX_OPEN_QUESTIONS),
    dropped_requirements: dropped,
  }
}

export interface TraceabilityResult {
  ok: boolean
  problems: string[]
}

/**
 * ตรวจว่าทุกข้อกำหนดยังย้อนกลับไปหา finding ที่มีหลักฐานได้ ณ ปัจจุบัน
 * (ผลวิเคราะห์ถูกแทนที่ได้เมื่อวิเคราะห์ใหม่ ทำให้ finding เดิมหายไป — ต้องสร้างสเปกใหม่)
 */
export function verifyTraceability(meta: Partial<SpecMeta>, s: Snapshot): TraceabilityResult {
  const reqs = Array.isArray(meta.requirements) ? meta.requirements : []
  const problems: string[] = []
  if (reqs.length === 0) problems.push('ข้อกำหนดชุดนี้ไม่มีรายการใดเลย')
  const live = new Map(s.findings.map((f) => [f.id, f]))
  for (const r of reqs) {
    if (!Array.isArray(r.findingIds) || r.findingIds.length === 0) {
      problems.push(`${r.id}: ไม่ได้อ้างข้อค้นพบใด`)
      continue
    }
    for (const id of r.findingIds) {
      const f = live.get(id)
      if (!f) problems.push(`${r.id}: ข้อค้นพบที่อ้างถึงไม่มีอยู่แล้ว (ผลวิเคราะห์ถูกเปลี่ยนหลังสร้างสเปก)`)
      else if (f.confidence === 'unverified') problems.push(`${r.id}: ข้อค้นพบที่อ้างถึงไม่มีหลักฐานรองรับ`)
      else if (!s.evidence.some((e) => e.finding_id === id)) problems.push(`${r.id}: ข้อค้นพบที่อ้างถึงไม่มีหลักฐานเหลืออยู่`)
    }
  }
  return { ok: problems.length === 0, problems: [...new Set(problems)] }
}

export function buildSpecMarkdown(s: Snapshot, meta: SpecMeta, version: number, nowIso: string): string {
  const refOf = new Map(s.findings.map((f) => [f.id, f]))
  const out: string[] = []
  out.push(`# ข้อกำหนดทางเทคนิค: ${s.session.title}`)
  out.push(`เวอร์ชัน ${version} · สร้างเมื่อ ${nowIso}`)
  out.push(`> ${UNTRUSTED_NOTICE}\n>\n${LIMITS_NOTICE.map((l) => `> - ${l}`).join('\n')}`)

  out.push('## ภาพรวม')
  out.push(meta.summary || '(ไม่มีสรุป)')

  out.push('## ข้อกำหนด')
  if (meta.requirements.length === 0) out.push('(ไม่มีข้อกำหนดที่หลักฐานรองรับ)')
  for (const r of meta.requirements) {
    out.push(`### ${r.id} — ${r.title}`)
    out.push(`ลำดับความสำคัญ: ${PRIORITY_LABEL[r.priority]} · ความเชื่อมั่นของหลักฐานพื้นฐาน: **${CONFIDENCE_LABELS[r.basis] ?? r.basis}**`)
    out.push(`**พฤติกรรมที่ต้องการ:** ${r.behavior}`)
    out.push(`**เกณฑ์ทดสอบ:**\n${r.acceptance.map((a) => `- [ ] ${a}`).join('\n')}`)
    out.push(`**อ้างอิง:** ${r.findingIds.map((id) => refOf.get(id)?.ref ?? '?').join(', ')}`)
  }

  out.push('## คำถามที่ยังไม่มีคำตอบ')
  out.push(meta.open_questions.length === 0 ? '(ไม่มี)' : meta.open_questions.map((q) => `- ${q}`).join('\n'))

  out.push('## ข้อจำกัดของหลักฐาน')
  out.push(
    s.limitations.length === 0
      ? '(ไม่มีข้อจำกัดที่บันทึกไว้)'
      : s.limitations.map((l) => `- **${l.title}**${l.statement ? ` — ${l.statement}` : ''}`).join('\n')
  )

  out.push('## ตารางย้อนกลับไปหาหลักฐาน')
  const rows = meta.requirements.map((r) => {
    const refs = r.findingIds.map((id) => {
      const f = refOf.get(id)
      const n = s.evidence.filter((e) => e.finding_id === id).length
      return f ? `${f.ref} (${CONFIDENCE_LABELS[f.confidence] ?? f.confidence}, หลักฐาน ${n})` : '?'
    })
    return `| ${r.id} | ${refs.join('<br>')} |`
  })
  out.push(rows.length === 0 ? '(ไม่มี)' : ['| ข้อกำหนด | ข้อค้นพบที่อ้าง |', '| --- | --- |', ...rows].join('\n'))
  if (meta.dropped_requirements > 0) {
    out.push(`_ระบบตัดข้อกำหนดที่ AI เสนอแต่อ้างหลักฐานไม่ได้ ${meta.dropped_requirements} รายการ_`)
  }
  return out.join('\n\n') + '\n'
}
