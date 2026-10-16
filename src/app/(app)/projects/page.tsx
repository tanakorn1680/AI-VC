import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import NewProjectForm from './new-project-form'

export default async function ProjectsPage() {
  const supabase = await createClient()
  interface ProjectListRow {
    id: string; name: string; spent_usd: number; budget_usd: number | null; created_at: string
  }
  const { data: projects } = await supabase
    .from<ProjectListRow>('projects')
    .select('id, name, spent_usd, budget_usd, created_at')
    .order('created_at', { ascending: false })

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Workspace ของคุณ</h1>
        <Link
          href="/reverse-engineering"
          className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 transition hover:border-indigo-600 hover:text-neutral-100"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M4 12h16" />
          </svg>
          Reverse Engineering
        </Link>
      </div>

      <NewProjectForm />

      <div className="mt-8 space-y-2">
        {(projects ?? []).map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            className="block rounded-lg border border-neutral-800 bg-neutral-900 p-4 transition hover:border-indigo-600"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{p.name}</span>
              <span className="text-sm text-neutral-400">
                ${p.spent_usd.toFixed(2)}{p.budget_usd ? ` / $${p.budget_usd}` : ''}
              </span>
            </div>
          </Link>
        ))}
        {(projects ?? []).length === 0 && (
          <p className="text-sm text-neutral-500">ยังไม่มี Project — สร้างใหม่ด้านบน</p>
        )}
      </div>
    </div>
  )
}
