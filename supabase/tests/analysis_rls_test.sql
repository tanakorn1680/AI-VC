-- =============================================================================
-- analysis_rls_test.sql — ทดสอบสิทธิ์ของ 0005_analysis_foundation.sql
--
-- วิธีรัน: รัน schema.sql และ migrations 0002-0005 ก่อน แล้ววางไฟล์นี้ใน SQL Editor แล้วกด Run
--   * ผ่านทั้งหมด  → NOTICE "ALL ANALYSIS RLS TESTS PASSED" และ ROLLBACK ไม่ทิ้งข้อมูล
--   * ข้อใดล้มเหลว → EXCEPTION ระบุชื่อเทสต์ที่ล้ม
-- เกณฑ์ผ่านของระยะ 01: สร้างงาน บันทึกสถานะ โหลดกลับมาได้ และเข้าถึงข้ามบัญชีไม่ได้
-- =============================================================================
begin;

create or replace function pg_temp.act_as(p_uid uuid) returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', p_uid::text, true);
  execute 'set local role authenticated';
end $$;

create or replace function pg_temp.act_as_anon() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role anon';
end $$;

create or replace function pg_temp.act_as_service() returns void
language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  execute 'set local role service_role';
end $$;

create or replace function pg_temp.act_as_admin() returns void
language plpgsql as $$
begin
  execute 'reset role';
end $$;

-- คำสั่งนี้ "ต้องถูกบล็อก": error ใด ๆ (สิทธิ์ / constraint / trigger / FK) หรือกระทบ 0 แถว = ผ่าน
create or replace function pg_temp.expect_blocked(p_name text, p_sql text) returns void
language plpgsql as $$
declare v_rows bigint;
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      raise exception 'FAIL [%]: ควรถูกบล็อก แต่กระทบ % แถว', p_name, v_rows;
    end if;
  exception when others then
    if sqlerrm like 'FAIL [%' then raise; end if;
  end;
end $$;

-- คำสั่งนี้ "ต้องสำเร็จ" และกระทบอย่างน้อย 1 แถว
create or replace function pg_temp.expect_ok(p_name text, p_sql text) returns void
language plpgsql as $$
declare v_rows bigint;
begin
  execute p_sql;
  get diagnostics v_rows = row_count;
  if v_rows < 1 then
    raise exception 'FAIL [%]: ควรสำเร็จ แต่กระทบ 0 แถว', p_name;
  end if;
exception when others then
  if sqlerrm like 'FAIL [%' then raise; end if;
  raise exception 'FAIL [%]: ควรสำเร็จ แต่เกิด error: %', p_name, sqlerrm;
end $$;

create or replace function pg_temp.expect_count(p_name text, p_sql text, p_expected bigint) returns void
language plpgsql as $$
declare v bigint;
begin
  execute 'select count(*) from (' || p_sql || ') q' into v;
  if v <> p_expected then
    raise exception 'FAIL [%]: คาดว่า % แถว แต่ได้ %', p_name, p_expected, v;
  end if;
end $$;

-- ---------- เตรียมผู้ใช้ (admin) ----------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@test.local'),
  ('00000000-0000-0000-0000-0000000000b1', 'b@test.local');

-- =============================================================================
-- 1) ผู้ใช้สร้างงานของตัวเอง
-- =============================================================================
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_ok('A สร้างงานของตัวเองได้ (เส้นทางเดียวกับ API)',
  $q$insert into public.analysis_sessions (owner_id, title, goal, target_kind)
     values ('00000000-0000-0000-0000-0000000000a1', 'งานชั่วคราว', 'หาวิธีคำนวณ', 'apk')$q$);
