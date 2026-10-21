-- =============================================================================
-- 0010: ทีม AI กลาง (ใช้ร่วมกันทุกโปรเจกต์) + ล็อก 1 โปรเจกต์ต่อทีม + ความจำโปรเจกต์
--
--   1) teams            ทีมของผู้ใช้ (agent ย้ายจาก "ผูกกับโปรเจกต์" มา "ผูกกับทีม")
--                       teams.active_project_id = โปรเจกต์ที่ทีมกำลังประจำอยู่ (ทีมละ 1 โปรเจกต์
--                       และโปรเจกต์ถูกทีมเดียวถือได้ — unique index บังคับที่ระดับ DB)
--   2) agents.team_id   agent เดิมทุกตัวถูกย้ายเข้า "ทีมหลัก" ของเจ้าของโปรเจกต์ให้อัตโนมัติ
--                       (ชื่อซ้ำกันข้ามโปรเจกต์ → ต่อท้าย (2), (3)…; หัวหน้าทีมเหลือคนเดียวต่อทีม)
--   3) acquire_team / release_team  ฟังก์ชัน atomic สำหรับเข้าประจำ/พักทีม (เฉพาะ service role)
--   4) project_memory   ความจำสรุปของโปรเจกต์ (brief) ที่ระบบรีเฟรชเองเมื่อแชทยาวเกินงบ token
--
-- รันครั้งเดียวใน Supabase -> SQL Editor หลัง 0004 (รันซ้ำได้ ไม่พัง)
-- ควรรันก่อน deploy โค้ดชุดนี้ เพราะโค้ดอ่าน teams / agents.team_id / project_memory
-- =============================================================================

-- -----------------------------------------------------------------------------
-- (1) teams
-- -----------------------------------------------------------------------------
create table if not exists public.teams (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references public.profiles (id) on delete cascade,
  name              text not null check (char_length(name) between 1 and 100),
  -- ผู้ใช้แก้เองไม่ได้ (column privilege ด้านล่าง) — เปลี่ยนผ่าน acquire_team/release_team เท่านั้น
  active_project_id uuid references public.projects (id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (owner_id, name)
);
create index if not exists teams_owner_idx on public.teams (owner_id);
-- 1 โปรเจกต์ถูกถือโดยทีมเดียวเท่านั้น (ทีมหนึ่งถือได้ 1 โปรเจกต์อยู่แล้วเพราะเป็นคอลัมน์เดียว)
create unique index if not exists teams_active_project_uniq
  on public.teams (active_project_id) where active_project_id is not null;

alter table public.teams enable row level security;

create or replace function public.is_team_owner(p_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.teams t
    where t.id = p_team_id and t.owner_id = (select auth.uid())
  );
$$;
revoke all on function public.is_team_owner(uuid) from public;
revoke all on function public.is_team_owner(uuid) from anon;
grant execute on function public.is_team_owner(uuid) to authenticated;

drop policy if exists teams_select_own on public.teams;
drop policy if exists teams_insert_own on public.teams;
drop policy if exists teams_update_own on public.teams;
drop policy if exists teams_delete_own on public.teams;
create policy teams_select_own on public.teams
  for select to authenticated using (owner_id = (select auth.uid()));
create policy teams_insert_own on public.teams
  for insert to authenticated with check (owner_id = (select auth.uid()));
create policy teams_update_own on public.teams
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy teams_delete_own on public.teams
  for delete to authenticated using (owner_id = (select auth.uid()));

-- ผู้ใช้เปลี่ยนได้แค่ชื่อทีม; active_project_id เป็นของระบบ (กันข้ามกติกา 1 โปรเจกต์ต่อทีม)
revoke update on public.teams from authenticated;
grant  update (name) on public.teams to authenticated;
revoke insert on public.teams from authenticated;
grant  insert (owner_id, name) on public.teams to authenticated;
revoke all on public.teams from anon;

-- ผู้ใช้ใหม่ได้ "ทีมหลัก" ทันทีตอนสมัคร (แทนที่ handle_new_user เดิม; trigger เดิมยังชี้ฟังก์ชันนี้อยู่)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)));
  insert into public.teams (owner_id, name) values (new.id, 'ทีมหลัก')
  on conflict (owner_id, name) do nothing;
  return new;
end;
$$;

-- ผู้ใช้เดิมทุกคนได้ทีมหลัก
insert into public.teams (owner_id, name)
select p.id, 'ทีมหลัก' from public.profiles p
on conflict (owner_id, name) do nothing;

-- -----------------------------------------------------------------------------
-- (2) agents → ผูกกับทีม
-- -----------------------------------------------------------------------------
alter table public.agents add column if not exists team_id uuid references public.teams (id) on delete cascade;
alter table public.agents alter column project_id drop not null;

