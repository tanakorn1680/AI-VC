# PROGRESS.md — บันทึกสถานการณ์สำหรับคน/AI ที่รับงานต่อ

อ่านไฟล์นี้ก่อนแก้อะไร ใช้เวลาไม่เกิน 3 นาที แล้วทำงานต่อได้ทันที
อัปเดตไฟล์นี้ทุกครั้งที่แก้โค้ด (ส่วน "สถานะ" และ "งานค้าง" เป็นหลัก)

## 1. โปรเจกต์คืออะไร
Multi-Agent AI Workspace — Next.js (App Router) + Supabase + Vercel, BYOK (ผู้ใช้ใส่ API key เอง)
ผู้ใช้คุยกับ "หัวหน้าทีม" AI → เสนอแผน → ผู้ใช้กดยืนยัน → งานกระจายไปให้ AI สมาชิกผ่าน queue (dependency + parallel)
มีโหมด Reverse Engineering แยก (`/reverse-engineering`) — ใช้ "ทีม AI" กลางชุดเดียวกัน ทั้งทีมทำงานพร้อมกัน (ดู 4.4)
รายละเอียดติดตั้ง/รัน: `README.md`

## 2. เป้าหมายของงานรอบนี้ (จากผู้ใช้ "Gg")
1. AI Agent ที่เคยเพิ่มต้อง **ใช้ได้กับทุกโปรเจกต์** (เดิมผูกกับโปรเจกต์เดียว — ออกแบบผิดมาตั้งแต่แรก)
2. **จำกัดทีมละ 1 โปรเจกต์ต่อครั้ง**
3. แบ่งงานให้มีประสิทธิภาพที่สุด (อ้างอิงภาพ "LTD OS": ผู้ประสานงานแค่ส่งงาน ไม่ลงมือเอง → ผู้เชี่ยวชาญทำ → ผู้ตรวจ/ผู้ตรวจข้อเท็จจริง → ความจำป้อนกลับ)
4. **context ต้องไม่บวม** (แชทยาว = AI แย่ลง) และ AI ต้อง **รีเฟรชตัวเองได้**
5. ดูโปรเฟสชันนัลขึ้น
6. (รอบ 2) **Reverse Engineering ต้องใช้ AI หลายตัวพร้อมกันเป็นทีม** ไม่ใช่เลือกทีละตัว + ไม่พังเมื่อโมเดลรับ context ได้น้อย (ตัวอย่างจริง: Groq gpt-oss-120b จำกัด 8,000 โทเคน/คำขอ แล้วฟ้อง "ต้องใช้ 9,243")

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

### 4.4 RE แบบทีม (รอบ 2 — **ไม่มี migration ใหม่**)
- **สาเหตุบั๊ก Groq 8k**: adapter openai-compatible บวก `outputHeadroom` 8192 เข้า `max_tokens` (ให้รุ่นคิดก่อนตอบ) แต่ Groq นับ max_tokens รวมในเพดานคำขอ → เกิน 8,000 เสมอ ลดแล้วก็ไม่พอ. แก้: `CompletionRequest.outputCap` (เพดาน max_tokens จริง) + `completeJson` คำนวณ headroom ตอนลด
- **Pool** (`lib/analysis/team-pool.ts`): ใช้ agent ทุกตัวในทีมที่มี key; ทีมเลือกที่ `analysis_sessions.config.team_id` (ไม่ตั้ง = ทีมแรกที่มี agent; งานเก่าที่มี `analyst_agent_id` = ทีมของ agent นั้น). แต่ละตัวมี `inputLimit` (prompt+max_tokens) — เดาจาก provider/โมเดล (`guessRequestLimit`) แล้ว **เรียนรู้จาก error จริง** เก็บที่ `config.agent_limits[agentId]`
- **แบ่งงาน**: `planWave` แบ่งผลเครื่องมือเป็นชุดย่อยตามความจุของแต่ละตัว (สูงสุด 4 ตัวขนาน, first-fit-decreasing) ; ตัวใหญ่ได้ชุดใหญ่ ตัวเล็กได้ชุดเล็ก; เพดานต่อคำขอ 60k โทเคน (context ไม่บวม)
- **ส่งต่ออัตโนมัติ** (`callModel` ใน `orchestrator.ts`): ชนเพดาน → จำเพดานแล้วส่งตัวที่ใหญ่กว่า; rate limit / ตอบผิดรูปแบบ / provider error → ตัวอื่นในทีม; ถ้าทั้งทีมพลาดเพราะ provider ไม่ว่างชั่วคราว (HTTP 500/502/503/504/529 เช่น Gemini 503 "high demand") คืน `waiting` ให้หน้าเว็บรอแล้วลองใหม่เอง (ไม่ใช่ error ถาวร); key ผิด/เครดิตหมด → ข้ามตัวนั้น (ทั้งทีมพังค่อยหยุด). ยอด token/ค่าใช้จ่ายนับตาม agent ที่เรียกจริง
- **บทบาท**: manager = วางแผนอย่างเดียว (`prefer:'lead'`), ผู้เชี่ยวชาญ = อ่านผลคนละชุดขนานกัน, reviewer = ตรวจทานข้อค้นพบรวม (`team-review.ts`: ลด/ตัดได้อย่างเดียว ตัดไม่เกินครึ่ง ข้อที่ตัดถูกบันทึกเป็น limitation) ; หลักฐาน/ความเชื่อมั่นยังตัดสินโดยระบบ (`evidence.ts`) เหมือนเดิม
- **สถานะต่อเนื่อง**: `config.analysis = {done, needs_more, reviewed, wave}` — สรุปทีละ wave ต่อ step (หยุดแล้วทำต่อได้) ; ชุดที่พลาดถูกลองใหม่ wave ถัดไป ; จบแล้วลบชื่อซ้ำ → รีวิว → (ถ้าต้อง) รอบเสริม → completed
- UI: `analyst-settings.tsx` ไม่มี dropdown เลือก agent แล้ว — แสดงสมาชิกทีม+เพดานของแต่ละตัว (เลือกทีมได้ถ้ามีหลายทีม)
- ไม่ต้องล็อกทีม (RE ไม่ใช่โปรเจกต์) — ทีมที่ประจำโปรเจกต์อยู่ใช้ทำ RE พร้อมกันได้ (ระวัง rate limit ร่วมกัน)

