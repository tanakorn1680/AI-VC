/**
 * สัญญาของเครื่องมือวิเคราะห์ — Adapter ทุกตัวต้องทำตามนี้
 * Registry ไม่เชื่อคำอ้างของ Adapter: ความพร้อมมาจาก probe() ที่รันจริงเท่านั้น
 */

/** ชนิดไฟล์ที่ file-identify ตรวจจากข้อมูลจริง (ไม่ใช่จากนามสกุล) */
export const DETECTED_KINDS = [
  'zip', 'elf', 'pe', 'macho', 'dex', 'gzip', 'pdf', 'sevenzip', 'rar', 'png', 'text', 'unknown',
] as const
export type DetectedKind = (typeof DETECTED_KINDS)[number]

export type ExecutionMode = 'builtin' | 'worker' | 'mcp'

export interface ToolLimits {
  maxInputBytes: number
  timeoutMs: number
}

export interface ToolDescriptor {
  id: string
  name: string
  description: string
  executionMode: ExecutionMode
  /** ชนิดไฟล์ที่รองรับ; '*' = ทุกชนิด */
  fileKinds: readonly (DetectedKind | '*')[]
  limits: ToolLimits
}

export interface ToolProbe {
  installed: boolean
  healthy: boolean
  version: string
  detail: string
}

export interface ToolInput {
  bytes: Uint8Array
  name: string
}

export interface ToolResult {
  /** สรุปสั้น ๆ เก็บใน analysis_tool_runs.output_summary */
  summary: string
  /** ผลเต็ม เก็บเป็น tool_output artifact */
  data: Record<string, unknown>
}

export interface ToolAdapter {
  descriptor: ToolDescriptor
  version: string
  probe(): Promise<ToolProbe>
  run(input: ToolInput): Promise<ToolResult>
}

/** รัน fn พร้อมเพดานเวลา — เกินเวลาคืน error ชื่อ TimeoutError */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const e = new Error(`เกินเวลาที่กำหนด (${ms} ms)`)
          e.name = 'TimeoutError'
          reject(e)
        }, ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