-- ย้าย agent เดิมเข้าทีมหลักของเจ้าของโปรเจกต์
update public.agents a
   set team_id = t.id
  from public.projects p, public.teams t
 where a.team_id is null
   and p.id = a.project_id
   and t.owner_id = p.owner_id
   and t.name = 'ทีมหลัก';

-- ชื่อซ้ำในทีมเดียวกัน (เกิดจากหลายโปรเจกต์ตั้งชื่อเหมือนกัน) → ต่อท้ายลำดับ ไม่ลบอะไรทิ้ง
with ranked as (
  select id, row_number() over (partition by team_id, lower(name) order by created_at, id) as rn
  from public.agents
  where team_id is not null
)
update public.agents a
   set name = left(a.name, 90) || ' (' || r.rn || ')'
  from ranked r
 where a.id = r.id and r.rn > 1;

-- หัวหน้าทีมมีได้คนเดียวต่อทีม: เก็บตัวที่เก่าสุด ที่เหลือเป็นสมาชิก
with m as (
  select id, row_number() over (partition by team_id order by created_at, id) as rn
  from public.agents
  where role = 'manager' and team_id is not null
)
update public.agents set role = 'custom' where id in (select id from m where rn > 1);

-- ทีมที่มี agent แต่ไม่มีหัวหน้า → ตั้งตัวที่เก่าสุดเป็นหัวหน้า
update public.agents set role = 'manager'
 where id in (
   select distinct on (a.team_id) a.id
   from public.agents a
   where a.team_id is not null
     and not exists (select 1 from public.agents b where b.team_id = a.team_id and b.role = 'manager')
   order by a.team_id, a.created_at, a.id
 );

-- agent ไม่ผูกโปรเจกต์อีกต่อไป (และลบโปรเจกต์แล้วต้องไม่ลบ agent ของทีมทิ้งตาม)
update public.agents set project_id = null where project_id is not null;

alter table public.agents alter column team_id set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'agents_team_name_key') then
    alter table public.agents add constraint agents_team_name_key unique (team_id, name);
  end if;
end $$;
create index if not exists agents_team_idx on public.agents (team_id);
create unique index if not exists agents_one_lead_per_team on public.agents (team_id) where role = 'manager';

-- สิทธิ์จัดการ agent = เจ้าของทีม
drop policy if exists agents_all_owner on public.agents;
create policy agents_all_owner on public.agents
  for all to authenticated
  using (public.is_team_owner(team_id))
  with check (public.is_team_owner(team_id));

-- task ที่ผูก agent ต้องเป็น agent ของเจ้าของโปรเจกต์เดียวกัน (เดิมเช็คว่าอยู่ project เดียวกัน)
create or replace function public.enforce_task_agent_same_project()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.assigned_agent is not null then
    if not exists (
      select 1
      from public.agents a
      join public.teams t on t.id = a.team_id
      join public.projects p on p.id = new.project_id
      where a.id = new.assigned_agent and t.owner_id = p.owner_id
    ) then
      raise exception 'assigned_agent must belong to a team of the project owner';
    end if;
  end if;
  if new.parent_id is not null then
    if not exists (
      select 1 from public.tasks t
      where t.id = new.parent_id and t.project_id = new.project_id
    ) then
      raise exception 'parent_id must belong to the same project';
    end if;
  end if;
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- projects.team_id = ทีมที่ผู้ใช้เลือกให้โปรเจกต์นี้ (ว่างได้ = ใช้ทีมแรกของผู้ใช้)
-- -----------------------------------------------------------------------------
alter table public.projects add column if not exists team_id uuid references public.teams (id) on delete set null;

update public.projects p
   set team_id = (select t.id from public.teams t where t.owner_id = p.owner_id order by t.created_at limit 1)
 where p.team_id is null;

grant update (team_id) on public.projects to authenticated;

create or replace function public.enforce_project_team_owner()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.team_id is not null and not exists (
    select 1 from public.teams t where t.id = new.team_id and t.owner_id = new.owner_id
  ) then
    raise exception 'team_id must belong to the project owner';
  end if;
  return new;
end;
$$;
drop trigger if exists projects_team_owner_guard on public.projects;
create trigger projects_team_owner_guard
  before insert or update of team_id on public.projects
  for each row execute function public.enforce_project_team_owner();

-- หมายเหตุ: ไม่มีทีมไหนถือโปรเจกต์ตอนรัน migration — ล็อกเริ่มเมื่อมีการคุย/เริ่มแผนครั้งแรกในโปรเจกต์นั้น

