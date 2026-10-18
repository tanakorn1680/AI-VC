'use client'

import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { Sheet, SheetItem } from '@/components/sheet'
import ZipImport from './zip-import'

interface FileItem {
  id: string
  path: string
  updated_at: string
  /** null = ยังไม่ได้รัน migration 0009 จึงไม่ทราบขนาด */
  size_bytes: number | null
}

interface VersionItem {
  id: string
  created_at: string
  author: string
}

interface FileDetail {
  file: { id: string; path: string; current_version_id: string | null }
  version_id: string | null
  content: string
  versions: VersionItem[]
}

type View = { kind: 'list' } | { kind: 'new' } | { kind: 'import'; file: File } | { kind: 'file'; id: string }

const inputCls =
  'w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-indigo-500'
const labelCls = 'mb-1 block text-xs text-neutral-400'
const primaryBtn =
  'inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50'
const ghostBtn =
  'inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800 disabled:opacity-50'

function Icon({ children, size = 16, fill = 'none' }: { children: ReactNode; size?: number; fill?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}
type IconProps = { size?: number }
const BackIcon = ({ size }: IconProps) => <Icon size={size}><path d="M15 6l-6 6 6 6" /></Icon>
const PlusIcon = ({ size }: IconProps) => <Icon size={size}><path d="M12 5v14M5 12h14" /></Icon>
const FileIcon = ({ size }: IconProps) => <Icon size={size}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></Icon>
const FolderIcon = ({ size }: IconProps) => <Icon size={size} fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Icon>
const CopyIcon = ({ size }: IconProps) => <Icon size={size}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></Icon>
const DownloadIcon = ({ size }: IconProps) => <Icon size={size}><path d="M12 4v11M7 11l5 5 5-5M5 20h14" /></Icon>
const EditIcon = ({ size }: IconProps) => <Icon size={size}><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></Icon>
const OpenIcon = ({ size }: IconProps) => <Icon size={size}><path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" /><path d="M18.5 3.5l2 2L12 14l-3 1 1-3z" /></Icon>
const UploadIcon = ({ size }: IconProps) => <Icon size={size}><path d="M12 16V4M7 9l5-5 5 5M5 20h14" /></Icon>
const TrashIcon = ({ size }: IconProps) => <Icon size={size}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" /></Icon>
const ClockIcon = ({ size }: IconProps) => <Icon size={size}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>
const CheckIcon = ({ size }: IconProps) => <Icon size={size}><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' })
}

function formatSize(n: number | null): string {
  if (n === null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const baseName = (path: string) => path.split('/').pop() || path
const dirName = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '')

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body.error ?? fallback
  } catch {
    return fallback
  }
}

/** รายการในโฟลเดอร์ปัจจุบัน: โฟลเดอร์ (สร้างจาก path ของไฟล์ ไม่มีตารางโฟลเดอร์จริง) ตามด้วยไฟล์ */
type Entry =
  | { kind: 'folder'; key: string; name: string; fileIds: string[] }
  | { kind: 'file'; key: string; name: string; item: FileItem }

function listDir(files: FileItem[], cwd: string[]): Entry[] {
  const prefix = cwd.length ? `${cwd.join('/')}/` : ''
  const folders = new Map<string, string[]>()
  const here: Entry[] = []
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue
    const rest = f.path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash >= 0) {
      const name = rest.slice(0, slash)
      folders.set(name, [...(folders.get(name) ?? []), f.id])
    } else {
      here.push({ kind: 'file', key: f.id, name: rest, item: f })
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => {
    const x = a.name.toLowerCase()
    const y = b.name.toLowerCase()
    return x < y ? -1 : x > y ? 1 : 0
  }
  const folderEntries: Entry[] = [...folders].map(([name, fileIds]) => ({ kind: 'folder', key: `d:${name}`, name, fileIds }))
  return [...folderEntries.sort(byName), ...here.sort(byName)]
}

const idsOf = (e: Entry) => (e.kind === 'folder' ? e.fileIds : [e.item.id])

