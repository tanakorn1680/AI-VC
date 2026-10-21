'use client'

import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { PROVIDER_LIST, getProviderMeta } from '@/lib/ai/providers'
import type { ModelOption } from '@/lib/ai/list-models'

export interface Agent {
  id: string
  name: string
  provider: string
  model: string
  role: string
  /** หน้าที่ของ AI ตัวนี้ (ข้อความอิสระ ว่าง = ทำได้ทุกอย่าง) */
  duty: string
  key_last4: string | null
  /** agent = มี key ของตัวเอง, shared = ใช้ key ร่วมแบบเดิมตาม provider, none = ยังไม่มี key */
  key_source: 'agent' | 'shared' | 'none'
  base_url?: string | null
  allowed_tools?: string[]
}

const primaryBtn =
  'inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-500 active:bg-indigo-500 disabled:opacity-50'
const ghostBtn =
  'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg border border-neutral-700 px-3.5 py-2 text-sm text-neutral-200 transition hover:bg-neutral-800 active:bg-neutral-800 disabled:opacity-50'
const inputCls =
  'block w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2.5 text-base text-neutral-100 outline-none placeholder:text-neutral-500 focus:border-indigo-500'
const card = 'rounded-xl border border-neutral-800 bg-neutral-900 p-4'

/** ตัวช่วยเติมหน้าที่ — กดแล้วเติมลงช่อง แก้ต่อเองได้ */
const DUTY_PRESETS = ['ค้นคว้าและสรุปข้อมูล', 'เขียนโค้ด', 'ตรวจทานหาข้อผิดพลาด', 'เขียนเนื้อหา', 'แปลภาษา', 'วิเคราะห์ข้อมูล', 'วางโครงสร้างและออกแบบ']

async function call(url: string, init?: RequestInit): Promise<{ ok: boolean; data: any }> {
  const res = await fetch(url, init)
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, data }
}
const JSON_HEADERS = { 'content-type': 'application/json' }

function providerLabel(id: string): string {
  return getProviderMeta(id)?.label ?? id
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="block text-sm font-medium text-neutral-200">{label}</span>
      {children}
      {hint && <span className="block text-xs leading-relaxed text-neutral-500">{hint}</span>}
    </label>
  )
}

