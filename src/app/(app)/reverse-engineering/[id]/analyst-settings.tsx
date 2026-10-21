'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { TOKEN_BUDGET_MAX, TOKEN_BUDGET_MIN } from '@/lib/analysis/types'

export interface TeamOption {
  id: string
  name: string
  agentCount: number
}

export interface TeamMemberView {
  id: string
  name: string
  provider: string
  model: string
  role: string
  /** เพดานคำขอ (token) ที่ระบบใช้กับ agent ตัวนี้ — เดาจากรุ่นแล้วเรียนรู้จาก error ของ provider */
  limit: number
}

export interface TeamView {
  teams: TeamOption[]
  /** ทีมที่ผู้ใช้เลือกไว้ (null = อัตโนมัติ) */
  selectedTeamId: string | null
  /** ทีมที่ระบบจะใช้จริง */
  resolvedTeamId: string | null
  members: TeamMemberView[]
}

const ROLE_LABEL: Record<string, string> = { manager: 'ผู้นำทีม (วางแผน)', reviewer: 'ผู้ตรวจทาน', custom: 'ผู้เชี่ยวชาญ' }

const FIELD =
  'w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500'

export default function AnalystSettings({
  sessionId,
  view,
  tokenBudget,
  locked,
}: {
  sessionId: string
  view: TeamView
  tokenBudget: number
  /** งานที่เสร็จ/ยกเลิกแล้วไม่ให้แก้ */
  locked: boolean
}) {
  const router = useRouter()
  const [team, setTeam] = useState(view.selectedTeamId ?? '')
  const [budget, setBudget] = useState(String(tokenBudget))
  const [savingTeam, setSavingTeam] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // ทีมบันทึกอัตโนมัติทันทีที่เลือก ปุ่มบันทึกใช้กับงบ token เท่านั้น
  const dirty = Number(budget) !== tokenBudget

  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setMessage(null)
    try {
      const res = await fetch(`/api/analysis/${sessionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setMessage({ kind: 'error', text: data.error ?? 'บันทึกไม่สำเร็จ' })
        return false
      }
      setMessage({ kind: 'ok', text: 'บันทึกแล้ว' })
      router.refresh()
      return true
    } catch {
      setMessage({ kind: 'error', text: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง' })
      return false
    }
  }

  async function changeTeam(next: string) {
    const previous = team
    setTeam(next)
    setSavingTeam(true)
    const ok = await patch({ analyst_team_id: next || null })
    if (!ok) setTeam(previous)
    setSavingTeam(false)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy || !dirty) return
    setBusy(true)
    await patch({ token_budget: Number(budget) })
    setBusy(false)
  }

  if (view.members.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        ทีม AI ยังไม่มี agent — เพิ่ม agent พร้อมใส่ API key ที่เมนู &quot;ทีม AI&quot; ก่อน แล้วกลับมากดเริ่มวิเคราะห์
        ระบบจะใช้ agent ทุกตัวในทีมช่วยกันทำงานพร้อมกัน ไม่ต้องเลือกทีละตัว
      </p>
    )
  }

  return (
    <form onSubmit={save} className="space-y-3">
      {view.teams.length > 1 && (
        <div>
          <label htmlFor="team" className="mb-1 block text-xs text-neutral-500">
            ทีม AI ที่ช่วยกันวิเคราะห์
          </label>
          <select
            id="team"
            value={team}
            onChange={(e) => void changeTeam(e.target.value)}
            disabled={locked || busy || savingTeam}
            className={FIELD}
          >
            <option value="">อัตโนมัติ (ทีมแรกที่มี agent)</option>
            {view.teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.agentCount} agent
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <p className="mb-1 text-xs text-neutral-500">
          สมาชิกที่ทำงานพร้อมกัน ({view.members.length} agent) — ระบบแบ่งงานตามขนาดที่แต่ละตัวรับได้ และส่งต่อให้ตัวอื่นเองเมื่อชนเพดาน/โควตา
        </p>
        <ul className="divide-y divide-neutral-800 rounded-md border border-neutral-800">
          {view.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="text-neutral-200">
                {m.name} <span className="text-xs text-neutral-500">· {m.provider}/{m.model}</span>
              </span>
              <span className="text-xs text-neutral-400">
                {ROLE_LABEL[m.role] ?? m.role} · รับได้ ~{m.limit.toLocaleString('en-US')} โทเคน/คำขอ
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <label htmlFor="budget" className="mb-1 block text-xs text-neutral-500">
          งบ token รวมของงานนี้ ({TOKEN_BUDGET_MIN.toLocaleString('en-US')}–{TOKEN_BUDGET_MAX.toLocaleString('en-US')})
        </label>
        <input
          id="budget"
          type="number"
          inputMode="numeric"
          min={TOKEN_BUDGET_MIN}
          max={TOKEN_BUDGET_MAX}
          step={10000}
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
          disabled={locked || busy}
          className={FIELD}
        />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={locked || busy || !dirty}
          className="rounded-md border border-neutral-700 px-4 py-1.5 text-sm text-neutral-200 transition hover:border-indigo-600 disabled:opacity-50"
        >
          {busy ? 'กำลังบันทึก...' : 'บันทึกงบ token'}
        </button>
        {message && (
          <span role={message.kind === 'error' ? 'alert' : 'status'} className={`text-sm ${message.kind === 'error' ? 'text-red-400' : 'text-emerald-400'}`}>
            {message.text}
          </span>
        )}
      </div>
    </form>
  )
}
