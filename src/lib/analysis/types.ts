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
}

// คอลัมน์ที่ส่งให้ client (ไม่รวม owner_id / config)
export const SESSION_COLUMNS = 'id, title, goal, target_kind, status, created_at, updated_at'

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
