'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function RunToolButton({
  sessionId,
  artifactId,
  toolId,
  label,
}: {
  sessionId: string
  artifactId: string
  toolId: string
  label: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/analysis/${sessionId}/tools/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool_id: toolId, artifact_id: artifactId }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) setError(body.error ?? 'รันเครื่องมือไม่สำเร็จ')
    } catch {
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง')
    } finally {
      setBusy(false)
      router.refresh() // รวมกรณีล้มเหลว: ประวัติ run ถูกบันทึกแล้ว
    }
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="rounded-md border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 transition hover:border-indigo-600 disabled:opacity-50"
      >
        {busy ? 'กำลังรัน...' : label}
      </button>
      {error && <span role="alert" className="text-xs text-red-400">{error}</span>}
    </span>
  )
}
