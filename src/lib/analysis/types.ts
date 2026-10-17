/**
 * Reverse Engineering Mode — ชนิดข้อมูลและป้ายชื่อที่ใช้ร่วมกันทั้งฝั่ง server และ client
 * (ไม่ import อะไรที่เป็น server-only ไฟล์นี้จึง import จาก client component ได้)
 */

export const TARGET_KINDS = [
  'unspecified',
  'source_code',
  'apk',
  'executable',
  'binary',
  'other',
] as const
export type TargetKind = (typeof TARGET_KINDS)[number]

// ป้ายชื่อประเภทเป้าหมายที่ผู้ใช้ระบุ — ไม่ได้หมายความว่าระบบมีเครื่องมือรองรับ (ดู Tool Registry ในระยะ 02)
export const TARGET_KIND_LABELS: Record<TargetKind, string> = {
  unspecified: 'ยังไม่ระบุ',
  source_code: 'ซอร์สโค้ด / ZIP',
  apk: 'APK',
  executable: 'ไฟล์ปฏิบัติการ (EXE / ELF)',
  binary: 'ไบนารีอื่น ๆ',
  other: 'อื่น ๆ',
}

export const SESSION_STATUSES = [
  'draft',
  'awaiting_tools',
  'planning',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const
export type SessionStatus = (typeof SESSION_STATUSES)[number]

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  draft: 'ฉบับร่าง',
  awaiting_tools: 'รอเครื่องมือ',
  planning: 'กำลังวางแผน',
  running: 'กำลังวิเคราะห์',
  completed: 'เสร็จสิ้น',
  failed: 'ล้มเหลว',
  cancelled: 'ยกเลิกแล้ว',
}

// สถานะที่ผู้ใช้ยกเลิกได้ — ต้องตรงกับ trigger guard_analysis_session_status ใน migration 0005
export const CANCELLABLE_STATUSES: readonly SessionStatus[] = [
  'draft',
  'awaiting_tools',
  'planning',
  'running',
]

export interface AnalysisSession {
  id: string
  title: string
  goal: string
  target_kind: TargetKind
  status: SessionStatus
  created_at: string
  updated_at: string
  analyst_agent_id: string | null
  token_budget: number
  tokens_in: number
  tokens_out: number
  cost_usd: number
  last_error: string | null
}

// คอลัมน์ที่ส่งให้ client (ไม่รวม owner_id / config / step_lock_until)
export const SESSION_COLUMNS =
  'id, title, goal, target_kind, status, created_at, updated_at, analyst_agent_id, token_budget, tokens_in, tokens_out, cost_usd, last_error'

export const TOKEN_BUDGET_MIN = 10_000
export const TOKEN_BUDGET_MAX = 2_000_000
export const TOKEN_BUDGET_DEFAULT = 200_000

/** จำนวนข้อมูลลูกของงานหนึ่ง ๆ — ใช้แสดงความคืบหน้าจริงในหน้ารายละเอียด */
export interface AnalysisCounts {
  tasks: number
  tool_runs: number
  artifacts: number
  findings: number
  evidence: number
  reports: number
}

export const TITLE_MAX = 200
export const GOAL_MAX = 4000

export const ARTIFACT_KINDS = ['source', 'tool_output', 'report_attachment'] as const
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export const ARTIFACT_KIND_LABELS: Record<ArtifactKind, string> = {
  source: 'ไฟล์ต้นทาง',
  tool_output: 'ผลจากเครื่องมือ',
  report_attachment: 'ไฟล์แนบรายงาน',
}

export interface AnalysisArtifact {
  id: string
  kind: ArtifactKind
  name: string
  size_bytes: number
  sha256: string
  metadata: { detected_kind?: string; detected_label?: string; tool_id?: string }
  produced_by_run_id: string | null
  created_at: string
}

export const ARTIFACT_COLUMNS = 'id, kind, name, size_bytes, sha256, metadata, produced_by_run_id, created_at'

export const TASK_STATUS_LABELS: Record<string, string> = {
  pending: 'รอคิว',
  running: 'กำลังทำ',
  completed: 'เสร็จ',
  failed: 'ล้มเหลว',
  cancelled: 'ยกเลิก',
}

export interface AnalysisTask {
  id: string
  title: string
  description: string
  success_criteria: string
  status: string
  depends_on: string[]
  input: { tool_id?: string; artifact_id?: string }
  error: string | null
  attempts: number
  created_at: string
}

export const TASK_COLUMNS =
  'id, title, description, success_criteria, status, depends_on, input, error, attempts, created_at'

export const CONFIDENCE_LABELS: Record<string, string> = {
  unverified: 'ยังไม่ยืนยัน',
  low: 'ต่ำ',
  medium: 'ปานกลาง',
  high: 'สูง',
}

export const REPORT_KINDS = ['report', 'specification'] as const
export type ReportKind = (typeof REPORT_KINDS)[number]

export const REPORT_KIND_LABELS: Record<ReportKind, string> = {
  report: 'รายงานผลวิเคราะห์',
  specification: 'ข้อกำหนดทางเทคนิค',
}

export interface HandoffRecord {
  project_id: string
  at: string
  mode: 'new' | 'existing'
  files: string[]
}

export interface AnalysisReport {
  id: string
  kind: ReportKind
  version: number
  status: string
  content: string
  meta: Record<string, unknown>
  handoffs: HandoffRecord[]
  created_at: string
}

export const REPORT_COLUMNS = 'id, kind, version, status, content, meta, handoffs, created_at'
