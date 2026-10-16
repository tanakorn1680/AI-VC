import { SESSION_STATUS_LABELS, type SessionStatus } from '@/lib/analysis/types'

const STYLES: Record<SessionStatus, string> = {
  draft: 'border-neutral-700 bg-neutral-800/60 text-neutral-300',
  awaiting_tools: 'border-amber-800/60 bg-amber-950/40 text-amber-300',
  planning: 'border-indigo-800/60 bg-indigo-950/40 text-indigo-300',
  running: 'border-sky-800/60 bg-sky-950/40 text-sky-300',
  completed: 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300',
  failed: 'border-red-800/60 bg-red-950/40 text-red-300',
  cancelled: 'border-neutral-800 bg-neutral-900 text-neutral-500',
}

export default function StatusBadge({ status }: { status: SessionStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${STYLES[status]}`}
    >
      {SESSION_STATUS_LABELS[status]}
    </span>
  )
}
