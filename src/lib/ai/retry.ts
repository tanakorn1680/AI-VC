import {
  type ProviderAdapter,
  type CompletionRequest,
  type CompletionResult,
  ProviderError,
  ProviderTimeoutError,
  RateLimitError,
} from './types'

// ข้อผิดพลาดฝั่งผู้ให้บริการที่มักหายเองในไม่กี่วินาที (เช่น Gemini 503 "high demand", Anthropic 529 overloaded)
const TRANSIENT_STATUS = new Set([500, 502, 503, 504, 529])

export interface RetryOptions {
  /** หน่วงก่อนลองใหม่แต่ละรอบเมื่อเจอ error ชั่วคราว (มิลลิวินาที) */
  transientDelaysMs?: readonly number[]
  /**
   * ถ้า provider บอกให้รอไม่เกินกี่วินาทีเมื่อชน rate limit ให้รอแล้วลองใหม่ 1 ครั้งในคำขอเดียวกัน
   * ใช้กับขั้นวางแผน (อยู่ในคำขอ HTTP ของผู้ใช้) — Worker ไม่ใช้ เพราะ Worker หน่วงผ่านคิวแทน
   */
  rateLimitWaitMaxSeconds?: number
  /** เวลาสิ้นสุด (epoch ms) ของ step ที่เรียกอยู่ — ทุกคำขอถูกจำกัดเวลาให้จบก่อนถึงจุดนี้ ไม่งั้นฟังก์ชันของ platform จะถูกตัด (HTTP 504) */
  deadlineAt?: number
}

const MIN_ATTEMPT_MS = 5_000
const RESERVE_MS = 2_000 // กันเวลาไว้เขียนผล/ตอบกลับหลังเรียก AI เสร็จ
const isAbort = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')

/**
 * เรียก adapter.complete พร้อม retry สั้น ๆ เมื่อเจอ error ชั่วคราวของ provider
 * ไม่ retry: key ผิด (InvalidApiKeyError) และ error 4xx อื่น ๆ ที่ลองซ้ำก็ไม่หาย
 */
export async function completeWithRetry(
  adapter: ProviderAdapter,
  req: CompletionRequest,
  opts: RetryOptions = {}
): Promise<CompletionResult> {
  const delays = opts.transientDelaysMs ?? [1500, 4000]
  const rlMax = opts.rateLimitWaitMaxSeconds ?? 0
  let rateLimitRetried = false

  for (let attempt = 0; ; attempt++) {
    let attemptReq = req
    if (opts.deadlineAt !== undefined) {
      const remaining = opts.deadlineAt - Date.now() - RESERVE_MS
      if (remaining < MIN_ATTEMPT_MS) throw new ProviderTimeoutError('เหลือเวลาของ step นี้ไม่พอสำหรับเรียก AI')
      attemptReq = { ...req, timeoutMs: Math.min(req.timeoutMs ?? 100_000, remaining) }
    }
    try {
      return await adapter.complete(attemptReq)
    } catch (err) {
      // ตอบช้าเกินเพดานเวลา: ไม่ลองซ้ำในที่เดิม (จะช้าซ้ำและกินเวลา step) ให้ผู้เรียกส่งต่อ agent อื่นหรือรอรอบถัดไป
      if (isAbort(err)) {
        throw new ProviderTimeoutError(`AI ตอบช้าเกิน ${Math.round((attemptReq.timeoutMs ?? 100_000) / 1000)} วินาที`)
      }
      if (
        err instanceof RateLimitError &&
        !rateLimitRetried &&
        err.retryAfterSeconds !== undefined &&
        err.retryAfterSeconds <= rlMax
      ) {
        rateLimitRetried = true
        await new Promise((resolve) => setTimeout(resolve, err.retryAfterSeconds! * 1000 + 500))
        attempt-- // การรอ rate limit ไม่กินโควตารอบของ error ชั่วคราว
        continue
      }

      const status = err instanceof ProviderError ? err.status : undefined
      const transient = status !== undefined && TRANSIENT_STATUS.has(status)
      if (!transient) throw err
      if (attempt >= delays.length) {
        throw new ProviderError(
          `AI provider ไม่ว่างชั่วคราว (HTTP ${status}) ลองใหม่อีกครั้งในอีกสักครู่\n${(err as Error).message}`,
          status
        )
      }
      const delay = delays[attempt] as number
      if (opts.deadlineAt !== undefined && Date.now() + delay + MIN_ATTEMPT_MS + RESERVE_MS > opts.deadlineAt) {
        throw new ProviderError(`AI provider ไม่ว่างชั่วคราว (HTTP ${status}) ลองใหม่อีกครั้งในอีกสักครู่\n${(err as Error).message}`, status)
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
