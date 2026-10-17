-- =============================================================================
-- 0008: Reverse Engineering Mode — ระยะ 04 (รายงาน / Technical Specification / ส่งต่อ)
--
--   analysis_reports  + kind      report = รายงานผลวิเคราะห์ (สร้างจากข้อมูลจริงโดยไม่ใช้ AI เขียน)
--                                 specification = ข้อกำหนดทางเทคนิค (AI แปลงข้อค้นพบ แล้วระบบตรวจย้อนกลับ)
--                     + meta      ข้อมูลโครงสร้างของเอกสาร (เช่น รายการข้อกำหนดพร้อม finding ที่อ้าง)
--                     + handoffs  ประวัติการส่งต่อไป Project Mode ([{project_id, at, mode, files}])
--                                 เก็บเป็น uuid เฉยๆ ไม่มี FK ไป projects (ไม่ผูกสองโหมดเข้าด้วยกัน)
--   เลขเวอร์ชันนับแยกตาม kind
--
-- ผู้ใช้อ่านได้อย่างเดียว (เหมือนเดิม) — เขียนผ่าน service role ฝั่ง server เท่านั้น
-- รันครั้งเดียวใน Supabase -> SQL Editor หลัง 0007 (รันซ้ำได้)
-- =============================================================================

alter table public.analysis_reports
  add column if not exists kind     text  not null default 'report',
  add column if not exists meta     jsonb not null default '{}'::jsonb,
  add column if not exists handoffs jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'analysis_reports_kind_check') then
    alter table public.analysis_reports
      add constraint analysis_reports_kind_check check (kind in ('report', 'specification'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'analysis_reports_meta_object') then
    alter table public.analysis_reports
      add constraint analysis_reports_meta_object check (jsonb_typeof(meta) = 'object');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'analysis_reports_handoffs_array') then
    alter table public.analysis_reports
      add constraint analysis_reports_handoffs_array check (jsonb_typeof(handoffs) = 'array');
  end if;
end $$;

-- เดิมเวอร์ชันไม่ซ้ำต่อ session → เปลี่ยนเป็นไม่ซ้ำต่อ (session, kind)
alter table public.analysis_reports drop constraint if exists analysis_reports_session_id_version_key;
create unique index if not exists analysis_reports_session_kind_version_uniq
  on public.analysis_reports (session_id, kind, version);