select pg_temp.expect_blocked('A ตั้ง id ของแถวเองไม่ได้',
  $q$insert into public.analysis_sessions (id, owner_id, title)
     values ('10000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'ตั้ง id เอง')$q$);
select pg_temp.expect_blocked('A สร้างงานโดยอ้าง owner เป็น B',
  $q$insert into public.analysis_sessions (owner_id, title)
     values ('00000000-0000-0000-0000-0000000000b1', 'แอบสร้างให้ B')$q$);
select pg_temp.expect_blocked('A สร้างงานโดยตั้ง status เอง',
  $q$insert into public.analysis_sessions (owner_id, title, status)
     values ('00000000-0000-0000-0000-0000000000a1', 'หลอกสถานะ', 'completed')$q$);
select pg_temp.expect_blocked('A สร้างงานโดยตั้ง config เอง',
  $q$insert into public.analysis_sessions (owner_id, title, config)
     values ('00000000-0000-0000-0000-0000000000a1', 'หลอก config', '{"budget":999}')$q$);
select pg_temp.expect_blocked('ชื่องานว่างไม่ได้',
  $q$insert into public.analysis_sessions (owner_id, title)
     values ('00000000-0000-0000-0000-0000000000a1', '')$q$);
select pg_temp.expect_blocked('ประเภทเป้าหมายนอกรายการไม่ได้',
  $q$insert into public.analysis_sessions (owner_id, title, target_kind)
     values ('00000000-0000-0000-0000-0000000000a1', 'x', 'malware')$q$);

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select pg_temp.expect_ok('B สร้างงานของตัวเองได้',
  $q$insert into public.analysis_sessions (owner_id, title)
     values ('00000000-0000-0000-0000-0000000000b1', 'งานชั่วคราวของ B')$q$);

-- เตรียม fixture ที่มี id คงที่ (admin): ลบแถวชั่วคราวแล้วสร้างงานจริงของ A และ B
select pg_temp.act_as_admin();
delete from public.analysis_sessions;
insert into public.analysis_sessions (id, owner_id, title, goal, target_kind) values
  ('10000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000a1', 'งาน A', 'หาวิธีคำนวณ', 'apk'),
  ('10000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000b1', 'งาน B', '', 'unspecified');

-- =============================================================================
-- 2) โหลดกลับมา + แยกข้ามบัญชี
-- =============================================================================
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_count('A เห็นเฉพาะงานตัวเอง', 'select 1 from public.analysis_sessions', 1);
select pg_temp.expect_count('A อ่านงานของ B ตรง ๆ ไม่ได้',
  $q$select 1 from public.analysis_sessions where id = '10000000-0000-0000-0000-0000000000b1'$q$, 0);
select pg_temp.expect_count('A โหลดงานตัวเองกลับมาได้ และสถานะเริ่มต้นเป็น draft',
  $q$select 1 from public.analysis_sessions where id = '10000000-0000-0000-0000-0000000000a1' and status = 'draft'$q$, 1);

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select pg_temp.expect_count('B เห็นเฉพาะงานตัวเอง', 'select 1 from public.analysis_sessions', 1);
select pg_temp.expect_blocked('B แก้ชื่องานของ A',
  $q$update public.analysis_sessions set title = 'ถูกแก้' where id = '10000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.expect_blocked('B ยกเลิกงานของ A',
  $q$update public.analysis_sessions set status = 'cancelled' where id = '10000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.expect_blocked('B ลบงานของ A',
  $q$delete from public.analysis_sessions where id = '10000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.expect_blocked('B ย้ายงานของตัวเองไปเป็นของ A',
  $q$update public.analysis_sessions set owner_id = '00000000-0000-0000-0000-0000000000a1'
     where id = '10000000-0000-0000-0000-0000000000b1'$q$);

select pg_temp.act_as_anon();
select pg_temp.expect_blocked('anon อ่านงานไม่ได้', 'select 1 from public.analysis_sessions');
select pg_temp.expect_blocked('anon เรียก is_analysis_owner ไม่ได้',
  $q$select public.is_analysis_owner('10000000-0000-0000-0000-0000000000a1')$q$);

-- =============================================================================
-- 3) กฎการเปลี่ยนสถานะ / คอลัมน์ที่ผู้ใช้แก้ได้
-- =============================================================================
-- ทุกอย่างอยู่ใน transaction เดียว now() จึงคงที่: ย้อน created_at เพื่อให้ตรวจ updated_at ได้
select pg_temp.act_as_admin();
update public.analysis_sessions set created_at = created_at - interval '1 hour';
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_ok('A แก้ชื่อและเป้าหมายของตัวเองได้',
  $q$update public.analysis_sessions set title = 'งาน A (แก้แล้ว)', goal = 'เป้าหมายใหม่'
     where id = '10000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.expect_blocked('A แก้ config เองไม่ได้',
  $q$update public.analysis_sessions set config = '{"x":1}' where id = '10000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.expect_blocked('A แก้ owner_id เองไม่ได้',
  $q$update public.analysis_sessions set owner_id = '00000000-0000-0000-0000-0000000000b1'
     where id = '10000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.expect_blocked('A ตั้งสถานะเป็น completed เองไม่ได้',
  $q$update public.analysis_sessions set status = 'completed' where id = '10000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.expect_blocked('A ตั้งสถานะเป็น running เองไม่ได้',
  $q$update public.analysis_sessions set status = 'running' where id = '10000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.expect_ok('A ยกเลิกงานของตัวเองได้ (draft -> cancelled)',
  $q$update public.analysis_sessions set status = 'cancelled' where id = '10000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.expect_blocked('A ฟื้นงานที่ยกเลิกแล้วกลับเป็น draft ไม่ได้',
  $q$update public.analysis_sessions set status = 'draft' where id = '10000000-0000-0000-0000-0000000000a1'$q$);

