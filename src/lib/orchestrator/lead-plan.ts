import { normalizeFilePath } from '../files/path'
import { FILE_WRITE_INSTRUCTION } from '../files/extract'
import { BUDGET, clip } from './context-budget'

/** ความยาวสูงสุดของบล็อก <summary> ที่ขอจากคนทำงาน */
const SUMMARY_CHARS = 400

// ---------------------------------------------------------------------------
// ชนิดข้อมูล
// ---------------------------------------------------------------------------
export interface TeamMember {
  id: string
  name: string
  /** หน้าที่ของ agent (ข้อความอิสระ ว่างได้ = ทำได้ทุกอย่าง) */
  duty: string
  role: string
  provider: string
  model: string
}

export interface PlanTask {
  title: string
  description: string
  /** ชื่อสมาชิกที่รับงาน (เก็บไว้แสดงในแชท) */
  agent: string
  agent_id: string
  /** index (0-based) ของงานอื่นในแผนเดียวกันที่ต้องเสร็จก่อน */
  depends_on: number[]
  /** ไฟล์ที่งานนี้ต้องอ่านจริง ๆ — มีแค่ไฟล์เหล่านี้ที่ถูกส่งเนื้อหาเข้า prompt (คุม token) */
  files: string[]
}

export interface StoredPlan {
  tasks: PlanTask[]
}

export const MAX_PLAN_FILES_PER_TASK = 8

// ---------------------------------------------------------------------------
// prompt ของคนทำงาน (worker) — สั้นและเน้นประหยัด token
// ---------------------------------------------------------------------------
export const WORKER_BASE_PROMPT =
  'ทำงานตาม "ใบสั่งงาน" ให้เสร็จในคำตอบเดียว ตอบเฉพาะผลลัพธ์ กระชับ ไม่ทวนคำสั่ง ไม่กล่าวนำหรือสรุปท้าย ไม่ถามกลับ ' +
  '(ถ้าข้อมูลไม่พอ ให้ระบุข้อสมมติสั้น ๆ แล้วทำต่อ) คุณเห็นเฉพาะใบสั่งงาน ความจำโปรเจกต์ และไฟล์ที่แนบมา ไม่เห็นแชทของผู้ใช้'

/** ท้ายคำตอบของคนทำงานทุกคน: บล็อกสรุปที่ระบบส่งต่อให้งานถัดไปแทนผลงานเต็ม (ประหยัด token และไม่เพี้ยนเหมือนตัดข้อความดิบ) */
export const SUMMARY_INSTRUCTION =
  `ท้ายคำตอบต้องต่อด้วยบล็อก <summary>…</summary> (ไม่เกิน ${SUMMARY_CHARS} ตัวอักษร) บอก: ทำอะไรเสร็จ · ข้อสมมติ/การตัดสินใจสำคัญ · ไฟล์ที่สร้างหรือแก้ · สิ่งที่ยังค้าง ` +
  '(งานถัดไปจะเห็นแค่บล็อกนี้ ไม่เห็นผลงานเต็ม จึงต้องครบประเด็นสำคัญ)'

export const REVIEWER_INSTRUCTION =
  'คุณคือผู้ตรวจ: ตรวจผลงานที่แนบมาตามเกณฑ์ในใบสั่งงาน ระบุปัญหาเป็นข้อ ๆ (ที่ไหน · ผิดอย่างไร · ควรแก้อย่างไร) ' +
  'ไม่เขียนผลงานใหม่ทั้งชิ้น ถ้าไม่พบปัญหาให้บอกสั้น ๆ ว่าผ่าน บรรทัดแรกของ <summary> ต้องขึ้นต้นด้วย "ผ่าน" หรือ "ต้องแก้"'

