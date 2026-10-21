import { cleanChatText, isValidUUID, sanitizeShort } from '@/lib/utils/sanitize'
import { computedConfidence, excerptIsGrounded, finalConfidence, type ConfidenceLevel } from './evidence'
import { UNTRUSTED_RULES, wrapUntrusted } from './security'

export const MAX_FINDINGS = 20
export const MAX_EVIDENCE_PER_FINDING = 6
export const MAX_LIMITATIONS = 10
// เพดานผลลัพธ์ของเครื่องมือหนึ่ง run ที่ส่งให้โมเดลอ่าน (คุม token) — การตรวจหลักฐานใช้ผลเต็มเสมอ
const MAX_OUTPUT_CHARS_PER_RUN = 12_000
const MAX_TOTAL_CHARS = 40_000

export interface RunOutput {
  runId: string
  toolId: string
  artifactName: string
  /** artifact (tool_output) ที่เก็บผลลัพธ์เต็มของ run นี้ */
  outputArtifactId: string
  /** ข้อความ JSON เต็มของผลลัพธ์ ใช้ตรวจว่าหลักฐานมีอยู่จริง */
  fullText: string
  summary: string
}

export const FINDINGS_SYSTEM_PROMPT = `คุณคือนักวิเคราะห์ซอฟต์แวร์ ภารกิจคือสรุปข้อค้นพบที่ "พิสูจน์ได้จากผลของเครื่องมือเท่านั้น" เพื่อตอบเป้าหมายของผู้ใช้
${UNTRUSTED_RULES}

ตอบเป็น JSON object เดียวเท่านั้น ไม่มี Markdown และไม่มีข้อความอื่น รูปแบบ:
{"findings":[{"title":"...","statement":"...","confidence":"low|medium|high","evidence":[{"tool_run_id":"...","locator":"...","excerpt":"..."}]}],
 "limitations":[{"title":"...","statement":"..."}],
 "needs_more":[{"title":"...","description":"...","success_criteria":"...","tool_id":"...","artifact_id":"...","depends_on_index":[]}]}

กติกา:
- ทุก finding ต้องมี evidence อย่างน้อย 1 รายการ โดย excerpt ต้องคัดลอกข้อความจากผลของเครื่องมือตรงตัว (ระบบจะตรวจว่ามีอยู่จริง ถ้าไม่ตรงจะตัดหลักฐานทิ้ง)
- tool_run_id ต้องมาจากรายการ runs เท่านั้น locator คือตำแหน่งในผลลัพธ์ เช่นชื่อฟิลด์หรือชื่อไฟล์
- ห้ามอนุมานเกินกว่าที่ผลเครื่องมือแสดง ถ้าเป็นการคาดเดาให้เขียนใน limitations ไม่ใช่ findings
- เครื่องมือที่มีทำได้เพียงระบุชนิดไฟล์ ไล่รายการใน ZIP/APK และอ่านโครงสร้าง ELF (ไลบรารีที่ต้องใช้ symbol ที่ export/import สตริง มาตรการป้องกัน) ไม่ได้ถอดรหัส แยกโค้ดเครื่อง หรืออ่านตรรกะภายในฟังก์ชัน ถ้าเป้าหมายของผู้ใช้ต้องการมากกว่านั้น (เช่น วิธีคำนวณภายในโปรแกรม) ให้ระบุเป็น limitations อย่างตรงไปตรงมา และห้ามเดาหน้าที่ของฟังก์ชันจากชื่อเพียงอย่างเดียวเกินกว่าที่ชื่อระบุ
- confidence เป็นเพียงข้อเสนอ ระบบจะคำนวณระดับจริงจากหลักฐานที่ตรวจผ่านแล้ว
- needs_more ใช้เมื่อยังมี artifact ที่ยังไม่ถูกตรวจด้วยเครื่องมือที่รองรับ มิฉะนั้นให้เป็น []`

export interface FindingsPromptOptions {
  /** ตัวอักษรที่ให้อ่านต่อ run (โหมดทีม: แบ่งตามความจุของ agent แต่ละตัว) — ไม่ระบุ = ใช้เพดานเดิม */
  slices?: Map<string, number>
  /** บอกโมเดลว่านี่เป็นชุดย่อย เพื่อไม่ให้สรุปเกินขอบเขตข้อมูลที่เห็น */
  shardNote?: string
}

/** กติกาเพิ่มสำหรับชุดย่อย: จำกัดจำนวนข้อค้นพบให้พอดีกับเพดานคำตอบของ agent ตัวนั้น */
export const findingsSystemPrompt = (maxFindings?: number): string =>
  maxFindings ? `${FINDINGS_SYSTEM_PROMPT}\n- เขียน findings ไม่เกิน ${maxFindings} รายการ (เลือกที่สำคัญที่สุด) ข้อความกระชับ` : FINDINGS_SYSTEM_PROMPT

