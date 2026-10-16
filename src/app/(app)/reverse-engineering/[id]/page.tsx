import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { ComponentType } from 'react'
import { createClient } from '@/lib/supabase/server'
import { countChildren } from '@/lib/analysis/queries'
import { SESSION_COLUMNS, type AnalysisSession } from '@/lib/analysis/types'
import { isValidUUID } from '@/lib/utils/sanitize'
import {
  ArrowLeftIcon,
  EvidenceIcon,
  FileIcon,
  GraphIcon,
  OverviewIcon,
  ReportIcon,
  ToolIcon,
} from '../components/icons'
import StatusBadge from '../components/status-badge'
import {
  ArtifactsPanel,
  CallGraphPanel,
  EvidencePanel,
  OverviewPanel,
  ReportPanel,
  ToolsPanel,
} from './panels'
import SessionControls from './session-controls'

const TABS = [
  { id: 'overview', label: 'Overview', Icon: OverviewIcon },
  { id: 'artifacts', label: 'Artifacts', Icon: FileIcon },
  { id: 'call-graph', label: 'Call Graph', Icon: GraphIcon },
  { id: 'evidence', label: 'Evidence', Icon: EvidenceIcon },
  { id: 'tools', label: 'Agents & Tools', Icon: ToolIcon },
  { id: 'report', label: 'Report', Icon: ReportIcon },
] as const satisfies readonly { id: string; label: string; Icon: ComponentType<{ size?: number }> }[]

type TabId = (typeof TABS)[number]['id']

function resolveTab(raw: string | string[] | undefined): TabId {
  const value = Array.isArray(raw) ? raw[0] : raw
  return TABS.find((t) => t.id === value)?.id ?? 'overview'
}

export default async function AnalysisDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string | string[] }>
}) {
  const { id } = await params
  if (!isValidUUID(id)) notFound()
  const tab = resolveTab((await searchParams).tab)

  const supabase = await createClient()
  // RLS กรองให้อยู่แล้ว: ไม่ใช่เจ้าของจะได้ null และถือว่าไม่พบ (ไม่บอกว่ามีอยู่แต่ไม่มีสิทธิ์)
  const { data } = await supabase
    .from('analysis_sessions')
    .select(SESSION_COLUMNS)
    .eq('id', id)
    .maybeSingle()
  if (!data) notFound()
  const session = data as unknown as AnalysisSession

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <Link
        href="/reverse-engineering"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-neutral-400 transition hover:text-neutral-200"
      >
        <ArrowLeftIcon size={16} />
        งานวิเคราะห์
      </Link>

      <div className="mb-5 flex items-start justify-between gap-3">
        <h1 className="text-xl font-semibold leading-snug">{session.title}</h1>
        <StatusBadge status={session.status} />
      </div>

      <div className="mb-6">
        <SessionControls session={session} />
      </div>

      <nav
        aria-label="หัวข้อของงานวิเคราะห์"
        className="mb-6 flex gap-1 overflow-x-auto border-b border-neutral-800"
      >
        {TABS.map(({ id: tabId, label, Icon }) => {
          const active = tabId === tab
          return (
            <Link
              key={tabId}
              href={tabId === 'overview' ? `/reverse-engineering/${id}` : `/reverse-engineering/${id}?tab=${tabId}`}
              aria-current={active ? 'page' : undefined}
              className={`-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition ${
                active
                  ? 'border-indigo-500 text-neutral-100'
                  : 'border-transparent text-neutral-400 hover:text-neutral-200'
              }`}
            >
              <Icon size={15} />
              {label}
            </Link>
          )
        })}
      </nav>

      {tab === 'overview' && <OverviewPanel session={session} counts={await countChildren(supabase, id)} />}
      {tab === 'artifacts' && <ArtifactsPanel supabase={supabase} sessionId={id} />}
      {tab === 'call-graph' && <CallGraphPanel />}
      {tab === 'evidence' && <EvidencePanel supabase={supabase} sessionId={id} />}
      {tab === 'tools' && <ToolsPanel supabase={supabase} sessionId={id} />}
      {tab === 'report' && <ReportPanel supabase={supabase} sessionId={id} />}
    </div>
  )
}
