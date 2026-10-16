-- =============================================================================
-- 0005: Reverse Engineering Mode — ระยะ 01 (Foundation)
--
--   ตารางสำหรับวงจรงานวิเคราะห์ซอฟต์แวร์ แยกจาก Project Mode อย่างสิ้นเชิง
--   (ไม่แก้ตารางเดิม ไม่มี foreign key ไปยัง projects / tasks / files)
--
--   analysis_sessions   งานวิเคราะห์ เจ้าของ เป้าหมาย สถานะ
--   analysis_tasks      ขั้นตอนวิเคราะห์ (dependency / retry / สถานะ)
--   analysis_tool_runs  ประวัติการเรียกเครื่องมือ (เวอร์ชัน เวลา ผลลัพธ์ ข้อผิดพลาด)
--   analysis_artifacts  ไฟล์ต้นทางและผลลัพธ์ของเครื่องมือ (เก็บ metadata + hash ไม่เก็บไบนารีในตาราง)
--   analysis_findings   ข้อค้นพบและระดับความเชื่อมั่น
--   analysis_evidence   หลักฐานที่ผูก Finding เข้ากับ Artifact / Tool run
--   analysis_reports    รายงาน (มีเวอร์ชัน)
--
-- หลักการสิทธิ์ (ตามรูปแบบเดียวกับ 0001):
--   * RLS เปิดทุกตาราง — เจ้าของงานเท่านั้นที่อ่านได้
--   * ผู้ใช้เขียนได้เฉพาะ analysis_sessions (สร้าง / แก้ชื่อ-เป้าหมาย / ยกเลิก / ลบ)
--   * ตารางอื่นทั้งหมดเขียนได้เฉพาะ service role (Worker/Orchestrator ฝั่ง server)
--     เพื่อไม่ให้ผู้ใช้ปลอมผลวิเคราะห์หรือหลักฐานได้
--   * ความเป็นเจ้าของตรวจผ่านแถว analysis_sessions ใน DB ไม่เชื่อ UUID จาก browser
--   * ข้อมูลที่ผูกกันข้ามตาราง (finding ↔ evidence ↔ artifact ↔ tool run) ต้องอยู่ session
--     เดียวกัน บังคับด้วย composite foreign key (id, session_id) ระดับ DB
--
-- รันครั้งเดียวใน Supabase -> SQL Editor หลัง schema.sql และ 0002-0004 (รันซ้ำได้ ไม่พัง)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- analysis_sessions
-- -----------------------------------------------------------------------------
create table if not exists public.analysis_sessions (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 200),
  goal        text not null default '' check (char_length(goal) <= 4000),
  -- ประเภทเป้าหมายที่ผู้ใช้ "ระบุ" (ข้อมูลประกอบเท่านั้น ไม่ได้แปลว่าระบบมีเครื่องมือรองรับ)
  target_kind text not null default 'unspecified'
    check (target_kind in ('unspecified', 'source_code', 'apk', 'executable', 'binary', 'other')),
  status      text not null default 'draft'
    check (status in ('draft', 'awaiting_tools', 'planning', 'running', 'completed', 'failed', 'cancelled')),
  -- งบ/ขอบเขตการวิเคราะห์ (ตั้งโดยระบบ ผู้ใช้ยังแก้ตรง ๆ ไม่ได้)
  config      jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists analysis_sessions_owner_idx
  on public.analysis_sessions (owner_id, created_at desc);

-- -----------------------------------------------------------------------------
-- ตัวช่วยตรวจเจ้าของ (security definer + search_path ล็อก เช่นเดียวกับ is_project_owner)
-- ต้องสร้างหลังตาราง analysis_sessions เพราะฟังก์ชัน SQL ถูกตรวจ body ตอนสร้าง
-- -----------------------------------------------------------------------------
create or replace function public.is_analysis_owner(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.analysis_sessions s
    where s.id = p_session_id
      and s.owner_id = (select auth.uid())
  );
$$;