export function composeWorkerPrompt(a: {
  name: string
  duty: string
  systemPrompt: string
  canWriteFiles: boolean
  isReviewer?: boolean
}): string {
  const parts = [`คุณคือ ${a.name}${a.duty.trim() ? ` หน้าที่: ${a.duty.trim()}` : ''}`, WORKER_BASE_PROMPT]
  if (a.isReviewer) parts.push(REVIEWER_INSTRUCTION)
  if (a.systemPrompt.trim()) parts.push(a.systemPrompt.trim())
  if (a.canWriteFiles) parts.push(FILE_WRITE_INSTRUCTION)
  parts.push(SUMMARY_INSTRUCTION)
  return parts.join('\n')
}

/**
 * แยกบล็อก <summary> ท้ายคำตอบออกจากเนื้อหา (ต้องอยู่ท้ายสุดเท่านั้น กันไปจับ <summary> ที่อยู่ในโค้ด/ไฟล์)
 * ไม่มีบล็อก → summary = null ให้ผู้เรียกตัดข้อความเองเป็น fallback
 */
export function splitSummary(text: string): { body: string; summary: string | null } {
  const m = /<summary>([\s\S]*?)<\/summary>\s*$/i.exec(text)
  if (!m) return { body: text, summary: null }
  const summary = (m[1] ?? '').trim()
  return { body: text.slice(0, m.index).trimEnd(), summary: summary || null }
}

// ---------------------------------------------------------------------------
// prompt ของหัวหน้าทีม (ผู้ประสานงาน)
// ---------------------------------------------------------------------------
export interface ChatLine {
  role: 'user' | 'assistant' | 'system'
  content: string
  /** ข้อความนี้คือผลงานของ task (ตัดให้สั้นลงตอนส่งเข้า prompt) */
  isTaskResult?: boolean
}

