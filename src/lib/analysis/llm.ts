import 'server-only'
import { getAdapter } from '@/lib/ai/registry'
import { completeWithRetry } from '@/lib/ai/retry'
import type { AnalystAgent } from './security'

/** โมเดลตอบไม่เป็น JSON ตามที่กำหนดแม้ลองซ้ำแล้ว */
export class AnalysisFormatError extends Error {}

export interface JsonCompletion {
  value: Record<string, unknown>
  tokensIn: number
  tokensOut: number
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
  const maxTokens = Math.min(Math.max(prompt.maxTokens, 1024), analyst.max_tokens ?? prompt.maxTokens)
  let tokensIn = 0
  let tokensOut = 0

  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await completeWithRetry(adapter, {
      apiKey: analyst.apiKey,
      model: analyst.model,
      systemPrompt: prompt.system,
      userPrompt:
        attempt === 0
          ? prompt.user
          : `${prompt.user}\n\n(คำตอบรอบก่อนไม่ใช่ JSON ที่ถูกต้อง — ตอบเป็น JSON object เดียวเท่านั้น ไม่มีข้อความอื่นและไม่มี code fence)`,
      maxTokens,
      baseUrl: analyst.base_url ?? undefined,
    })
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