-- -----------------------------------------------------------------------------
-- analysis_tasks
-- -----------------------------------------------------------------------------
create table if not exists public.analysis_tasks (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.analysis_sessions (id) on delete cascade,
  title         text not null check (char_length(title) between 1 and 300),
  description   text not null default '',
  -- เงื่อนไขสำเร็จของขั้นนี้ และข้อมูลที่ต้องการ (Planner กำหนด)
  success_criteria text not null default '',
  status        text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  priority      integer not null default 0,
  depends_on    uuid[] not null default '{}'::uuid[],
  input         jsonb not null default '{}'::jsonb,
  error         text,
  attempts      integer not null default 0 check (attempts >= 0),
  max_attempts  integer not null default 2 check (max_attempts between 1 and 5),
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  completed_at  timestamptz,
  constraint analysis_tasks_no_self_dependency check (not (id = any (depends_on))),
  -- ใช้เป็นเป้าของ composite foreign key จากตารางลูก
  constraint analysis_tasks_id_session_uniq unique (id, session_id)
);
create index if not exists analysis_tasks_session_status_idx
  on public.analysis_tasks (session_id, status);

-- -----------------------------------------------------------------------------
-- analysis_tool_runs
-- -----------------------------------------------------------------------------
create table if not exists public.analysis_tool_runs (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.analysis_sessions (id) on delete cascade,
  task_id      uuid,
  tool_id      text not null check (char_length(tool_id) between 1 and 100),
  tool_version text not null default '' check (char_length(tool_version) <= 100),
  status       text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'timed_out', 'cancelled')),
  input        jsonb not null default '{}'::jsonb,
  -- สรุปผลสั้น ๆ; ผลเต็มเก็บเป็น artifact
  output_summary text not null default '',
  exit_code    integer,
  error        text,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  constraint analysis_tool_runs_id_session_uniq unique (id, session_id),
  constraint analysis_tool_runs_task_fk
    foreign key (task_id, session_id) references public.analysis_tasks (id, session_id)
);
create index if not exists analysis_tool_runs_session_idx
  on public.analysis_tool_runs (session_id, created_at desc);

-- -----------------------------------------------------------------------------
-- analysis_artifacts — เก็บ metadata + ตำแหน่งอ้างอิงเท่านั้น
-- ไบนารีจริงอยู่ในที่เก็บ Artifact แยก ไม่เก็บเป็นข้อความใน files / file_versions
-- -----------------------------------------------------------------------------
create table if not exists public.analysis_artifacts (
  id                uuid primary key default gen_random_uuid(),
  session_id        uuid not null references public.analysis_sessions (id) on delete cascade,
  kind              text not null check (kind in ('source', 'tool_output', 'report_attachment')),
  name              text not null check (char_length(name) between 1 and 300),
  storage_path      text not null check (char_length(storage_path) between 1 and 500),
  size_bytes        bigint not null check (size_bytes >= 0),
  sha256            text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  mime_type         text,
  metadata          jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  produced_by_run_id uuid,
  created_at        timestamptz not null default now(),
  constraint analysis_artifacts_id_session_uniq unique (id, session_id),
  constraint analysis_artifacts_run_fk
    foreign key (produced_by_run_id, session_id)
    references public.analysis_tool_runs (id, session_id)
);
create index if not exists analysis_artifacts_session_idx
  on public.analysis_artifacts (session_id, created_at desc);

-- -----------------------------------------------------------------------------
-- analysis_findings
-- -----------------------------------------------------------------------------
create table if not exists public.analysis_findings (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.analysis_sessions (id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 300),
  statement   text not null default '',
  -- unverified = ยังไม่มีหลักฐานรองรับ; ระดับอื่นต้องมี evidence (ตรวจในชั้น Orchestrator)
  confidence  text not null default 'unverified'
    check (confidence in ('unverified', 'low', 'medium', 'high')),
  created_at  timestamptz not null default now(),
  constraint analysis_findings_id_session_uniq unique (id, session_id)
);
create index if not exists analysis_findings_session_idx
  on public.analysis_findings (session_id, created_at desc);