export function buildLeadSystemPrompt(a: {
  lead: TeamMember
  projectName: string
  instructions: string
  team: TeamMember[]
  /** model → ข้อความราคา เช่น "$3/$15 ต่อล้าน token" */
  prices: Map<string, string>
  filePaths: string[]
  filesTotal: number
  pendingPlan: StoredPlan | null
  taskStatus: string
  /** ความจำโปรเจกต์ (สรุปที่ระบบรีเฟรชให้เอง) */
  brief: string
}): string {
  const teamLines = a.team.map((m) => {
    const price = a.prices.get(`${m.provider}/${m.model}`)
    const tag = m.id === a.lead.id ? ' (คุณเอง)' : m.role === 'reviewer' ? ' [ผู้ตรวจ]' : ''
    return `- ${m.name}${tag} | หน้าที่: ${m.duty.trim() || 'ทั่วไป'} | โมเดล: ${m.model}${price ? ` | ราคา ${price}` : ''}`
  })
  const hasReviewer = a.team.some((m) => m.role === 'reviewer')
  const solo = a.team.length === 1

  const pending = a.pendingPlan
    ? `แผนที่รอผู้ใช้ยืนยัน:\n${a.pendingPlan.tasks.map((t, i) => `${i + 1}. ${t.title} (${t.agent})`).join('\n')}`
    : 'ตอนนี้ไม่มีแผนที่รอยืนยัน (ห้ามใช้ <start/>)'

  return [
    `คุณคือ "${a.lead.name}" ผู้ประสานงานของทีม AI ที่กำลังทำโปรเจกต์ "${a.projectName}" คุยกับผู้ใช้ตรง ๆ แบบเพื่อนร่วมงาน ตอบกระชับ ตรงประเด็น ใช้ภาษาเดียวกับผู้ใช้`,
    '',
    'บทบาทของคุณคือ "ประสานและมอบหมาย" ไม่ใช่ลงมือผลิตชิ้นงานเอง:',
    '1. คุยให้เป้าหมายชัดก่อนลงมือ ถ้าข้อมูลไม่พอให้ถามกลับ (ไม่เกิน 3 ข้อ เฉพาะที่จำเป็นจริง)',
    '2. คำถามหรืองานเล็กที่ตอบจบในข้อความเดียว (อธิบาย ตอบสถานะ แก้สั้น ๆ) ตอบเองทันที ไม่ต้องแบ่งงาน',
    solo
      ? '3. ชิ้นงานจริง (โค้ด เอกสาร วิเคราะห์ หลายขั้นตอน): ทีมมีคุณคนเดียว ให้เสนอแผนแล้วมอบงานให้ตัวเอง — งานแต่ละชิ้นรันใน context สะอาดของมันเอง ทำให้ไม่เพี้ยนเมื่อแชทยาว'
      : '3. ชิ้นงานจริง (โค้ด เอกสาร วิเคราะห์ หลายขั้นตอน): ให้มอบสมาชิกตาม "หน้าที่" ไม่ทำเอง สรุปแผนเป็นข้อสั้น ๆ ให้ผู้ใช้ยืนยันก่อน',
    '   แล้วต่อท้ายคำตอบด้วยบล็อกแผน (ผู้ใช้ไม่เห็นบล็อกนี้ ระบบแปลงเป็นปุ่มให้) ห้ามเริ่มงานเองโดยไม่ได้รับการยืนยัน:',
    '<plan>{"tasks":[{"id":"t1","title":"ชื่องานสั้น","description":"ใบสั่งงานครบในตัว","agent":"ชื่อสมาชิก","depends_on":[],"files":[]}]}</plan>',
    '4. เมื่อผู้ใช้ยืนยันแผนที่รออยู่ (เช่น "เริ่มเลย", "โอเค") ให้ตอบสั้น ๆ แล้วต่อท้ายด้วย <start/> ถ้าผู้ใช้ขอแก้แผน ให้เสนอแผนใหม่ด้วย <plan> อีกครั้ง',
    '',
    'กติกาแบ่งงาน (ประหยัด token และได้งานแม่น):',
    '- description คือ "ใบสั่งงาน": เป้าหมาย · ข้อมูล/ข้อกำหนดที่ต้องใช้ · รูปแบบผลลัพธ์ · เกณฑ์ว่าเสร็จ — คนทำงานเห็นแค่ใบสั่งงาน + ความจำโปรเจกต์ + ไฟล์ที่ระบุ ไม่เห็นแชท ถ้าต้องสร้างไฟล์ให้ระบุชื่อไฟล์',
    '- 1 งาน = 1 เป้าหมายที่จบในรอบเดียว ไม่ยัดหลายเรื่องในงานเดียว และไม่แตกเล็กเกินจำเป็น ถ้าคนเดียวทำได้ใช้งานเดียว',
    '- งานที่ไม่ต้องรอกันให้ depends_on ว่าง (ทำพร้อมกัน) depends_on ใส่ id ของงานที่ต้องเสร็จก่อน งานที่รอจะเห็นเฉพาะ "สรุป" ของงานก่อนหน้า',
    '- ส่งต่อผ่านไฟล์: ถ้างานก่อนหน้าสร้างไฟล์ ให้งานถัดไปอ่านผ่านช่อง files แทนการคัดลอกเนื้อหามาใส่ description ใส่เฉพาะไฟล์ที่ต้องอ่านจริง (แต่ละไฟล์คือ token ที่ต้องจ่าย)',
    '- มอบตาม "หน้าที่" ถ้าไม่ระบุหน้าที่ ให้เลือกตามความถนัดของโมเดล งานง่าย (สรุป จัดรูปแบบ แปล) ให้โมเดลเล็ก/ถูก งานยาก (โค้ด เหตุผลซับซ้อน) ให้โมเดลที่เก่งกว่า',
    hasReviewer
      ? '- ทีมมี [ผู้ตรวจ]: ชิ้นงานสำคัญ (โค้ดที่จะใช้จริง ข้อเท็จจริง เอกสารที่ส่งต่อคนอื่น) ให้เพิ่มงานตรวจที่ depends_on งานนั้น และระบุใน files ว่าต้องตรวจไฟล์ไหน งานเล็กไม่ต้องตรวจ'
      : '- ไม่ต้องเพิ่มงานตรวจ/สรุปที่ไม่จำเป็น',
    '- งานสุดท้ายต้องส่งมอบผลที่ผู้ใช้ใช้ได้ทันที',
    '',
    'ทีมของคุณ (ใช้ชื่อตามนี้เท่านั้นในช่อง agent):',
    ...teamLines,
    a.brief.trim()
      ? `\nความจำโปรเจกต์ (ระบบสรุปให้อัตโนมัติจากบทสนทนาเก่า — เชื่อถือได้ แต่ถ้าข้อความล่าสุดของผู้ใช้ขัดกัน ให้ยึดข้อความล่าสุด):\n${a.brief.trim()}`
      : '',
    a.filesTotal > 0
      ? `\nไฟล์ในโปรเจกต์ (${a.filesTotal}${a.filesTotal > a.filePaths.length ? `, แสดง ${a.filePaths.length} ไฟล์ล่าสุด` : ''}): ${a.filePaths.join(', ')}`
      : '',
    a.taskStatus ? `\nสถานะงานล่าสุด: ${a.taskStatus}` : '',
    a.instructions.trim() ? `\nคำสั่งของโปรเจกต์: ${clip(a.instructions.trim(), BUDGET.instructionsChars)}` : '',
    `\n${pending}`,
  ]
    .filter((l) => l !== '')
    .join('\n')
}