export function buildFindingsPrompt(
  goal: string,
  runs: RunOutput[],
  uninspected: { artifact_id: string; name: string; supported_tools: string[] }[],
  opts: FindingsPromptOptions = {}
): string {
  let budget = MAX_TOTAL_CHARS
  const blocks = runs.map((r) => {
    const limit = opts.slices?.get(r.runId) ?? Math.min(MAX_OUTPUT_CHARS_PER_RUN, Math.max(budget, 500))
    const slice = r.fullText.slice(0, limit)
    budget -= slice.length
    const truncated = slice.length < r.fullText.length ? '\n[ตัดผลลัพธ์ส่วนที่เหลือเพื่อประหยัด token]' : ''
    return `run_id: ${r.runId}\ntool_id: ${r.toolId}\ninput_file: ${r.artifactName}\n${wrapUntrusted(`tool-output:${r.runId}`, slice + truncated)}`
  })
  return [
    `เป้าหมายของผู้ใช้:\n${goal || '(ผู้ใช้ไม่ได้ระบุ — สรุปโครงสร้างโดยรวมของไฟล์)'}`,
    opts.shardNote ? `หมายเหตุ: ${opts.shardNote}` : '',
    `runs (ผลของเครื่องมือที่รันสำเร็จ):\n\n${blocks.join('\n\n---\n\n')}`,
    uninspected.length > 0
      ? `artifacts ที่ยังไม่ถูกตรวจด้วยเครื่องมือที่รองรับ:\n${wrapUntrusted('uninspected', JSON.stringify(uninspected, null, 2))}`
      : 'artifacts ที่ยังไม่ถูกตรวจด้วยเครื่องมือที่รองรับ: (ไม่มี)',
  ].filter(Boolean).join('\n\n')
}

export interface VerifiedEvidence {
  toolRunId: string
  artifactId: string
  locator: string
  excerpt: string
}

export interface ProcessedFinding {
  title: string
  statement: string
  confidence: ConfidenceLevel
  evidence: VerifiedEvidence[]
  rejectedEvidence: number
}

export interface ProcessedFindings {
  findings: ProcessedFinding[]
  limitations: { title: string; statement: string }[]
  /** ข้อเสนอให้วางงานเพิ่ม ยังไม่ผ่าน parsePlan */
  needsMore: unknown
}

/** ตรวจ + ให้ระดับความเชื่อมั่นเอง ไม่เชื่อสิ่งที่โมเดลอ้าง */
export function processFindings(raw: Record<string, unknown>, runs: RunOutput[]): ProcessedFindings {
  const byRun = new Map(runs.map((r) => [r.runId, r]))
  const findings: ProcessedFinding[] = []

  for (const f of (Array.isArray(raw.findings) ? raw.findings : []).slice(0, MAX_FINDINGS)) {
    const rec = f as Record<string, unknown> | null
    if (!rec || typeof rec !== 'object') continue
    const title = sanitizeShort(rec.title, 300)
    if (!title) continue

    const verified: VerifiedEvidence[] = []
    let rejected = 0
    for (const e of (Array.isArray(rec.evidence) ? rec.evidence : []).slice(0, MAX_EVIDENCE_PER_FINDING)) {
      const ev = e as Record<string, unknown> | null
      const runId = ev && typeof ev.tool_run_id === 'string' ? ev.tool_run_id : ''
      const excerpt = ev && typeof ev.excerpt === 'string' ? ev.excerpt.slice(0, 1000) : ''
      const run = isValidUUID(runId) ? byRun.get(runId) : undefined
      if (!ev || !run || !excerptIsGrounded(excerpt, run.fullText)) {
        rejected++
        continue
      }
      verified.push({
        toolRunId: run.runId,
        artifactId: run.outputArtifactId,
        locator: sanitizeShort(ev.locator, 500),
        excerpt,
      })
    }

    findings.push({
      title,
      statement: cleanChatText(typeof rec.statement === 'string' ? rec.statement : '', 2000),
      confidence: finalConfidence(rec.confidence, computedConfidence(verified)),
      evidence: verified,
      rejectedEvidence: rejected,
    })
  }

  const limitations = (Array.isArray(raw.limitations) ? raw.limitations : [])
    .slice(0, MAX_LIMITATIONS)
    .map((l) => {
      const rec = l as Record<string, unknown> | null
      return {
        title: sanitizeShort(rec?.title, 300),
        statement: cleanChatText(typeof rec?.statement === 'string' ? rec.statement : '', 2000),
      }
    })
    .filter((l) => l.title)

  return { findings, limitations, needsMore: raw.needs_more }
}
