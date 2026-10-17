'use client'

import Link from 'next/link'
import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'

const FIELD =
  'w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500'

export default function HandoffForm({
  sessionId,
  reportId,
  defaultName,
  projects,
  blockedReason,
}: {
  sessionId: string
  reportId: string
  defaultName: string
  projects: { id: string; name: string }[]
  /** ถ้ามีค่า = ส่งต่อไม่ได้ (เช่น ย้อนกลับไปหาหลักฐานไม่ครบ) */
  blockedReason: string | null
}) {
  const router = useRouter()
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  const [name, setName] = useState(defaultName)
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '')
  const [includeEvidence, setIncludeEvidence] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ projectId: string; files: string[] } | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy || blockedReason) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/analysis/${sessionId}/handoff`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          report_id: reportId,
          mode,
          name: mode === 'new' ? name : undefined,
          project_id: mode === 'existing' ? projectId : undefined,
          include_evidence: includeEvidence,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string; project_id?: string; files?: string[] }
      if (!res.ok || !body.project_id) {
        setError(body.error ?? 'ส่งต่อไม่สำเร็จ')
      } else {
        setDone({ projectId: body.project_id, files: body.files ?? [] })
        router.refresh()
      }
    } catch {
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง')
    } finally {
      setBusy(false)
    }
  }

  if (blockedReason) {
    return <p role="alert" className="text-xs text-amber-400">ส่งต่อไม่ได้: {blockedReason}</p>
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <fieldset className="flex flex-wrap gap-4 text-sm text-neutral-300">
        <legend className="sr-only">รูปแบบการส่งต่อ</legend>
        <label className="inline-flex items-center gap-2">
          <input type="radio" name="mode" checked={mode === 'new'} onChange={() => setMode('new')} />
          สร้างโปรเจกต์ใหม่
        </label>
        <label className={`inline-flex items-center gap-2 ${projects.length === 0 ? 'opacity-50' : ''}`}>
          <input
            type="radio"
            name="mode"
            checked={mode === 'existing'}
            disabled={projects.length === 0}
            onChange={() => setMode('existing')}
          />
          ส่งไปโปรเจกต์เดิม
        </label>
      </fieldset>

      {mode === 'new' ? (
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} aria-label="ชื่อโปรเจกต์ใหม่" className={FIELD} />
      ) : (
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="โปรเจกต์ปลายทาง" className={FIELD}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}

      <label className="flex items-start gap-2 text-sm text-neutral-300">
        <input type="checkbox" checked={includeEvidence} onChange={(e) => setIncludeEvidence(e.target.checked)} className="mt-1" />
        <span>
          แนบหลักฐานอ้างอิง (เฉพาะข้อค้นพบที่ข้อกำหนดอ้างถึง)
          <span className="block text-xs text-neutral-500">
            ไม่ส่งไฟล์ต้นทาง ผลดิบของเครื่องมือ ประวัติการวิเคราะห์ หรือ API key ไปยัง Project Mode
          </span>
        </span>
      </label>

      <button
        type="submit"
        disabled={busy || (mode === 'new' && !name.trim()) || (mode === 'existing' && !projectId)}
        className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium transition hover:bg-indigo-500 disabled:opacity-50"
      >
        {busy ? 'กำลังส่งต่อ...' : 'ส่งต่อไป Project Mode'}
      </button>

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      {done && (
        <p role="status" className="text-sm text-emerald-400">
          ส่งต่อแล้ว {done.files.length} ไฟล์ ·{' '}
          <Link href={`/projects/${done.projectId}`} className="underline hover:text-emerald-300">
            เปิดโปรเจกต์
          </Link>
        </p>
      )}
    </form>
  )
}
