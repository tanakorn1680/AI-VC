-- =============================================================================
-- 0009: ขนาดของไฟล์แต่ละเวอร์ชัน (ไบต์) สำหรับแสดงในหน้า Files
--
--   file_versions.size_bytes = octet_length(content) คำนวณโดยฐานข้อมูลเอง (generated column)
--   จึงไม่ต้องดึงเนื้อหาทั้งไฟล์มาเพื่อนับขนาด และผู้ใช้/agent เขียนค่านี้เองไม่ได้
--
-- ถ้ายังไม่รัน migration นี้ หน้า Files ยังใช้งานได้ตามปกติ เพียงแต่ไม่แสดงขนาดไฟล์
-- รันครั้งเดียวใน Supabase -> SQL Editor (รันซ้ำได้)
-- =============================================================================
alter table public.file_versions
  add column if not exists size_bytes integer generated always as (octet_length(content)) stored;