function DutyChips({ onPick }: { onPick: (v: string) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5 pt-1">
      {DUTY_PRESETS.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onPick(d)}
          className="rounded-full border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 active:bg-neutral-800"
        >
          {d}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// หน้าหลัก
// ---------------------------------------------------------------------------
export default function AgentsPanel({
  apiBase,
  agents,
  onChanged,
}: {
  /** เส้นทาง API ของทีม เช่น /api/teams/<teamId> — AI เป็นของทีม ใช้ร่วมกันทุกโปรเจกต์ */
  apiBase: string
  agents: Agent[]
  onChanged: () => void | Promise<void>
}) {
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState('')

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-neutral-100">AI ในทีม</h2>
        <p className="mt-1 text-sm leading-relaxed text-neutral-400">
          AI ชุดนี้ใช้ร่วมกันได้ทุกโปรเจกต์ (ทีมทำได้ทีละ 1 โปรเจกต์) เพิ่มกี่ตัวก็ได้ แค่วาง API key แล้วเลือกโมเดล หัวหน้าทีมจะคุยกับคุณและมอบงานให้ตัวอื่นเอง
        </p>
      </div>

      {notice && (
        <p role="status" className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2.5 text-sm text-emerald-300">
          {notice}
        </p>
      )}

      {agents.length === 0 && !adding && (
        <div className={`${card} space-y-3`}>
          <p className="text-sm font-medium text-neutral-100">เริ่มต้นใน 3 ขั้นตอน</p>
          <ol className="space-y-2 text-sm text-neutral-400">
            <li>1. กด &quot;เพิ่ม AI เข้าทีม&quot; แล้ววาง API key</li>
            <li>2. เลือกโมเดลที่ต้องการ</li>
            <li>3. กลับไปที่แชทแล้วคุยได้เลย — AI ตัวแรกจะเป็นหัวหน้าทีม</li>
          </ol>
        </div>
      )}

      <ul className="space-y-3">
        {agents.map((a) => (
          <li key={a.id}>
            <AgentCard
              apiBase={apiBase}
              agent={a}
              isLead={a.role === 'manager'}
              onChanged={onChanged}
              onNotice={setNotice}
            />
          </li>
        ))}
      </ul>

      {adding ? (
        <AddAgent
          apiBase={apiBase}
          isFirst={agents.length === 0}
          onCancel={() => setAdding(false)}
          onDone={(name, first) => {
            setAdding(false)
            setNotice(first ? `เพิ่ม ${name} แล้ว — เป็นหัวหน้าทีม ไปคุยในแชทได้เลย` : `เพิ่ม ${name} เข้าทีมแล้ว`)
            void onChanged()
          }}
        />
      ) : (
        <button
          onClick={() => {
            setNotice('')
            setAdding(true)
          }}
          className={`${primaryBtn} w-full`}
        >
          เพิ่ม AI เข้าทีม
        </button>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// เพิ่ม AI: วาง key → ระบบรู้เองว่าเจ้าไหน → เลือกโมเดล
// ---------------------------------------------------------------------------
type Probe =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; provider: string; label: string; models: ModelOption[]; source: 'live' | 'static' }
  | { kind: 'fail'; reason: string; message: string }

function AddAgent({
  apiBase,
  isFirst,
  onCancel,
  onDone,
}: {
  apiBase: string
  isFirst: boolean
  onCancel: () => void
  onDone: (name: string, first: boolean) => void
}) {
  const [apiKey, setApiKey] = useState('')
  const [manualProvider, setManualProvider] = useState('')
  const [pickProvider, setPickProvider] = useState(false)
  const [baseUrl, setBaseUrl] = useState('')
  const [probe, setProbe] = useState<Probe>({ kind: 'idle' })
  const [model, setModel] = useState('')
  const [name, setName] = useState('')
  const [duty, setDuty] = useState('')
  const [priceIn, setPriceIn] = useState('')
  const [priceOut, setPriceOut] = useState('')
  const [canWrite, setCanWrite] = useState(true)
  const [kind, setKind] = useState<'worker' | 'reviewer'>('worker')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // วาง/พิมพ์ key เสร็จแล้วรอสักครู่ → ตรวจ key + ดึงรายชื่อโมเดลให้อัตโนมัติ
  useEffect(() => {
    const key = apiKey.trim()
    if (key.length < 8 || (manualProvider === 'custom' && baseUrl.trim().length < 8)) {
      setProbe({ kind: 'idle' })
      return
    }
    const ctrl = new AbortController()
    const timer = setTimeout(async () => {
      setProbe({ kind: 'checking' })
      try {
        const { ok, data } = await call('/api/agents/probe', {
          method: 'POST',
          headers: JSON_HEADERS,
          signal: ctrl.signal,
          body: JSON.stringify({ api_key: key, provider: manualProvider || undefined, base_url: baseUrl.trim() || undefined }),
        })
        if (ctrl.signal.aborted) return
        if (ok && data.ok) {
          const models = (data.models ?? []) as ModelOption[]
          setProbe({ kind: 'ok', provider: data.provider, label: data.label, models, source: data.source })
          // เปลี่ยนเจ้า/ใส่ key ใหม่ → เคลียร์โมเดลที่ไม่อยู่ในรายการ; มีตัวเดียวก็เลือกให้
          setModel((cur) => (models.some((m) => m.id === cur) ? cur : models.length === 1 ? (models[0]?.id ?? '') : ''))
        } else {
          if (data.reason === 'unknown_provider') setPickProvider(true)
          setProbe({ kind: 'fail', reason: data.reason ?? 'error', message: data.message ?? data.error ?? 'ตรวจ key ไม่สำเร็จ' })
        }
      } catch {
        if (!ctrl.signal.aborted) setProbe({ kind: 'fail', reason: 'upstream', message: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' })
      }
    }, 600)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [apiKey, manualProvider, baseUrl])

  const detected = probe.kind === 'ok' ? probe : null
  const canSubmit = !!detected && model.trim().length > 0 && !busy
  const needsBaseUrl = getProviderMeta(manualProvider)?.customBaseUrl === true

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!detected || !canSubmit) return
    setBusy(true)
    setError('')
    const hasPrice = priceIn.trim() !== '' || priceOut.trim() !== ''
    const { ok, data } = await call(`${apiBase}/agents`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        api_key: apiKey.trim(),
        provider: detected.provider,
        model: model.trim(),
        base_url: needsBaseUrl ? baseUrl.trim() : undefined,
        name: name.trim() || undefined,
        duty: duty.trim() || undefined,
        can_write_files: canWrite,
        kind: isFirst ? undefined : kind,
        ...(hasPrice ? { price_in: Number(priceIn || 0), price_out: Number(priceOut || 0) } : {}),
      }),
    }).catch(() => ({ ok: false, data: { error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' } }))
    setBusy(false)
    if (!ok) {
      setError(data.error ?? 'เพิ่มไม่สำเร็จ')
      return
    }
    setApiKey('') // ไม่ทิ้ง key ค้างในหน้าจอ
    onDone(data.agent?.name ?? model.trim(), isFirst)
  }

  return (
    <form onSubmit={submit} className={`${card} space-y-5`}>
      <h3 className="text-base font-semibold text-neutral-100">เพิ่ม AI เข้าทีม</h3>

      <Field label="1. API key" hint="วาง key ที่ได้จากผู้ให้บริการ (Anthropic, OpenAI, Google, OpenRouter ฯลฯ) ระบบจะดูให้เองว่าเป็นของเจ้าไหน">
        <input
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="วาง API key ที่นี่"
          className={inputCls}
        />
      </Field>

      {probe.kind === 'checking' && <p className="text-sm text-neutral-400">กำลังตรวจสอบ key...</p>}
      {detected && (
        <p role="status" className="text-sm text-emerald-400">
          พบ {detected.label}
          {detected.models.length > 0 ? ` — ${detected.models.length} โมเดลที่ใช้ได้` : ''}
        </p>
      )}
      {probe.kind === 'fail' && (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2.5 text-sm text-red-300">
          {probe.message}
        </p>
      )}

      {(pickProvider || manualProvider) && (
        <div className="space-y-3">
          <Field label="ผู้ให้บริการ">
            <select value={manualProvider} onChange={(e) => setManualProvider(e.target.value)} className={inputCls}>
              <option value="">— เลือกผู้ให้บริการ —</option>
              {PROVIDER_LIST.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          {needsBaseUrl && (
            <Field label="Base URL" hint="ที่อยู่ API แบบ OpenAI-compatible ขึ้นต้นด้วย https:// (ไม่ต้องใส่ /chat/completions)">
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" className={inputCls} />
            </Field>
          )}
        </div>
      )}
      {!pickProvider && !manualProvider && apiKey.trim().length >= 8 && (
        <button type="button" onClick={() => setPickProvider(true)} className="text-xs text-neutral-500 underline-offset-2 hover:underline">
          ไม่ใช่เจ้านี้? เลือกผู้ให้บริการเอง
        </button>
      )}

      {detected && (
        <>
          <Field
            label="2. เลือกโมเดล"
            hint={
              detected.source === 'static'
                ? 'ผู้ให้บริการนี้ไม่มีรายชื่อโมเดลให้ดึง — รายการนี้เป็นรุ่นที่ระบบรู้จัก พิมพ์ชื่อรุ่นอื่นเองได้ และจะรู้ว่า key ใช้ได้จริงตอนเริ่มใช้งานครั้งแรก'
                : 'พิมพ์เพื่อค้นหา หรือแตะเพื่อเลือกจากรายการ'
            }
          >
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list="agent-model-options"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="เลือกหรือพิมพ์ชื่อโมเดล"
              className={inputCls}
            />
            <datalist id="agent-model-options">
              {detected.models.map((m) => (
                <option key={m.id} value={m.id} label={m.free ? `${m.label} (ฟรี)` : m.label} />
              ))}
            </datalist>
          </Field>

          <details className="group rounded-lg border border-neutral-800 px-3 py-2">
            <summary className="cursor-pointer py-1.5 text-sm text-neutral-300">ตั้งค่าเพิ่มเติม (ไม่บังคับ)</summary>
            <div className="space-y-4 pb-2 pt-3">
              <Field label="หน้าที่" hint="เว้นว่างได้ — หัวหน้าทีมจะเลือกงานให้ตามความถนัดของโมเดลนี้">
                <input value={duty} onChange={(e) => setDuty(e.target.value)} maxLength={300} placeholder="เช่น เขียนโค้ด" className={inputCls} />
                <DutyChips onPick={setDuty} />
              </Field>
              {!isFirst && (
                <Field label="บทบาท" hint="ผู้ตรวจ = ตรวจผลงานของ AI ตัวอื่นก่อนส่งมอบ (หัวหน้าทีมจะเพิ่มงานตรวจให้เองเมื่อชิ้นงานสำคัญ)">
                  <select value={kind} onChange={(e) => setKind(e.target.value as 'worker' | 'reviewer')} className={inputCls}>
                    <option value="worker">ผู้ทำงาน</option>
                    <option value="reviewer">ผู้ตรวจ</option>
                  </select>
                </Field>
              )}
              <Field label="ชื่อ" hint="ถ้าไม่ตั้ง ระบบจะใช้ชื่อโมเดล">
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="เช่น นักเขียน" className={inputCls} />
              </Field>
              <div>
                <p className="mb-1.5 text-sm font-medium text-neutral-200">ราคาโมเดล (USD ต่อ 1 ล้าน token)</p>
                <div className="grid grid-cols-2 gap-2">
                  <input value={priceIn} onChange={(e) => setPriceIn(e.target.value)} inputMode="decimal" placeholder="ขาเข้า เช่น 3" aria-label="ราคาขาเข้า" className={inputCls} />
                  <input value={priceOut} onChange={(e) => setPriceOut(e.target.value)} inputMode="decimal" placeholder="ขาออก เช่น 15" aria-label="ราคาขาออก" className={inputCls} />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-neutral-500">ใส่เพื่อให้ระบบคำนวณค่าใช้จ่ายและคุมงบได้แม่นยำ ถ้าไม่ใส่ ค่าใช้จ่ายของโมเดลนี้จะแสดงเป็น $0</p>
              </div>
              <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm text-neutral-200">
                <input type="checkbox" checked={canWrite} onChange={(e) => setCanWrite(e.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-indigo-600" />
                <span>
                  ให้ AI ตัวนี้สร้างและแก้ไฟล์ในโปรเจกต์ได้
                  <span className="block text-xs text-neutral-500">เปิดไว้เป็นค่าเริ่มต้น</span>
                </span>
              </label>
            </div>
          </details>
        </>
      )}

      {isFirst && detected && (
        <p className="text-xs leading-relaxed text-neutral-500">AI ตัวแรกจะเป็นหัวหน้าทีม (ผู้ประสานงาน): คุยกับคุณ ถามกลับเมื่อข้อมูลไม่พอ แล้วมอบงานให้ AI ตัวอื่นตามหน้าที่</p>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2.5 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={!canSubmit} className={primaryBtn}>
          {busy ? 'กำลังเพิ่ม...' : 'เพิ่ม AI เข้าทีม'}
        </button>
        <button type="button" onClick={onCancel} className={ghostBtn}>
          ยกเลิก
        </button>
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// การ์ด AI แต่ละตัว
// ---------------------------------------------------------------------------
function AgentCard({
  apiBase,
  agent,
  isLead,
  onChanged,
  onNotice,
}: {
  apiBase: string
  agent: Agent
  isLead: boolean
  onChanged: () => void | Promise<void>
  onNotice: (m: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(agent.name)
  const [duty, setDuty] = useState(agent.duty)
  const [model, setModel] = useState(agent.model)
  const [newKey, setNewKey] = useState('')
  const [canWrite, setCanWrite] = useState(agent.allowed_tools?.includes('write_file') ?? true)
  const [kind, setKind] = useState<'worker' | 'reviewer'>(agent.role === 'reviewer' ? 'reviewer' : 'worker')
  const [models, setModels] = useState<ModelOption[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // เปิดโหมดแก้ไขแล้วค่อยโหลดรายชื่อโมเดลของ key นี้ (ไม่โหลดทุกการ์ดตั้งแต่ต้น)
  useEffect(() => {
    if (!editing) return
    let cancelled = false
    void call(`${apiBase}/agents/${agent.id}/models`)
      .then(({ ok, data }) => {
        if (!cancelled && ok && Array.isArray(data.models)) setModels(data.models as ModelOption[])
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [editing, apiBase, agent.id])

  function openEditor() {
    setName(agent.name)
    setDuty(agent.duty)
    setModel(agent.model)
    setNewKey('')
    setCanWrite(agent.allowed_tools?.includes('write_file') ?? true)
    setKind(agent.role === 'reviewer' ? 'reviewer' : 'worker')
    setError('')
    setEditing(true)
  }

  async function patch(body: Record<string, unknown>, okMessage?: string): Promise<boolean> {
    setBusy(true)
    setError('')
    const { ok, data } = await call(`${apiBase}/agents/${agent.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }).catch(() => ({ ok: false, data: { error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' } }))
    setBusy(false)
    if (!ok) {
      setError(data.error ?? 'บันทึกไม่สำเร็จ')
      return false
    }
    if (okMessage) onNotice(okMessage)
    await onChanged()
    return true
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const body: Record<string, unknown> = {}
    if (name.trim() !== agent.name) body.name = name.trim()
    if (duty.trim() !== agent.duty) body.duty = duty.trim()
    if (model.trim() !== agent.model) body.model = model.trim()
    if (newKey.trim()) body.api_key = newKey.trim()
    if (canWrite !== (agent.allowed_tools?.includes('write_file') ?? true)) body.can_write_files = canWrite
    if (!isLead && kind !== (agent.role === 'reviewer' ? 'reviewer' : 'worker')) body.kind = kind
    if (Object.keys(body).length === 0) {
      setEditing(false)
      return
    }
    if (await patch(body, `บันทึกการแก้ไข ${name.trim() || agent.name} แล้ว`)) {
      setNewKey('')
      setEditing(false)
    }
  }

  async function remove() {
    if (!window.confirm(`ลบ ${agent.name} ออกจากทีม? จะหายไปจากทุกโปรเจกต์ และ API key ของ AI ตัวนี้จะถูกลบด้วย`)) return
    setBusy(true)
    const { ok, data } = await call(`${apiBase}/agents/${agent.id}`, { method: 'DELETE' }).catch(() => ({
      ok: false,
      data: { error: 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้' },
    }))
    setBusy(false)
    if (!ok) {
      setError(data.error ?? 'ลบไม่สำเร็จ')
      return
    }
    onNotice(`ลบ ${agent.name} แล้ว`)
    await onChanged()
  }

  const keyLine =
    agent.key_source === 'agent' ? (
      <span className="text-neutral-500">API key ••••{agent.key_last4}</span>
    ) : agent.key_source === 'shared' ? (
      <span className="text-neutral-500">ใช้ API key ร่วมของ {providerLabel(agent.provider)} (ตั้งไว้ก่อนระบบใหม่)</span>
    ) : (
      <span className="text-red-400">ยังไม่มี API key — กดแก้ไขเพื่อใส่</span>
    )

  return (
    <div className={card}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="break-words text-[15px] font-semibold text-neutral-100">{agent.name}</p>
            {isLead && <span className="rounded-full bg-indigo-600/20 px-2.5 py-0.5 text-xs font-medium text-indigo-300">หัวหน้าทีม</span>}
            {agent.role === 'reviewer' && <span className="rounded-full bg-amber-600/20 px-2.5 py-0.5 text-xs font-medium text-amber-300">ผู้ตรวจ</span>}
          </div>
          <p className="mt-0.5 break-all font-mono text-xs text-neutral-500">
            {agent.model} · {providerLabel(agent.provider)}
          </p>
        </div>
        {!editing && (
          <button onClick={openEditor} className={`${ghostBtn} shrink-0`}>
            แก้ไข
          </button>
        )}
      </div>

      {!editing && (
        <div className="mt-3 space-y-1 text-sm">
          <p className="text-neutral-300">
            <span className="text-neutral-500">หน้าที่: </span>
            {agent.duty || (isLead ? 'คุยกับคุณและมอบงานให้ทีม' : agent.role === 'reviewer' ? 'ตรวจผลงานของ AI ตัวอื่น' : 'ทำได้ทุกอย่าง — หัวหน้าทีมเลือกงานให้ตามความถนัด')}
          </p>
          <p className="text-xs">{keyLine}</p>
        </div>
      )}

      {editing && (
        <form onSubmit={save} className="mt-4 space-y-4 border-t border-neutral-800 pt-4">
          <Field label="หน้าที่" hint="เว้นว่างได้ — หัวหน้าทีมจะเลือกงานให้ตามความถนัด">
            <input value={duty} onChange={(e) => setDuty(e.target.value)} maxLength={300} placeholder="เช่น เขียนโค้ด" className={inputCls} />
            <DutyChips onPick={setDuty} />
          </Field>
          <Field label="ชื่อ">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} className={inputCls} />
          </Field>
          <Field label="โมเดล" hint={models.length > 0 ? `${models.length} โมเดลที่ key นี้ใช้ได้ — พิมพ์เพื่อค้นหา` : undefined}>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              list={`models-${agent.id}`}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              className={inputCls}
            />
            <datalist id={`models-${agent.id}`}>
              {models.map((m) => (
                <option key={m.id} value={m.id} label={m.free ? `${m.label} (ฟรี)` : m.label} />
              ))}
            </datalist>
          </Field>
          <Field label="เปลี่ยน API key" hint={`ปัจจุบัน: ${agent.key_source === 'agent' ? `••••${agent.key_last4}` : agent.key_source === 'shared' ? 'ใช้ key ร่วมแบบเดิม' : 'ยังไม่มี'} — ใส่เฉพาะเมื่ออยากเปลี่ยน`}>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="วาง API key ใหม่"
              className={inputCls}
            />
          </Field>
          {!isLead && (
            <Field label="บทบาท" hint="ผู้ตรวจ = ตรวจผลงานของ AI ตัวอื่นก่อนส่งมอบ">
              <select value={kind} onChange={(e) => setKind(e.target.value as 'worker' | 'reviewer')} className={inputCls}>
                <option value="worker">ผู้ทำงาน</option>
                <option value="reviewer">ผู้ตรวจ</option>
              </select>
            </Field>
          )}
          <label className="flex min-h-11 cursor-pointer items-start gap-3 text-sm text-neutral-200">
            <input type="checkbox" checked={canWrite} onChange={(e) => setCanWrite(e.target.checked)} className="mt-1 h-4 w-4 shrink-0 accent-indigo-600" />
            <span>ให้ AI ตัวนี้สร้างและแก้ไฟล์ในโปรเจกต์ได้</span>
          </label>

          {error && (
            <p role="alert" className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2.5 text-sm text-red-300">
              {error}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={primaryBtn}>
              {busy ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
            <button type="button" onClick={() => setEditing(false)} disabled={busy} className={ghostBtn}>
              ยกเลิก
            </button>
          </div>

          <div className="flex flex-wrap gap-2 border-t border-neutral-800 pt-4">
            {!isLead && (
              <button type="button" disabled={busy} onClick={() => void patch({ make_lead: true }, `${agent.name} เป็นหัวหน้าทีมแล้ว`).then((done) => done && setEditing(false))} className={ghostBtn}>
                ตั้งเป็นหัวหน้าทีม
              </button>
            )}
            <button type="button" disabled={busy} onClick={() => void remove()} className={`${ghostBtn} border-red-900/60 text-red-300 hover:bg-red-950/40`}>
              ลบออกจากทีม
            </button>
          </div>
        </form>
      )}

      {!editing && error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  )
}
