'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ReportKind } from '@/lib/analysis/types'

export function CreateDocButton({
  sessionId,
  kind,
  label,
  disabled,
}: {
  sessionId: string
  kind: ReportKind
  label: string
  disabled: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function create() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/analysis/${sessionId}/report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) setError(body.error ?? 'สร้างเอกสารไม่สำเร็จ')
      else router.refresh()
    } catch {
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={create}
        disabled={disabled || busy}
        className="rounded-md border border-neutral-700 px-4 py-2 text-sm text-neutral-200 transition hover:border-indigo-600 disabled:opacity-50"
      >
        {busy ? 'กำลังสร้าง...' : label}
      </button>
      {error && <p role="alert" className="max-w-md text-xs text-red-400">{error}</p>}
    </div>
  )
}

export function DownloadButton({ content, filename }: { content: string; filename: string }) {
  function download() {
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <button
      type="button"
      onClick={download}
      className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition hover:border-indigo-600"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />
      </svg>
      ดาวน์โหลด .md
    </button>
  )
}
