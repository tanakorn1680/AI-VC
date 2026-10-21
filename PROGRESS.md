# PROGRESS.md — บันทึกสถานการณ์สำหรับคน/AI ที่รับงานต่อ

อ่านไฟล์นี้ก่อนแก้อะไร ใช้เวลาไม่เกิน 3 นาที แล้วทำงานต่อได้ทันที
อัปเดตไฟล์นี้ทุกครั้งที่แก้โค้ด (ส่วน "สถานะ" และ "งานค้าง" เป็นหลัก)

## 1. โปรเจกต์คืออะไร
Multi-Agent AI Workspace — Next.js (App Router) + Supabase + Vercel, BYOK (ผู้ใช้ใส่ API key เอง)
ผู้ใช้คุยกับ "หัวหน้าทีม" AI → เสนอแผน → ผู้ใช้กดยืนยัน → งานกระจายไปให้ AI สมาชิกผ่าน queue (dependency + parallel)
มีโหมด Reverse Engineering แยก (`/reverse-engineering`) ไม่เกี่ยวกับงานทีม ยกเว้นยืม agent เป็นนักวิเคราะห์
รายละเอียดติดตั้ง/รัน: `README.md`

## 2. เป้าหมายของงานรอบนี้ (จากผู้ใช้ "Gg")
1. AI Agent ที่เคยเพิ่มต้อง **ใช้ได้กับทุกโปรเจกต์** (เดิมผูกกับโปรเจกต์เดียว — ออกแบบผิดมาตั้งแต่แรก)
2. **จำกัดทีมละ 1 โปรเจกต์ต่อครั้ง**
3. แบ่งงานให้มีประสิทธิภาพที่สุด (อ้างอิงภาพ "LTD OS": ผู้ประสานงานแค่ส่งงาน ไม่ลงมือเอง → ผู้เชี่ยวชาญทำ → ผู้ตรวจ/ผู้ตรวจข้อเท็จจริง → ความจำป้อนกลับ)
4. **context ต้องไม่บวม** (แชทยาว = AI แย่ลง) และ AI ต้อง **รีเฟรชตัวเองได้**
5. ดูโปรเฟสชันนัลขึ้น

## 3. กติกาการทำงานของผู้ใช้ (ต้องทำตาม)
- ส่งงานเป็น **zip เฉพาะไฟล์ที่แก้/เพิ่ม** แตกทับ root ของ repo ได้เลย (path ตรงโครงสร้าง **ไม่มีโฟลเดอร์ครอบ**) + ไฟล์นี้ (PROGRESS.md) ทุกครั้ง
  (ถ้ามี SQL ใหม่ ให้อยู่ใน `supabase/migrations/NNNN_*.sql`)
- ไม่ต้องทดสอบ/ทำอะไรเกินจำเป็น; ภาษาที่คุยกับผู้ใช้: ไทย
- ไฟล์ที่ต้องลบไม่ได้ผ่าน zip ทับ → ปล่อยเป็น stub (เช่น `api/projects/[id]/runs`, `api/projects/[id]/agents/*`)

## 4. สถาปัตยกรรมหลังแก้รอบนี้

### 4.1 ทีมกลาง + ล็อก 1 โปรเจกต์/ทีม (migration `0010_shared_teams.sql`)
- ตาราง `teams` (owner_id, name, `active_project_id`) — `agents.team_id` แทน `agents.project_id` (คอลัมน์เก่ายังอยู่แต่เป็น NULL)
- unique index: โปรเจกต์ถูกทีมเดียวถือได้; ทีมถือได้ 1 โปรเจกต์ (คอลัมน์เดียว)
- `acquire_team(team, project)` / `release_team(team)` — plpgsql atomic, **service role เท่านั้น**, คืน jsonb `{ok, reason...}`
  "ยุ่ง" = โปรเจกต์มี task `pending/running`; ทีมยุ่งอยู่ที่อื่น → `team_busy`, โปรเจกต์ถูกทีมอื่นยุ่ง → `project_busy`