### 4.5 ZIP ที่มี .so หลายไฟล์ + ผลเครื่องมือยาว (รอบ 3 — ไม่มี migration)
- **ปัญหาที่ผู้ใช้เจอ**: อัปโหลด `arm64-v8a.zip` (25 ไฟล์ .so) ได้แค่รายชื่อไฟล์ — `elf-inspect` รับเฉพาะ ELF ตรง ๆ ไม่มีเครื่องมือที่คลาย ZIP แล้วตรวจ .so ข้างใน
- **เครื่องมือใหม่ `zip-elf-inspect`** (`tools/zip-elf-inspect.ts`, ลงทะเบียนใน `tool-registry.ts`): คลายทีละไฟล์ในหน่วยความจำ (fflate; เพดาน 40 ไฟล์/64MB ต่อไฟล์/256MB รวม/20 วินาที) ตรวจ ELF จากไบต์จริง (ไม่ดูนามสกุลอย่างเดียว) ได้ตารางต่อไลบรารี (soname, needed, JNI, hardening, ตระกูล symbol, section ผิดปกติ, URL, compiler) + `internal_dependencies` (ใครต้องใช้ใครในแพ็ก) + `external_needed_libraries`
- `elf-inspect` v1.1.0 เพิ่ม `export_families`/`import_families` (สรุปทั้งตาราง symbol ด้วย `tools/symbol-families.ts` — เดาจากชื่อ ไม่ใช่การยืนยัน) และ `unusual_sections` (section ชื่อไม่ขึ้นต้นด้วยจุด เช่น `alyn` ใน libGTASA)
- **สรุปผลยาว**: ผลเครื่องมือถูกย่อ JSON (ไม่มีช่องว่าง) แล้วหั่นเป็นส่วน (`part_chars` ≤12,000 ตัวอักษร และเล็กพอให้ทุก agent ที่ใช้ได้รับได้; รวมต่อ run ≤96,000) ให้ agent หลายตัวอ่านคนละส่วนพร้อมกัน (เดิมตัดเหลือ 12,000 ตัวอักษรแรก ทำให้ไม่เห็น export/section ท้ายไฟล์). `config.analysis.done` เก็บ `runId:เลขส่วน`
- `planWave` เลือกตัวที่ "เต็มน้อยที่สุดตามสัดส่วนความจุ" — ตัวใหญ่รับงานเป็นหลัก ตัวเล็ก (เช่น Groq 8k) รับเมื่อมีงานพอ/เป็นตัวสำรอง
- ไฟล์: `tools/zip-elf-inspect.ts`, `tools/symbol-families.ts`, `tools/elf-inspect.ts`, `tool-registry.ts`, `findings.ts` (PromptItem), `team-pool.ts` (planWave/partCharsFor), `orchestrator.ts` (analyzeStep/analyzeWave)
- ทดสอบแล้ว: `zip-elf-inspect` กับ ZIP ที่มี .so จริง 12 ไฟล์ (self-test + ผลจริง); ยังไม่ได้ยิง AI จริง/ไม่ได้ทดสอบกับ `arm64-v8a.zip` ของผู้ใช้ (ไฟล์ .so ไม่ได้อยู่ในมือ)

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
RE ทีม (รอบ 2): `lib/analysis/team-pool.ts` (pool/เพดาน/แบ่งชุด), `team-review.ts` (ผู้ตรวจทาน), `orchestrator.ts` (callModel แบบทีม, analyzeWave, finalizeAnalysis), `llm.ts` (PromptTooLargeError, headroom-aware), `findings.ts` (prompt ชุดย่อย), `report-service.ts`, `api/analysis/[id]/route.ts` (PATCH `analyst_team_id` → config.team_id), `lib/ai/openai-compatible.ts`+`types.ts` (`outputCap`), UI `reverse-engineering/[id]/analyst-settings.tsx`+`panels.tsx`
แก้เล็กน้อย: `lib/analysis/security.ts` + `reverse-engineering/[id]/panels.tsx` (agent ตรวจสิทธิ์ผ่านทีม), `api/projects/[id]/usage` (agent ทั้งหมดของผู้ใช้),
`lib/utils/api.ts` (+`CONFLICT` 409), `lib/supabase/middleware.ts` (+`/team`)

