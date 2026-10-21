/**
 * งบ context กลาง — ทุกอย่างที่ส่งเข้าโมเดลต้องผ่านค่าเพดานในไฟล์นี้
 * เหตุผล: ยิ่ง prompt ยาว โมเดลยิ่งหลุดประเด็นและแพง จึงกำหนดเพดานเป็น "token โดยประมาณ" ไว้ที่เดียว
 * (ปรับค่าที่นี่ที่เดียว ไม่ต้องไล่แก้ทุกไฟล์)
 */

/**
 * ประมาณจำนวน token โดยไม่เรียก tokenizer จริง (เร็ว ไม่มี dependency)
 * ภาษาอังกฤษ/โค้ด ≈ 4 ตัวอักษรต่อ token, ภาษาไทยและอักขระอื่น ≈ 1.6 ตัวอักษรต่อ token (ประมาณแบบระมัดระวัง ให้สูงกว่าจริงนิดหน่อย)
 */
export function estimateTokens(text: string): number {
  let ascii = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++
    else other++
  }
  return Math.ceil(ascii / 4 + other / 1.6)
}

/** ตัดข้อความให้ไม่เกิน max ตัวอักษร (ต่อท้าย … ถ้าถูกตัด) */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

export const BUDGET = {
  // ---- หัวหน้าทีม (ผู้ประสานงาน) ----
  /** token ของประวัติแชทดิบที่ส่งให้หัวหน้าทีมได้สูงสุดต่อครั้ง */
  leadHistoryTokens: 3500,
  /** ประวัติแชทดิบที่ยังไม่ถูกสรุปเกินค่านี้ → ระบบรีเฟรชความจำอัตโนมัติ (สรุปของเก่าลง brief) */
  refreshTriggerTokens: 3000,
  /** ตอนรีเฟรช เก็บข้อความล่าสุดไว้แบบดิบกี่ข้อความ (บทสนทนาไม่ขาดตอน) */
  keepRecentMessages: 4,
  /** ความยาวต่อบรรทัดของประวัติแชท */
  historyLineChars: 1200,
  /** ผลงานของ task ที่โผล่ในแชท ตัดให้สั้นเมื่อส่งให้หัวหน้าทีม */
  taskResultChars: 300,

  // ---- ความจำโปรเจกต์ (brief) ----
  briefMaxChars: 3000,
  /** brief ส่งให้ worker ได้ไม่เกินนี้ (ตัดท้าย) */
  briefForWorkerChars: 1800,

  // ---- คนทำงาน (worker) ----
  /** เพดาน token ของ prompt ขาเข้าต่อ 1 task (ไม่รวมคำตอบ) */
  workerInputTokens: 7000,
  instructionsChars: 1500,
  dependencySummaryChars: 600,
  dependencyTotalChars: 2400,
  /** ผู้ตรวจต้องเห็นผลงานจริงของงานที่ตรวจ ไม่ใช่แค่สรุป */
  reviewerOutputPerDepChars: 4000,
  reviewerOutputTotalChars: 8000,
  filesMaxCharsPerFile: 6000,
  filesMaxCharsTotal: 12000,

  // ---- ตอนสรุปความจำ ----
  /** ข้อความที่ส่งเข้ารอบสรุปได้สูงสุดต่อครั้ง */
  memoryInputChars: 14000,
  memoryLineChars: 700,
  memoryMaxOutputTokens: 900,
} as const

/** ตัวอักษรที่เหลือได้สำหรับเนื้อหาไฟล์ เมื่อส่วนอื่นของ prompt ใช้ไปแล้ว usedTokens (ไม่ต่ำกว่า 0) */
export function remainingChars(totalTokens: number, usedTokens: number, charsPerToken = 3): number {
  return Math.max(0, Math.floor((totalTokens - usedTokens) * charsPerToken))
}
