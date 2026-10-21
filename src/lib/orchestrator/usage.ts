import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateCost } from './pricing'

/**
 * บันทึก token + ค่าใช้จ่ายของการเรียก AI ที่ไม่ผูกกับ task (คุยแชท / สรุปความจำ) รวมเข้า spent_usd ของโปรเจกต์
 * บันทึกพลาดไม่ทำให้งานหลักล้ม
 */
export async function recordChatUsage(
  admin: SupabaseClient,
  p: { projectId: string; provider: string; model: string; tokensIn: number; tokensOut: number }
): Promise<void> {
  try {
    const cost = await calculateCost(admin, p.provider, p.model, p.tokensIn, p.tokensOut)
    const { error } = await admin.rpc('record_chat_usage', {
      p_project_id: p.projectId,
      p_provider: p.provider,
      p_model: p.model,
      p_tokens_in: p.tokensIn,
      p_tokens_out: p.tokensOut,
      p_cost_usd: cost,
    })
    if (error) {
      // ยังไม่ได้รัน migration 0004 → อย่างน้อยให้ token ถูกนับในแท็บการใช้งาน
      await admin.from('usage').insert({
        project_id: p.projectId,
        task_id: null,
        provider: p.provider,
        model: p.model,
        tokens_in: p.tokensIn,
        tokens_out: p.tokensOut,
        cost_usd: cost,
      })
    }
  } catch (e) {
    console.error('[usage] บันทึก usage ไม่สำเร็จ:', e instanceof Error ? e.message : e)
  }
}
