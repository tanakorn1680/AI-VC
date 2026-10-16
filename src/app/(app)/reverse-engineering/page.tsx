import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { formatDateTime } from '@/lib/analysis/format'
import {
  SESSION_COLUMNS,
  TARGET_KIND_LABELS,
  type AnalysisSession,
} from '@/lib/analysis/types'
import { ArrowLeftIcon, PlusIcon, ScanIcon } from './components/icons'
import StatusBadge from './components/status-badge'

export default async function ReverseEngineeringPage() {
  const supabase = await createClient()
  // RLS กรองให้เห็นเฉพาะงานของผู้ใช้เอง
  const { data, error } = await supabase
    .from('analysis_sessions')
    .select(SESSION_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(100)
  const sessions = (data ?? []) as unknown as AnalysisSession[]

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <Link
        href="/projects"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-neutral-400 transition hover:text-neutral-200"
      >
        <ArrowLeftIcon size={16} />
        Workspace
      </Link>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wider text-indigo-400">
            AI_Z / Reverse Engineering
          </p>
          <h1 className="text-2xl font-semibold">Software Analysis Workspace</h1>
          <p className="mt-1 text-sm text-neutral-400">
            จัดการงานวิเคราะห์โปรแกรม แยกจาก Project Mode
          </p>
        </div>
        <Link
          href="/reverse-engineering/new"
          className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium transition hover:bg-indigo-500"
        >
          <PlusIcon size={16} />
          สร้างงานวิเคราะห์
        </Link>
      </div>

      <h2 className="mb-3 text-sm font-medium text-neutral-300">งานวิเคราะห์ของคุณ</h2>

      {error && (
        <p className="mb-3 rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-sm text-red-300">
          โหลดรายการงานไม่สำเร็จ กรุณาลองใหม่อีกครั้ง
        </p>
      )}

      <div className="space-y-2">
        {sessions.map((s) => (
          <Link
            key={s.id}
            href={`/reverse-engineering/${s.id}`}
            className="block rounded-lg border border-neutral-800 bg-neutral-900 p-4 transition hover:border-indigo-600"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium">{s.title}</span>
              <StatusBadge status={s.status} />
            </div>
            {s.goal && (
              <p className="mt-1.5 line-clamp-2 text-sm text-neutral-400">{s.goal}</p>
            )}
            <p className="mt-2 text-xs text-neutral-500">
              {TARGET_KIND_LABELS[s.target_kind]} · สร้างเมื่อ {formatDateTime(s.created_at)}
            </p>
          </Link>
        ))}

        {!error && sessions.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-neutral-800 px-6 py-12 text-center">
            <span className="text-neutral-600">
              <ScanIcon size={32} />
            </span>
            <p className="text-sm text-neutral-400">ยังไม่มีงานวิเคราะห์</p>
            <p className="max-w-sm text-xs text-neutral-500">
              สร้างงานแรกเพื่อระบุเป้าหมายการวิเคราะห์ ระบบจะแสดงเฉพาะข้อมูลที่เกิดขึ้นจริงจากงานของคุณ
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
