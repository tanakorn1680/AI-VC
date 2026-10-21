import { apiError } from '@/lib/utils/api'

/**
 * เลิกใช้แล้ว — AI เป็นของ "ทีม" ใช้ร่วมกันทุกโปรเจกต์ ใช้ /api/teams/:teamId/agents แทน
 * (หน้าโปรเจกต์ดูทีมของโปรเจกต์ได้ที่ GET /api/projects/:id/team)
 * คงไฟล์ไว้เป็น stub เพื่อให้การแตกไฟล์ทับ repo เดิมไม่ทิ้งโค้ดเก่าที่ยังผูก agent กับโปรเจกต์
 */
const gone = () => apiError('BAD_REQUEST', 'เส้นทางนี้เลิกใช้แล้ว — AI เป็นของทีม ใช้ /api/teams/:teamId/agents แทน')

export const GET = gone
export const PATCH = gone
export const DELETE = gone
