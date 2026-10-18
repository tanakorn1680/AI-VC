'use client'

import { useEffect, type ReactNode } from 'react'

/** แผงด้านล่างแบบเดียวกับแอปมือถือ: แตะฉากหลังหรือกด Esc เพื่อปิด */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
    }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <button aria-label="ปิด" onClick={onClose} className="absolute inset-0 cursor-default bg-black/60" />
      <div
        className="absolute inset-x-0 bottom-0 mx-auto max-h-[85vh] max-w-3xl overflow-y-auto rounded-t-2xl bg-neutral-800 px-5 pt-3 shadow-2xl"
        style={{ paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' }}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-neutral-600" />
        <h3 className="mb-2 break-all text-xl font-semibold">{title}</h3>
        {children}
      </div>
    </div>
  )
}

export function SheetItem({
  icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-4 rounded-lg px-1 py-3.5 text-left text-base transition hover:bg-neutral-700/50 disabled:opacity-50 ${
        danger ? 'text-red-400' : 'text-neutral-100'
      }`}
    >
      <span className={danger ? 'text-red-400' : 'text-neutral-400'}>{icon}</span>
      {label}
    </button>
  )
}
