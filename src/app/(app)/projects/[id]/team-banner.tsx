'use client'

import { useState } from 'react'
import Link from 'next/link'

export interface TeamSummary {
  id: string
  name: string
  active_project_id: string | null
  active_project_name: string | null
  /** โปรเจกต์ที่ทีมประจำอยู่มีงานค้าง (pending/running) */
  busy: boolean
}

export type TeamLock =
  | { state: 'held' }
  | { state: 'free' }
  | { state: 'elsewhere'; project_id: string; project_name: string; busy: boolean }

export interface TeamInfo {
  team: { id: string; name: string }
  teams: TeamSummary[]
  lock: TeamLock
  /** ทีมอื่นที่ถือโปรเจกต์นี้อยู่ */
  held_by_other: { id: string; name: string } | null
}

const primaryBtn =
  'inline-flex min-h-10 items-center justify-center rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 active:bg-indigo-500 disabled:opacity-50'
const inputCls =
  'block w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-base text-neutral-100 outline-none focus:border-indigo-500'

/** สถานะทีมของโปรเจกต์นี้ — ทีมประจำได้ทีละ 1 โปรเจกต์ */
export default function TeamBanner({
  projectId,
  info,
  onChanged,
}: {
  projectId: string
  info: TeamInfo
  onChanged: () => void | Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { team, teams, lock, held_by_other: other } = info

  async function activate(teamId: string) {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/projects/${projectId}/team`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ team_id: teamId }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown }
        setError(typeof body.error === 'string' ? body.error : 'ทำรายการไม่สำเร็จ')
      }
    } catch {
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้')
    } finally {
      setBusy(false)
      await onChanged()
    }
  }

  const status =
    lock.state === 'held' ? (
      <span className="rounded-full bg-emerald-600/20 px-2.5 py-0.5 text-xs font-medium text-emerald-300">ประจำโปรเจกต์นี้อยู่</span>
    ) : lock.state === 'free' ? (
      <span className="rounded-full bg-neutral-700/50 px-2.5 py-0.5 text-xs font-medium text-neutral-300">ว่าง</span>
    ) : (
      <span className="rounded-full bg-amber-600/20 px-2.5 py-0.5 text-xs font-medium text-amber-300">
        ประจำโปรเจกต์อื่น
      </span>
    )

  return (
    <div className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <p className="text-xs text-neutral-500">ทีม</p>
          <p className="break-words text-[15px] font-semibold text-neutral-100">{team.name}</p>
          {status}
        </div>
        <Link href="/team" className="text-xs text-indigo-400 hover:underline">
          จัดการทีมทั้งหมด
        </Link>
      </div>

      {lock.state === 'free' && (
        <p className="text-sm leading-relaxed text-neutral-400">ทีมนี้ว่างอยู่ — จะเข้าประจำโปรเจกต์นี้เองเมื่อคุณส่งข้อความในแชท</p>
      )}
      {lock.state === 'elsewhere' && (
        <p className="text-sm leading-relaxed text-neutral-400">
          ตอนนี้ทีมประจำโปรเจกต์ &quot;{lock.project_name}&quot;{' '}
          {lock.busy
            ? 'และยังมีงานค้างอยู่ — ต้องรอให้เสร็จ (หรือยกเลิกงาน) ก่อนจึงจะย้ายมาทำโปรเจกต์นี้ได้ หรือเลือกทีมอื่นด้านล่าง'
            : '(ไม่มีงานค้าง) — ส่งข้อความในแชทเพื่อย้ายทีมมาทำโปรเจกต์นี้ ความจำของโปรเจกต์เดิมจะถูกสรุปเก็บไว้ให้'}
        </p>
      )}
      {other && (
        <p className="text-sm leading-relaxed text-amber-300">โปรเจกต์นี้ถูกทีม &quot;{other.name}&quot; ถืออยู่ — เลือกทีมนั้นเพื่อทำต่อ หรือรอให้ทีมนั้นว่าง</p>
      )}

      {teams.length > 1 && (
        <label className="block space-y-1.5">
          <span className="block text-sm font-medium text-neutral-200">เลือกทีมสำหรับโปรเจกต์นี้</span>
          <select
            value={team.id}
            disabled={busy}
            onChange={(e) => void activate(e.target.value)}
            className={inputCls}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.active_project_id === projectId ? ' — ประจำโปรเจกต์นี้' : t.active_project_name ? ` — ทำ "${t.active_project_name}"${t.busy ? ' (งานค้าง)' : ''}` : ' — ว่าง'}
              </option>
            ))}
          </select>
        </label>
      )}

      {lock.state === 'elsewhere' && !lock.busy && (
        <button type="button" disabled={busy} onClick={() => void activate(team.id)} className={primaryBtn}>
          {busy ? 'กำลังย้าย...' : 'ให้ทีมมาทำโปรเจกต์นี้'}
        </button>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2.5 text-sm text-red-300">
          {error}
        </p>
      )}
    </div>
  )
}
