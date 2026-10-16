# Multi-Agent AI Workspace

MVP ตามสเปค: Next.js + Supabase + Vercel, BYOK, Multi-Agent (หัวหน้าทีม + สมาชิกที่มี "หน้าที่" ของตัวเอง),
Task queue พร้อม dependency + parallel execution, Cost control ด้วย budget ต่อ project

**สถานะ:** ยังไม่เคย build/deploy จริงในเครื่องผู้เขียน (sandbox ไม่มีเครือข่ายให้ลง npm package)
โค้ดผ่าน `tsc --strict` 100% ด้วย type stub ของทุก library ที่ใช้ แต่ต้องรันจริงเพื่อยืนยัน
ดูหัวข้อ "สิ่งที่ยังไม่ได้ตรวจ" ท้ายไฟล์นี้ก่อนใช้งานจริง

---

## 1. สร้าง Supabase Project

**แนะนำ: สร้างโปรเจกต์ใหม่เอี่ยม** แทนการใช้โปรเจกต์เดิมที่เคยรันไฟล์เวอร์ชันก่อนหน้าไปแล้ว เพราะ schema เวอร์ชันนี้แก้ช่องโหว่ด้าน `current_user` check ที่พบระหว่างทดสอบ (ดูหัวข้อ "ประวัติการแก้ไขด้านความปลอดภัย" ท้ายไฟล์) และการรันซ้ำบน schema เก่าที่อาจมี object ค้างอยู่มีความเสี่ยงมากกว่าการเริ่มสะอาด