-- -----------------------------------------------------------------------------
-- (3) ล็อก 1 โปรเจกต์ต่อทีม — atomic, เรียกได้เฉพาะ service role
--     "ยุ่ง" = โปรเจกต์นั้นมี task สถานะ pending/running อยู่ (ย้ายทีมออกกลางงานไม่ได้)
-- -----------------------------------------------------------------------------
create or replace function public.project_is_busy(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.tasks t
    where t.project_id = p_project_id and t.status in ('pending', 'running')
  );
$$;

create or replace function public.acquire_team(p_team_id uuid, p_project_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team    public.teams;
  v_project public.projects;
  v_holder  public.teams;
  v_prev    uuid;
  v_name    text;
begin
  select * into v_team from public.teams where id = p_team_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_team');
  end if;

  select * into v_project from public.projects where id = p_project_id;
  if not found or v_project.owner_id <> v_team.owner_id then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  -- ถือโปรเจกต์นี้อยู่แล้ว
  if v_team.active_project_id = p_project_id then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  -- ตรวจเงื่อนไขทั้งหมดก่อน แล้วค่อยเปลี่ยนข้อมูล (ไม่มีผลข้างเคียงเมื่อปฏิเสธ)
  v_prev := v_team.active_project_id;
  if v_prev is not null and public.project_is_busy(v_prev) then
    select name into v_name from public.projects where id = v_prev;
    return jsonb_build_object('ok', false, 'reason', 'team_busy', 'project_id', v_prev, 'project_name', v_name);
  end if;

  select * into v_holder from public.teams where active_project_id = p_project_id and id <> p_team_id for update;
  if found and public.project_is_busy(p_project_id) then
    return jsonb_build_object('ok', false, 'reason', 'project_busy', 'team_id', v_holder.id, 'team_name', v_holder.name);
  end if;

  if found then
    update public.teams set active_project_id = null where id = v_holder.id;
  end if;
  update public.teams set active_project_id = p_project_id where id = p_team_id;
  update public.projects set team_id = p_team_id where id = p_project_id;

  return jsonb_build_object('ok', true, 'changed', true, 'previous_project_id', v_prev);
end;
$$;

create or replace function public.release_team(p_team_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team public.teams;
  v_name text;
begin
  select * into v_team from public.teams where id = p_team_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'no_team');
  end if;
  if v_team.active_project_id is null then
    return jsonb_build_object('ok', true, 'released_project_id', null);
  end if;
  if public.project_is_busy(v_team.active_project_id) then
    select name into v_name from public.projects where id = v_team.active_project_id;
    return jsonb_build_object('ok', false, 'reason', 'team_busy', 'project_id', v_team.active_project_id, 'project_name', v_name);
  end if;
  update public.teams set active_project_id = null where id = p_team_id;
  return jsonb_build_object('ok', true, 'released_project_id', v_team.active_project_id);
end;
$$;

revoke all on function public.project_is_busy(uuid)     from public, anon, authenticated;
revoke all on function public.acquire_team(uuid, uuid)  from public, anon, authenticated;
revoke all on function public.release_team(uuid)        from public, anon, authenticated;
grant execute on function public.project_is_busy(uuid)    to service_role;
grant execute on function public.acquire_team(uuid, uuid) to service_role;
grant execute on function public.release_team(uuid)       to service_role;

-- -----------------------------------------------------------------------------
-- (4) project_memory — ความจำสรุปของโปรเจกต์
--     brief = สรุปสั้น (เป้าหมาย/ข้อตกลง/ความคืบหน้า/งานค้าง/ไฟล์สำคัญ) ที่ส่งให้ AI แทนประวัติแชทเก่า
--     summarized_through = ข้อความที่เก่ากว่าเวลานี้ถูกสรุปรวมใน brief แล้ว (ไม่ต้องส่งซ้ำ)
--     เขียนผ่าน service role เท่านั้น ผู้ใช้อ่านได้เฉพาะของโปรเจกต์ตัวเอง
-- -----------------------------------------------------------------------------
create table if not exists public.project_memory (
  project_id         uuid primary key references public.projects (id) on delete cascade,
  brief              text not null default '' check (char_length(brief) <= 8000),
  summarized_through timestamptz,
  refresh_count      integer not null default 0 check (refresh_count >= 0),
  last_refreshed_at  timestamptz,
  updated_at         timestamptz not null default now()
);

alter table public.project_memory enable row level security;

drop policy if exists project_memory_select_owner on public.project_memory;
create policy project_memory_select_owner on public.project_memory
  for select to authenticated using (public.is_project_owner(project_id));

revoke insert, update, delete on public.project_memory from authenticated;
revoke all on public.project_memory from anon;
