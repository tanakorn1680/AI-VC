import {
  type ProviderAdapter,
  type CompletionRequest,
  type CompletionResult,
  InvalidApiKeyError,
  ProviderError,
} from './types'
import { toRateLimitError } from './rate-limit'

// รูปแบบ response ของ models.generateContent เท่าที่เราต้องใช้จริง
// (ยืนยันจากเอกสาร ai.google.dev — Gemini แยก systemInstruction ออกจาก contents)
interface GeminiGenerateContentResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
}

export const geminiAdapter: ProviderAdapter = {
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(req.timeoutMs ?? 100_000),
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': req.apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: req.userPrompt }] }],
        // รุ่น thinking (2.5+/3.x) นับ token ที่ "คิด" รวมใน maxOutputTokens ถ้าเพดานต่ำ คำตอบจริงจะถูกตัดจนว่าง
        // จึงเผื่อ headroom (จำกัดไม่เกิน 32768 ให้ใช้ได้กับทุกรุ่น)
        generationConfig: { maxOutputTokens: Math.min(req.maxTokens + 8192, 32768) },
      }),
    })

    if (res.status === 401 || res.status === 403) {
      throw new InvalidApiKeyError('Gemini: API key ไม่ถูกต้องหรือไม่มีสิทธิ์')
    }
    if (res.status === 429) throw await toRateLimitError(res, 'Gemini')
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ProviderError(`Gemini error ${res.status}: ${body.slice(0, 500)}`, res.status)
    }

    const data = (await res.json()) as GeminiGenerateContentResponse
    const cand = data.candidates?.[0]
    const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('')
    if (!text) {
      throw new ProviderError(`Gemini ไม่ส่งข้อความกลับมา (finishReason: ${cand?.finishReason ?? 'ไม่ทราบ'})`)
    }

    return {
      text,
      tokensIn: data.usageMetadata?.promptTokenCount ?? 0,
      // token ที่ "คิด" ถูกนับแยกใน thoughtsTokenCount แต่กินโควตาจริง จึงรวมเข้าด้วย
      tokensOut: (data.usageMetadata?.candidatesTokenCount ?? 0) + (data.usageMetadata?.thoughtsTokenCount ?? 0),
    }
  },
}
