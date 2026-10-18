'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ANALYSIS_BUCKET, MAX_ARTIFACT_BYTES } from '@/lib/analysis/limits'

type Phase = 'idle' | 'preparing' | 'uploading' | 'registering'

const PHASE_LABEL: Record<Phase, string> = {
  idle: '',
  preparing: 'กำลังเตรียมการอัปโหลด...',
  uploading: 'กำลังอัปโหลด...',
  registering: 'กำลังตรวจสอบไฟล์...',
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new Error(body.error ?? 'ดำเนินการไม่สำเร็จ')
  return body as T
}

/** ข้อความสถานะ + ปุ่ม + ลอยมุมขวาล่างสำหรับเลือกไฟล์เป้าหมาย */
export default function ArtifactUploader({ sessionId }: { sessionId: string }) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const busy = phase !== 'idle'

  async function handleFile(file: File) {
    setError('')
    if (file.size === 0) return setError('ไฟล์ว่างเปล่า')
    if (file.size > MAX_ARTIFACT_BYTES) {
      return setError(`ไฟล์ใหญ่เกิน ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB`)
    }
    try {
      setPhase('preparing')
      const init = await postJson<{ object_id: string; path: string; token: string }>(
        `/api/analysis/${sessionId}/artifacts/upload`,
        { name: file.name, size: file.size }
      )

      setPhase('uploading')
      const { error: upErr } = await createClient()
        .storage.from(ANALYSIS_BUCKET)
        .uploadToSignedUrl(init.path, init.token, file)
      if (upErr) throw new Error('อัปโหลดไฟล์ไม่สำเร็จ')

      setPhase('registering')
      await postJson(`/api/analysis/${sessionId}/artifacts/complete`, {
        object_id: init.object_id,
        name: file.name,
      })
      router.refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setPhase('idle')
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div className="mb-3">
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        id="artifact-file"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void handleFile(f)
        }}
      />
      <p className="text-xs text-neutral-500" aria-live="polite">
        {busy
          ? PHASE_LABEL[phase]
          : `แตะปุ่ม + เพื่อเลือกไฟล์เป้าหมาย · ไฟล์ละไม่เกิน ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB · ระบบตรวจชนิดจากเนื้อไฟล์ ไม่ใช่นามสกุล`}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {error}
        </p>
      )}
      <label
        htmlFor="artifact-file"
        aria-label="เลือกไฟล์เป้าหมาย"
        className={`fixed right-5 z-40 grid size-14 cursor-pointer place-items-center rounded-full bg-blue-600 text-white shadow-lg transition hover:bg-blue-500 ${
          busy ? 'pointer-events-none opacity-70' : ''
        }`}
        style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}
      >
        {busy ? (
          <svg className="animate-spin" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 3a9 9 0 1 0 9 9" />
          </svg>
        ) : (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        )}
      </label>
    </div>
  )
}