- `projects.team_id` = ทีมที่ผู้ใช้เลือกให้โปรเจกต์ (ว่าง = ทีมแรกของผู้ใช้); ผู้ใช้ทุกคนมี "ทีมหลัก" (trigger สมัคร + backfill)
- agent ชื่อซ้ำข้ามโปรเจกต์ตอน migrate → ต่อท้าย `(2)`; หัวหน้า (`role='manager'`) เหลือ 1 ต่อทีม (unique index)
- จุดบังคับล็อกในแอป: `api/projects/[id]/chat` (acquire ก่อนคุย), `plans/[messageId]` (ก่อนเริ่มแผน), `api/tasks/[id]/retry`,
  `api/projects/[id]/team` POST (ปุ่มย้ายทีม), และ `worker.ts` ตรวจซ้ำก่อนทำ task (`TeamNotAssignedError` = ล้มทันทีไม่ retry)
- บทบาท agent ใช้ enum `agent_role` เดิม: `manager`=ผู้ประสานงาน, `reviewer`=ผู้ตรวจ, `custom`=ผู้ทำงาน (UI เลือกได้)

### 4.2 งบ context + ความจำ
- `src/lib/orchestrator/context-budget.ts` — **ค่าเพดานทั้งหมดอยู่ที่นี่ที่เดียว** (`BUDGET`) + `estimateTokens` (ประมาณ ไม่ใช้ tokenizer)
- `memory.ts` — `project_memory(brief, summarized_through, refresh_count…)`; `refreshProjectMemory` สรุปข้อความเก่าลง brief เมื่อ
  ประวัติแชทดิบที่ยังไม่ถูกสรุป > `refreshTriggerTokens` (หรือ force) ใช้โมเดลของหัวหน้าทีม; กันชนกันด้วย `refresh_count`
  หมายเหตุ: ข้อความในแชทไม่ถูกลบ แค่เลื่อน `summarized_through`
- `memory-run.ts` — ตัวห่อ "รีเฟรชด้วยหัวหน้าทีม"; เรียกใน `after()` ของ route (ไม่ทำให้ผู้ใช้รอ): หลังตอบแชท และตอนย้ายทีมออกจากโปรเจกต์เดิม (force)
- `lead.ts` — หัวหน้าทีมได้ brief + ประวัติดิบที่พอดีงบ + สถานะงาน/ไฟล์; `context-builder.ts` — worker ได้ instructions(ตัด) + brief(ตัด) + ใบสั่งงาน
  + สรุป dependency (ตัด) + ไฟล์ตามงบที่เหลือ; ผู้ตรวจเห็นผลงานจริงของ dependency
- แท็บ "ความจำ" (`memory-panel.tsx`, API `api/projects/[id]/memory`): ดู/แก้/สรุปตอนนี้/เริ่มบทสนทนาใหม่

### 4.3 การแบ่งงาน (prompt ใน `lead-plan.ts`)
- หัวหน้า = ผู้ประสานงาน: ชิ้นงานจริงมอบสมาชิกตามหน้าที่; ใบสั่งงานครบในตัว; 1 งาน 1 เป้าหมาย; ส่งต่อด้วยไฟล์ (`files`) ไม่ก๊อปเนื้อหา
- ทีมมีผู้ตรวจ → ชิ้นงานสำคัญเพิ่มงานตรวจ; ทีมมีคนเดียว → มอบงานให้ตัวเอง (ได้ context สะอาดต่อ task)
- worker ปิดท้ายด้วย `<summary>…</summary>` (≤400 ตัวอักษร) — `splitSummary()`; ไม่มี → fallback ตัด 800 ตัวอักษร

## 5. แผนที่ไฟล์ที่เกี่ยวข้อง
```
supabase/migrations/0010_shared_teams.sql      teams, agents.team_id, acquire/release_team, project_memory
src/lib/team/team.ts                           listTeams/resolveProjectTeam/acquireTeam/releaseTeam/listTeamAgents
src/lib/orchestrator/context-budget.ts         BUDGET + estimateTokens   (ปรับเพดานที่นี่)
src/lib/orchestrator/memory.ts, memory-run.ts  ความจำ + รีเฟรช
src/lib/orchestrator/usage.ts                  recordChatUsage (แชท/สรุปความจำ นับเข้างบโปรเจกต์)
src/lib/orchestrator/lead.ts, lead-plan.ts     หัวหน้าทีม/prompt/plan; startPlan(admin, projectId, messageId, teamId)
src/lib/orchestrator/context-builder.ts        context ของ task ตามงบ
src/lib/orchestrator/worker.ts                 ตรวจทีมถือโปรเจกต์, <summary>, reviewer
src/app/api/teams/**                           CRUD ทีม, agents ของทีม, models, release
src/app/api/projects/[id]/team|memory          ทีมของโปรเจกต์(+ล็อก) / ความจำ
src/app/(app)/team/**                          หน้าจัดการทีมทั้งหมด (/team)
src/app/(app)/projects/[id]/                   workspace-client (แท็บ ความจำ, แบนเนอร์ทีม), agents-panel (apiBase), team-banner, memory-panel
```
แก้เล็กน้อย: `lib/analysis/security.ts` + `reverse-engineering/[id]/panels.tsx` (agent ตรวจสิทธิ์ผ่านทีม), `api/projects/[id]/usage` (agent ทั้งหมดของผู้ใช้),
`lib/utils/api.ts` (+`CONFLICT` 409), `lib/supabase/middleware.ts` (+`/team`)

