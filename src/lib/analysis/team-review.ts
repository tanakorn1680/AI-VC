import { cleanChatText, sanitizeShort } from '@/lib/utils/sanitize'
import { UNTRUSTED_RULES, wrapUntrusted } from './security'

/**
 * ผู้ตรวจทาน (critic) ของทีมวิเคราะห์ — agent อีกตัวอ่านข้อค้นพบที่ agent อื่นเขียน แล้วชี้ว่าอันไหนอนุมานเกินหลักฐาน/ซ้ำกัน
 * ผู้ตรวจทาน "ลด/ตัด" ได้อย่างเดียว เพิ่มข้อค้นพบหรือเพิ่มระดับความเชื่อมั่นไม่ได้ (ระดับจริงมาจากหลักฐานที่ระบบตรวจเอง)
 */

export const REVIEW_SYSTEM_PROMPT = `คุณคือผู้ตรวจทานผลวิเคราะห์ซอฟต์แวร์ ภารกิจคือตรวจข้อค้นพบที่นักวิเคราะห์ท่านอื่นเขียน ว่าข้อความแต่ละข้อ "ถูกรองรับด้วยหลักฐานที่แนบมา" จริงหรือไม่
${UNTRUSTED_RULES}

ตอบเป็น JSON object เดียวเท่านั้น ไม่มี Markdown และไม่มีข้อความอื่น รูปแบบ:
{"verdicts":[{"i":0,"action":"keep|downgrade|drop","reason":"..."}],"duplicates":[[1,4]]}

กติกา:
- i คือเลขลำดับของข้อค้นพบในรายการ (เริ่มที่ 0) ใส่เฉพาะข้อที่ต้อง downgrade หรือ drop ข้อที่ไม่มีปัญหาไม่ต้องใส่
- drop = ข้อความไม่ได้รับการรองรับจากหลักฐานเลย หรือเป็นการเดา; downgrade = มีหลักฐานแต่ข้อความอนุมานเกินกว่าหลักฐาน
- duplicates = คู่ [a,b] ที่พูดเรื่องเดียวกัน ให้เก็บ a และตัด b
- ห้ามเพิ่มข้อค้นพบใหม่ ห้ามเขียนอะไรนอกจาก JSON`

export interface ReviewItem {
  title: string
  statement: string
  confidence: string
  /** ข้อความหลักฐาน (สั้น) */
  evidence: string[]
}

/** ใส่ข้อค้นพบเท่าที่งบตัวอักษรอนุญาต (ตัดข้อความให้สั้น) คืนจำนวนข้อที่ใส่ได้ — ข้อที่เหลือไม่ถูกตรวจ */
export function buildReviewPrompt(
  goal: string,
  items: ReviewItem[],
  maxChars: number
): { user: string; included: number } {
  const lines: string[] = []
  let used = 0
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const ev = it.evidence.slice(0, 2).map((e) => `    หลักฐาน: ${e.slice(0, 160).replace(/\s+/g, ' ')}`).join('\n')
    const block = `[${i}] ${it.title.slice(0, 160)} (ความเชื่อมั่น: ${it.confidence})\n    ข้อความ: ${it.statement.slice(0, 300).replace(/\s+/g, ' ')}\n${ev || '    หลักฐาน: (ไม่มี)'}`
    if (used + block.length > maxChars && lines.length > 0) break
    lines.push(block)
    used += block.length
  }
  const user = [
    `เป้าหมายของผู้ใช้:\n${goal || '(ไม่ได้ระบุ)'}`,
    `ข้อค้นพบที่ต้องตรวจ:\n${wrapUntrusted('findings-to-review', lines.join('\n\n'))}`,
  ].join('\n\n')
  return { user, included: lines.length }
}

export interface Verdicts {
  drops: Map<number, string>
  downgrades: Map<number, string>
  duplicates: [number, number][]
}

/** ตรวจคำตัดสินอย่างเข้มงวด: index ต้องอยู่ในช่วง, ตัดได้ไม่เกินครึ่งหนึ่งของที่ตรวจ (กันผู้ตรวจที่ตอบเพี้ยนล้างผลทั้งหมด) */
export function parseVerdicts(raw: Record<string, unknown>, count: number): Verdicts {
  const drops = new Map<number, string>()
  const downgrades = new Map<number, string>()
  const okIndex = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < count

  for (const v of Array.isArray(raw.verdicts) ? raw.verdicts.slice(0, 100) : []) {
    const rec = v as Record<string, unknown> | null
    if (!rec || !okIndex(rec.i)) continue
    const reason = cleanChatText(typeof rec.reason === 'string' ? rec.reason : '', 400)
    if (rec.action === 'drop') drops.set(rec.i, reason)
    else if (rec.action === 'downgrade') downgrades.set(rec.i, reason)
  }

  const maxDrops = Math.floor(count / 2)
  if (drops.size > maxDrops) {
    // เกินกึ่งหนึ่ง = ผู้ตรวจไม่น่าเชื่อถือในรอบนี้ → ลดระดับแทนการตัด
    for (const [i, r] of drops) downgrades.set(i, r)
    drops.clear()
  }

  const duplicates: [number, number][] = []
  for (const d of Array.isArray(raw.duplicates) ? raw.duplicates.slice(0, 50) : []) {
    if (Array.isArray(d) && okIndex(d[0]) && okIndex(d[1]) && d[0] !== d[1]) duplicates.push([d[0], d[1]])
  }
  return { drops, downgrades, duplicates }
}

export const limitationTitleForDrop = (title: string): string => sanitizeShort(`ผู้ตรวจทานตัดข้อค้นพบ: ${title}`, 300)
