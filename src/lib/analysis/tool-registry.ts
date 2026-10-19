import { fileIdentifyAdapter } from './tools/file-identify'
import { zipInventoryAdapter } from './tools/zip-inventory'
import { elfInspectAdapter } from './tools/elf-inspect'
import type { DetectedKind, ToolAdapter, ToolDescriptor, ToolProbe } from './tool-adapter'

/**
 * Tool Registry — แหล่งความจริงว่าระบบ "ทำอะไรได้จริง"
 *
 * รายการ Adapter ที่เขียนไว้ในโค้ดเป็นเพียง "ผู้สมัคร" ความพร้อมมาจาก probe() ที่รัน self-test จริง
 * (installed / healthy / version) ไม่มี Adapter ใดถูกประกาศว่าพร้อมโดยไม่ผ่าน probe
 * เครื่องมือแบบ worker / mcp จะเพิ่มในระยะถัดไปเมื่อมีโครงสร้างพื้นฐานรองรับ
 */
const ADAPTERS: readonly ToolAdapter[] = [fileIdentifyAdapter, zipInventoryAdapter, elfInspectAdapter]

export interface RegistryEntry extends ToolDescriptor {
  installed: boolean
  healthy: boolean
  version: string
  detail: string
  /** พร้อมให้เรียกใช้ = ติดตั้งแล้วและ self-test ผ่าน */
  ready: boolean
  checkedAt: string
}

const CACHE_TTL_MS = 60_000
let cache: { at: number; entries: RegistryEntry[] } | null = null

async function probeSafely(a: ToolAdapter): Promise<ToolProbe> {
  try {
    return await a.probe()
  } catch (e) {
    return { installed: true, healthy: false, version: a.version, detail: `probe error: ${(e as Error).message}` }
  }
}

/** ตรวจความพร้อมของเครื่องมือทั้งหมด (cache 60 วินาทีต่อ instance) */
export async function getRegistry(force = false): Promise<RegistryEntry[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.entries
  const checkedAt = new Date().toISOString()
  const entries = await Promise.all(
    ADAPTERS.map(async (a): Promise<RegistryEntry> => {
      const p = await probeSafely(a)
      return {
        ...a.descriptor,
        installed: p.installed,
        healthy: p.healthy,
        version: p.version,
        detail: p.detail,
        ready: p.installed && p.healthy,
        checkedAt,
      }
    })
  )
  cache = { at: Date.now(), entries }
  return entries
}

/** หา Adapter ที่เรียกใช้ได้จริง — คืน null ถ้าไม่มี / ไม่พร้อม */
export async function resolveReadyTool(
  toolId: string
): Promise<{ adapter: ToolAdapter; entry: RegistryEntry } | null> {
  const adapter = ADAPTERS.find((a) => a.descriptor.id === toolId)
  if (!adapter) return null
  const entry = (await getRegistry()).find((e) => e.id === toolId)
  if (!entry || !entry.ready) return null
  return { adapter, entry }
}

/** เครื่องมือรองรับชนิดไฟล์นี้หรือไม่ */
export function supportsKind(entry: Pick<ToolDescriptor, 'fileKinds'>, kind: DetectedKind): boolean {
  return entry.fileKinds.includes('*') || entry.fileKinds.includes(kind)
}
