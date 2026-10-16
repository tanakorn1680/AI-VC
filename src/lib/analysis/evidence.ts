/**
 * ตรวจหลักฐานและให้ระดับความเชื่อมั่น — ทำฝั่งระบบทั้งหมด ไม่เชื่อสิ่งที่โมเดลอ้างเอง
 *
 * หลักฐานที่ "ผ่าน" ต้อง:
 *   1) อ้าง tool run ที่อยู่ในงานนี้และสำเร็จจริง
 *   2) ข้อความที่ยกมา (excerpt) ปรากฏอยู่ในผลลัพธ์จริงของ run นั้น (เทียบหลัง normalize ช่องว่าง)
 */
export type ConfidenceLevel = 'unverified' | 'low' | 'medium' | 'high'

const ORDER: ConfidenceLevel[] = ['unverified', 'low', 'medium', 'high']

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** excerpt ต้องยาวพอจะเป็นหลักฐาน (ไม่ใช่คำสั้น ๆ ที่บังเอิญตรง) และอยู่ในผลลัพธ์จริง */
export function excerptIsGrounded(excerpt: string, outputText: string): boolean {
  const e = normalizeText(excerpt)
  if (e.length < 3) return false
  return normalizeText(outputText).includes(e)
}

/**
 * ระดับที่ระบบให้ได้จากหลักฐานที่ผ่านการตรวจแล้ว
 *   ไม่มีหลักฐาน → unverified · 1 → low · ≥2 → medium · ≥3 จาก ≥2 run ต่างกัน → high
 */
export function computedConfidence(verified: { toolRunId: string }[]): ConfidenceLevel {
  const n = verified.length
  if (n === 0) return 'unverified'
  const runs = new Set(verified.map((v) => v.toolRunId)).size
  if (n >= 3 && runs >= 2) return 'high'
  if (n >= 2) return 'medium'
  return 'low'
}

/** ระดับสุดท้ายคือค่าต่ำกว่าระหว่างที่โมเดลอ้างกับที่ระบบคำนวณ (โมเดลดันระดับให้สูงขึ้นไม่ได้) */
export function finalConfidence(claimed: unknown, computed: ConfidenceLevel): ConfidenceLevel {
  const c = ORDER.indexOf(claimed as ConfidenceLevel)
  if (c < 0) return computed
  return ORDER[Math.min(c, ORDER.indexOf(computed))] as ConfidenceLevel
}
