import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import { createAdminClient } from '@/lib/supabase/admin'
import { STALE_RUN_MS } from './limits'
import { resolveReadyTool, supportsKind } from './tool-registry'
import { withTimeout, type DetectedKind } from './tool-adapter'
import { buildObjectPath, downloadObject, removeObject, uploadObject } from './storage'
import { ZipFormatError } from './tools/zip-inventory'
import type { AnalysisArtifact } from './types'

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024
const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

export type RunOutcome =
  | { ok: true; runId: string; summary: string; outputArtifactId: string }
  | { ok: false; status: 400 | 404 | 409 | 500; message: string }

/**
 * เรียกเครื่องมือหนึ่งตัวกับ artifact ต้นทางหนึ่งไฟล์ แล้วบันทึกประวัติ + ผลลัพธ์
 *
 * ผู้เรียกต้องตรวจเจ้าของงานและโหลด artifact ผ่าน client ของผู้ใช้ (RLS) มาก่อน
 * ฟังก์ชันนี้ใช้ service role เพื่อเขียนตารางที่ผู้ใช้เขียนเองไม่ได้ และทุก query กรองด้วย sessionId เสมอ
 */
export async function runTool(args: {
  sessionId: string
  artifact: Pick<AnalysisArtifact, 'id' | 'kind' | 'name' | 'sha256' | 'metadata' | 'size_bytes'> & {
    storage_path: string
  }
  toolId: string
  /** งานในแผนที่เรียกครั้งนี้ (ถ้ามี) — ผูกประวัติการรันเข้ากับ analysis_tasks */
  taskId?: string
}): Promise<RunOutcome> {
  const { sessionId, artifact, toolId } = args

  const tool = await resolveReadyTool(toolId)
  if (!tool) return { ok: false, status: 400, message: 'เครื่องมือนี้ไม่มีอยู่หรือยังไม่พร้อมใช้งาน' }
  const { adapter, entry } = tool

  if (artifact.kind !== 'source') {
    return { ok: false, status: 400, message: 'เรียกเครื่องมือได้เฉพาะกับไฟล์ต้นทาง' }
  }
  const kind = (artifact.metadata.detected_kind ?? 'unknown') as DetectedKind
  if (!supportsKind(entry, kind)) {
    return { ok: false, status: 400, message: `${entry.name} ไม่รองรับไฟล์ชนิดนี้` }
  }
  if (artifact.size_bytes > entry.limits.maxInputBytes) {
    return { ok: false, status: 400, message: 'ไฟล์ใหญ่เกินขีดจำกัดของเครื่องมือนี้' }
  }

  const admin = createAdminClient()

  // run ที่ค้างเกินเวลา (function ถูกตัดกลางทาง) ถือว่าตาย เพื่อไม่ให้บล็อกงานตลอดไป
  await admin
    .from('analysis_tool_runs')
    .update({ status: 'timed_out', error: 'run ค้างเกินเวลาที่กำหนด', finished_at: new Date().toISOString() })
    .eq('session_id', sessionId)
    .in('status', ['queued', 'running'])
    .lt('created_at', new Date(Date.now() - STALE_RUN_MS).toISOString())

  const { data: run, error: insertErr } = await admin
    .from('analysis_tool_runs')
    .insert({
      session_id: sessionId,
      task_id: args.taskId ?? null,
      tool_id: entry.id,
      tool_version: entry.version,
      status: 'running',
      started_at: new Date().toISOString(),
      input: { artifact_id: artifact.id, artifact_sha256: artifact.sha256 },
    })
    .select('id')
    .single()
  if (insertErr || !run) {
    // unique index analysis_tool_runs_one_active_per_session
    if (insertErr?.code === '23505') {
      return { ok: false, status: 409, message: 'มีเครื่องมือกำลังรันในงานนี้อยู่ กรุณารอให้เสร็จก่อน' }
    }
    console.error('[analysis] create tool run failed:', insertErr?.message)
    return { ok: false, status: 500, message: 'บันทึกการเรียกเครื่องมือไม่สำเร็จ' }
  }
  const runId = (run as { id: string }).id

  const finish = (patch: Record<string, unknown>) =>
    admin
      .from('analysis_tool_runs')
      .update({ finished_at: new Date().toISOString(), ...patch })
      .eq('id', runId)
      .eq('session_id', sessionId)

  let outputPath: string | null = null
  try {
    const bytes = await downloadObject(artifact.storage_path, entry.limits.maxInputBytes)
    // ตรวจว่าไฟล์ที่เครื่องมืออ่านตรงกับที่บันทึกไว้ตอนอัปโหลด (กันไฟล์ถูกสลับ)
    if (sha256Hex(bytes) !== artifact.sha256) throw new Error('INTEGRITY: hash ของไฟล์ไม่ตรงกับที่บันทึกไว้')

    const result = await withTimeout(() => adapter.run({ bytes, name: artifact.name }), entry.limits.timeoutMs)

    const json = new TextEncoder().encode(JSON.stringify({
      tool: { id: entry.id, version: entry.version },
      input_artifact: { id: artifact.id, sha256: artifact.sha256 },
      summary: result.summary,
      data: result.data,
    }, null, 2))
    if (json.length > MAX_OUTPUT_BYTES) throw new Error('OUTPUT_TOO_LARGE')

    outputPath = buildObjectPath(sessionId, randomUUID())
    await uploadObject(outputPath, json, 'application/json')

    const { data: outArtifact, error: artErr } = await admin
      .from('analysis_artifacts')
      .insert({
        session_id: sessionId,
        kind: 'tool_output',
        name: `${entry.id}-${artifact.name}`.slice(0, 290) + '.json',
        storage_path: outputPath,
        size_bytes: json.length,
        sha256: sha256Hex(json),
        mime_type: 'application/json',
        metadata: { tool_id: entry.id },
        produced_by_run_id: runId,
      })
      .select('id')
      .single()
    if (artErr || !outArtifact) throw new Error(`ARTIFACT_INSERT: ${artErr?.message}`)

    await finish({ status: 'succeeded', output_summary: result.summary.slice(0, 2000), exit_code: 0 })
    return { ok: true, runId, summary: result.summary, outputArtifactId: (outArtifact as { id: string }).id }
  } catch (e) {
    const err = e as Error
    if (outputPath) await removeObject(outputPath).catch(() => undefined)

    // แสดงผู้ใช้เฉพาะข้อความที่เราควบคุมเอง รายละเอียดอื่นลง log
    const timedOut = err.name === 'TimeoutError'
    const safe =
      timedOut || e instanceof ZipFormatError
        ? err.message
        : err.message.startsWith('INTEGRITY')
          ? 'ไฟล์ไม่ตรงกับ hash ที่บันทึกไว้ จึงไม่รันเครื่องมือ'
          : err.message === 'OUTPUT_TOO_LARGE'
            ? 'ผลลัพธ์ของเครื่องมือใหญ่เกินเพดาน'
            : 'เครื่องมือทำงานไม่สำเร็จ'
    if (safe === 'เครื่องมือทำงานไม่สำเร็จ') console.error('[analysis] tool failed:', entry.id, err.message)

    await finish({ status: timedOut ? 'timed_out' : 'failed', error: safe, exit_code: 1 })
    return { ok: false, status: 400, message: safe }
  }
}
