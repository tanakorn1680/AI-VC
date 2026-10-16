import Link from 'next/link'
import { ArrowLeftIcon } from '../components/icons'
import NewSessionForm from './new-session-form'

export default function NewAnalysisPage() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <Link
        href="/reverse-engineering"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-neutral-400 transition hover:text-neutral-200"
      >
        <ArrowLeftIcon size={16} />
        งานวิเคราะห์
      </Link>

      <p className="mb-1 text-xs font-medium uppercase tracking-wider text-indigo-400">
        เริ่มงานวิเคราะห์ใหม่
      </p>
      <h1 className="text-2xl font-semibold">คุณต้องการทำความเข้าใจโปรแกรมอะไร?</h1>
      <p className="mb-8 mt-1 text-sm text-neutral-400">
        ระบุชื่อและเป้าหมายของงาน เพื่อใช้เป็นกรอบในการวางแผนการตรวจสอบ
      </p>

      <NewSessionForm />
    </div>
  )
}
