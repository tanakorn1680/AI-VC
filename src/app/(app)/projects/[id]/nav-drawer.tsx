'use client'

import { useEffect, useRef, type ReactNode, type TouchEvent } from 'react'
import Link from 'next/link'
import { AgentsIcon, CloseIcon, FolderIcon, LogoutIcon } from './icons'

export interface NavItem {
  id: string
  label: string
  icon: ReactNode
  /** ตัวเลขเล็ก ๆ ท้ายรายการ (เช่น จำนวนงานที่กำลังทำ) */
  badge?: number
}

export default function NavDrawer({
  open,
  onClose,
  items,
  activeId,
  onSelect,
  projectName,
  onSignOut,
}: {
  open: boolean
  onClose: () => void
  items: NavItem[]
  activeId: string
  onSelect: (id: string) => void
  projectName: string
  onSignOut: () => void
}) {
  const touchStart = useRef<{ x: number; y: number } | null>(null)

  // กด Esc เพื่อปิด (เวลาใช้บนคอมพิวเตอร์)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // ปัดไปทางขวาเพื่อปิด
  function handleTouchStart(e: TouchEvent) {
    const t = e.touches[0]
    if (!t) return
    touchStart.current = { x: t.clientX, y: t.clientY }
  }
  function handleTouchEnd(e: TouchEvent) {
    const start = touchStart.current
    touchStart.current = null
    if (!start) return
    const t = e.changedTouches[0]
    if (!t) return
    const dx = t.clientX - start.x
    const dy = Math.abs(t.clientY - start.y)
    if (dx > 60 && dy < 48) onClose()
  }

  return (
    <div className={`fixed inset-0 z-50 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
      />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="เมนูนำทาง"
        inert={!open}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className={`absolute right-0 top-0 flex h-full w-72 max-w-[85%] flex-col border-l border-neutral-800 bg-neutral-950 shadow-2xl transition-transform duration-200 ease-out ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-neutral-800 pl-5 pr-3">
          <div className="min-w-0">
            <p className="text-xs text-neutral-500">Workspace</p>
            <p className="truncate text-sm font-semibold text-neutral-100">{projectName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="ปิดเมนู"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-300 active:bg-neutral-800"
          >
            <CloseIcon />
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
          <ul className="space-y-1">
            {items.map((item) => {
              const active = item.id === activeId
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.id)}
                    aria-current={active ? 'page' : undefined}
                    className={`flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] transition-colors ${
                      active
                        ? 'bg-neutral-800 font-medium text-white'
                        : 'text-neutral-400 active:bg-neutral-900 hover:bg-neutral-900 hover:text-neutral-200'
                    }`}
                  >
                    <span className={active ? 'text-indigo-400' : ''}>{item.icon}</span>
                    <span className="flex-1">{item.label}</span>
                    {item.badge ? (
                      <span className="rounded-full bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white">
                        {item.badge}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="shrink-0 space-y-1 border-t border-neutral-800 px-3 py-3">
          <Link
            href="/projects"
            className="flex min-h-12 items-center gap-3 rounded-lg px-3 text-[15px] text-neutral-400 active:bg-neutral-900 hover:bg-neutral-900 hover:text-neutral-200"
          >
            <FolderIcon />
            <span>โปรเจกต์ทั้งหมด</span>
          </Link>
          <Link
            href="/team"
            className="flex min-h-12 items-center gap-3 rounded-lg px-3 text-[15px] text-neutral-400 active:bg-neutral-900 hover:bg-neutral-900 hover:text-neutral-200"
          >
            <AgentsIcon />
            <span>ทีม AI ทั้งหมด</span>
          </Link>
          <button
            type="button"
            onClick={onSignOut}
            className="flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-[15px] text-neutral-400 active:bg-neutral-900 hover:bg-neutral-900 hover:text-neutral-200"
          >
            <LogoutIcon />
            <span>ออกจากระบบ</span>
          </button>
        </div>
      </aside>
    </div>
  )
}
