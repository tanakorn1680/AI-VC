'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import {
  GOAL_MAX,
  TARGET_KINDS,
  TARGET_KIND_LABELS,
  TITLE_MAX,
  type TargetKind,
} from '@/lib/analysis/types'
import { InfoIcon } from '../components/icons'

const FIELD =
  'w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm outline-none transition focus:border-indigo-500'

export default function NewSessionForm() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [targetKind, setTargetKind] = useState<TargetKind>('unspecified')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (loading) return
    if (!title.trim()) {
      setError('กรุณาระบุชื่องานวิเคราะห์')
      return
    }
    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/analysis', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, goal, target_kind: targetKind }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        error?: string
        session?: { id: string }
      }
      if (!res.ok || !body.session) {
        setError(body.error ?? 'สร้างงานวิเคราะห์ไม่สำเร็จ')
        setLoading(false)
        return
      }
      router.push(`/reverse-engineering/${body.session.id}`)
    } catch {
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง')
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label htmlFor="title" className="mb-1.5 block text-sm font-medium text-neutral-300">
          ชื่องาน
        </label>
        <input
          id="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={TITLE_MAX}
          placeholder="เช่น วิเคราะห์ระบบคำนวณราคาของแอปเดิม"
          className={FIELD}
          autoFocus
        />
      </div>

      <div>
        <label htmlFor="goal" className="mb-1.5 block text-sm font-medium text-neutral-300">
          เป้าหมายการวิเคราะห์
        </label>
        <textarea
          id="goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={GOAL_MAX}
          rows={5}
          placeholder="เช่น ค้นหาวิธีคำนวณ ค้นหาเส้นทางข้อมูล หรือทำความเข้าใจโครงสร้างระบบ"
          className={`${FIELD} resize-y`}
        />
      </div>

      <div>
        <label htmlFor="kind" className="mb-1.5 block text-sm font-medium text-neutral-300">
          ประเภทเป้าหมาย
        </label>
        <select
          id="kind"
          value={targetKind}
          onChange={(e) => setTargetKind(e.target.value as TargetKind)}
          className={FIELD}
        >
          {TARGET_KINDS.map((k) => (
            <option key={k} value={k}>
              {TARGET_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-neutral-800 bg-neutral-900/50 px-3 py-2.5 text-xs leading-relaxed text-neutral-500">
        <span className="mt-0.5 shrink-0 text-neutral-400">
          <InfoIcon size={14} />
        </span>
        <p>
          ระยะนี้ระบบบันทึกชื่อ เป้าหมาย และประเภทที่คุณระบุเท่านั้น ยังไม่รองรับการนำเข้าไฟล์
          และยังไม่มีเครื่องมือวิเคราะห์ ซึ่งจะเปิดใช้หลังตรวจสอบเครื่องมือจริงในระยะถัดไป
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={loading}
          className="rounded-md bg-indigo-600 px-5 py-2 text-sm font-medium transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {loading ? 'กำลังสร้าง...' : 'สร้างงานวิเคราะห์'}
        </button>
        <button
          type="button"
          onClick={() => router.push('/reverse-engineering')}
          className="rounded-md border border-neutral-700 px-5 py-2 text-sm text-neutral-300 transition hover:border-neutral-500"
        >
          ยกเลิก
        </button>
      </div>
    </form>
  )
}