## 6. สถานะ (อัปเดตล่าสุด 2026-10-21)
- [x] ออกแบบ + เขียนโค้ดครบตามเป้าหมายข้อ 2 (1–4) (SQL, lib, API, UI, README)
- [x] ตรวจ syntax ทุกไฟล์ .ts/.tsx ผ่าน (TypeScript transpile) — **ยังไม่ได้ `npm install`/`next build`/รัน SQL/ยิง AI จริง** (ผู้ใช้สั่งไม่ต้องทดสอบ)
- `next.config.ts` ตั้ง `ignoreBuildErrors: true` อยู่ (โค้ดเดิมมี type ไม่ตรง supabase-js ~30 จุด) — โค้ดใหม่เขียนแบบ cast เหมือน `lead.ts` เพื่อไม่เพิ่ม error

## 7. ขั้นตอนใช้งานหลังแตก zip ทับ
1. Supabase SQL Editor: รัน `supabase/migrations/0010_shared_teams.sql` (**ก่อน deploy** เพราะโค้ดอ่าน `teams`/`agents.team_id`/`project_memory`; รันซ้ำได้)
2. Deploy ตามปกติ (ไม่มี env ใหม่)
3. เข้า `/team` ตรวจว่า agent เดิมอยู่ใน "ทีมหลัก" (ชื่อซ้ำจะมี (2)(3)) ลบตัวซ้ำที่ไม่ต้องการ
4. เปิดโปรเจกต์ → ส่งข้อความ = ทีมเข้าประจำโปรเจกต์นั้น

## 8. งานค้าง / ไอเดียต่อ (ยังไม่ทำ)
- รัน `npm run typecheck` จริงแล้วแก้ type ทั้งโปรเจกต์ → เอา `ignoreBuildErrors` ออก
- เพิ่ม test ใน `supabase/tests/` สำหรับ `acquire_team` (ล็อก, busy, สลับทีม, project_busy) และ RLS ของ `teams`/`project_memory`
- ให้เลือก "โมเดลสรุปความจำ" แยกจากหัวหน้า (ตอนนี้ใช้โมเดลของหัวหน้า) — ถ้าอยากประหยัด ใช้รุ่นเล็ก
- ผู้ตรวจ → ถ้า summary ขึ้นต้น "ต้องแก้" ให้ระบบวนแก้อัตโนมัติ (ตอนนี้แค่รายงานในแชท ผู้ใช้/หัวหน้าตัดสินต่อ)
- ตัว `estimateTokens` เป็นการประมาณ (ไทย ≈1.6 ตัวอักษร/token) ปรับตามผลใช้งานจริงได้ใน `context-budget.ts`
- `agents.project_id` (nullable, ไม่ใช้แล้ว) ลบได้ในอนาคตเมื่อมั่นใจ; `lib/orchestrator/planner.ts` เป็นโค้ดเก่าที่ไม่ถูกเรียกแล้ว

## 9. ข้อควรระวัง
- ห้ามให้ browser เรียก `acquire_team/release_team/set_agent_key/...` ตรง ๆ (revoke จาก authenticated แล้ว) — ผ่าน API route + admin client หลังตรวจสิทธิ์ด้วย RLS เสมอ
- ผู้ใช้แก้ `teams.active_project_id` เองไม่ได้ (column privilege) — อย่า grant เพิ่ม
- ย้ายทีมออกกลางงานไม่ได้โดยออกแบบ (ต้องรอ/ยกเลิก task) — อย่าเอาเงื่อนไข busy ออกโดยไม่คิดเรื่อง task ที่ค้างอยู่
