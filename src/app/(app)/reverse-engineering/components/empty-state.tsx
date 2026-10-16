import type { ReactNode } from 'react'
import { InfoIcon } from './icons'

/**
 * สถานะ "ยังไม่พร้อม/ยังไม่มีข้อมูล" — ใช้แทนข้อมูลตัวอย่างเสมอ
 * (ห้ามสร้างข้อมูลที่ดูเหมือนผลวิเคราะห์จริงเมื่อยังไม่มีเครื่องมือสร้างข้อมูลนั้น)
 */
export default function EmptyState({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-neutral-800 bg-neutral-900/40 p-5">
      <div className="flex items-center gap-2 text-neutral-300">
        <InfoIcon size={16} />
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      {children && <div className="text-sm leading-relaxed text-neutral-500">{children}</div>}
    </div>
  )
}
