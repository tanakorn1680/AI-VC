'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { TOKEN_BUDGET_MAX, TOKEN_BUDGET_MIN } from '@/lib/analysis/types'

export interface AgentOption {
  id: string
  name: string
  provider: string
  model: string
  projectName: string
}

const FIELD =
  'w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500'

export default function AnalystSettings({
  sessionId,
  agents,
  agentId,
  tokenBudget,
  locked,
}: {
  sessionId: string
  agents: AgentOption[]
  agentId: string | null
  tokenBudget: number
  /** งานที่เสร็จ/ยกเลิกแล้วไม่ให้แก้ */
  locked: boolean
}) {
  const router = useRouter()
  const [agent, setAgent] = useState(agentId ?? '')
  const [budget, setBudget] = useState(String(tokenBudget))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const dirty = agent !== (agentId ?? '') || Number(budget) !== tokenBudget

  async function save(e: FormEvent) {
    e.preventDefault()
    if (busy || !dirty) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/analysis/${sessionId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ analyst_agent_id: agent || null, token_budget: Number(budget) }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setMessage({ kind: 'error', text: body.error ?? 'บันทึกไม่สำเร็จ' })
      } else {
        setMessage({ kind: 'ok', text: 'บันทึกแล้ว' })
        router.refresh()
      }
    } catch {
      setMessage({ kind: 'error', text: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง' })
    } finally {
      setBusy(false)
    }
  }

  if (agents.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        ยังไม่มี agent ให้เลือก — สร้าง agent พร้อมใส่ API key ที่แท็บ Agents ของ Project Mode ก่อน
        แล้วกลับมาเลือกที่นี่ (ระบบยืมเฉพาะ provider, โมเดล และ key ของ agent นั้น)
      </p>
    )
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <div>
        <label htmlFor="analyst" className="mb-1 block text-xs text-neutral-500">
          Agent ที่ใช้วิเคราะห์
        </label>
        <select
          id="analyst"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          disabled={locked || busy}
          className={FIELD}
        >
          <option value="">— ยังไม่เลือก —</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {a.provider}/{a.model} · {a.projectName}
            </option>
          ))}
        </select>
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
          {busy ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่า'}
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
