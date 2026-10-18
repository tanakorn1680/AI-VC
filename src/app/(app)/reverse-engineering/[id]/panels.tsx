import Link from 'next/link'
import type { SupabaseClient } from '@supabase/supabase-js'
import EmptyState from '../components/empty-state'
import { formatDateTime } from '@/lib/analysis/format'
import {
  TARGET_KIND_LABELS,
  type AnalysisCounts,
  type AnalysisSession,
} from '@/lib/analysis/types'
import { PHASES } from './phases'
import { getRegistry, supportsKind } from '@/lib/analysis/tool-registry'
import {
  ARTIFACT_COLUMNS,
  CONFIDENCE_LABELS,
  REPORT_COLUMNS,
  REPORT_KIND_LABELS,
  TASK_COLUMNS,
  TASK_STATUS_LABELS,
  type AnalysisArtifact,
  type AnalysisReport,
  type AnalysisTask,
} from '@/lib/analysis/types'
import AnalystSettings, { type AgentOption } from './analyst-settings'
import RunControls from './run-controls'
import ArtifactUploader from './artifact-uploader'
import { CreateDocButton, DownloadButton } from './report-actions'
import HandoffForm from './handoff-form'
import { loadSnapshot } from '@/lib/analysis/report'
import { verifyTraceability, type SpecMeta } from '@/lib/analysis/spec'
import ArtifactList from './artifact-list'

type Db = SupabaseClient

const CARD = 'rounded-lg border border-neutral-800 bg-neutral-900'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const TASK_TONE: Record<string, string> = {
  pending: 'border-neutral-700 bg-neutral-800/60 text-neutral-300',
  running: 'border-sky-800/60 bg-sky-950/40 text-sky-300',
  completed: 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300',
  failed: 'border-red-800/60 bg-red-950/40 text-red-300',
  cancelled: 'border-neutral-800 bg-neutral-900 text-neutral-500',
}

async function loadAgentOptions(supabase: Db): Promise<AgentOption[]> {
  // RLS ของ agents/projects กรองให้เห็นเฉพาะของผู้ใช้เอง
  const [{ data: agents }, { data: projects }] = await Promise.all([
    supabase.from('agents').select('id, name, provider, model, project_id').order('created_at', { ascending: false }).limit(100),
    supabase.from('projects').select('id, name').limit(200),
  ])
  const names = new Map(((projects ?? []) as { id: string; name: string }[]).map((p) => [p.id, p.name]))
  return ((agents ?? []) as { id: string; name: string; provider: string; model: string; project_id: string }[]).map((a) => ({
    id: a.id,
    name: a.name,
    provider: a.provider,
    model: a.model,
    projectName: names.get(a.project_id) ?? '-',
  }))
}

