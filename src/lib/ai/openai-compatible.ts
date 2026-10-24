import {
  type ProviderAdapter,
  type CompletionRequest,
  type CompletionResult,
  InvalidApiKeyError,
  ProviderError,
} from './types'
import { toRateLimitError } from './rate-limit'
import { validateBaseUrl } from './providers'

// รูปแบบ response ของ POST {base}/chat/completions (มาตรฐานที่ OpenRouter/DeepSeek/Groq/xAI/Mistral/Together ใช้ร่วมกัน)
interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/**
 * Adapter เดียวรองรับทุกค่ายที่ใช้ API แบบ OpenAI
 * presetBase = base URL ของค่ายนั้น ๆ; ถ้าเป็น custom ใช้ req.baseUrl ที่ผู้ใช้กรอกต่อ agent
 */
export function openaiCompatibleAdapter(
  opts: { presetBase?: string; outputHeadroom?: number } = {}
): ProviderAdapter {
  const { presetBase, outputHeadroom = 0 } = opts
  return {
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      const check = validateBaseUrl(presetBase ?? req.baseUrl)
      if (!check.ok) throw new ProviderError(`base URL ใช้ไม่ได้: ${check.error}`)

      const res = await fetch(`${check.url}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${req.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          // รุ่นที่คิดก่อนตอบ (เช่น GLM) นับ token คิดรวมในเพดานนี้ — เผื่อ headroom (ไม่เกิน 32768)
          max_tokens: Math.min(
            outputHeadroom > 0 ? Math.min(req.maxTokens + outputHeadroom, 32768) : req.maxTokens,
            req.outputCap !== undefined ? Math.max(256, req.outputCap) : Number.MAX_SAFE_INTEGER
          ),
          messages: [
            { role: 'system', content: req.systemPrompt },
            { role: 'user', content: req.userPrompt },
          ],
        }),
        // ไม่ตาม redirect: กัน key ถูกส่งต่อไปโฮสต์อื่น
        redirect: 'error',
        signal: AbortSignal.timeout(req.timeoutMs ?? 100_000),
      })

      if (res.status === 401 || res.status === 403) {
        throw new InvalidApiKeyError('API key ไม่ถูกต้องหรือไม่มีสิทธิ์ใช้รุ่นนี้')
      }
      if (res.status === 429) throw await toRateLimitError(res, 'AI provider')
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new ProviderError(`provider error ${res.status}: ${body.slice(0, 500)}`, res.status)
      }

      const data = (await res.json()) as ChatCompletionsResponse
      const choice = data.choices?.[0]
      const text = choice?.message?.content ?? ''
      if (!text) {
        throw new ProviderError(
          `provider ไม่ส่งข้อความกลับมา (finish_reason: ${choice?.finish_reason ?? 'ไม่ทราบ'}) — ถ้าเป็นรุ่นที่คิดก่อนตอบ ลองเพิ่ม max tokens`
        )
      }
      return {
        text,
        tokensIn: data.usage?.prompt_tokens ?? 0,
        tokensOut: data.usage?.completion_tokens ?? 0,
      }
    },
  }
}