/** รวมประวัติแชทล่าสุดเป็นข้อความเดียว (adapter รับแค่ system + user) แล้วต่อด้วยข้อความใหม่ */
export function buildLeadUserPrompt(history: ChatLine[], userMessage: string): string {
  const lines = history.map((m) => {
    if (m.isTaskResult) {
      const body = m.content.length > BUDGET.taskResultChars ? `${m.content.slice(0, BUDGET.taskResultChars)}…(ผลงานเต็มอยู่ในไฟล์/แท็บ Tasks)` : m.content
      return `[ผลงานจากทีม] ${body}`
    }
    const who = m.role === 'user' ? 'ผู้ใช้' : m.role === 'assistant' ? 'คุณ' : 'ระบบ'
    return `${who}: ${clip(m.content, BUDGET.historyLineChars)}`
  })
  return [lines.length ? `บทสนทนาล่าสุด:\n${lines.join('\n')}\n` : '', `ข้อความใหม่ของผู้ใช้:\n${userMessage}`]
    .filter(Boolean)
    .join('\n')
}

// ---------------------------------------------------------------------------
// อ่านคำตอบของหัวหน้าทีม: ข้อความคุย + (ถ้ามี) <plan>{...}</plan> + (ถ้ามี) <start/>
// ---------------------------------------------------------------------------
export interface ParsedLeadOutput {
  reply: string
  planJson: unknown | null
  planError: string | null
  start: boolean
}

function stripFence(s: string): string {
  return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
}

export function parseLeadOutput(text: string): ParsedLeadOutput {
  let reply = text
  let planJson: unknown = null
  let planError: string | null = null

  const closed = /<plan>([\s\S]*?)<\/plan>/i.exec(reply)
  if (closed) {
    reply = reply.replace(/<plan>[\s\S]*?<\/plan>/gi, '')
    try {
      planJson = JSON.parse(stripFence(closed[1] ?? ''))
    } catch {
      planError = 'อ่านแผนไม่ได้ (รูปแบบ JSON ไม่ถูกต้อง)'
    }
  } else if (/<plan>/i.test(reply)) {
    // เปิดแท็กแล้วแต่ไม่ปิด = คำตอบถูกตัดกลางคัน
    reply = reply.replace(/<plan>[\s\S]*$/i, '')
    planError = 'แผนถูกตัดกลางคัน (คำตอบยาวเกินเพดาน)'
  }

  const start = /<start\s*\/?>/i.test(reply)
  reply = reply.replace(/<start\s*\/?>/gi, '').trim()
  return { reply, planJson, planError, start }
}

