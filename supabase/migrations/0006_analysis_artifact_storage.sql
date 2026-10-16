-- =============================================================================
-- 0006: Reverse Engineering Mode — ระยะ 02 (ที่เก็บ Artifact)
--
--   * สร้าง Storage bucket แบบ private ชื่อ analysis-artifacts (จำกัด 25 MB ต่อไฟล์)
--   * ไม่สร้าง policy บน storage.objects: ผู้ใช้เข้าถึงไฟล์ตรง ๆ ไม่ได้เลย
--     อัปโหลดผ่าน signed upload URL ที่ server ออกให้หลังตรวจเจ้าของงาน
--     อ่านไฟล์ผ่าน service role ฝั่ง server เท่านั้น (Worker / Orchestrator)
--   * storage_path ของ artifact ต้องไม่ซ้ำ (กัน finalize ซ้ำ / ชี้ไฟล์เดียวกันสองแถว)
--   * หนึ่งงานวิเคราะห์มี tool run ที่ active ได้ทีละหนึ่ง
--
-- รันครั้งเดียวใน Supabase -> SQL Editor หลัง 0005 (รันซ้ำได้)
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit)
values ('analysis-artifacts', 'analysis-artifacts', false, 26214400)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit;

create unique index if not exists analysis_artifacts_storage_path_uniq
  on public.analysis_artifacts (storage_path);

-- หนึ่งงานวิเคราะห์รันเครื่องมือได้ทีละหนึ่ง run (กันคำขอซ้อนแข่งกันตรวจแล้วผ่านทั้งคู่)
create unique index if not exists analysis_tool_runs_one_active_per_session
  on public.analysis_tool_runs (session_id)
  where status in ('queued', 'running');