export default function FilesPanel({ projectId }: { projectId: string }) {
  const [view, setView] = useState<View>({ kind: 'list' })
  // โฟลเดอร์ที่เปิดอยู่ เก็บไว้ที่นี่เพื่อให้กลับจากหน้าไฟล์แล้วยังอยู่โฟลเดอร์เดิม
  const [cwd, setCwd] = useState<string[]>([])

  if (view.kind === 'new') {
    return (
      <NewFile
        projectId={projectId}
        initialPath={cwd.length ? `${cwd.join('/')}/` : ''}
        onCancel={() => setView({ kind: 'list' })}
        onSaved={(id) => setView({ kind: 'file', id })}
      />
    )
  }
  if (view.kind === 'import') {
    return <ZipImport projectId={projectId} file={view.file} onClose={() => setView({ kind: 'list' })} />
  }
  if (view.kind === 'file') {
    return (
      <FileViewer
        key={view.id}
        projectId={projectId}
        fileId={view.id}
        onBack={() => setView({ kind: 'list' })}
      />
    )
  }
  return (
    <FileList
      projectId={projectId}
      cwd={cwd}
      onNavigate={setCwd}
      onOpen={(id) => setView({ kind: 'file', id })}
      onNew={() => setView({ kind: 'new' })}
      onImport={(file) => setView({ kind: 'import', file })}
    />
  )
}

/** เมนูของไฟล์: Open / Download / Rename / Delete */
function FileSheet({
  projectId,
  item,
  onClose,
  onOpen,
  onChanged,
}: {
  projectId: string
  item: FileItem
  onClose: () => void
  onOpen: (id: string) => void
  onChanged: () => Promise<void>
}) {
  const [mode, setMode] = useState<'menu' | 'rename'>('menu')
  const [name, setName] = useState(baseName(item.path))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function download() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/projects/${projectId}/files/${item.id}`)
      if (!res.ok) {
        setError(await readError(res, 'ดาวน์โหลดไม่สำเร็จ'))
        return
      }
      const detail = (await res.json()) as FileDetail
      const url = URL.createObjectURL(new Blob([detail.content], { type: 'text/plain;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = baseName(item.path)
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      onClose()
    } catch {
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง')
    } finally {
      setBusy(false)
    }
  }

  async function rename(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    const next = name.trim()
    if (!next) return setError('ชื่อไฟล์ต้องไม่ว่าง')
    // เปลี่ยนได้เฉพาะชื่อ ไม่ให้ย้ายโฟลเดอร์ผ่านช่องนี้
    if (next.includes('/') || next.includes('\\')) return setError('ชื่อไฟล์ห้ามมี / หรือ \\')
    if (next === baseName(item.path)) return onClose()

    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/projects/${projectId}/files/${item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: dirName(item.path) + next }),
      })
      if (!res.ok) {
        setError(await readError(res, 'เปลี่ยนชื่อไม่สำเร็จ'))
        return
      }
      await onChanged()
      onClose()
    } catch {
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (busy) return
    if (!window.confirm(`ลบไฟล์ "${item.path}" ?`)) return
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/projects/${projectId}/files/${item.id}`, { method: 'DELETE' })
      if (!res.ok) {
        setError(await readError(res, 'ลบไม่สำเร็จ'))
        return
      }
      await onChanged()
      onClose()
    } catch {
      setError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง')
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'rename') {
    return (
      <Sheet title="เปลี่ยนชื่อ" onClose={onClose}>
        <form onSubmit={rename} className="space-y-3 pb-1">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            spellCheck={false}
            aria-label="ชื่อไฟล์ใหม่"
            className={`${inputCls} font-mono`}
          />
          {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className={primaryBtn}>
              {busy ? 'กำลังบันทึก...' : 'บันทึก'}
            </button>
            <button type="button" onClick={() => { setMode('menu'); setError('') }} disabled={busy} className={ghostBtn}>
              ยกเลิก
            </button>
          </div>
        </form>
      </Sheet>
    )
  }

  return (
    <Sheet title={baseName(item.path)} onClose={onClose}>
      <SheetItem icon={<OpenIcon size={22} />} label="Open" onClick={() => { onClose(); onOpen(item.id) }} />
      <SheetItem icon={<DownloadIcon size={22} />} label={busy ? 'กำลังดาวน์โหลด...' : 'Download'} onClick={download} disabled={busy} />
      <SheetItem icon={<EditIcon size={22} />} label="Rename" onClick={() => setMode('rename')} disabled={busy} />
      <div className="my-1 border-t border-neutral-700" />
      <SheetItem icon={<TrashIcon size={22} />} label="Delete" onClick={remove} danger disabled={busy} />
      {error && <p role="alert" className="mt-2 text-sm text-red-400">{error}</p>}
    </Sheet>
  )
}

