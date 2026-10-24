import {
  type ProviderAdapter,
  type CompletionRequest,
  type CompletionResult,
  InvalidApiKeyError,
  ProviderError,
} from './types'
import { toRateLimitError } from './rate-limit'

// รูปแบบ response ของ POST /v1/chat/completions เท่าที่เราต้องใช้จริง
interface OpenAIChatResponse {
  choices: Array<{ message: { content: string | null } }>
  usage: { prompt_tokens: number; completion_tokens: number }
}

export const openaiAdapter: ProviderAdapter = {
  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(req.timeoutMs ?? 100_000),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      }),
    })

    if (res.status === 401) throw new InvalidApiKeyError('OpenAI: API key ไม่ถูกต้อง')
    if (res.status === 429) throw await toRateLimitError(res, 'OpenAI')
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ProviderError(`OpenAI error ${res.status}: ${body.slice(0, 500)}`, res.status)
    }

    const data = (await res.json()) as OpenAIChatResponse
    return {
      text: data.choices[0]?.message.content ?? '',
      tokensIn: data.usage.prompt_tokens,
      tokensOut: data.usage.completion_tokens,
    }
  },
}
