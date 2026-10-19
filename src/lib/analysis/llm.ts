import 'server-only'
import { getAdapter } from '@/lib/ai/registry'
import { completeWithRetry } from '@/lib/ai/retry'
import { ProviderError } from '@/lib/ai/types'
import type { AnalystAgent } from './security'

/** โมเดลตอบไม่เป็น JSON ตามที่กำหนดแม้ลองซ้ำแล้ว */
export class AnalysisFormatError extends Error {}

export interface JsonCompletion {
  value: Record<string, unknown>
  tokensIn: number
  tokensOut: number
}

const MIN_OUTPUT_TOKENS = 1024

const looksTooLarge = (e: unknown): e is ProviderError =>
  e instanceof ProviderError && (e.status === 413 || /request too large|reduce your message size/i.test(e.message))

/**
 * provider บางเจ้า (เช่น Groq แพ็กเกจฟรี) นับ "จำนวน token ขาออกที่ขอไว้ (max tokens)" รวมในขนาดคำขอ
 * ถ้า error บอกเพดานกับยอดที่ขอ (Limit N, Requested M) และลดขาออกลงแล้วจะพอดี คืนค่าขาออกใหม่ ไม่งั้น null
 * เหลือขาออกต่ำสุด 1,024 เพื่อไม่ให้คำตอบ JSON ถูกตัดกลางคัน
 */
export function shrunkOutputTokens(err: unknown, current: number): number | null {
  if (!looksTooLarge(err)) return null
  const m = /Limit (\d+), Requested (\d+)/i.exec(err.message)
  if (!m) return null
  const limit = Number(m[1]), requested = Number(m[2])
  if (!(requested > limit)) return null
  const next = current - (requested - limit) - 256 // เผื่อส่วนต่างของการนับ token
  return next >= MIN_OUTPUT_TOKENS ? next : null
}

function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const v = JSON.parse(cleaned.slice(start, end + 1)) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * เรียกโมเดลให้ตอบเป็น JSON object — ตอบผิดรูปแบบจะลองซ้ำ 1 ครั้ง
 * token ของทุกครั้งที่เรียกถูกรวมคืนให้ผู้เรียกบันทึก (ต้องนับแม้ตอบผิดรูปแบบ)
 * error ของ provider (key ผิด / เครดิตหมด / rate limit) ส่งต่อให้ orchestrator จัดการ
 */
export async function completeJson(
  analyst: AnalystAgent,
  prompt: { system: string; user: string; maxTokens: number }
): Promise<JsonCompletion> {
  const adapter = getAdapter(analyst.provider)
  let currentMax = Math.min(Math.max(prompt.maxTokens, MIN_OUTPUT_TOKENS), analyst.max_tokens ?? prompt.maxTokens)
  let tokensIn = 0
  let tokensOut = 0

  // เรียก provider หนึ่งครั้ง: ถ้าคำขอใหญ่เกินเพดานของโมเดลและลดขาออกแล้วพอดี จะลดแล้วลองใหม่ได้ 1 ครั้ง
  let shrunkOnce = false
  const callProvider = async (userPrompt: string) => {
    for (;;) {
      try {
        return await completeWithRetry(adapter, {
          apiKey: analyst.apiKey,
          model: analyst.model,
          systemPrompt: prompt.system,
          userPrompt,
          maxTokens: currentMax,
          baseUrl: analyst.base_url ?? undefined,
        })
      } catch (e) {
        const next = shrunkOnce ? null : shrunkOutputTokens(e, currentMax)
        if (next !== null) {
          currentMax = next
          shrunkOnce = true
          continue
        }
        if (looksTooLarge(e)) {
          const lim = /Limit (\d+), Requested (\d+)/i.exec(e.message)
          throw new ProviderError(
            `คำขอใหญ่เกินขีดจำกัดของโมเดลนี้${lim ? ` (จำกัด ${lim[1]} โทเคน แต่ต้องใช้ ${lim[2]})` : ''} ลดข้อมูลลงอีกไม่ได้ — ` +
              'เลือก agent ที่ใช้โมเดลซึ่งรับโทเคนได้มากกว่านี้ หรืออัปเกรดแพ็กเกจของ provider',
            413
          )
        }
        throw e
      }
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await callProvider(
      attempt === 0
        ? prompt.user
        : `${prompt.user}\n\n(คำตอบรอบก่อนไม่ใช่ JSON ที่ถูกต้อง — ตอบเป็น JSON object เดียวเท่านั้น ไม่มีข้อความอื่นและไม่มี code fence)`
    )
    tokensIn += r.tokensIn
    tokensOut += r.tokensOut
    const value = extractJson(r.text)
    if (value) return { value, tokensIn, tokensOut }
  }
  const err = new AnalysisFormatError('โมเดลตอบไม่เป็น JSON ตามที่กำหนด')
  ;(err as AnalysisFormatError & { tokensIn: number; tokensOut: number }).tokensIn = tokensIn
  ;(err as AnalysisFormatError & { tokensIn: number; tokensOut: number }).tokensOut = tokensOut
  throw err
}