function FileList({
  projectId,
  cwd,
  onNavigate,
  onOpen,
  onNew,
  onImport,
}: {
  projectId: string
  cwd: string[]
  onNavigate: (cwd: string[]) => void
  onOpen: (id: string) => void
  onNew: () => void
  onImport: (file: File) => void
}) {
  const [files, setFiles] = useState<FileItem[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [sheet, setSheet] = useState<{ kind: 'file'; item: FileItem } | { kind: 'history' } | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const selecting = selected.size > 0

  const load = useCallback(async () => {
    const res = await fetch(`/api/projects/${projectId}/files`)
    if (!res.ok) {
      setError(await readError(res, 'โหลดรายการไฟล์ไม่สำเร็จ'))
      return
    }
    setError('')
    setFiles(((await res.json()) as { files: FileItem[] }).files ?? [])
  }, [projectId])

  // agent อาจสร้างไฟล์ระหว่างที่เปิดหน้านี้อยู่ จึงรีเฟรชเป็นระยะ
  // (หยุดรีเฟรชอัตโนมัติระหว่างกำลังเลือกไฟล์ กันรายการสั่นตอนผู้ใช้กำลังกดเลือกอยู่)
  useEffect(() => {
    void load()
    if (selecting) return
    const t = setInterval(() => void load(), 5000)
    return () => clearInterval(t)
  }, [load, selecting])

  const entries = useMemo(() => listDir(files ?? [], cwd), [files, cwd])

  // โฟลเดอร์ที่เปิดอยู่ไม่มีไฟล์เหลือแล้ว (ถูกลบ/ย้าย) → ถอยขึ้นหนึ่งระดับ
  useEffect(() => {
    if (!files || cwd.length === 0) return
    const prefix = `${cwd.join('/')}/`
    if (!files.some((f) => f.path.startsWith(prefix))) onNavigate(cwd.slice(0, -1))
  }, [files, cwd, onNavigate])

  const isSelected = (e: Entry) => {
    const ids = idsOf(e)
    return ids.length > 0 && ids.every((id) => selected.has(id))
  }

  function toggleEntry(e: Entry) {
    const ids = idsOf(e)
    setSelected((prev) => {
      const next = new Set(prev)
      if (ids.every((id) => next.has(id))) ids.forEach((id) => next.delete(id))
      else ids.forEach((id) => next.add(id))
      return next
    })
  }

  function toggleAll() {
    const all = entries.flatMap(idsOf)
    setSelected((prev) => (all.every((id) => prev.has(id)) ? new Set() : new Set(all)))
  }

  async function deleteSelected() {
    if (selected.size === 0 || deleting) return
    if (!window.confirm(`ลบ ${selected.size} ไฟล์ที่เลือก?`)) return

    setDeleting(true)
    setError('')
    const res = await fetch(`/api/projects/${projectId}/files/batch-delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_ids: [...selected] }),
    })
    setDeleting(false)
    if (!res.ok) {
      setError(await readError(res, 'ลบไฟล์ไม่สำเร็จ'))
      return
    }
    setSelected(new Set())
    await load()
  }

  const recent = useMemo(
    () => [...(files ?? [])].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)).slice(0, 30),
    [files]
  )

  return (
    <section className="pb-24">
      {/* แถบบน: เส้นทางโฟลเดอร์ + History หรือแถบการเลือก */}
      <div className="mb-4 flex min-h-10 items-center justify-between gap-3 border-b border-neutral-800 pb-3">
        {selecting ? (
          <>
            <span className="text-sm font-medium text-neutral-200">เลือกแล้ว {selected.size} ไฟล์</span>
            <div className="flex items-center gap-2">
              <button onClick={toggleAll} className={ghostBtn}>เลือกทั้งหมด</button>
              <button
                onClick={deleteSelected}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium hover:bg-red-500 disabled:opacity-50"
              >
                <TrashIcon />
                {deleting ? 'กำลังลบ...' : `ลบ (${selected.size})`}
              </button>
              <button onClick={() => setSelected(new Set())} className={ghostBtn}>ยกเลิก</button>
            </div>
          </>
        ) : (
          <>
            <nav aria-label="เส้นทางโฟลเดอร์" className="flex min-w-0 items-center gap-1.5 overflow-x-auto whitespace-nowrap text-sm">
              <button
                onClick={() => onNavigate([])}
                className={cwd.length === 0 ? 'font-medium text-neutral-200' : 'text-neutral-400 transition hover:text-neutral-200'}
              >
                Root
              </button>
              {cwd.map((seg, i) => (
                <span key={`${i}-${seg}`} className="flex items-center gap-1.5">
                  <span className="text-neutral-600">/</span>
                  <button
                    onClick={() => onNavigate(cwd.slice(0, i + 1))}
                    className={i === cwd.length - 1 ? 'font-medium text-neutral-200' : 'text-neutral-400 transition hover:text-neutral-200'}
                  >
                    {seg}
                  </button>
                </span>
              ))}
            </nav>
            <button
              onClick={() => setSheet({ kind: 'history' })}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-neutral-700 px-3.5 py-1.5 text-sm text-neutral-300 transition hover:bg-neutral-800"
            >
              <ClockIcon size={16} />
              History
            </button>
          </>
        )}
      </div>

      {error && <p role="alert" className="mb-3 text-sm text-red-400">{error}</p>}

      <div className="space-y-2.5">
        {entries.map((e) => {
          const on = isSelected(e)
          return (
            <div
              key={e.key}
              className={`flex items-center gap-3 rounded-2xl border bg-neutral-900 px-4 py-3.5 transition ${
                on ? 'border-indigo-500' : 'border-neutral-800 hover:border-neutral-700'
              }`}
            >
              <button
                onClick={() => {
                  if (selecting) toggleEntry(e)
                  else if (e.kind === 'folder') onNavigate([...cwd, e.name])
                  else setSheet({ kind: 'file', item: e.item })
                }}
                className="flex min-w-0 flex-1 items-center gap-4 text-left"
              >
                <span className={`shrink-0 ${e.kind === 'folder' ? 'text-blue-400' : 'text-neutral-500'}`}>
                  {e.kind === 'folder' ? <FolderIcon size={28} /> : <FileIcon size={28} />}
                </span>
                <span className="min-w-0 flex-1 truncate text-base">{e.name}</span>
                <span className="shrink-0 text-sm text-neutral-500">
                  {e.kind === 'folder' ? `${e.fileIds.length} ไฟล์` : formatSize(e.item.size_bytes)}
                </span>
              </button>
              <button
                onClick={() => toggleEntry(e)}
                role="checkbox"
                aria-checked={on}
                aria-label={`เลือก ${e.name}`}
                className={`grid size-7 shrink-0 place-items-center rounded-full border-2 transition ${
                  on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-neutral-600 text-transparent hover:border-neutral-400'
                }`}
              >
                <CheckIcon size={16} />
              </button>
            </div>
          )
        })}

        {files && entries.length === 0 && (
          <p className="px-1 py-6 text-sm leading-relaxed text-neutral-500">
            {files.length === 0
              ? 'ยังไม่มีไฟล์ — agent ที่เปิดสิทธิ์ "สร้าง/แก้ไฟล์ได้" จะบันทึกไฟล์ที่ทำเสร็จไว้ที่นี่ กดปุ่ม + เพื่อสร้างไฟล์เอง หรืออัปโหลด zip เพื่อนำเข้าทั้งโปรเจกต์'
              : 'โฟลเดอร์นี้ว่าง'}
          </p>
        )}
        {!files && !error && <p className="px-1 text-sm text-neutral-500">กำลังโหลด...</p>}
      </div>

      {/* ปุ่ม + ลอย: สร้างไฟล์ใหม่ / อัปโหลด zip */}
      {!selecting && !sheet && (
        <>
          {menuOpen && <button aria-label="ปิดเมนู" onClick={() => setMenuOpen(false)} className="fixed inset-0 z-30 cursor-default" />}
          <div className="fixed right-5 z-40 flex flex-col items-end gap-2" style={{ bottom: 'calc(1.5rem + env(safe-area-inset-bottom))' }}>
            {menuOpen && (
              <div className="w-52 overflow-hidden rounded-xl border border-neutral-700 bg-neutral-800 shadow-xl">
                <button
                  onClick={() => { setMenuOpen(false); onNew() }}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-neutral-100 transition hover:bg-neutral-700/50"
                >
                  <PlusIcon size={18} />
                  ไฟล์ใหม่
                </button>
                <label className="flex w-full cursor-pointer items-center gap-3 border-t border-neutral-700 px-4 py-3 text-sm text-neutral-100 transition focus-within:bg-neutral-700/50 hover:bg-neutral-700/50">
                  <UploadIcon size={18} />
                  อัปโหลด zip
                  <input
                    type="file"
                    accept=".zip,application/zip,application/x-zip-compressed"
                    className="sr-only"
                    onChange={(ev: ChangeEvent<HTMLInputElement>) => {
                      const picked = ev.target.files?.[0]
                      ev.target.value = '' // เลือกไฟล์เดิมซ้ำได้อีก
                      setMenuOpen(false)
                      if (picked) onImport(picked)
                    }}
                  />
                </label>
              </div>
            )}
            <button
              onClick={() => setMenuOpen((o) => !o)}
              aria-label="เพิ่มไฟล์"
              aria-expanded={menuOpen}
              className={`grid size-14 place-items-center rounded-full bg-blue-600 text-white shadow-lg transition hover:bg-blue-500 ${menuOpen ? 'rotate-45' : ''}`}
            >
              <PlusIcon size={28} />
            </button>
          </div>
        </>
      )}

      {sheet?.kind === 'file' && (
        <FileSheet
          projectId={projectId}
          item={sheet.item}
          onClose={() => setSheet(null)}
          onOpen={onOpen}
          onChanged={load}
        />
      )}
      {sheet?.kind === 'history' && (
        <Sheet title="แก้ไขล่าสุด" onClose={() => setSheet(null)}>
          {recent.length === 0 ? (
            <p className="py-4 text-sm text-neutral-400">ยังไม่มีไฟล์</p>
          ) : (
            <ul>
              {recent.map((f) => (
                <li key={f.id}>
                  <button
                    onClick={() => { setSheet(null); onOpen(f.id) }}
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-3 text-left transition hover:bg-neutral-700/50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-base text-neutral-100">{baseName(f.path)}</span>
                      {dirName(f.path) && <span className="block truncate text-xs text-neutral-500">{dirName(f.path)}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">{formatTime(f.updated_at)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Sheet>
      )}
    </section>
  )
}

function NewFile({
  projectId,
  initialPath,
  onCancel,
  onSaved,
}: {
  projectId: string
  /** ขึ้นต้น path ด้วยโฟลเดอร์ที่ผู้ใช้เปิดอยู่ */
  initialPath: string
  onCancel: () => void
  onSaved: (id: string) => void
}) {
  const [path, setPath] = useState(initialPath)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    const res = await fetch(`/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content }),
    })
    setBusy(false)
    if (!res.ok) {
      setError(await readError(res, 'บันทึกไม่สำเร็จ'))
      return
    }
    onSaved(((await res.json()) as { file: { id: string } }).file.id)
  }

  return (
    <section>
      <button onClick={onCancel} className={`${ghostBtn} mb-3`}>
        <BackIcon />
        กลับ
      </button>
      <form onSubmit={submit} className="space-y-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <div>
          <label className={labelCls}>Path ของไฟล์</label>
          <input
            required
            maxLength={500}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="เช่น src/app.ts หรือ docs/notes.md"
            className={`${inputCls} font-mono`}
          />
        </div>
        <div>
          <label className={labelCls}>เนื้อหา</label>
          <textarea
            rows={14}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
            className={`${inputCls} font-mono text-xs`}
          />
        </div>
        <p className="text-xs text-neutral-500">ถ้า path นี้มีอยู่แล้ว จะบันทึกเป็นเวอร์ชันใหม่ของไฟล์เดิม</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button type="submit" disabled={busy} className={primaryBtn}>
          {busy ? 'กำลังบันทึก...' : 'บันทึก'}
        </button>
      </form>
    </section>
  )
}

