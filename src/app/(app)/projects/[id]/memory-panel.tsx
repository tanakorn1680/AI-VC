'use client'

import { useCallback, useEffect, useState } from 'react'

interface MemoryState {
  brief: string
  refresh_count: number
  last_refreshed_at: string | null
  /** ข้อความที่ยังไม่ถูกสรุปลง brief (ส่งให้ AI แบบดิบ) */
  pending_messages: number
  pending_tokens: number
  refresh_trigger_tokens: number
  brief_max_chars: number
}

const primaryBtn =
  'inline-flex min-h-11 items-center justify-center rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 active:bg-indigo-500 disabled:opacity-50'
const ghostBtn =
  'inline-flex min-h-10 items-center justify-center rounded-lg border border-neutral-700 px-3.5 py-2 text-sm text-neutral-200 transition hover:bg-neutral-800 active:bg-neutral-800 disabled:opacity-50'

function formatStamp(iso: string | null): string {
  if (!iso) return 'ยังไม่เคย'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
}

/**
 * ความจำโปรเจกต์: AI ไม่ได้อ่านแชททั้งหมดทุกครั้ง แต่อ่าน "brief" (สรุป) + ข้อความล่าสุด
 * เมื่อแชทเกินงบ ระบบสรุปของเก่าลง brief เอง — แก้เอง สั่งสรุปทันที หรือเริ่มบทสนทนาใหม่ได้จากที่นี่
 */
export default function MemoryPanel({ projectId }: { projectId: string }) {
  const [mem, setMem] = useState<MemoryState | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'save' | 'refresh' | 'reset' | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/memory`)
      if (!res.ok) return
      const data = (await res.json()) as MemoryState
      setMem(data)
      setDirty((d) => {
        if (!d) setDraft(data.brief)
        return d
      })
    } catch {
      // เครือข่ายหลุดชั่วคราว
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  async function act(action: 'save' | 'refresh' | 'reset') {
    setBusy(action)
    setError('')
    setNotice('')
    try {
      const res = await fetch(`/api/projects/${projectId}/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, brief: action === 'save' ? draft : undefined }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: unknown; refreshed?: boolean; folded?: number }
      if (!res.ok) {
        setError(typeof data.error === 'string' ? data.error : 'ทำรายการไม่สำเร็จ')
        return
      }
      setDirty(false)
      if (action === 'save') setNotice('บันทึกความจำแล้ว')
      if (action === 'reset') setNotice('เริ่มบทสนทนาใหม่แล้ว — AI จะไม่เห็นข้อความเก่าอีก (ข้อความในแชทยังอยู่ครบ)')
      if (action === 'refresh') setNotice(data.refreshed ? `สรุป ${data.folded ?? 0} ข้อความลงความจำแล้ว` : 'ยังไม่มีอะไรให้สรุปเพิ่ม')
      await load()
    } catch {
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้')
    } finally {
      setBusy(null)
    }
  }

  const pct = mem ? Math.min(100, Math.round((mem.pending_tokens / Math.max(1, mem.refresh_trigger_tokens)) * 100)) : 0

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-neutral-100">ความจำโปรเจกต์</h2>
        <p className="mt-1 text-sm leading-relaxed text-neutral-400">
          AI ไม่อ่านแชททั้งหมดทุกครั้ง (ยาวไปจะช้า แพง และหลุดประเด็น) แต่อ่านสรุปด้านล่างกับข้อความล่าสุด เมื่อแชทยาวเกินงบ ระบบสรุปของเก่าลงที่นี่ให้เองอัตโนมัติ
        </p>
      </div>

      {mem && (
        <div className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
          <div className="flex items-center justify-between text-xs text-neutral-400">
            <span>แชทที่ยังไม่ถูกสรุป · {mem.pending_messages} ข้อความ</span>
            <span>
              ~{mem.pending_tokens.toLocaleString('th-TH')} / {mem.refresh_trigger_tokens.toLocaleString('th-TH')} token
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={`h-full rounded-full ${pct >= 100 ? 'bg-amber-500' : 'bg-indigo-500'}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-neutral-500">
            สรุปอัตโนมัติมาแล้ว {mem.refresh_count} ครั้ง · ล่าสุด {formatStamp(mem.last_refreshed_at)}
          </p>
        </div>
      )}

      <label className="block space-y-1.5">
        <span className="block text-sm font-medium text-neutral-200">สรุปที่ AI เห็น (แก้เองได้)</span>
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setDirty(true)
          }}
          rows={12}
          maxLength={mem?.brief_max_chars ?? 3000}
          placeholder="ยังไม่มีสรุป — จะถูกสร้างอัตโนมัติเมื่อแชทยาวขึ้น หรือกด “สรุปตอนนี้”"
          className="block w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-sm leading-relaxed text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-indigo-500"
        />
        <span className="block text-xs text-neutral-500">
          {draft.length.toLocaleString('th-TH')} / {(mem?.brief_max_chars ?? 3000).toLocaleString('th-TH')} ตัวอักษร
        </span>
      </label>

      {notice && (
        <p role="status" className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2.5 text-sm text-emerald-300">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2.5 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy !== null || !dirty} onClick={() => void act('save')} className={primaryBtn}>
          {busy === 'save' ? 'กำลังบันทึก...' : 'บันทึก'}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void act('refresh')} className={ghostBtn}>
          {busy === 'refresh' ? 'กำลังสรุป...' : 'สรุปตอนนี้'}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => {
            if (window.confirm('เริ่มบทสนทนาใหม่? ความจำสรุปจะถูกล้าง และ AI จะไม่เห็นข้อความเก่าอีก (ข้อความในแชทยังอยู่)')) void act('reset')
          }}
          className={`${ghostBtn} border-red-900/60 text-red-300 hover:bg-red-950/40`}
        >
          เริ่มบทสนทนาใหม่
        </button>
      </div>
    </section>
  )
}
