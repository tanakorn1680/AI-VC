'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { CANCELLABLE_STATUSES, GOAL_MAX, TITLE_MAX, type AnalysisSession } from '@/lib/analysis/types'
import { EditIcon, StopIcon, TrashIcon } from '../components/icons'

const FIELD =
  'w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500'
const BTN =
  'inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition hover:border-neutral-500 disabled:opacity-50'

type Mode = 'idle' | 'edit' | 'confirm-cancel' | 'confirm-delete'

export default function SessionControls({ session }: { session: AnalysisSession }) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('idle')
  const [title, setTitle] = useState(session.title)
  const [goal, setGoal] = useState(session.goal)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const canCancel = CANCELLABLE_STATUSES.includes(session.status)

  async function request(method: 'PATCH' | 'DELETE', payload?: Record<string, unknown>) {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/analysis/${session.id}`, {
        method,
        headers: payload ? { 'content-type': 'application/json' } : undefined,
        body: payload ? JSON.stringify(payload) : undefined,
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) {
        setError(body.error ?? 'ดำเนินการไม่สำเร็จ')
        setBusy(false)
        return false
      }
      setBusy(false)
      return true
    } catch {
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง')
      setBusy(false)
      return false
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!title.trim()) {
      setError('ชื่องานต้องไม่ว่าง')
      return
    }
    if (await request('PATCH', { title, goal })) {
      setMode('idle')
      router.refresh()
    }
  }

  async function handleCancel() {
    if (await request('PATCH', { status: 'cancelled' })) {
      setMode('idle')
      router.refresh()
    }
  }

  async function handleDelete() {
    if (await request('DELETE')) router.push('/reverse-engineering')
  }

  if (mode === 'edit') {
    return (
      <form onSubmit={handleSave} className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TITLE_MAX}
          aria-label="ชื่องาน"
          className={FIELD}
        />
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={GOAL_MAX}
          rows={5}
          aria-label="เป้าหมายการวิเคราะห์"
          className={`${FIELD} resize-y`}
        />
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium transition hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? 'กำลังบันทึก...' : 'บันทึก'}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('idle')
              setTitle(session.title)
              setGoal(session.goal)
              setError('')
            }}
            className={BTN}
          >
            ยกเลิกการแก้ไข
          </button>
        </div>
      </form>
    )
  }

  if (mode === 'confirm-cancel' || mode === 'confirm-delete') {
    const deleting = mode === 'confirm-delete'
    return (
      <div className="space-y-3 rounded-lg border border-red-900/60 bg-red-950/20 p-4">
        <p className="text-sm text-neutral-200">
          {deleting
            ? 'ลบงานนี้ถาวร? ข้อมูลทั้งหมดของงาน (ขั้นตอน หลักฐาน รายงาน) จะถูกลบและกู้คืนไม่ได้'
            : 'ยกเลิกงานนี้? งานที่ยกเลิกแล้วจะกลับมาทำต่อไม่ได้'}
        </p>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={deleting ? handleDelete : handleCancel}
            className="rounded-md bg-red-600 px-4 py-1.5 text-sm font-medium transition hover:bg-red-500 disabled:opacity-50"
          >
            {busy ? 'กำลังดำเนินการ...' : deleting ? 'ยืนยันการลบ' : 'ยืนยันการยกเลิกงาน'}
          </button>
          <button
            type="button"
            onClick={() => {
              setMode('idle')
              setError('')
            }}
            className={BTN}
          >
            กลับ
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => setMode('edit')} className={BTN}>
        <EditIcon size={15} />
        แก้ไข
      </button>
      {canCancel && (
        <button type="button" onClick={() => setMode('confirm-cancel')} className={BTN}>
          <StopIcon size={15} />
          ยกเลิกงาน
        </button>
      )}
      <button type="button" onClick={() => setMode('confirm-delete')} className={`${BTN} hover:border-red-700 hover:text-red-300`}>
        <TrashIcon size={15} />
        ลบ
      </button>
    </div>
  )
}