export async function OverviewPanel({
  session,
  counts,
  supabase,
}: {
  session: AnalysisSession
  counts: AnalysisCounts
  supabase: Db
}) {
  const [agents, { data: taskData }] = await Promise.all([
    loadAgentOptions(supabase),
    supabase.from('analysis_tasks').select(TASK_COLUMNS).eq('session_id', session.id).order('created_at', { ascending: true }).limit(50),
  ])
  const tasks = (taskData ?? []) as unknown as AnalysisTask[]
  const titleById = new Map(tasks.map((t) => [t.id, t.title]))
  const locked = session.status === 'completed' || session.status === 'cancelled'
  const used = session.tokens_in + session.tokens_out
  const stats: [string, number][] = [
    ['ขั้นตอน', counts.tasks],
    ['การเรียกเครื่องมือ', counts.tool_runs],
    ['Artifact', counts.artifacts],
    ['ข้อค้นพบ/ข้อจำกัด', counts.findings],
    ['หลักฐาน', counts.evidence],
    ['รายงาน', counts.reports],
  ]

  return (
    <div className="space-y-6">
      <section className={`${CARD} p-4`}>
        <h2 className="mb-2 text-sm font-medium text-neutral-300">เป้าหมายการวิเคราะห์</h2>
        {session.goal ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">{session.goal}</p>
        ) : (
          <p className="text-sm text-neutral-500">ยังไม่ได้ระบุเป้าหมาย — กดแก้ไขเพื่อเพิ่ม</p>
        )}
        <dl className="mt-4 grid grid-cols-1 gap-3 border-t border-neutral-800 pt-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-neutral-500">ประเภทเป้าหมาย (ที่ระบุ)</dt>
            <dd className="mt-0.5 text-neutral-200">{TARGET_KIND_LABELS[session.target_kind]}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">สร้างเมื่อ</dt>
            <dd className="mt-0.5 text-neutral-200">{formatDateTime(session.created_at)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">อัปเดตล่าสุด</dt>
            <dd className="mt-0.5 text-neutral-200">{formatDateTime(session.updated_at)}</dd>
          </div>
        </dl>
      </section>

      <section className={`${CARD} space-y-4 p-4`}>
        <h2 className="text-sm font-medium text-neutral-300">การวิเคราะห์ด้วย AI</h2>
        <AnalystSettings
          sessionId={session.id}
          agents={agents}
          agentId={session.analyst_agent_id}
          tokenBudget={session.token_budget}
          locked={locked}
        />
        <div className="border-t border-neutral-800 pt-4">
          <RunControls
            sessionId={session.id}
            status={session.status}
            label={tasks.length === 0 ? 'เริ่มวิเคราะห์' : 'ทำต่อ'}
          />
          {session.last_error && (
            <p role="alert" className="mt-3 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
              {session.last_error}
            </p>
          )}
          <p className="mt-3 text-xs text-neutral-500">
            ใช้ token แล้ว {used.toLocaleString('en-US')} / {session.token_budget.toLocaleString('en-US')}
            {Number(session.cost_usd) > 0 && ` · ประมาณ $${Number(session.cost_usd).toFixed(4)}`}
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-300">แผนการวิเคราะห์</h2>
        {tasks.length === 0 ? (
          <EmptyState title="ยังไม่มีแผน">
            เลือก agent อัปโหลดไฟล์ที่แท็บ Artifacts แล้วกดเริ่มวิเคราะห์ AI จะวางแผนโดยเลือกจากเครื่องมือที่พร้อมใช้งานจริงเท่านั้น
          </EmptyState>
        ) : (
          <ul className={`${CARD} divide-y divide-neutral-800`}>
            {tasks.map((t, i) => (
              <li key={t.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-neutral-200">
                    <span className="mr-2 text-xs text-neutral-500">{i + 1}.</span>
                    {t.title}
                  </p>
                  <span className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs ${TASK_TONE[t.status] ?? TASK_TONE.pending}`}>
                    {TASK_STATUS_LABELS[t.status] ?? t.status}
                  </span>
                </div>
                {t.description && <p className="mt-1 text-xs text-neutral-400">{t.description}</p>}
                <p className="mt-1 text-xs text-neutral-500">
                  เครื่องมือ: {t.input.tool_id ?? '-'}
                  {t.depends_on.length > 0 && ` · ต้องรอ: ${t.depends_on.map((d) => titleById.get(d) ?? '-').join(', ')}`}
                </p>
                {t.success_criteria && <p className="mt-0.5 text-xs text-neutral-500">เงื่อนไขสำเร็จ: {t.success_criteria}</p>}
                {t.error && <p className="mt-1 text-xs text-red-400">{t.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-300">ความคืบหน้าจริงของงาน</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {stats.map(([label, n]) => (
            <div key={label} className={`${CARD} px-3 py-2.5`}>
              <p className="text-xs text-neutral-500">{label}</p>
              <p className="mt-0.5 text-lg font-semibold tabular-nums">{n}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-300">ความพร้อมของระบบ</h2>
        <ul className={`${CARD} divide-y divide-neutral-800`}>
          {PHASES.map((p) => (
            <li key={p.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm text-neutral-200">
                  <span className="mr-2 text-xs text-neutral-500">ระยะ {p.id}</span>
                  {p.name}
                </p>
                <p className="mt-0.5 text-xs text-neutral-500">{p.detail}</p>
              </div>
              <span
                className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs ${
                  p.ready
                    ? 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300'
                    : 'border-neutral-700 bg-neutral-800/60 text-neutral-400'
                }`}
              >
                {p.ready ? 'พร้อมใช้งาน' : 'ยังไม่พร้อม'}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export async function ArtifactsPanel({ supabase, sessionId }: { supabase: Db; sessionId: string }) {
  const [{ data }, registry] = await Promise.all([
    supabase
      .from('analysis_artifacts')
      .select(ARTIFACT_COLUMNS)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(200),
    getRegistry(),
  ])
  const rows = (data ?? []) as unknown as AnalysisArtifact[]
  const readyTools = registry.filter((t) => t.ready)

  // เครื่องมือที่ใช้ได้กับแต่ละไฟล์ต้นทาง (ตรวจจากความพร้อมจริงและชนิดไฟล์ที่ระบบตรวจเอง)
  const toolsByArtifact: Record<string, { id: string; name: string }[]> = {}
  for (const a of rows) {
    if (a.kind !== 'source') continue
    const kind = (a.metadata.detected_kind ?? 'unknown') as Parameters<typeof supportsKind>[1]
    toolsByArtifact[a.id] = readyTools.filter((t) => supportsKind(t, kind)).map((t) => ({ id: t.id, name: t.name }))
  }

  return (
    <div>
      <ArtifactUploader sessionId={sessionId} />
      {rows.length === 0 ? (
        <EmptyState title="ยังไม่มี Artifact">
          แตะปุ่ม + เพื่ออัปโหลดไฟล์ต้นทางและเริ่มวิเคราะห์ ผลลัพธ์ที่เครื่องมือสร้างจะแสดงที่นี่พร้อม hash
        </EmptyState>
      ) : (
        <ArtifactList sessionId={sessionId} artifacts={rows} toolsByArtifact={toolsByArtifact} />
      )}
    </div>
  )
}

export function CallGraphPanel() {
  return (
    <EmptyState title="Call Graph ยังไม่พร้อม">
      ยังไม่มีเครื่องมือที่สร้างข้อมูล Call Graph ระบบจะแสดงเฉพาะความสัมพันธ์ที่เครื่องมือสร้างขึ้นจริง
      และไม่แสดงข้อมูลตัวอย่างแทน
    </EmptyState>
  )
}

export async function EvidencePanel({ supabase, sessionId }: { supabase: Db; sessionId: string }) {
  const [{ data: findingData }, { data: evidenceData }] = await Promise.all([
    supabase
      .from('analysis_findings')
      .select('id, kind, title, statement, confidence, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(200),
    supabase
      .from('analysis_evidence')
      .select('id, finding_id, artifact_id, locator, excerpt')
      .eq('session_id', sessionId)
      .limit(2000),
  ])
  const rows = (findingData ?? []) as { id: string; kind: string; title: string; statement: string; confidence: string }[]
  const findings = rows.filter((r) => r.kind === 'finding')
  const limitations = rows.filter((r) => r.kind === 'limitation')
  const evidenceByFinding = new Map<string, { id: string; artifact_id: string | null; locator: string; excerpt: string }[]>()
  for (const e of (evidenceData ?? []) as { id: string; finding_id: string; artifact_id: string | null; locator: string; excerpt: string }[]) {
    const list = evidenceByFinding.get(e.finding_id) ?? []
    list.push(e)
    evidenceByFinding.set(e.finding_id, list)
  }

  if (rows.length === 0) {
    return (
      <EmptyState title="ยังไม่มีข้อค้นพบหรือหลักฐาน">
        ข้อค้นพบจะปรากฏหลัง AI สรุปผลจากเครื่องมือ ทุกข้อต้องอ้างหลักฐานที่ระบบตรวจแล้วว่ามีอยู่จริงในผลของเครื่องมือ
      </EmptyState>
    )
  }
  return (
    <div className="space-y-6">
      <p className="text-xs text-neutral-500">
        ระดับความเชื่อมั่นคำนวณโดยระบบจากหลักฐานที่ตรวจผ่านแล้ว ไม่ใช่ค่าที่ AI ประเมินเอง
        (ไม่มีหลักฐาน = ยังไม่ยืนยัน · 1 รายการ = ต่ำ · 2 รายการขึ้นไป = ปานกลาง · 3 รายการจากหลาย run = สูง)
      </p>

      {findings.length > 0 && (
        <ul className={`${CARD} divide-y divide-neutral-800`}>
          {findings.map((f) => {
            const ev = evidenceByFinding.get(f.id) ?? []
            return (
              <li key={f.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm text-neutral-200">{f.title}</p>
                  <span className="shrink-0 text-xs text-neutral-400">
                    ความเชื่อมั่น: {CONFIDENCE_LABELS[f.confidence] ?? f.confidence}
                  </span>
                </div>
                {f.statement && <p className="mt-1 text-sm text-neutral-400">{f.statement}</p>}
                {ev.length === 0 ? (
                  <p className="mt-1.5 text-xs text-amber-400">ยังไม่มีหลักฐานรองรับ</p>
                ) : (
                  <ul className="mt-2 space-y-1.5">
                    {ev.map((e) => (
                      <li key={e.id} className="rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2">
                        {e.locator && <p className="text-xs text-neutral-500">ตำแหน่ง: {e.locator}</p>}
                        <p className="mt-0.5 whitespace-pre-wrap break-all font-mono text-xs text-neutral-300">{e.excerpt}</p>
                        {e.artifact_id && (
                          <a
                            href={`/api/analysis/${sessionId}/artifacts/${e.artifact_id}/content`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 inline-block text-xs text-indigo-400 hover:text-indigo-300"
                          >
                            ดูผลลัพธ์ต้นทาง (JSON)
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {limitations.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-neutral-300">ข้อจำกัดและสิ่งที่ยังตรวจสอบไม่ได้</h2>
          <ul className={`${CARD} divide-y divide-neutral-800`}>
            {limitations.map((l) => (
              <li key={l.id} className="px-4 py-3">
                <p className="text-sm text-neutral-200">{l.title}</p>
                {l.statement && <p className="mt-1 text-sm text-neutral-400">{l.statement}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

const MODE_LABELS: Record<string, string> = { builtin: 'Builtin', worker: 'Worker', mcp: 'MCP' }
const RUN_STATUS_LABELS: Record<string, string> = {
  queued: 'รอคิว', running: 'กำลังรัน', succeeded: 'สำเร็จ', failed: 'ล้มเหลว',
  timed_out: 'หมดเวลา', cancelled: 'ยกเลิก',
}

export async function ToolsPanel({ supabase, sessionId }: { supabase: Db; sessionId: string }) {
  const [registry, { data: runData }, { data: outData }] = await Promise.all([
    getRegistry(),
    supabase
      .from('analysis_tool_runs')
      .select('id, tool_id, tool_version, status, output_summary, error, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('analysis_artifacts')
      .select('id, produced_by_run_id')
      .eq('session_id', sessionId)
      .eq('kind', 'tool_output')
      .limit(200),
  ])
  const runs = (runData ?? []) as {
    id: string; tool_id: string; tool_version: string; status: string
    output_summary: string; error: string | null; created_at: string
  }[]
  const outputByRun = new Map<string, string>()
  for (const o of (outData ?? []) as { id: string; produced_by_run_id: string | null }[]) {
    if (o.produced_by_run_id) outputByRun.set(o.produced_by_run_id, o.id)
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-300">Tool Registry</h2>
        <p className="mb-2 text-xs text-neutral-500">
          สถานะมาจากการทดสอบเครื่องมือจริง (self-test) ไม่ใช่รายชื่อที่ประกาศไว้ล่วงหน้า
        </p>
        <ul className={`${CARD} divide-y divide-neutral-800`}>
          {registry.map((t) => (
            <li key={t.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm text-neutral-200">
                    {t.name}
                    <span className="ml-2 text-xs text-neutral-500">
                      {MODE_LABELS[t.executionMode] ?? t.executionMode} · v{t.version}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-neutral-500">{t.description}</p>
                </div>
                <span
                  className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs ${
                    t.ready
                      ? 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300'
                      : 'border-red-800/60 bg-red-950/40 text-red-300'
                  }`}
                >
                  {t.ready ? 'พร้อมใช้งาน' : 'ไม่พร้อม'}
                </span>
              </div>
              <p className="mt-1.5 text-xs text-neutral-500">
                รองรับ: {t.fileKinds.includes('*') ? 'ทุกชนิดไฟล์' : t.fileKinds.join(', ')} · ไฟล์ไม่เกิน{' '}
                {formatBytes(t.limits.maxInputBytes)} · เวลาไม่เกิน {t.limits.timeoutMs / 1000} วินาที
              </p>
              <p className="mt-0.5 text-xs text-neutral-500">ผลตรวจ: {t.detail}</p>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-neutral-500">
          เครื่องมือแบบ Worker และ MCP (เช่น Decompiler, Disassembler) ยังไม่ได้เชื่อมต่อ จึงยังไม่แสดงในรายการ
        </p>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-neutral-300">ประวัติการเรียกเครื่องมือ</h2>
        {runs.length === 0 ? (
          <EmptyState title="ยังไม่เคยเรียกเครื่องมือ">
            เลือกไฟล์ในแท็บ Artifacts แล้วกดวิเคราะห์ ประวัติและผลลัพธ์จะบันทึกที่นี่
          </EmptyState>
        ) : (
          <ul className={`${CARD} divide-y divide-neutral-800`}>
            {runs.map((r) => {
              const outId = outputByRun.get(r.id)
              return (
                <li key={r.id} className="px-4 py-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-neutral-200">
                      {r.tool_id}
                      {r.tool_version && <span className="ml-1.5 text-xs text-neutral-500">v{r.tool_version}</span>}
                    </span>
                    <span className="text-xs text-neutral-500">
                      {RUN_STATUS_LABELS[r.status] ?? r.status} · {formatDateTime(r.created_at)}
                    </span>
                  </div>
                  {r.output_summary && <p className="mt-1 text-xs text-neutral-400">{r.output_summary}</p>}
                  {r.error && <p className="mt-1 text-xs text-red-400">{r.error}</p>}
                  {outId && (
                    <a
                      href={`/api/analysis/${sessionId}/artifacts/${outId}/content`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1.5 inline-block text-xs text-indigo-400 hover:text-indigo-300"
                    >
                      ดูผลลัพธ์ (JSON)
                    </a>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function DocCard({ report, sessionId, children }: { report: AnalysisReport; sessionId: string; children?: React.ReactNode }) {
  return (
    <div className={`${CARD} p-4`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-neutral-200">
          {REPORT_KIND_LABELS[report.kind]} · เวอร์ชัน {report.version}
          <span className="ml-2 text-xs font-normal text-neutral-500">{formatDateTime(report.created_at)}</span>
        </p>
        <DownloadButton
          content={report.content}
          filename={`${report.kind === 'report' ? 'analysis-report' : 'technical-specification'}-${sessionId.slice(0, 8)}-v${report.version}.md`}
        />
      </div>
      <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-neutral-800 bg-neutral-950/60 p-3 font-sans text-xs leading-relaxed text-neutral-300">
        {report.content}
      </pre>
      {children}
    </div>
  )
}

export async function ReportPanel({
  supabase,
  sessionId,
  status,
  title,
}: {
  supabase: Db
  sessionId: string
  status: string
  title: string
}) {
  const [{ data: reportData }, { data: projectData }, snap] = await Promise.all([
    supabase
      .from('analysis_reports')
      .select(REPORT_COLUMNS)
      .eq('session_id', sessionId)
      .order('version', { ascending: false })
      .limit(40),
    supabase.from('projects').select('id, name').order('created_at', { ascending: false }).limit(100),
    loadSnapshot(supabase, sessionId),
  ])
  const reports = (reportData ?? []) as unknown as AnalysisReport[]
  const projects = (projectData ?? []) as { id: string; name: string }[]
  const latestReport = reports.find((r) => r.kind === 'report')
  const latestSpec = reports.find((r) => r.kind === 'specification')
  const completed = status === 'completed'

  // ตรวจย้อนกลับ ณ ตอนนี้ (ผลวิเคราะห์อาจถูกเปลี่ยนหลังสร้างสเปก)
  const trace = latestSpec && snap ? verifyTraceability(latestSpec.meta as unknown as SpecMeta, snap) : null
  const projectNames = new Map(projects.map((p) => [p.id, p.name]))

  return (
    <div className="space-y-6">
      <section className={`${CARD} space-y-4 p-4`}>
        <h2 className="text-sm font-medium text-neutral-300">สร้างเอกสาร</h2>
        {!completed && (
          <p className="text-xs text-amber-400">สร้างได้เมื่อวิเคราะห์เสร็จแล้ว (สถานะ "เสร็จสิ้น") — ไปที่แท็บ Overview เพื่อเริ่มหรือทำต่อ</p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <CreateDocButton sessionId={sessionId} kind="report" label="สร้างรายงานผลวิเคราะห์" disabled={!completed} />
            <p className="text-xs text-neutral-500">
              ประกอบจากข้อมูลจริงเท่านั้น (ไฟล์ + hash, เครื่องมือ, ข้อค้นพบ + หลักฐาน, ข้อจำกัด) ไม่ใช้ AI เขียนเนื้อหา
            </p>
          </div>
          <div className="space-y-2">
            <CreateDocButton sessionId={sessionId} kind="specification" label="สร้างข้อกำหนดทางเทคนิค" disabled={!completed} />
            <p className="text-xs text-neutral-500">
              AI แปลงข้อค้นพบที่มีหลักฐานเป็นข้อกำหนดและเกณฑ์ทดสอบ ระบบตัดข้อที่อ้างหลักฐานไม่ได้ทิ้ง (ใช้ token ตามงบของงานนี้)
            </p>
          </div>
        </div>
      </section>

      {!latestReport && !latestSpec && (
        <EmptyState title="ยังไม่มีรายงานหรือข้อกำหนด">
          เมื่อวิเคราะห์เสร็จ สร้างรายงานเพื่อสรุปสิ่งที่พิสูจน์ได้ ข้อจำกัด และสิ่งที่ยังไม่ทราบ
          แล้วสร้างข้อกำหนดเพื่อส่งต่อไปสร้างระบบใหม่ใน Project Mode
        </EmptyState>
      )}

      {latestReport && <DocCard report={latestReport} sessionId={sessionId} />}

      {latestSpec && (
        <DocCard report={latestSpec} sessionId={sessionId}>
          <div className="mt-4 space-y-4 border-t border-neutral-800 pt-4">
            <div>
              <h3 className="mb-1 text-sm font-medium text-neutral-300">การตรวจย้อนกลับไปหาหลักฐาน</h3>
              {trace?.ok ? (
                <p className="text-xs text-emerald-400">
                  ทุกข้อกำหนดย้อนกลับไปหาข้อค้นพบที่มีหลักฐานได้ครบ ณ ตอนนี้
                </p>
              ) : (
                <ul className="space-y-0.5 text-xs text-amber-400">
                  {(trace?.problems ?? ['ตรวจไม่ได้']).map((p) => <li key={p}>{p}</li>)}
                  <li className="text-neutral-500">สร้างข้อกำหนดเวอร์ชันใหม่เพื่อให้ตรงกับผลวิเคราะห์ปัจจุบัน</li>
                </ul>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-sm font-medium text-neutral-300">ส่งต่อไป Project Mode</h3>
              <HandoffForm
                sessionId={sessionId}
                reportId={latestSpec.id}
                defaultName={`${title} — ระบบใหม่`.slice(0, 200)}
                projects={projects}
                blockedReason={trace?.ok ? null : (trace?.problems[0] ?? 'ตรวจย้อนกลับไม่ได้')}
              />
            </div>

            {latestSpec.handoffs.length > 0 && (
              <div>
                <h3 className="mb-1 text-sm font-medium text-neutral-300">ประวัติการส่งต่อของเวอร์ชันนี้</h3>
                <ul className="space-y-1 text-xs text-neutral-400">
                  {[...latestSpec.handoffs].reverse().map((h) => (
                    <li key={`${h.project_id}-${h.at}`}>
                      {formatDateTime(h.at)} · {h.mode === 'new' ? 'โปรเจกต์ใหม่' : 'โปรเจกต์เดิม'} ·{' '}
                      {projectNames.has(h.project_id) ? (
                        <Link href={`/projects/${h.project_id}`} className="text-indigo-400 hover:text-indigo-300">
                          {projectNames.get(h.project_id)}
                        </Link>
                      ) : (
                        'โปรเจกต์ถูกลบแล้ว'
                      )}{' '}
                      · {h.files.length} ไฟล์
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </DocCard>
      )}

      {reports.length > (latestReport ? 1 : 0) + (latestSpec ? 1 : 0) && (
        <p className="text-xs text-neutral-500">
          มีเอกสารเวอร์ชันก่อนหน้า {reports.length - (latestReport ? 1 : 0) - (latestSpec ? 1 : 0)} ฉบับ (เก็บไว้ ไม่ได้แสดงที่นี่)
        </p>
      )}
    </div>
  )
}
