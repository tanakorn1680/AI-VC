'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sheet, SheetItem } from '@/components/sheet'
import { formatDateTime } from '@/lib/analysis/format'
import { ARTIFACT_KIND_LABELS, type AnalysisArtifact } from '@/lib/analysis/types'
import { BracesIcon, CheckIcon, DownloadIcon, FileIcon, OpenIcon, ToolIcon, TrashIcon } from '../components/icons'

export interface ToolOption {
  id: string
  name: string
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const ghostBtn =
  'inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800 disabled:opacity-50'

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    return ((await res.json()) as { error?: string }).error ?? fallback
  } catch {
    return fallback
  }
}

interface DeleteResult {
  deleted: number
  skipped: { id: string; reason: string }[]
}

export default function ArtifactList({
  sessionId,
  artifacts,
  toolsByArtifact,
}: {
  sessionId: string
  artifacts: AnalysisArtifact[]
  /** เครื่องมือที่พร้อมใช้งานจริงและรองรับชนิดไฟล์ของแต่ละ artifact (ตรวจที่ฝั่งเซิร์ฟเวอร์) */
  toolsByArtifact: Record<string, ToolOption[]>
}) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sheet, setSheet] = useState<AnalysisArtifact | null>(null)
  const [busy, setBusy] = useState('')
  const [sheetError, setSheetError] = useState('')
  const [notice, setNotice] = useState('')

  const selecting = selected.size > 0
  const nameOf = (id: string) => artifacts.find((a) => a.id === id)?.name ?? ''

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function closeSheet() {
    setSheet(null)
    setSheetError('')
  }

  async function postDelete(ids: string[]): Promise<DeleteResult | null> {
    const res = await fetch(`/api/analysis/${sessionId}/artifacts/delete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_ids: ids }),
    })
    if (!res.ok) throw new Error(await readError(res, 'ลบไม่สำเร็จ'))
    return (await res.json()) as DeleteResult
  }

  async function deleteSelected() {
    if (busy || selected.size === 0) return
    if (!window.confirm(`ลบ ${selected.size} รายการที่เลือก?`)) return
    setBusy('delete')
    setNotice('')
    try {
      const r = await postDelete([...selected])
      if (r && r.skipped.length > 0) {
        setNotice(`ลบแล้ว ${r.deleted} รายการ · ข้าม ${r.skipped.length} รายการ: ${r.skipped.map((s) => `${nameOf(s.id) || 'ไม่ทราบชื่อ'} (${s.reason})`).join(' / ')}`)
      }
      setSelected(new Set())
      router.refresh()
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function deleteOne(a: AnalysisArtifact) {
    if (busy) return
    if (!window.confirm(`ลบ "${a.name}" ?`)) return
    setBusy('delete')
    setSheetError('')
    try {
      const r = await postDelete([a.id])
      if (r && r.deleted === 0) {
        setSheetError(r.skipped[0]?.reason ?? 'ลบไม่ได้')
        return
      }
      closeSheet()
      router.refresh()
    } catch (e) {
      setSheetError((e as Error).message)
    } finally {
      setBusy('')
    }
  }

  async function runTool(a: AnalysisArtifact, tool: ToolOption) {
    if (busy) return
    setBusy(`run:${tool.id}`)
    setSheetError('')
    try {
      const res = await fetch(`/api/analysis/${sessionId}/tools/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool_id: tool.id, artifact_id: a.id }),
      })
      if (!res.ok) {
        setSheetError(await readError(res, 'รันเครื่องมือไม่สำเร็จ'))
        router.refresh() // ประวัติ run ที่ล้มเหลวถูกบันทึกแล้ว
        return
      }
      closeSheet()
      router.refresh()
    } catch {
      setSheetError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง')
    } finally {
      setBusy('')
    }
  }

  async function downloadOutput(a: AnalysisArtifact) {
    if (busy) return
    setBusy('download')
    setSheetError('')
    try {
      const res = await fetch(`/api/analysis/${sessionId}/artifacts/${a.id}/content`)
      if (!res.ok) {
        setSheetError(await readError(res, 'ดาวน์โหลดไม่สำเร็จ'))
        return
      }
      const url = URL.createObjectURL(await res.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = a.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      closeSheet()
    } catch {
      setSheetError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่อีกครั้ง')
    } finally {
      setBusy('')
    }
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === artifacts.length ? new Set() : new Set(artifacts.map((a) => a.id))))
  }

  return (
    <section className="pb-24">
      <div className="mb-4 flex min-h-10 items-center justify-between gap-3 border-b border-neutral-800 pb-3">
        {selecting ? (
          <>
            <span className="text-sm font-medium text-neutral-200">เลือกแล้ว {selected.size} รายการ</span>
            <div className="flex items-center gap-2">
              <button onClick={toggleAll} className={ghostBtn}>เลือกทั้งหมด</button>
              <button
                onClick={deleteSelected}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium hover:bg-red-500 disabled:opacity-50"
              >
                <TrashIcon size={14} />
                {busy === 'delete' ? 'กำลังลบ...' : `ลบ (${selected.size})`}
              </button>
              <button onClick={() => setSelected(new Set())} className={ghostBtn}>ยกเลิก</button>
            </div>
          </>
        ) : (
          <span className="text-sm text-neutral-400">{artifacts.length} รายการ</span>
        )}
      </div>

      {notice && (
        <p role="status" className="mb-3 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs leading-relaxed text-amber-300">
          {notice}
        </p>
      )}

      <div className="space-y-2.5">
        {artifacts.map((a) => {
          const on = selected.has(a.id)
          const isOutput = a.kind === 'tool_output'
          return (
            <div
              key={a.id}
              className={`flex items-center gap-3 rounded-2xl border bg-neutral-900 px-4 py-3.5 transition ${
                on ? 'border-indigo-500' : 'border-neutral-800 hover:border-neutral-700'
              }`}
            >
              <button
                onClick={() => (selecting ? toggle(a.id) : setSheet(a))}
                className="flex min-w-0 flex-1 items-center gap-4 text-left"
              >
                <span className={`shrink-0 ${isOutput ? 'text-indigo-400' : 'text-neutral-500'}`}>
                  {isOutput ? <BracesIcon size={28} /> : <FileIcon size={28} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base">{a.name}</span>
                  <span className="block truncate text-xs text-neutral-500">
                    {isOutput ? ARTIFACT_KIND_LABELS.tool_output : (a.metadata.detected_label ?? ARTIFACT_KIND_LABELS[a.kind])}
                  </span>
                </span>
                <span className="shrink-0 text-sm text-neutral-500">{formatBytes(a.size_bytes)}</span>
              </button>
              <button
                onClick={() => toggle(a.id)}
                role="checkbox"
                aria-checked={on}
                aria-label={`เลือก ${a.name}`}
                className={`grid size-7 shrink-0 place-items-center rounded-full border-2 transition ${
                  on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-neutral-600 text-transparent hover:border-neutral-400'
                }`}
              >
                <CheckIcon size={16} />
              </button>
            </div>
          )
        })}
      </div>

      {sheet && (
        <Sheet title={sheet.name} onClose={closeSheet}>
          <dl className="mb-2 space-y-1 border-b border-neutral-700 pb-3 text-xs text-neutral-400">
            <div>{ARTIFACT_KIND_LABELS[sheet.kind]}{sheet.metadata.detected_label ? ` · ${sheet.metadata.detected_label}` : ''} · {formatBytes(sheet.size_bytes)}</div>
            <div>เพิ่มเมื่อ {formatDateTime(sheet.created_at)}</div>
            <div className="break-all font-mono text-[11px] text-neutral-500">SHA-256 {sheet.sha256}</div>
          </dl>

          {sheet.kind === 'tool_output' && (
            <>
              <SheetItem
                icon={<OpenIcon size={22} />}
                label="ดูผลลัพธ์ (JSON)"
                onClick={() => window.open(`/api/analysis/${sessionId}/artifacts/${sheet.id}/content`, '_blank', 'noopener,noreferrer')}
              />
              <SheetItem
                icon={<DownloadIcon size={22} />}
                label={busy === 'download' ? 'กำลังดาวน์โหลด...' : 'Download'}
                onClick={() => downloadOutput(sheet)}
                disabled={!!busy}
              />
            </>
          )}

          {sheet.kind === 'source' &&
            ((toolsByArtifact[sheet.id] ?? []).length > 0 ? (
              (toolsByArtifact[sheet.id] ?? []).map((t) => (
                <SheetItem
                  key={t.id}
                  icon={<ToolIcon size={22} />}
                  label={busy === `run:${t.id}` ? `กำลังรัน ${t.name}...` : `วิเคราะห์ด้วย ${t.name}`}
                  onClick={() => runTool(sheet, t)}
                  disabled={!!busy}
                />
              ))
            ) : (
              <p className="py-3 text-sm text-neutral-500">ยังไม่มีเครื่องมือที่พร้อมและรองรับไฟล์ชนิดนี้</p>
            ))}

          <div className="my-1 border-t border-neutral-700" />
          <SheetItem
            icon={<TrashIcon size={22} />}
            label={busy === 'delete' ? 'กำลังลบ...' : 'Delete'}
            onClick={() => deleteOne(sheet)}
            danger
            disabled={!!busy}
          />
          {sheetError && <p role="alert" className="mt-2 text-sm text-red-400">{sheetError}</p>}
        </Sheet>
      )}
    </section>
  )
}