-- ระบบ (service role) เปลี่ยนสถานะได้ และ updated_at เปลี่ยนตาม
select pg_temp.act_as_service();
select pg_temp.expect_ok('service role เปลี่ยนสถานะงาน B เป็น running ได้',
  $q$update public.analysis_sessions set status = 'running' where id = '10000000-0000-0000-0000-0000000000b1'$q$);
select pg_temp.act_as_admin();
do $$ begin
  if not exists (select 1 from public.analysis_sessions where title = 'งาน A (แก้แล้ว)' and updated_at > created_at) then
    raise exception 'FAIL [updated_at ไม่ถูกอัปเดตเมื่อแก้งาน]';
  end if;
end $$;

-- =============================================================================
-- 4) ตารางลูก: เขียนได้เฉพาะ service role, เจ้าของอ่านได้อย่างเดียว
-- =============================================================================
select pg_temp.act_as_service();
insert into public.analysis_tasks (id, session_id, title)
  values ('20000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a1', 'ตรวจไฟล์');
insert into public.analysis_tool_runs (id, session_id, task_id, tool_id)
  values ('30000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a1',
          '20000000-0000-0000-0000-0000000000a1', 'example-tool');
insert into public.analysis_artifacts (id, session_id, kind, name, storage_path, size_bytes, sha256, produced_by_run_id)
  values ('40000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a1', 'tool_output',
          'out.txt', 'a/out.txt', 10, repeat('a', 64), '30000000-0000-0000-0000-0000000000a1');
insert into public.analysis_findings (id, session_id, title)
  values ('50000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a1', 'ข้อค้นพบ');
insert into public.analysis_evidence (session_id, finding_id, artifact_id, locator)
  values ('10000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000a1',
          '40000000-0000-0000-0000-0000000000a1', 'offset 0x10');
insert into public.analysis_reports (session_id, version, content)
  values ('10000000-0000-0000-0000-0000000000a1', 1, 'รายงาน');
insert into public.analysis_findings (id, session_id, title)
  values ('50000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-0000000000b1', 'ข้อค้นพบของ B');

