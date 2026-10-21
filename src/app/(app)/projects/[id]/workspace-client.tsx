'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import AgentsPanel, { type Agent } from './agents-panel'
import MemoryPanel from './memory-panel'
import TeamBanner, { type TeamInfo } from './team-banner'
import FilesPanel from './files-panel'
import UsagePanel from './usage-panel'
import ChatView, { type Message } from './chat-view'
import NavDrawer, { type NavItem } from './nav-drawer'
import { AgentsIcon, ChatIcon, FilesIcon, MemoryIcon, MenuIcon, TasksIcon, UsageIcon } from './icons'

type Tab = 'chat' | 'agents' | 'tasks' | 'files' | 'memory' | 'usage'

interface TaskRow {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  error: string | null
  created_at: string
}

// polling แทน Realtime ตามหลักการของสเปค (ข้อ 2: ถ้าไม่จำเป็นต้องใช้ Realtime ให้ใช้ Polling)
const POLL_MS = 3000

const STATUS_COLOR: Record<TaskRow['status'], string> = {
  pending: 'text-neutral-400',
  running: 'text-indigo-400',
  completed: 'text-emerald-400',
  failed: 'text-red-400',
  cancelled: 'text-neutral-600',
}

const TAB_LABEL: Record<Tab, string> = {
  chat: 'แชท',
  agents: 'Agents',
  tasks: 'Tasks',
  files: 'ไฟล์',
  memory: 'ความจำ',
  usage: 'การใช้งาน',
}

