import { cleanChatText, isValidEnum, isValidUUID, sanitizeShort } from '@/lib/utils/sanitize'
import {
  GOAL_MAX,
  TOKEN_BUDGET_MAX,
  TOKEN_BUDGET_MIN,
  TARGET_KINDS,
  TITLE_MAX,
  type TargetKind,
} from './types'

type Result<T> = { ok: true; value: T } | { ok: false; message: string }

function asRecord(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

export interface CreateSessionInput {
  title: string
  goal: string
  target_kind: TargetKind
}

/** ตรวจข้อมูลสร้างงานวิเคราะห์ใหม่ — ค่าที่ไม่ถูกต้องคืนข้อความภาษาไทยให้แสดงผู้ใช้ได้ทันที */
export function parseCreateSession(body: unknown): Result<CreateSessionInput> {
  const rec = asRecord(body)
  if (!rec) return { ok: false, message: 'รูปแบบข้อมูลไม่ถูกต้อง' }

  const title = sanitizeShort(rec.title, TITLE_MAX)
  if (!title) return { ok: false, message: 'กรุณาระบุชื่องานวิเคราะห์' }

  if (rec.goal !== undefined && typeof rec.goal !== 'string') {
    return { ok: false, message: 'เป้าหมายการวิเคราะห์ต้องเป็นข้อความ' }
  }
  const rawGoal = typeof rec.goal === 'string' ? rec.goal : ''
  if (rawGoal.length > GOAL_MAX) {
    return { ok: false, message: `เป้าหมายยาวเกิน ${GOAL_MAX} ตัวอักษร` }
  }

  let target_kind: TargetKind = 'unspecified'
  if (rec.target_kind !== undefined) {
    if (!isValidEnum(rec.target_kind, TARGET_KINDS)) {
      return { ok: false, message: 'ประเภทเป้าหมายไม่ถูกต้อง' }
    }
    target_kind = rec.target_kind
  }

  return { ok: true, value: { title, goal: cleanChatText(rawGoal, GOAL_MAX), target_kind } }
}

export interface UpdateSessionInput {
  title?: string
  goal?: string
  /** agent ที่ใช้วิเคราะห์ (null = ล้างค่า) */
  analyst_agent_id?: string | null
  token_budget?: number
  /** ผู้ใช้เปลี่ยนสถานะได้อย่างเดียวคือยกเลิก */
  cancel?: true
}

/** ตรวจข้อมูลแก้ไขงาน (PATCH) — ต้องมีอย่างน้อยหนึ่งฟิลด์ และไม่รับฟิลด์ที่ระบบคุม */
export function parseUpdateSession(body: unknown): Result<UpdateSessionInput> {
  const rec = asRecord(body)
  if (!rec) return { ok: false, message: 'รูปแบบข้อมูลไม่ถูกต้อง' }

  const out: UpdateSessionInput = {}

  if (rec.title !== undefined) {
    const title = sanitizeShort(rec.title, TITLE_MAX)
    if (!title) return { ok: false, message: 'ชื่องานต้องไม่ว่าง' }
    out.title = title
  }

  if (rec.goal !== undefined) {
    if (typeof rec.goal !== 'string') return { ok: false, message: 'เป้าหมายการวิเคราะห์ต้องเป็นข้อความ' }
    if (rec.goal.length > GOAL_MAX) return { ok: false, message: `เป้าหมายยาวเกิน ${GOAL_MAX} ตัวอักษร` }
    out.goal = cleanChatText(rec.goal, GOAL_MAX)
  }

  if (rec.analyst_agent_id !== undefined) {
    if (rec.analyst_agent_id !== null && !isValidUUID(rec.analyst_agent_id)) {
      return { ok: false, message: 'รหัส agent ไม่ถูกต้อง' }
    }
    out.analyst_agent_id = rec.analyst_agent_id
  }

  if (rec.token_budget !== undefined) {
    const b = rec.token_budget
    if (typeof b !== 'number' || !Number.isInteger(b) || b < TOKEN_BUDGET_MIN || b > TOKEN_BUDGET_MAX) {
      return {
        ok: false,
        message: `งบ token ต้องเป็นจำนวนเต็มระหว่าง ${TOKEN_BUDGET_MIN.toLocaleString('en-US')} ถึง ${TOKEN_BUDGET_MAX.toLocaleString('en-US')}`,
      }
    }
    out.token_budget = b
  }

  if (rec.status !== undefined) {
    if (rec.status !== 'cancelled') {
      return { ok: false, message: 'เปลี่ยนสถานะได้เฉพาะการยกเลิกงาน' }
    }
    out.cancel = true
  }

  if (
    out.title === undefined && out.goal === undefined && out.analyst_agent_id === undefined &&
    out.token_budget === undefined && !out.cancel
  ) {
    return { ok: false, message: 'ไม่มีข้อมูลที่ต้องแก้ไข' }
  }
  return { ok: true, value: out }
}
