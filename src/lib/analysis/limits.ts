// ขีดจำกัดของระบบวิเคราะห์ — ค่าเดียวใช้ทั้ง API, Registry และ migration 0006 (25 MB)
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
export const MAX_ARTIFACTS_PER_SESSION = 20
export const ANALYSIS_BUCKET = 'analysis-artifacts'

// เครื่องมือ builtin รันใน serverless function: เวลารวมต้องต่ำกว่า maxDuration ของ route
export const BUILTIN_TIMEOUT_MS = 15_000

// กันงานค้าง: run ที่ยังเป็น running เกินเวลานี้ถือว่าตาย
export const STALE_RUN_MS = 2 * 60 * 1000