-- -----------------------------------------------------------------------------
-- analysis_evidence — ทุกหลักฐานต้องชี้ไป artifact หรือ tool run อย่างน้อยหนึ่งอย่าง
-- -----------------------------------------------------------------------------
create table if not exists public.analysis_evidence (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.analysis_sessions (id) on delete cascade,
  finding_id  uuid not null,
  artifact_id uuid,
  tool_run_id uuid,
  -- ตำแหน่งอ้างอิงในต้นทาง เช่น offset / ชื่อฟังก์ชัน / บรรทัด
  locator     text not null default '' check (char_length(locator) <= 500),
  excerpt     text not null default '' check (char_length(excerpt) <= 4000),
  created_at  timestamptz not null default now(),
  constraint analysis_evidence_has_source check (artifact_id is not null or tool_run_id is not null),
  constraint analysis_evidence_finding_fk
    foreign key (finding_id, session_id) references public.analysis_findings (id, session_id) on delete cascade,
  constraint analysis_evidence_artifact_fk
    foreign key (artifact_id, session_id) references public.analysis_artifacts (id, session_id),
  constraint analysis_evidence_tool_run_fk
    foreign key (tool_run_id, session_id) references public.analysis_tool_runs (id, session_id)
);
create index if not exists analysis_evidence_finding_idx
  on public.analysis_evidence (finding_id);
create index if not exists analysis_evidence_session_idx
  on public.analysis_evidence (session_id);

-- -----------------------------------------------------------------------------
-- analysis_reports
-- -----------------------------------------------------------------------------
create table if not exists public.analysis_reports (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.analysis_sessions (id) on delete cascade,
  version     integer not null check (version >= 1),
  status      text not null default 'draft' check (status in ('draft', 'final')),
  content     text not null default '',
  created_at  timestamptz not null default now(),
  unique (session_id, version)
);

-- -----------------------------------------------------------------------------
-- Trigger: updated_at ของ analysis_sessions
-- -----------------------------------------------------------------------------
create or replace function public.analysis_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists analysis_sessions_touch on public.analysis_sessions;
create trigger analysis_sessions_touch
  before update on public.analysis_sessions
  for each row execute function public.analysis_touch_updated_at();

-- -----------------------------------------------------------------------------
-- Trigger: ผู้ใช้เปลี่ยนสถานะงานได้แค่ "ยกเลิก" (สถานะอื่นเป็นของระบบ)
-- ใช้แนวป้องกันเดียวกับ guard_task_status_change: service role (auth.uid() null)
-- และฟังก์ชัน security definer (current_user เป็นเจ้าของฟังก์ชัน) ผ่านได้
-- -----------------------------------------------------------------------------
create or replace function public.guard_analysis_session_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  if new.status is distinct from old.status then
    if new.status = 'cancelled'
       and old.status in ('draft', 'awaiting_tools', 'planning', 'running') then
      return new;
    end if;
    raise exception 'ผู้ใช้เปลี่ยนสถานะงานวิเคราะห์จาก % เป็น % ไม่ได้', old.status, new.status
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists analysis_sessions_status_guard on public.analysis_sessions;
create trigger analysis_sessions_status_guard
  before update of status on public.analysis_sessions
  for each row execute function public.guard_analysis_session_status();

-- -----------------------------------------------------------------------------
-- เปิด RLS ทุกตาราง (deny by default)
-- -----------------------------------------------------------------------------
alter table public.analysis_sessions  enable row level security;
alter table public.analysis_tasks     enable row level security;
alter table public.analysis_tool_runs enable row level security;
alter table public.analysis_artifacts enable row level security;
alter table public.analysis_findings  enable row level security;
alter table public.analysis_evidence  enable row level security;
alter table public.analysis_reports   enable row level security;

-- -----------------------------------------------------------------------------
-- Policies
-- -----------------------------------------------------------------------------
drop policy if exists analysis_sessions_select_own on public.analysis_sessions;
create policy analysis_sessions_select_own on public.analysis_sessions
  for select to authenticated using (owner_id = (select auth.uid()));

