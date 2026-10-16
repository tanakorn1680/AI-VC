'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

type StepState = 'continue' | 'waiting' | 'done' | 'blocked' | 'busy' | 'error'
interface StepResponse {
  state?: StepState
  message?: string
  retryAfterSeconds?: number
  error?: string
}

const MAX_STEPS_PER_RUN = 40 // กัน loop ไม่รู้จบฝั่ง client

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export default function RunControls({
  sessionId,
  status,
  label,
}: {
  sessionId: string
  status: string
  label: string
}) {
  const router = useRouter()
  const stopRef = useRef(false)
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<{ text: string; tone: 'info' | 'error' | 'ok' }[]>([])

  // หยุด loop เมื่อออกจากหน้า (สถานะอยู่ใน DB อยู่แล้ว กลับมากดทำต่อได้)
  useEffect(() => () => { stopRef.current = true }, [])

  const push = (text: string, tone: 'info' | 'error' | 'ok' = 'info') =>
    setLog((l) => [...l.slice(-7), { text, tone }])

  async function start() {
    if (running) return
    stopRef.current = false
    setRunning(true)
    setLog([])
    try {
      for (let i = 0; i < MAX_STEPS_PER_RUN && !stopRef.current; i++) {
        const res = await fetch(`/api/analysis/${sessionId}/run`, { method: 'POST' })
        const body = (await res.json().catch(() => ({}))) as StepResponse
        if (!res.ok || !body.state) {
          push(body.error ?? 'เรียกเซิร์ฟเวอร์ไม่สำเร็จ', 'error')
          break
        }
        router.refresh()

        if (body.state === 'continue') {
          push(body.message ?? 'ทำต่อ')
          continue
        }
        if (body.state === 'waiting') {
          const wait = body.retryAfterSeconds ?? 20
          push(`${body.message} (รอ ${wait} วินาที)`)
          for (let s = 0; s < wait && !stopRef.current; s++) await sleep(1000)
          continue
        }
        if (body.state === 'busy') {
          push(body.message ?? 'กำลังมี step อื่นทำงานอยู่')
          await sleep(3000)
          continue
        }
        push(body.message ?? '', body.state === 'done' ? 'ok' : 'error')
        break
      }
      if (stopRef.current) push('หยุดแล้ว — กดทำต่อได้จากสถานะเดิม')
    } catch {
      push('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง', 'error')
    } finally {
      setRunning(false)
      router.refresh()
    }
  }

  const finished = status === 'completed' || status === 'cancelled'

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={start}
          disabled={running || finished}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {running ? 'กำลังวิเคราะห์...' : label}
        </button>
        {running && (
          <button
            type="button"
            onClick={() => { stopRef.current = true }}
            className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-300 transition hover:border-neutral-500"
          >
            หยุด
          </button>
        )}
      </div>
      {log.length > 0 && (
        <ul aria-live="polite" className="space-y-1 text-xs">
          {log.map((l, i) => (
            <li key={i} className={l.tone === 'error' ? 'text-red-400' : l.tone === 'ok' ? 'text-emerald-400' : 'text-neutral-400'}>
              {l.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