## 6. สถานะ (อัปเดตล่าสุด 2026-10-21)
- [x] ออกแบบ + เขียนโค้ดครบตามเป้าหมายข้อ 2 (1–4) (SQL, lib, API, UI, README)
- [x] ตรวจ syntax ทุกไฟล์ .ts/.tsx ผ่าน (TypeScript transpile) — **ยังไม่ได้ `npm install`/`next build`/รัน SQL/ยิง AI จริง** (ผู้ใช้สั่งไม่ต้องทดสอบ)
- [x] รอบ 2: RE แบบทีม (ดู 4.4) เขียนครบ ตรวจ syntax ผ่าน — ยังไม่ได้ยิง AI จริง
- `next.config.ts` ตั้ง `ignoreBuildErrors: true` อยู่ (โค้ดเดิมมี type ไม่ตรง supabase-js ~30 จุด) — โค้ดใหม่เขียนแบบ cast เหมือน `lead.ts` เพื่อไม่เพิ่ม error

## 7. ขั้นตอนใช้งานหลังแตก zip ทับ
0. (รอบ 2 ไม่มี SQL ใหม่)
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

- RE: เพดานเริ่มต้นของ Groq ตั้งไว้ 6–8k (แพ็กเกจจ่ายเงินสูงกว่านั้น แต่ระบบไม่ปรับขึ้นเอง) — ถ้าต้องการ ให้เพิ่มช่องตั้ง "เพดานคำขอ" ต่อ agent
- RE: ZIP ที่ใหญ่เกิน 25MB (`MAX_ARTIFACT_BYTES`) อัปโหลดไม่ได้ และ .so เดี่ยวใน ZIP ที่เกิน 64MB ถูกข้าม (เช่น `libsimcity.so` 37MB ผ่าน)
- RE: ผู้ตรวจทานตรวจได้ ≤40 ข้อค้นพบต่อรอบ และถ้าทั้งทีมเล็กเกินจะข้ามรีวิว; spec/report (`report-service.ts`) ยังเรียกตัวเดียว (เลือกตัวใหญ่สุด) ไม่แบ่งชุด
- `analyst_agent_id` ยังอยู่ใน DB/API เพื่อความเข้ากันได้ย้อนหลัง แต่ UI ไม่ใช้แล้ว

## 9. ข้อควรระวัง
- ห้ามให้ browser เรียก `acquire_team/release_team/set_agent_key/...` ตรง ๆ (revoke จาก authenticated แล้ว) — ผ่าน API route + admin client หลังตรวจสิทธิ์ด้วย RLS เสมอ
- ผู้ใช้แก้ `teams.active_project_id` เองไม่ได้ (column privilege) — อย่า grant เพิ่ม
- ย้ายทีมออกกลางงานไม่ได้โดยออกแบบ (ต้องรอ/ยกเลิก task) — อย่าเอาเงื่อนไข busy ออกโดยไม่คิดเรื่อง task ที่ค้างอยู่