drop policy if exists analysis_sessions_insert_own on public.analysis_sessions;
create policy analysis_sessions_insert_own on public.analysis_sessions
  for insert to authenticated with check (owner_id = (select auth.uid()));

drop policy if exists analysis_sessions_update_own on public.analysis_sessions;
create policy analysis_sessions_update_own on public.analysis_sessions
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists analysis_sessions_delete_own on public.analysis_sessions;
create policy analysis_sessions_delete_own on public.analysis_sessions
  for delete to authenticated using (owner_id = (select auth.uid()));

-- ตารางลูก: อ่านได้อย่างเดียว (เขียนผ่าน service role)
drop policy if exists analysis_tasks_select_owner on public.analysis_tasks;
create policy analysis_tasks_select_owner on public.analysis_tasks
  for select to authenticated using (public.is_analysis_owner(session_id));

drop policy if exists analysis_tool_runs_select_owner on public.analysis_tool_runs;
create policy analysis_tool_runs_select_owner on public.analysis_tool_runs
  for select to authenticated using (public.is_analysis_owner(session_id));

drop policy if exists analysis_artifacts_select_owner on public.analysis_artifacts;
create policy analysis_artifacts_select_owner on public.analysis_artifacts
  for select to authenticated using (public.is_analysis_owner(session_id));

drop policy if exists analysis_findings_select_owner on public.analysis_findings;
create policy analysis_findings_select_owner on public.analysis_findings
  for select to authenticated using (public.is_analysis_owner(session_id));

drop policy if exists analysis_evidence_select_owner on public.analysis_evidence;
create policy analysis_evidence_select_owner on public.analysis_evidence
  for select to authenticated using (public.is_analysis_owner(session_id));

drop policy if exists analysis_reports_select_owner on public.analysis_reports;
create policy analysis_reports_select_owner on public.analysis_reports
  for select to authenticated using (public.is_analysis_owner(session_id));

-- -----------------------------------------------------------------------------
-- Privileges ระดับคอลัมน์ / ตาราง (ชั้นป้องกันที่สองต่อจาก RLS)
-- -----------------------------------------------------------------------------
revoke all on public.analysis_sessions  from authenticated, anon;
revoke all on public.analysis_tasks     from authenticated, anon;
revoke all on public.analysis_tool_runs from authenticated, anon;
revoke all on public.analysis_artifacts from authenticated, anon;
revoke all on public.analysis_findings  from authenticated, anon;
revoke all on public.analysis_evidence  from authenticated, anon;
revoke all on public.analysis_reports   from authenticated, anon;

-- ผู้ใช้: สร้างงานได้เฉพาะคอลัมน์พื้นฐาน (status/config ใช้ค่า default ของระบบ)
grant select on public.analysis_sessions to authenticated;
grant insert (owner_id, title, goal, target_kind) on public.analysis_sessions to authenticated;
grant update (title, goal, status)               on public.analysis_sessions to authenticated;
grant delete on public.analysis_sessions to authenticated;

grant select on public.analysis_tasks     to authenticated;
grant select on public.analysis_tool_runs to authenticated;
grant select on public.analysis_artifacts to authenticated;
grant select on public.analysis_findings  to authenticated;
grant select on public.analysis_evidence  to authenticated;
grant select on public.analysis_reports   to authenticated;

-- service role (Worker/Orchestrator) เข้าถึงได้เต็มที่
grant all on public.analysis_sessions  to service_role;
grant all on public.analysis_tasks     to service_role;
grant all on public.analysis_tool_runs to service_role;
grant all on public.analysis_artifacts to service_role;
grant all on public.analysis_findings  to service_role;
grant all on public.analysis_evidence  to service_role;
grant all on public.analysis_reports   to service_role;

revoke all on function public.is_analysis_owner(uuid) from public, anon;
grant execute on function public.is_analysis_owner(uuid) to authenticated, service_role;
