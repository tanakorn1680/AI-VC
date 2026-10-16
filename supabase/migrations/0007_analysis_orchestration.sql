-- =============================================================================
-- 0007: Reverse Engineering Mode — ระยะ 03 (AI Orchestration)
--
--   analysis_sessions  + analyst_agent_id  agent ที่ใช้เป็นนักวิเคราะห์ (ยืมแค่ provider/model/key)
--                        เก็บเป็น uuid เฉยๆ ไม่มี FK ไป Project Mode; ฝั่ง server ตรวจเจ้าของซ้ำทุกครั้งที่ใช้
--                      + token_budget      เพดาน token รวมของงาน (ผู้ใช้ตั้งได้ ภายใน 10k–2M)
--                      + tokens_in/out, cost_usd   ยอดใช้จริง (เขียนโดย service role เท่านั้น)
--                      + last_error        เหตุผลล่าสุดที่งานหยุด (แสดงให้ผู้ใช้เห็น)
--                      + step_lock_until   lease กัน step ซ้อนกันเมื่อเรียกพร้อมกัน
--   analysis_findings  + kind  finding = ข้อค้นพบ (ต้องมีหลักฐานจึงเกิน unverified)
--                              limitation = ข้อจำกัด/สิ่งที่ตรวจสอบไม่ได้ (ไม่ต้องมีหลักฐาน)
--
-- รันครั้งเดียวใน Supabase -> SQL Editor หลัง 0006 (รันซ้ำได้)
-- =============================================================================

alter table public.analysis_sessions
  add column if not exists analyst_agent_id uuid,
  add column if not exists token_budget     bigint        not null default 200000,
  add column if not exists tokens_in        bigint        not null default 0,
  add column if not exists tokens_out       bigint        not null default 0,
  add column if not exists cost_usd         numeric(12,6) not null default 0,
  add column if not exists last_error       text,
  add column if not exists step_lock_until  timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'analysis_sessions_token_budget_range') then
    alter table public.analysis_sessions
      add constraint analysis_sessions_token_budget_range
      check (token_budget between 10000 and 2000000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'analysis_sessions_usage_nonneg') then
    alter table public.analysis_sessions
      add constraint analysis_sessions_usage_nonneg
      check (tokens_in >= 0 and tokens_out >= 0 and cost_usd >= 0);
  end if;
end $$;

alter table public.analysis_findings
  add column if not exists kind text not null default 'finding';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'analysis_findings_kind_check') then
    alter table public.analysis_findings
      add constraint analysis_findings_kind_check check (kind in ('finding', 'limitation'));
  end if;
end $$;

-- ผู้ใช้แก้ได้เพิ่มเฉพาะ agent ที่ใช้วิเคราะห์ และงบ token (ยอดใช้จริง/lease/ข้อผิดพลาดเป็นของระบบ)
grant update (analyst_agent_id, token_budget) on public.analysis_sessions to authenticated;