select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_count('A อ่าน tasks ของตัวเองได้',      'select 1 from public.analysis_tasks', 1);
select pg_temp.expect_count('A อ่าน tool_runs ของตัวเองได้',  'select 1 from public.analysis_tool_runs', 1);
select pg_temp.expect_count('A อ่าน artifacts ของตัวเองได้',  'select 1 from public.analysis_artifacts', 1);
select pg_temp.expect_count('A อ่าน findings ของตัวเองได้ (ไม่เห็นของ B)', 'select 1 from public.analysis_findings', 1);
select pg_temp.expect_count('A อ่าน evidence ของตัวเองได้',   'select 1 from public.analysis_evidence', 1);
select pg_temp.expect_count('A อ่าน reports ของตัวเองได้',    'select 1 from public.analysis_reports', 1);

select pg_temp.expect_blocked('A เขียน task เองไม่ได้',
  $q$insert into public.analysis_tasks (session_id, title) values ('10000000-0000-0000-0000-0000000000a1', 'x')$q$);
select pg_temp.expect_blocked('A เขียน tool run เองไม่ได้',
  $q$insert into public.analysis_tool_runs (session_id, tool_id) values ('10000000-0000-0000-0000-0000000000a1', 'x')$q$);
select pg_temp.expect_blocked('A เขียน artifact เองไม่ได้',
  $q$insert into public.analysis_artifacts (session_id, kind, name, storage_path, size_bytes, sha256)
     values ('10000000-0000-0000-0000-0000000000a1', 'source', 'x', 'x', 1, repeat('b', 64))$q$);
select pg_temp.expect_blocked('A ปลอม finding เองไม่ได้',
  $q$insert into public.analysis_findings (session_id, title, confidence)
     values ('10000000-0000-0000-0000-0000000000a1', 'ปลอม', 'high')$q$);
select pg_temp.expect_blocked('A ปลอม evidence เองไม่ได้',
  $q$insert into public.analysis_evidence (session_id, finding_id, artifact_id)
     values ('10000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000a1',
             '40000000-0000-0000-0000-0000000000a1')$q$);
select pg_temp.expect_blocked('A เขียนรายงานเองไม่ได้',
  $q$insert into public.analysis_reports (session_id, version, content)
     values ('10000000-0000-0000-0000-0000000000a1', 2, 'ปลอม')$q$);
select pg_temp.expect_blocked('A แก้ระดับความเชื่อมั่นของ finding เองไม่ได้',
  $q$update public.analysis_findings set confidence = 'high' where id = '50000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.expect_blocked('A ลบ evidence เองไม่ได้',
  $q$delete from public.analysis_evidence where session_id = '10000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.expect_blocked('A แก้ task เองไม่ได้',
  $q$update public.analysis_tasks set status = 'completed' where id = '20000000-0000-0000-0000-0000000000a1'$q$);

select pg_temp.act_as('00000000-0000-0000-0000-0000000000b1');
select pg_temp.expect_count('B ไม่เห็น tasks ของ A',     'select 1 from public.analysis_tasks', 0);
select pg_temp.expect_count('B ไม่เห็น tool_runs ของ A', 'select 1 from public.analysis_tool_runs', 0);
select pg_temp.expect_count('B ไม่เห็น artifacts ของ A', 'select 1 from public.analysis_artifacts', 0);
select pg_temp.expect_count('B เห็น findings เฉพาะของตัวเอง', 'select 1 from public.analysis_findings', 1);
select pg_temp.expect_count('B ไม่เห็น evidence ของ A',  'select 1 from public.analysis_evidence', 0);
select pg_temp.expect_count('B ไม่เห็น reports ของ A',   'select 1 from public.analysis_reports', 0);

select pg_temp.act_as_anon();
select pg_temp.expect_blocked('anon อ่าน findings ไม่ได้', 'select 1 from public.analysis_findings');

-- =============================================================================
-- 5) ความสมบูรณ์ข้าม session (composite FK) และกฎหลักฐาน
-- =============================================================================
select pg_temp.act_as_service();
select pg_temp.expect_blocked('evidence ผูก finding ของ A เข้ากับ session ของ B',
  $q$insert into public.analysis_evidence (session_id, finding_id, artifact_id)
     values ('10000000-0000-0000-0000-0000000000b1', '50000000-0000-0000-0000-0000000000a1',
             '40000000-0000-0000-0000-0000000000a1')$q$);
