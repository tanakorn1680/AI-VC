import 'server-only'
import { getAdapter } from '@/lib/ai/registry'
import { completeWithRetry } from '@/lib/ai/retry'
import { ProviderError } from '@/lib/ai/types'
import { getProviderMeta } from '@/lib/ai/providers'
import type { AnalystAgent } from './security'

/** โมเดลตอบไม่เป็น JSON ตามที่กำหนดแม้ลองซ้ำแล้ว */
export class AnalysisFormatError extends Error {}

export interface JsonCompletion {
  value: Record<string, unknown>
  tokensIn: number
  tokensOut: number
}

const MIN_OUTPUT_TOKENS = 1024

/** คำขอใหญ่เกินที่โมเดล/แพ็กเกจนี้รับได้ (ลดขาออกแล้วก็ยังไม่พอ) — ทีมใช้เป็นสัญญาณให้ส่งต่อให้ agent ที่ context ใหญ่กว่า */
export class PromptTooLargeError extends ProviderError {
  constructor(message: string, public limit?: number, public requested?: number) {
    super(message, 413)
  }
}

const looksTooLarge = (e: unknown): e is ProviderError =>
  e instanceof ProviderError &&
  (e.status === 413 || /request too large|reduce your message size|maximum context length|context length exceeded/i.test(e.message))

/** ดึงเพดาน/ยอดที่ขอจากข้อความ error ของ provider (Groq: "Limit 8000, Requested 9243"; OpenAI-style: "maximum context length is N tokens ... requested M") */
export function parseTokenLimit(message: string): { limit?: number; requested?: number } {
  const groq = /Limit (\d+), Requested (\d+)/i.exec(message)
  if (groq) return { limit: Number(groq[1]), requested: Number(groq[2]) }
  const ctx = /maximum context length is (\d+) tokens[\s\S]*?(?:requested|resulted in|you requested)\D{0,20}(\d+)/i.exec(message)
  if (ctx) return { limit: Number(ctx[1]), requested: Number(ctx[2]) }
  const only = /maximum context length is (\d+)/i.exec(message)
  return only ? { limit: Number(only[1]) } : {}
}

/**
 * provider บางเจ้า (เช่น Groq แพ็กเกจฟรี) นับ "จำนวน token ขาออกที่ขอไว้ (max_tokens)" รวมในขนาดคำขอ
 * ถ้า error บอกเพดานกับยอดที่ขอ และลด max_tokens ที่ส่งจริงลงแล้วจะพอดี คืนค่า max_tokens ใหม่ ไม่งั้น null
 * sentNow = ค่า max_tokens ที่ส่งไปจริงในคำขอที่พลาด (รวม headroom แล้ว)
 * เหลือขาออกต่ำสุด 1,024 เพื่อไม่ให้คำตอบ JSON ถูกตัดกลางคัน
 */
export function shrunkOutputTokens(err: unknown, sentNow: number): number | null {
  if (!looksTooLarge(err)) return null
  const { limit, requested } = parseTokenLimit(err.message)
  if (limit === undefined || requested === undefined || !(requested > limit)) return null
  const next = sentNow - (requested - limit) - 256 // เผื่อส่วนต่างของการนับ token
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
  prompt: { system: string; user: string; maxTokens: number; outputCap?: number; deadlineAt?: number }
): Promise<JsonCompletion> {
  const adapter = getAdapter(analyst.provider)
  const headroom = getProviderMeta(analyst.provider)?.outputHeadroom ?? 0
  let currentMax = Math.min(Math.max(prompt.maxTokens, MIN_OUTPUT_TOKENS), analyst.max_tokens ?? prompt.maxTokens)
  let cap = prompt.outputCap
  let tokensIn = 0
  let tokensOut = 0

  // max_tokens ที่ adapter จะส่งจริง (รวม headroom ของ provider ที่คิดก่อนตอบ และเพดานที่กำหนด)
  const sentNow = () => Math.min(headroom > 0 ? Math.min(currentMax + headroom, 32768) : currentMax, cap ?? Number.MAX_SAFE_INTEGER)

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
          outputCap: cap,
          baseUrl: analyst.base_url ?? undefined,
        }, prompt.deadlineAt !== undefined ? { deadlineAt: prompt.deadlineAt } : {})
      } catch (e) {
        const next = shrunkOnce ? null : shrunkOutputTokens(e, sentNow())
        if (next !== null) {
          cap = next
          currentMax = Math.min(currentMax, next)
          shrunkOnce = true
          continue
        }
        if (looksTooLarge(e)) {
          const { limit, requested } = parseTokenLimit(e.message)
          throw new PromptTooLargeError(
            `คำขอใหญ่เกินขีดจำกัดของโมเดลนี้${limit ? ` (จำกัด ${limit} โทเคน${requested ? ` แต่ต้องใช้ ${requested}` : ''})` : ''}`,
            limit,
            requested
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