1. ไปที่ [supabase.com/dashboard](https://supabase.com/dashboard) → **New Project** (ไม่ใช่โปรเจกต์เดิม)
2. รอจน project พร้อม (Vault เปิดใช้งานเป็นค่าเริ่มต้นอยู่แล้ว ไม่ต้องตั้งค่าเพิ่ม)
3. ไปที่ **SQL Editor** → New query → วางทั้งไฟล์ `supabase/schema.sql` → **Run**
   - ควรเห็น "Success. No rows returned"
   - **ถ้าเจอ `relation "tasks" already exists` หรือ error คล้ายกัน**: แปลว่ามี schema ค้างจากการรันครั้งก่อนในโปรเจกต์นี้ (มักเกิดจากไฟล์ถูกตัดตอนกลางคันตอนวาง แล้วตารางบางส่วนถูกสร้างไปแล้ว) — รัน `supabase/reset.sql` ก่อน แล้วรัน `schema.sql` ใหม่ทั้งไฟล์ ตรวจให้แน่ใจว่าวางครบถึงบรรทัดสุดท้ายจริง ๆ (จบด้วย `alter default privileges in schema public revoke all on sequences from anon;`) — หรือสร้างโปรเจกต์ใหม่ไปเลยตามที่แนะนำข้างต้น ปลอดภัยกว่าและเร็วกว่า
4. วางทั้งไฟล์ `supabase/tests/rls_test.sql` → **Run**
   - ต้องเห็น `NOTICE: ALL RLS TESTS PASSED` ที่ท้าย log
   - อาจเห็น `NOTICE` หรือ `WARNING` สีเหลืองเกี่ยวกับ `SET ROLE postgres` ระหว่างทาง — **อันนี้ปกติ ไม่ใช่ความล้มเหลว** เทสต์จุดนั้นตรวจสอบเรื่อง role permission จากหลายมุมพร้อมกันเพื่อความชัวร์ ตราบใดที่ไม่มีบรรทัดขึ้นต้นด้วย `FAIL` และจบด้วย `ALL RLS TESTS PASSED` แปลว่าผ่านหมด
   - ถ้าเห็น error ที่ขึ้นต้นด้วย `FAIL [...]` — **อย่าเพิ่ง deploy** ส่งข้อความ error นั้นกลับมา
   - ไฟล์นี้ทำงานใน transaction เดียวและ `rollback` ท้ายไฟล์เอง จึงไม่ทิ้งข้อมูลทดสอบไว้จริง
5. ไปที่ **Project Settings → API** เก็บ 3 ค่านี้ไว้:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` key → `SUPABASE_SERVICE_ROLE_KEY` (เก็บเป็นความลับ ห้ามใส่ในโค้ดหรือ commit)

## 2. เตรียมโค้ดในเครื่อง

```bash
cd multi-agent-workspace
```

ที่ต้องติดตั้ง (ยังไม่ได้ generate package.json ไว้ — ดูหัวข้อ 2.1):

```bash
npm install next@latest react@latest react-dom@latest
npm install @supabase/ssr @supabase/supabase-js
npm install @vercel/queue
npm install -D typescript @types/react @types/react-dom @types/node tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

### 2.1 ทำไมไม่มี package.json มาให้

ผมไม่มีเครือข่ายในสภาพแวดล้อมที่เขียนโค้ดนี้ จึง `npm install` และปล่อยให้ npm generate
`package.json` + `package-lock.json` ที่มีเลขเวอร์ชันจริงให้ไม่ได้ ถ้าผมเขียนเลขเวอร์ชันขึ้นมาเอง
มีความเสี่ยงสูงที่จะผิดหรือเป็นเวอร์ชันที่ไม่มีอยู่จริง จึงให้คุณรัน `npm install` ตามแพ็กเกจข้างบน
แล้วให้ npm resolve เวอร์ชันล่าสุดที่ใช้ได้จริงให้เอง

ตั้งค่า `tailwind.config.ts` ให้ `content` ครอบคลุม `./src/**/*.{ts,tsx}`

### 2.2 ตั้งค่า Environment Variables

```bash
cp .env.example .env.local
```

กรอก 3 ค่าจากข้อ 1 ลงใน `.env.local` และตั้ง `CRON_SECRET` เป็นสตริงสุ่มยาว ๆ (เช่น `openssl rand -hex 32`)

## 3. Deploy ขึ้น Vercel

1. Push โค้ดขึ้น Git repo (GitHub/GitLab/Bitbucket)
2. ไปที่ [vercel.com/new](https://vercel.com/new) → Import repo นี้
3. ใส่ Environment Variables ให้ตรงกับ `.env.local` (4 ตัว) ใน Vercel Project Settings → Environment Variables
4. Deploy

### 3.1 เปิดใช้งาน Vercel Queues (สำคัญ — ไม่ทำข้อนี้ Worker จะไม่ทำงาน)

Vercel Queues เป็น public beta ณ ตอนเขียนนี้ ต้องเปิดใช้งานแยกต่างหาก:

1. ไปที่ Vercel Dashboard → โปรเจกต์นี้ → แท็บ **Storage** (หรือ **Queues** ถ้ามีแยก)
2. เปิดใช้งาน Queues สำหรับโปรเจกต์นี้ตามที่หน้าจอแนะนำ
3. Deploy ใหม่อีกครั้งหลังเปิดใช้งาน (`vercel.json` ในโปรเจกต์นี้ประกาศ trigger ของ topic
   `agent-tasks` ไว้ที่ `src/app/api/worker/run-task/route.ts` แล้ว)

**ถ้า Vercel Queues ใช้ไม่ได้ในบัญชีคุณ (ยังไม่เปิดให้ทุกคน หรือ API เปลี่ยนไปจากตอนที่เขียนโค้ดนี้):**
ไฟล์เดียวที่ต้องแก้คือ `src/lib/orchestrator/queue.ts` — เปลี่ยน implementation ของ `enqueueTask`
ให้เรียก endpoint ของ Worker ตรง ๆ ด้วย `fetch` แทน (ดูคอมเมนต์ในไฟล์) ที่เหลือของระบบไม่ต้องแก้
เพราะทุกที่เรียกผ่านฟังก์ชันนี้ฟังก์ชันเดียว

### 3.2 ตรวจสอบ Cron

`vercel.json` ตั้ง cron ให้เรียก `/api/worker/recover` ทุกชั่วโมงเพื่อกู้ Task ที่ค้าง
Vercel จะใส่ header ยืนยันให้เองตอนเรียกจาก cron ที่ประกาศไว้ — เราเช็คซ้ำด้วย `CRON_SECRET`
ที่ตั้งไว้ในข้อ 2.2 เผื่อกรณีตั้งค่าผิดพลาด

## 4. ทดสอบใช้งานจริงครั้งแรก

1. เปิดเว็บที่ deploy แล้ว → **Sign up** ด้วยอีเมลจริง (ต้องกดลิงก์ยืนยันในอีเมล)
2. หลังล็อกอิน → สร้าง Project ใหม่
3. รัน SQL ไฟล์ `supabase/migrations/0004_simple_agents.sql` ใน Supabase SQL Editor หนึ่งครั้ง (หลังรัน `schema.sql`)
   — เพิ่มการเก็บ API key แยกต่อ AI, ช่องหน้าที่, และแผนงานที่รอยืนยันในแชท รันซ้ำได้ ไม่พัง
4. เปิดแท็บ **Agents** → กด "เพิ่ม AI เข้าทีม" → วาง API key → เลือกโมเดล แค่นั้น
   (ระบบดูเองว่า key เป็นของเจ้าไหน AI ตัวแรกเป็นหัวหน้าทีมอัตโนมัติ ไม่ต้องตั้งบทบาทหรือเรียก API เอง)
5. (ไม่บังคับ) ใส่ราคาโมเดลในช่อง "ตั้งค่าเพิ่มเติม" หรือเพิ่ม `model_prices` ตามข้อ 5 เพื่อให้คำนวณค่าใช้จ่ายและคุมงบได้
6. กลับมาที่แชทแล้วคุยได้เลย — หัวหน้าทีมตอบ ถามกลับ และเสนอแผนให้กดยืนยันก่อนเริ่มงาน

### วิธีที่ระบบแบ่งงานและประหยัด token
- ทุกข้อความในแชทเป็นการคุยกับหัวหน้าทีม ไม่ใช่การสั่งงานทันที งานเล็กหัวหน้าตอบเองโดยไม่แบ่งงาน
- งานใหญ่: หัวหน้าเสนอแผน (กี่งาน ใครทำ ทำพร้อมกันได้ไหม) เป็นการ์ดในแชท งานเริ่มเมื่อกด "เริ่มทำตามแผน" เท่านั้น
- มอบงานตาม "หน้าที่" ของแต่ละ AI ถ้าไม่ได้ระบุหน้าที่ จะเลือกตามความถนัดและราคาของโมเดล (งานง่ายให้รุ่นเล็ก งานยากให้รุ่นเก่ง)
- แต่ละ AI ที่ทำงานเห็นเฉพาะงานของตัวเอง ผลสรุปของงานที่ต้องรอ และไฟล์ที่แผนระบุว่าต้องใช้ — ไม่เห็นประวัติแชททั้งหมด
- หัวหน้าทีมเห็นแชทแค่ 14 ข้อความล่าสุด (ไม่โตตามความยาวแชท)
- AI ที่สร้างไว้ก่อนระบบใหม่ยังทำงานได้ด้วย key ร่วมแบบเดิม (เปลี่ยนเป็น key ต่อ AI ได้จากปุ่ม "แก้ไข")

## 5. เรื่องราคา (model_prices)

ตาราง `model_prices` ว่างเปล่าโดยตั้งใจ — **ผมไม่ใส่ตัวเลขราคาที่เดาขึ้นมาเอง** เพราะราคาเปลี่ยนบ่อย
และใส่ผิดจะทำให้ระบบคุมงบประมาณผิดตาม ก่อนใช้งานจริง ให้ดูราคาปัจจุบันจากหน้าทางการของแต่ละค่าย
แล้วเพิ่มแถวเอง เช่น:

```sql
insert into public.model_prices (provider, model, in_per_mtok, out_per_mtok) values
  ('anthropic', 'claude-sonnet-4-6', 3.00, 15.00);
```

ถ้ารุ่นไหนไม่มีราคาในตารางนี้ ระบบจะคิดค่าใช้จ่ายเป็น $0 และ log คำเตือนไว้ (ดู
`src/lib/orchestrator/pricing.ts`) — งบประมาณของ project จะไม่ลดลงจริงจนกว่าจะใส่ราคา

---

## Reverse Engineering Mode (ระยะ 01: Foundation)

โหมดวิเคราะห์ซอฟต์แวร์ที่แยกจาก Project Mode (หน้า `/reverse-engineering`, API `/api/analysis`)

**ทำงานได้จริงแล้ว:** สร้างงานวิเคราะห์ (ชื่อ เป้าหมาย ประเภทเป้าหมายที่ระบุ) · แก้ไข · ยกเลิก · ลบ · โหลดกลับมา · เจ้าของข้อมูลเท่านั้นที่เข้าถึงได้

**ยังไม่มี (ระยะถัดไป):** การนำเข้าไฟล์ · Tool Registry / Analysis Worker · AI Orchestration · รายงานและการส่งต่อไป Project Mode
หน้าจอที่ยังไม่มีข้อมูลจริง (Call Graph, Evidence, Agents & Tools, Report) จะแสดงสถานะ "ยังไม่พร้อม" ไม่แสดงข้อมูลตัวอย่าง

วิธีเปิดใช้:
1. Supabase → SQL Editor → รัน `supabase/migrations/0005_analysis_foundation.sql` (รันซ้ำได้)
2. (ไม่บังคับ) รัน `supabase/tests/analysis_rls_test.sql` ได้ `ALL ANALYSIS RLS TESTS PASSED` และ rollback ไม่ทิ้งข้อมูล
3. Deploy ตามปกติ — ไม่มี env var เพิ่ม

สิทธิ์: ผู้ใช้เขียนได้เฉพาะตาราง `analysis_sessions` (และแก้ได้เฉพาะชื่อ/เป้าหมาย/ยกเลิก) ส่วนตารางอื่น
(`analysis_tasks`, `analysis_tool_runs`, `analysis_artifacts`, `analysis_findings`, `analysis_evidence`, `analysis_reports`)
เขียนได้เฉพาะ service role ฝั่ง server เพื่อไม่ให้ปลอมผลวิเคราะห์หรือหลักฐานได้

## สิ่งที่ยังไม่ได้ตรวจ (สำคัญ — อ่านก่อนใช้งานจริง)

sandbox ที่ใช้เขียนโค้ดนี้**ไม่มีเครือข่าย** จึงทำสิ่งต่อไปนี้ไม่ได้:

| รายการ | สถานะ |
|---|---|
| `npm install` แล้ว build จริง | ยังไม่เคยรัน |
| `next build` ผ่านจริง | ยังไม่เคยรัน |
| SQL รันบน Postgres จริง | ยังไม่เคยรัน (ตรวจแบบ static: วงเล็บ/dollar-quote สมดุล, ทุกตารางมี RLS, ทุกฟังก์ชัน grant ถูก role) |
| `@vercel/queue` เรียกจริงบน Vercel | ยังไม่เคยรัน — เขียนตาม doc ที่ค้นล่าสุด แต่เป็น public beta อาจเปลี่ยน API |
| เรียก Anthropic/OpenAI/Gemini API จริง | ยังไม่เคยรัน — รูปแบบ request/response ตรวจจากเอกสารล่าสุดแล้ว แต่ไม่เคยยิงจริง |
| Supabase Vault (`vault.create_secret` ฯลฯ) | ยังไม่เคยรัน — ตรวจจาก doc แล้วว่าฟังก์ชันชื่อนี้มีจริงและพารามิเตอร์ตรงกัน |

**สิ่งที่ตรวจแล้วมั่นใจสูง:**
- `tsc --strict --noUnusedLocals --noUnusedParameters` ผ่าน 0 error ทั้ง 36 ไฟล์ (ด้วย type stub
  ที่เขียนตาม signature จริงของ `@supabase/ssr`, `@supabase/supabase-js`, `@vercel/queue`, React, Next.js)
- `rls_test.sql` ครอบคลุมทุกตาราง: การมองเห็นข้ามผู้ใช้, การเขียนข้ามผู้ใช้, column-level privilege
  (เช่น แก้ `spent_usd`/`attempts` เองไม่ได้), ฟังก์ชัน Worker ทำงานถูกต้อง (claim/complete/fail/
  recover/cancel_blocked) รวมถึงเทสต์ที่สลับเป็น role `service_role` จริงเพื่อพิสูจน์ว่า Worker
  เรียกได้จริง ไม่ใช่แค่ทดสอบผ่าน `postgres` role เฉย ๆ
- Logic ของ dependency graph, concurrency limit, budget limit ตรวจผ่านเทสต์จำลองสถานการณ์จริง
  (T1→T2 dependency, concurrency เพดาน 2, งบหมดแล้ว claim ไม่ได้)

**คำแนะนำ:** รันตามขั้นตอนข้อ 1 ก่อนเสมอ (schema + RLS test) เพราะเป็นส่วนที่ตรวจเข้มที่สุดแล้ว
ถ้าผ่านหมด ความเสี่ยงที่เหลือจะอยู่ที่ชั้น Next.js/Vercel Queues ซึ่งเป็นเรื่อง infrastructure
มากกว่า business logic

## โครงสร้างไฟล์

```
supabase/
  schema.sql          รันครั้งเดียวจบ (RLS + Vault + ฟังก์ชัน Worker ทั้งหมด)
  reset.sql           ลบทุกอย่างที่ schema.sql สร้าง (ใช้ตอนต้องการรันใหม่)
  tests/rls_test.sql  ทดสอบ RLS/Worker/Vault ทั้งหมด รันใน SQL Editor
src/
  lib/ai/             Provider Adapter (Anthropic/OpenAI/Gemini) + registry กลาง
  lib/orchestrator/   planner (แบ่งงาน), worker (ประมวลผล task), context-builder,
                       pricing, queue (ห่อ @vercel/queue)
  lib/supabase/       server.ts (RLS) / admin.ts (service role) / auth.ts (requireUser)
  app/api/            ทุก endpoint ตาม Architecture ที่ตกลงกันไว้
  app/(app)/          UI หลัก (ต้องล็อกอิน): รายการ project, workspace (chat/agents/tasks/usage)
  app/(auth)/         login/signup
vercel.json           Queue trigger + Cron ทุกชั่วโมง
```

## ประวัติการแก้ไขด้านความปลอดภัย

ระหว่างทดสอบ `rls_test.sql` พบและแก้ช่องโหว่จริง 1 จุด: ฟังก์ชัน `guard_task_status_change`
(trigger ที่ป้องกันไม่ให้ผู้ใช้ทั่วไปปลอมสถานะ Task เป็น `completed` เอง) เดิมเช็คจาก
`current_setting('app.system_task_update')` ซึ่งเป็นค่าที่ผู้ใช้ authenticated ตั้งเองได้
ผ่านฟังก์ชันมาตรฐาน `set_config()` โดยไม่ต้องมีสิทธิ์พิเศษ ทำให้ปลอมผลงานได้จริง

แก้โดยเปลี่ยนไปเช็คจาก `current_user` แทน ซึ่งภายในฟังก์ชัน `SECURITY DEFINER` จะเปลี่ยนเป็น
เจ้าของฟังก์ชันเสมอ (ปกติคือ `postgres` บน Supabase) และผู้ใช้ทั่วไปไม่มีทางปลอมค่านี้ได้
เพราะไม่มี role membership ใน `postgres`/`supabase_admin` — ตรวจยืนยันด้วยเทสต์ที่อ่านจาก
`pg_auth_members` catalog โดยตรงใน `rls_test.sql`

ถ้าคุณเคยรัน schema เวอร์ชันก่อนหน้าไปแล้วในโปรเจกต์ใด ๆ **ให้สร้างโปรเจกต์ Supabase ใหม่และ
รัน schema.sql เวอร์ชันนี้แทน** อย่าพยายามแพตช์เฉพาะจุดบนโปรเจกต์เดิม เพราะ `create or replace
function` จะอัปเดตฟังก์ชันให้ก็จริง แต่การไล่ตรวจว่าไม่มีจุดอื่นตกหล่นทำได้ยากกว่าการเริ่มสะอาด