select pg_temp.expect_blocked('evidence ของ session B อ้าง artifact ของ A',
  $q$insert into public.analysis_evidence (session_id, finding_id, artifact_id)
     values ('10000000-0000-0000-0000-0000000000b1', '50000000-0000-0000-0000-0000000000b1',
             '40000000-0000-0000-0000-0000000000a1')$q$);
select pg_temp.expect_blocked('tool run ของ session B อ้าง task ของ A',
  $q$insert into public.analysis_tool_runs (session_id, task_id, tool_id)
     values ('10000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000a1', 'x')$q$);
select pg_temp.expect_blocked('artifact ของ session B อ้าง tool run ของ A',
  $q$insert into public.analysis_artifacts (session_id, kind, name, storage_path, size_bytes, sha256, produced_by_run_id)
     values ('10000000-0000-0000-0000-0000000000b1', 'tool_output', 'x', 'x', 1, repeat('c', 64),
             '30000000-0000-0000-0000-0000000000a1')$q$);
select pg_temp.expect_blocked('evidence ต้องชี้ไป artifact หรือ tool run อย่างน้อยหนึ่งอย่าง',
  $q$insert into public.analysis_evidence (session_id, finding_id)
     values ('10000000-0000-0000-0000-0000000000a1', '50000000-0000-0000-0000-0000000000a1')$q$);
select pg_temp.expect_blocked('sha256 ต้องเป็น hex 64 ตัว',
  $q$insert into public.analysis_artifacts (session_id, kind, name, storage_path, size_bytes, sha256)
     values ('10000000-0000-0000-0000-0000000000a1', 'source', 'x', 'x', 1, 'not-a-hash')$q$);
select pg_temp.expect_blocked('task พึ่งพาตัวเองไม่ได้',
  $q$insert into public.analysis_tasks (id, session_id, title, depends_on)
     values ('20000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-0000000000a1', 'x',
             array['20000000-0000-0000-0000-0000000000c1']::uuid[])$q$);
select pg_temp.expect_blocked('รายงานเวอร์ชันซ้ำใน session เดียวกันไม่ได้',
  $q$insert into public.analysis_reports (session_id, version) values ('10000000-0000-0000-0000-0000000000a1', 1)$q$);

-- =============================================================================
-- 6) ลบงาน -> ข้อมูลลูกหายตาม (cascade) และลบข้ามบัญชีไม่ได้
-- =============================================================================
select pg_temp.act_as('00000000-0000-0000-0000-0000000000a1');
select pg_temp.expect_ok('A ลบงานของตัวเองได้',
  $q$delete from public.analysis_sessions where id = '10000000-0000-0000-0000-0000000000a1'$q$);
select pg_temp.act_as_admin();
do $$
declare n bigint;
begin
  select (select count(*) from public.analysis_tasks      where session_id = '10000000-0000-0000-0000-0000000000a1')
       + (select count(*) from public.analysis_tool_runs  where session_id = '10000000-0000-0000-0000-0000000000a1')
       + (select count(*) from public.analysis_artifacts  where session_id = '10000000-0000-0000-0000-0000000000a1')
       + (select count(*) from public.analysis_findings   where session_id = '10000000-0000-0000-0000-0000000000a1')
       + (select count(*) from public.analysis_evidence   where session_id = '10000000-0000-0000-0000-0000000000a1')
       + (select count(*) from public.analysis_reports    where session_id = '10000000-0000-0000-0000-0000000000a1')
    into n;
  if n <> 0 then raise exception 'FAIL [ลบงานแล้วข้อมูลลูกไม่หายตาม: เหลือ % แถว]', n; end if;
  if not exists (select 1 from public.analysis_sessions where id = '10000000-0000-0000-0000-0000000000b1') then
    raise exception 'FAIL [ลบงาน A แล้วงานของ B หายไปด้วย]';
  end if;
end $$;

do $$ begin raise notice 'ALL ANALYSIS RLS TESTS PASSED'; end $$;
rollback;
