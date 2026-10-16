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
  ARTIFACT_KIND_LABELS,
  type AnalysisArtifact,
} from '@/lib/analysis/types'
import ArtifactUploader from './artifact-uploader'
import RunToolButton from './run-tool-button'

type Db = SupabaseClient

const CARD = 'rounded-lg border border-neutral-800 bg-neutral-900'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const CONFIDENCE_LABELS: Record<string, string> = {
  unverified: 'ยังไม่ยืนยัน',
  low: 'ต่ำ',
  medium: 'ปานกลาง',
  high: 'สูง',
}

export function OverviewPanel({ session, counts }: { session: AnalysisSession; counts: AnalysisCounts }) {
  const stats: [string, number][] = [
    ['ขั้นตอน', counts.tasks],
    ['การเรียกเครื่องมือ', counts.tool_runs],
    ['Artifact', counts.artifacts],
    ['ข้อค้นพบ', counts.findings],
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

  return (
    <div>
      <ArtifactUploader sessionId={sessionId} />
      {rows.length === 0 ? (
        <EmptyState title="ยังไม่มี Artifact">
          อัปโหลดไฟล์ต้นทางเพื่อเริ่มวิเคราะห์ ผลลัพธ์ที่เครื่องมือสร้างจะแสดงที่นี่พร้อม hash
        </EmptyState>
      ) : (
        <ul className={`${CARD} divide-y divide-neutral-800`}>
          {rows.map((a) => {
            const kind = a.metadata.detected_kind
            const tools =
              a.kind === 'source'
                ? readyTools.filter((t) => supportsKind(t, (kind ?? 'unknown') as Parameters<typeof supportsKind>[1]))
                : []
            return (
              <li key={a.id} className="px-4 py-3">
                <p className="break-all text-sm text-neutral-200">{a.name}</p>
                <p className="mt-0.5 text-xs text-neutral-500">
                  {ARTIFACT_KIND_LABELS[a.kind]}
                  {a.metadata.detected_label ? ` · ${a.metadata.detected_label}` : ''} · {formatBytes(a.size_bytes)} ·
                  SHA-256 {a.sha256.slice(0, 12)}… · {formatDateTime(a.created_at)}
                </p>
                {a.kind === 'tool_output' && (
                  <a
                    href={`/api/analysis/${sessionId}/artifacts/${a.id}/content`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-block text-xs text-indigo-400 hover:text-indigo-300"
                  >
                    ดูผลลัพธ์ (JSON)
                  </a>
                )}
                {tools.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {tools.map((t) => (
                      <RunToolButton
                        key={t.id}
                        sessionId={sessionId}
                        artifactId={a.id}
                        toolId={t.id}
                        label={`วิเคราะห์ด้วย ${t.name}`}
                      />
                    ))}
                  </div>
                )}
                {a.kind === 'source' && tools.length === 0 && (
                  <p className="mt-2 text-xs text-neutral-500">ยังไม่มีเครื่องมือที่พร้อมและรองรับไฟล์ชนิดนี้</p>
                )}
              </li>
            )
          })}
        </ul>
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
      .select('id, title, statement, confidence, created_at')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .limit(200),
    supabase.from('analysis_evidence').select('finding_id').eq('session_id', sessionId).limit(2000),
  ])
  const findings = (findingData ?? []) as {
    id: string; title: string; statement: string; confidence: string
  }[]
  const evidenceCount = new Map<string, number>()
  for (const e of (evidenceData ?? []) as { finding_id: string }[]) {
    evidenceCount.set(e.finding_id, (evidenceCount.get(e.finding_id) ?? 0) + 1)
  }

  if (findings.length === 0) {
    return (
      <EmptyState title="ยังไม่มีข้อค้นพบหรือหลักฐาน">
        ข้อค้นพบจะปรากฏหลังเครื่องมือวิเคราะห์สร้างผลลัพธ์ พร้อมระดับความเชื่อมั่นและหลักฐานอ้างอิง
        ซึ่งยังไม่เปิดใช้ในระยะนี้
      </EmptyState>
    )
  }
  return (
    <ul className={`${CARD} divide-y divide-neutral-800`}>
      {findings.map((f) => {
        const n = evidenceCount.get(f.id) ?? 0
        return (
          <li key={f.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm text-neutral-200">{f.title}</p>
              <span className="shrink-0 text-xs text-neutral-400">
                ความเชื่อมั่น: {CONFIDENCE_LABELS[f.confidence] ?? f.confidence}
              </span>
            </div>
            {f.statement && <p className="mt-1 text-sm text-neutral-400">{f.statement}</p>}
            <p className={`mt-1.5 text-xs ${n === 0 ? 'text-amber-400' : 'text-neutral-500'}`}>
              {n === 0 ? 'ยังไม่มีหลักฐานรองรับ' : `หลักฐานอ้างอิง ${n} รายการ`}
            </p>
          </li>
        )
      })}
    </ul>
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

export async function ReportPanel({ supabase, sessionId }: { supabase: Db; sessionId: string }) {
  const { data } = await supabase
    .from('analysis_reports')
    .select('id, version, status, content, created_at')
    .eq('session_id', sessionId)
    .order('version', { ascending: false })
    .limit(20)
  const reports = (data ?? []) as {
    id: string; version: number; status: string; content: string; created_at: string
  }[]
  const latest = reports[0]

  if (!latest) {
    return (
      <EmptyState title="ยังไม่มีรายงาน">
        รายงานจะสร้างจากข้อค้นพบที่มีหลักฐานรองรับ โดยสรุปสิ่งที่พิสูจน์ได้ ข้อจำกัด และสิ่งที่ยังไม่ทราบ
      </EmptyState>
    )
  }
  return (
    <div className="space-y-3">
      <div className={`${CARD} p-4`}>
        <p className="mb-2 text-xs text-neutral-500">
          เวอร์ชัน {latest.version} · {latest.status === 'final' ? 'ฉบับสมบูรณ์' : 'ฉบับร่าง'} ·{' '}
          {formatDateTime(latest.created_at)}
        </p>
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">{latest.content}</div>
      </div>
      {reports.length > 1 && (
        <p className="text-xs text-neutral-500">มีรายงานเวอร์ชันก่อนหน้า {reports.length - 1} ฉบับ</p>
      )}
    </div>
  )
}
