'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import AgentsPanel, { type Agent } from '@/app/(app)/projects/[id]/agents-panel'

interface TeamItem {
  id: string
  name: string
  agent_count: number
  active_project: { id: string; name: string; busy: boolean } | null
}

const primaryBtn =
  'inline-flex min-h-10 items-center justify-center rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 active:bg-indigo-500 disabled:opacity-50'
const ghostBtn =
  'inline-flex min-h-10 items-center justify-center rounded-lg border border-neutral-700 px-3.5 py-2 text-sm text-neutral-200 transition hover:bg-neutral-800 active:bg-neutral-800 disabled:opacity-50'
const inputCls =
  'block w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-base text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-indigo-500'

async function call(url: string, init?: RequestInit): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(url, init)
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, data }
}
const JSON_HEADERS = { 'content-type': 'application/json' }

export default function TeamManager() {
  const [teams, setTeams] = useState<TeamItem[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [newName, setNewName] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const loadTeams = useCallback(async () => {
    const { ok, data } = await call('/api/teams').catch(() => ({ ok: false, data: { error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' } }))
    if (!ok) {
      setError(data.error ?? 'โหลดทีมไม่สำเร็จ')
      setTeams((t) => t ?? [])
      return
    }
    const list = (data.teams ?? []) as TeamItem[]
    setTeams(list)
    setSelectedId((cur) => (cur && list.some((t) => t.id === cur) ? cur : (list[0]?.id ?? null)))
  }, [])

  const loadAgents = useCallback(async (teamId: string) => {
    const { ok, data } = await call(`/api/teams/${teamId}/agents`).catch(() => ({ ok: false, data: {} }))
    if (ok) setAgents((data.agents ?? []) as Agent[])
  }, [])

  useEffect(() => {
    void loadTeams()
  }, [loadTeams])

  useEffect(() => {
    if (selectedId) void loadAgents(selectedId)
    else setAgents([])
  }, [selectedId, loadAgents])

  const selected = teams?.find((t) => t.id === selectedId) ?? null

  async function refreshAll() {
    await loadTeams()
    if (selectedId) await loadAgents(selectedId)
  }

  async function createTeam(e: FormEvent) {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    setBusy(true)
    setError('')
    setNotice('')
    const { ok, data } = await call('/api/teams', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name }) }).catch(() => ({
      ok: false,
      data: { error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' },
    }))
    setBusy(false)
    if (!ok) {
      setError(data.error ?? 'สร้างทีมไม่สำเร็จ')
      return
    }
    setNewName('')
    setNotice(`สร้างทีม "${name}" แล้ว — เพิ่ม AI เข้าทีมได้ด้านล่าง`)
    await loadTeams()
    if (data.team?.id) setSelectedId(data.team.id)
  }

  async function rename(e: FormEvent) {
    e.preventDefault()
    if (!selected || !renameValue.trim()) return
    setBusy(true)
    setError('')
    const { ok, data } = await call(`/api/teams/${selected.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: renameValue.trim() }),
    }).catch(() => ({ ok: false, data: { error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' } }))
    setBusy(false)
    if (!ok) {
      setError(data.error ?? 'เปลี่ยนชื่อไม่สำเร็จ')
      return
    }
    setRenaming(false)
    await loadTeams()
  }

  async function release() {
    if (!selected) return
    setBusy(true)
    setError('')
    setNotice('')
    const { ok, data } = await call(`/api/teams/${selected.id}/release`, { method: 'POST' }).catch(() => ({
      ok: false,
      data: { error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' },
    }))
    setBusy(false)
    if (!ok) setError(data.error ?? 'พักทีมไม่สำเร็จ')
    else setNotice('พักทีมแล้ว — เลือกโปรเจกต์ใหม่ได้')
    await loadTeams()
  }

  async function remove() {
    if (!selected) return
    if (!window.confirm(`ลบทีม "${selected.name}"? AI ทั้งหมดในทีมและ API key ของมันจะถูกลบ`)) return
    setBusy(true)
    setError('')
    setNotice('')
    const { ok, data } = await call(`/api/teams/${selected.id}`, { method: 'DELETE' }).catch(() => ({
      ok: false,
      data: { error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' },
    }))
    setBusy(false)
    if (!ok) setError(data.error ?? 'ลบทีมไม่สำเร็จ')
    else setNotice(`ลบทีม "${selected.name}" แล้ว`)
    setSelectedId(null)
    await loadTeams()
  }

  if (teams === null) return <p className="text-sm text-neutral-500">กำลังโหลด...</p>

  return (
    <div className="space-y-6">
      <p className="text-sm leading-relaxed text-neutral-400">
        AI เป็นของ &quot;ทีม&quot; ใช้ร่วมกันได้ทุกโปรเจกต์ แต่ทีมหนึ่งทำได้ทีละ 1 โปรเจกต์ — อยากทำหลายโปรเจกต์พร้อมกันให้สร้างหลายทีม
      </p>

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

      <ul className="space-y-2">
        {teams.map((t) => {
          const active = t.id === selectedId
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  setSelectedId(t.id)
                  setRenaming(false)
                  setNotice('')
                  setError('')
                }}
                aria-current={active ? 'true' : undefined}
                className={`flex w-full items-center justify-between gap-3 rounded-xl border p-4 text-left transition ${
                  active ? 'border-indigo-600 bg-neutral-900' : 'border-neutral-800 bg-neutral-900/60 hover:border-neutral-700'
                }`}
              >
                <span className="min-w-0">
                  <span className="block truncate font-medium text-neutral-100">{t.name}</span>
                  <span className="block text-xs text-neutral-500">{t.agent_count} AI</span>
                </span>
                {t.active_project ? (
                  <span className="shrink-0 rounded-full bg-amber-600/20 px-2.5 py-0.5 text-xs text-amber-300">
                    ทำ &quot;{t.active_project.name}&quot;{t.active_project.busy ? ' · มีงานค้าง' : ''}
                  </span>
                ) : (
                  <span className="shrink-0 rounded-full bg-neutral-700/50 px-2.5 py-0.5 text-xs text-neutral-300">ว่าง</span>
                )}
              </button>
            </li>
          )
        })}
      </ul>

      <form onSubmit={createTeam} className="flex gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          maxLength={100}
          placeholder="ชื่อทีมใหม่"
          aria-label="ชื่อทีมใหม่"
          className={inputCls}
        />
        <button type="submit" disabled={busy || !newName.trim()} className={`${primaryBtn} shrink-0`}>
          สร้างทีม
        </button>
      </form>

      {selected && (
        <div className="space-y-4 border-t border-neutral-800 pt-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            {renaming ? (
              <form onSubmit={rename} className="flex w-full gap-2">
                <input value={renameValue} onChange={(e) => setRenameValue(e.target.value)} maxLength={100} className={inputCls} aria-label="ชื่อทีม" />
                <button type="submit" disabled={busy} className={`${primaryBtn} shrink-0`}>
                  บันทึก
                </button>
                <button type="button" onClick={() => setRenaming(false)} className={`${ghostBtn} shrink-0`}>
                  ยกเลิก
                </button>
              </form>
            ) : (
              <>
                <h2 className="text-lg font-semibold text-neutral-100">{selected.name}</h2>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setRenameValue(selected.name)
                      setRenaming(true)
                    }}
                    className={ghostBtn}
                  >
                    เปลี่ยนชื่อ
                  </button>
                  {selected.active_project && (
                    <button type="button" disabled={busy || selected.active_project.busy} onClick={() => void release()} className={ghostBtn}>
                      พักทีม
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={() => void remove()} className={`${ghostBtn} border-red-900/60 text-red-300 hover:bg-red-950/40`}>
                    ลบทีม
                  </button>
                </div>
              </>
            )}
          </div>
          {selected.active_project && (
            <p className="text-sm text-neutral-400">
              ตอนนี้ประจำโปรเจกต์ &quot;{selected.active_project.name}&quot;
              {selected.active_project.busy ? ' และยังมีงานค้าง — พักทีมไม่ได้จนกว่าจะเสร็จหรือยกเลิกงาน' : ' (ไม่มีงานค้าง — พักทีมเพื่อให้โปรเจกต์อื่นใช้ได้)'}
            </p>
          )}

          <AgentsPanel apiBase={`/api/teams/${selected.id}`} agents={agents} onChanged={refreshAll} />
        </div>
      )}
    </div>
  )
}