function sameMessages(a: Message[], b: Message[]): boolean {
  return (
    a.length === b.length &&
    a.every((m, i) => {
      const o = b[i]
      // plan_status ต้องนับด้วย: กด "ไม่เอาแผนนี้" แล้วมีแค่สถานะที่เปลี่ยน ไม่มีข้อความใหม่
      return !!o && m.id === o.id && m.content.length === o.content.length && (m.plan_status ?? null) === (o.plan_status ?? null)
    })
  )
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export default function WorkspaceClient({
  projectId,
  projectName,
}: {
  projectId: string
  projectName: string
}) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('chat')
  const [menuOpen, setMenuOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [teamInfo, setTeamInfo] = useState<TeamInfo | null>(null)
  const [agentsLoaded, setAgentsLoaded] = useState(false)
  const [draft, setDraft] = useState('') // เก็บไว้ที่นี่ เพื่อไม่หายเวลาสลับแท็บ

  const refresh = useCallback(async () => {
    try {
      const [msgRes, taskRes, agentRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/messages`),
        fetch(`/api/projects/${projectId}/tasks`),
        fetch(`/api/projects/${projectId}/team`),
      ])
      // อัปเดต state เฉพาะเมื่อข้อมูลเปลี่ยนจริง เพื่อไม่ให้หน้า render ซ้ำทุก 3 วินาที
      if (msgRes.ok) {
        const next: Message[] = (await msgRes.json()).messages ?? []
        setMessages((prev) => (sameMessages(prev, next) ? prev : next))
      }
      if (taskRes.ok) {
        const next: TaskRow[] = (await taskRes.json()).tasks ?? []
        setTasks((prev) => (sameJson(prev, next) ? prev : next))
      }
      if (agentRes.ok) {
        // ทีมกลาง: AI เป็นของทีม (ใช้ร่วมกันทุกโปรเจกต์) — endpoint นี้คืนทีมของโปรเจกต์ + AI + สถานะล็อก 1 โปรเจกต์ต่อทีม
        const data = (await agentRes.json()) as TeamInfo & { agents?: Agent[] }
        const next: Agent[] = data.agents ?? []
        setAgents((prev) => (sameJson(prev, next) ? prev : next))
        const info: TeamInfo = { team: data.team, teams: data.teams, lock: data.lock, held_by_other: data.held_by_other }
        setTeamInfo((prev) => (sameJson(prev, info) ? prev : info))
        setAgentsLoaded(true)
      }
    } catch {
      // เครือข่ายหลุดชั่วคราว — รอรอบถัดไป
    }
  }, [projectId])

  // polling เฉพาะตอนที่หน้าจออยู่หน้าสุด (ประหยัดแบต/เน็ตบนมือถือ) และดึงใหม่ทันทีเมื่อกลับมา
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      if (timer !== null) return
      void refresh()
      timer = setInterval(() => void refresh(), POLL_MS)
    }
    const stop = () => {
      if (timer === null) return
      clearInterval(timer)
      timer = null
    }
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop())
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  // กันหน้าเว็บ "ดึงลงเพื่อรีเฟรช" ตอนลากแถบบน (มีผลเฉพาะหน้านี้)
  useEffect(() => {
    const el = document.documentElement
    const prev = el.style.overscrollBehaviorY
    el.style.overscrollBehaviorY = 'none'
    return () => {
      el.style.overscrollBehaviorY = prev
    }
  }, [])

  const running = tasks.filter((t) => t.status === 'running').length
  const pending = tasks.filter((t) => t.status === 'pending').length
  const activeCount = running + pending
  const hasAgents = agentsLoaded ? agents.length > 0 : null

  const navItems: NavItem[] = useMemo(
    () => [
      { id: 'chat', label: TAB_LABEL.chat, icon: <ChatIcon /> },
      { id: 'agents', label: TAB_LABEL.agents, icon: <AgentsIcon /> },
      { id: 'tasks', label: TAB_LABEL.tasks, icon: <TasksIcon />, badge: activeCount || undefined },
      { id: 'files', label: TAB_LABEL.files, icon: <FilesIcon /> },
      { id: 'memory', label: TAB_LABEL.memory, icon: <MemoryIcon /> },
      { id: 'usage', label: TAB_LABEL.usage, icon: <UsageIcon /> },
    ],
    [activeCount],
  )

  const lock = teamInfo?.lock ?? null

  const closeMenu = useCallback(() => setMenuOpen(false), [])

  function selectTab(id: string) {
    setTab(id as Tab)
    setMenuOpen(false)
  }

  async function handleSignOut() {
    await createClient().auth.signOut()
    router.replace('/login')
    router.refresh()
  }

  async function handleRetry(taskId: string) {
    await fetch(`/api/tasks/${taskId}/retry`, { method: 'POST' })
    void refresh()
  }

  async function handleCancel(taskId: string) {
    await fetch(`/api/tasks/${taskId}/cancel`, { method: 'POST' })
    void refresh()
  }

  return (
    // fixed inset-0 = กรอบเท่าหน้าจอที่เห็นจริงพอดี แถบบนจึงไม่เลื่อนหนีไปไหน
    <div className="fixed inset-0 flex flex-col bg-neutral-950 text-neutral-100">
      <header
        className="shrink-0 border-b border-neutral-800 bg-neutral-950"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-4">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-semibold leading-5">{projectName}</h1>
            <p className="truncate text-xs leading-4 text-neutral-500">
              {TAB_LABEL[tab]}
              {teamInfo ? ` · ทีม ${teamInfo.team.name}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-label="เปิดเมนู"
            aria-expanded={menuOpen}
            className="relative -mr-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-neutral-300 active:bg-neutral-800"
          >
            <MenuIcon />
            {activeCount > 0 && (
              <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-indigo-500" />
            )}
          </button>
        </div>
      </header>

      {tab === 'chat' && teamInfo && lock?.state === 'elsewhere' && (
        <div className="shrink-0 border-b border-amber-900/50 bg-amber-950/30 px-4 py-2 text-xs leading-relaxed text-amber-200">
          <div className="mx-auto w-full max-w-3xl">
            ทีม &quot;{teamInfo.team.name}&quot; ประจำโปรเจกต์ &quot;{lock.project_name}&quot; อยู่
            {lock.busy
              ? ' และยังมีงานค้าง — ส่งข้อความที่นี่ไม่ได้จนกว่างานนั้นจะเสร็จ (หรือเลือกทีมอื่นที่แท็บ Agents)'
              : ' — ส่งข้อความเพื่อย้ายทีมมาทำโปรเจกต์นี้'}
          </div>
        </div>
      )}

      {tab === 'chat' ? (
        <ChatView
          projectId={projectId}
          messages={messages}
          running={running}
          pending={pending}
          hasAgents={hasAgents}
          draft={draft}
          onDraftChange={setDraft}
          onSent={() => void refresh()}
          onOpenAgents={() => setTab('agents')}
          onOpenTasks={() => setTab('tasks')}
        />
      ) : (
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div
            className="mx-auto w-full max-w-3xl p-4"
            style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
          >
            {tab === 'agents' && teamInfo && (
              <div className="space-y-4">
                <TeamBanner projectId={projectId} info={teamInfo} onChanged={refresh} />
                <AgentsPanel apiBase={`/api/teams/${teamInfo.team.id}`} agents={agents} onChanged={refresh} />
              </div>
            )}
            {tab === 'agents' && !teamInfo && <p className="text-sm text-neutral-500">กำลังโหลดทีม...</p>}

            {tab === 'tasks' && (
              <div className="space-y-2">
                {tasks.map((t) => (
                  <div key={t.id} className="rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{t.title}</span>
                      <span className={`shrink-0 ${STATUS_COLOR[t.status]}`}>{t.status}</span>
                    </div>
                    {t.error && (
                      <p
                        className={`mt-1 whitespace-pre-wrap break-words text-xs ${
                          t.status === 'pending' || t.status === 'running' ? 'text-amber-400' : 'text-red-400'
                        }`}
                      >
                        {t.error}
                      </p>
                    )}
                    <div className="mt-2 flex gap-2">
                      {(t.status === 'failed' || t.status === 'cancelled') && (
                        <button
                          onClick={() => handleRetry(t.id)}
                          className="py-1 text-xs text-indigo-400 hover:underline"
                        >
                          ลองใหม่
                        </button>
                      )}
                      {(t.status === 'pending' || t.status === 'running') && (
                        <button
                          onClick={() => handleCancel(t.id)}
                          className="py-1 text-xs text-neutral-500 hover:underline"
                        >
                          ยกเลิก
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {tasks.length === 0 && <p className="text-sm text-neutral-500">ยังไม่มี Task</p>}
              </div>
            )}

            {tab === 'files' && <FilesPanel projectId={projectId} />}

            {tab === 'memory' && <MemoryPanel projectId={projectId} />}

            {tab === 'usage' && <UsagePanel projectId={projectId} />}
          </div>
        </main>
      )}

      <NavDrawer
        open={menuOpen}
        onClose={closeMenu}
        items={navItems}
        activeId={tab}
        onSelect={selectTab}
        projectName={projectName}
        onSignOut={handleSignOut}
      />
    </div>
  )
}