// ---------------------------------------------------------------------------
// ตรวจแผน → แปลงเป็นรูปแบบที่เก็บ/รันได้ (หรือบอกเหตุผลที่ใช้ไม่ได้)
// ---------------------------------------------------------------------------
export type PlanCheck = { ok: true; plan: StoredPlan } | { ok: false; error: string }

function resolveMember(raw: unknown, team: TeamMember[], lead: TeamMember): TeamMember {
  const wanted = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!wanted) return lead
  return (
    team.find((m) => m.name.toLowerCase() === wanted) ??
    team.find((m) => m.name.toLowerCase().includes(wanted) || wanted.includes(m.name.toLowerCase())) ??
    lead
  )
}

function hasCycle(tasks: PlanTask[]): boolean {
  const state = new Array<number>(tasks.length).fill(0) // 0 = ยังไม่เยี่ยม, 1 = กำลังเยี่ยม, 2 = เสร็จ
  const visit = (i: number): boolean => {
    if (state[i] === 1) return true
    if (state[i] === 2) return false
    state[i] = 1
    for (const d of tasks[i]?.depends_on ?? []) if (visit(d)) return true
    state[i] = 2
    return false
  }
  return tasks.some((_, i) => visit(i))
}

export function validatePlan(
  raw: unknown,
  ctx: { team: TeamMember[]; lead: TeamMember; maxTasks: number }
): PlanCheck {
  const list = (raw as { tasks?: unknown } | null)?.tasks
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: 'แผนไม่มีงานเลย' }
  if (list.length > ctx.maxTasks) {
    return { ok: false, error: `แผนมี ${list.length} งาน เกินเพดาน ${ctx.maxTasks} งานต่อแผนของโปรเจกต์` }
  }

  // id ของงาน (ที่โมเดลตั้งเอง) → index; ถ้าไม่ตั้งให้ใช้ t1, t2, ...
  const ids = list.map((t, i) => {
    const id = (t as { id?: unknown } | null)?.id
    return typeof id === 'string' && id.trim() ? id.trim() : `t${i + 1}`
  })
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'id ของงานในแผนซ้ำกัน' }

  const tasks: PlanTask[] = []
  for (const [i, t] of list.entries()) {
    const o = (t ?? {}) as Record<string, unknown>
    const title = typeof o.title === 'string' ? o.title.trim().slice(0, 200) : ''
    if (!title) return { ok: false, error: `งานที่ ${i + 1} ไม่มีชื่อ` }
    const description = typeof o.description === 'string' ? o.description.trim().slice(0, 4000) : ''

    const depends: number[] = []
    for (const d of Array.isArray(o.depends_on) ? o.depends_on : []) {
      // รับทั้ง id ("t1") และตัวเลข index (0-based) เผื่อโมเดลเขียนมาแบบหลัง
      const idx = typeof d === 'string' ? ids.indexOf(d.trim()) : Number.isInteger(d) ? (d as number) : -1
      if (idx < 0 || idx >= list.length || idx === i) return { ok: false, error: `งานที่ ${i + 1} อ้างงานที่ต้องรอไม่ถูกต้อง` }
      if (!depends.includes(idx)) depends.push(idx)
    }

    const files: string[] = []
    for (const f of Array.isArray(o.files) ? o.files : []) {
      const p = normalizeFilePath(f)
      if (p.ok && !files.includes(p.path) && files.length < MAX_PLAN_FILES_PER_TASK) files.push(p.path)
    }

    const member = resolveMember(o.agent, ctx.team, ctx.lead)
    tasks.push({ title, description: description || title, agent: member.name, agent_id: member.id, depends_on: depends, files })
  }

  if (hasCycle(tasks)) return { ok: false, error: 'แผนมีงานที่รอกันเป็นวงกลม' }
  return { ok: true, plan: { tasks } }
}
