import type { SupabaseClient } from '@supabase/supabase-js'
import type { AnalysisCounts } from './types'

/**
 * นับแถวลูกของงานวิเคราะห์ — ต้องส่ง client ที่ผูกกับผู้ใช้ (ผ่าน RLS) เท่านั้น
 * ห้ามส่ง service-role client เพราะจะข้ามการตรวจสิทธิ์เจ้าของงาน
 */
export async function countChildren(
  supabase: SupabaseClient,
  sessionId: string
): Promise<AnalysisCounts> {
  const count = async (table: string) => {
    const { count: n } = await supabase
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('session_id', sessionId)
    return n ?? 0
  }
  const [tasks, tool_runs, artifacts, findings, evidence, reports] = await Promise.all([
    count('analysis_tasks'),
    count('analysis_tool_runs'),
    count('analysis_artifacts'),
    count('analysis_findings'),
    count('analysis_evidence'),
    count('analysis_reports'),
  ])
  return { tasks, tool_runs, artifacts, findings, evidence, reports }
}