function FileViewer({
  projectId,
  fileId,
  onBack,
}: {
  projectId: string
  fileId: string
  onBack: () => void
}) {
  const [detail, setDetail] = useState<FileDetail | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  const load = useCallback(
    async (versionId?: string) => {
      const qs = versionId ? `?version=${encodeURIComponent(versionId)}` : ''
      const res = await fetch(`/api/projects/${projectId}/files/${fileId}${qs}`)
      if (!res.ok) {
        setError(await readError(res, 'โหลดไฟล์ไม่สำเร็จ'))
        return
      }
      setError('')
      setDetail((await res.json()) as FileDetail)
    },
    [projectId, fileId]
  )

  useEffect(() => {
    void load()
  }, [load])

  if (!detail) {
    return (
      <section>
        <button onClick={onBack} className={`${ghostBtn} mb-3`}>
          <BackIcon />
          กลับ
        </button>
        {error ? <p className="text-sm text-red-400">{error}</p> : <p className="text-sm text-neutral-500">กำลังโหลด...</p>}
      </section>
    )
  }

  const isCurrent = detail.version_id === detail.file.current_version_id
  const fileName = detail.file.path.split('/').pop() || 'file.txt'

  async function save(content: string) {
    if (!detail || busy) return
    setBusy(true)
    setError('')
    const res = await fetch(`/api/projects/${projectId}/files`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: detail.file.path, content }),
    })
    setBusy(false)
    if (!res.ok) {
      setError(await readError(res, 'บันทึกไม่สำเร็จ'))
      return
    }
    setEditing(false)
    await load()
  }

  async function remove() {
    if (!window.confirm(`ลบไฟล์ "${detail?.file.path}" ?`)) return
    const res = await fetch(`/api/projects/${projectId}/files/${fileId}`, { method: 'DELETE' })
    if (!res.ok) {
      setError(await readError(res, 'ลบไม่สำเร็จ'))
      return
    }
    onBack()
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(detail?.content ?? '')
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setError('คัดลอกไม่สำเร็จ — เบราว์เซอร์ไม่อนุญาต')
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([detail?.content ?? ''], { type: 'text/plain;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <button onClick={onBack} className={ghostBtn}>
          <BackIcon />
          กลับ
        </button>
        <button onClick={remove} aria-label="ลบไฟล์" className="rounded-md p-1.5 text-neutral-500 transition hover:bg-neutral-800 hover:text-red-400">
          <TrashIcon />
        </button>
      </div>

      <div>
        <h2 className="break-all font-mono text-sm">{detail.file.path}</h2>
        {!isCurrent && (
          <p className="mt-1 text-xs text-amber-400">
            กำลังดูเวอร์ชันเก่า —{' '}
            <button onClick={() => load()} className="underline">
              กลับไปเวอร์ชันปัจจุบัน
            </button>
          </p>
        )}
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            rows={18}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className={`${inputCls} font-mono text-xs`}
          />
          <div className="flex gap-2">
            <button onClick={() => save(draft)} disabled={busy} className={primaryBtn}>
              {busy ? 'กำลังบันทึก...' : 'บันทึกเป็นเวอร์ชันใหม่'}
            </button>
            <button onClick={() => setEditing(false)} disabled={busy} className={ghostBtn}>
              ยกเลิก
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <button onClick={copy} className={ghostBtn}>
              <CopyIcon />
              {copied ? 'คัดลอกแล้ว' : 'คัดลอก'}
            </button>
            <button onClick={download} className={ghostBtn}>
              <DownloadIcon />
              ดาวน์โหลด
            </button>
            {isCurrent ? (
              <button
                onClick={() => {
                  setDraft(detail.content)
                  setEditing(true)
                }}
                className={ghostBtn}
              >
                <EditIcon />
                แก้ไข
              </button>
            ) : (
              <button onClick={() => save(detail.content)} disabled={busy} className={ghostBtn}>
                กู้คืนเวอร์ชันนี้
              </button>
            )}
          </div>
          <pre className="max-h-[60vh] overflow-auto rounded-md border border-neutral-800 bg-neutral-950 p-3 text-xs leading-relaxed">
            {detail.content || <span className="text-neutral-600">(ไฟล์ว่าง)</span>}
          </pre>
        </>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      <details className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-sm">
        <summary className="cursor-pointer text-neutral-300">ประวัติเวอร์ชัน ({detail.versions.length})</summary>
        <div className="mt-2 space-y-1">
          {detail.versions.map((v, i) => (
            <button
              key={v.id}
              onClick={() => (i === 0 ? load() : load(v.id))}
              className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition hover:bg-neutral-800 ${
                v.id === detail.version_id ? 'bg-neutral-800' : ''
              }`}
            >
              <span>{formatTime(v.created_at)}</span>
              <span className="text-neutral-500">
                {v.author}
                {i === 0 ? ' · ปัจจุบัน' : ''}
              </span>
            </button>
          ))}
        </div>
      </details>
    </section>
  )
}
