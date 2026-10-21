import Link from 'next/link'
import TeamManager from './team-manager'

/**
 * ทีม AI ของคุณ — AI เป็นของ "ทีม" ใช้ร่วมกันได้ทุกโปรเจกต์ ทีมหนึ่งประจำได้ทีละ 1 โปรเจกต์
 * (อยากทำหลายโปรเจกต์พร้อมกัน → สร้างหลายทีม)
 */
export default function TeamPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">ทีม AI</h1>
        <Link
          href="/projects"
          className="inline-flex items-center rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition hover:border-indigo-600 hover:text-neutral-100"
        >
          โปรเจกต์ทั้งหมด
        </Link>
      </div>
      <TeamManager />
    </div>
  )
}
