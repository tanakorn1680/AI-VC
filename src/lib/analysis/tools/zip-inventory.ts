import { MAX_ARTIFACT_BYTES, BUILTIN_TIMEOUT_MS } from '../limits'
import type { ToolAdapter, ToolInput, ToolProbe, ToolResult } from '../tool-adapter'

const VERSION = '1.0.0'
const MAX_ENTRIES = 20_000 // เพดานจำนวนรายการที่อ่าน (กัน zip ที่ออกแบบมาให้ใหญ่ผิดปกติ)
const MAX_LISTED = 500 // จำนวนรายการที่ใส่ในผลลัพธ์

const u16 = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
const u32 = (b: Uint8Array, o: number) =>
  ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0

interface ZipEntry {
  name: string
  size: number
  compressedSize: number
  method: number
  encrypted: boolean
}

export class ZipFormatError extends Error {}

/**
 * อ่านเฉพาะ central directory — ไม่คลายการบีบอัดข้อมูลใด ๆ จึงไม่เสี่ยง zip bomb
 * ไม่รองรับ ZIP64 (แจ้งผู้ใช้ชัดเจนแทนการเดา)
 */
export function readZipEntries(b: Uint8Array): ZipEntry[] {
  // หา End Of Central Directory (EOCD) จากท้ายไฟล์ย้อนกลับ (comment ยาวได้สูงสุด 65535)
  const minEocd = 22
  if (b.length < minEocd) throw new ZipFormatError('ไฟล์สั้นเกินกว่าจะเป็น ZIP')
  let eocd = -1
  for (let i = b.length - minEocd; i >= Math.max(0, b.length - minEocd - 65535); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new ZipFormatError('ไม่พบ End Of Central Directory (ไฟล์เสียหรือไม่ใช่ ZIP)')

  const total = u16(b, eocd + 10)
  const cdSize = u32(b, eocd + 12)
  const cdOffset = u32(b, eocd + 16)
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipFormatError('ไฟล์เป็น ZIP64 ซึ่งเครื่องมือนี้ยังไม่รองรับ')
  }
  if (cdOffset + cdSize > b.length) throw new ZipFormatError('central directory ชี้เกินขนาดไฟล์')
  if (total > MAX_ENTRIES) throw new ZipFormatError(`จำนวนรายการเกินเพดาน ${MAX_ENTRIES}`)

  const decoder = new TextDecoder('utf-8')
  const entries: ZipEntry[] = []
  let p = cdOffset
  for (let n = 0; n < total; n++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) {
      throw new ZipFormatError(`central directory เสียหายที่รายการ ${n + 1}`)
    }
    const flags = u16(b, p + 8)
    const method = u16(b, p + 10)
    const compressedSize = u32(b, p + 20)
    const size = u32(b, p + 24)
    const nameLen = u16(b, p + 28)
    const extraLen = u16(b, p + 30)
    const commentLen = u16(b, p + 32)
    if (p + 46 + nameLen > b.length) throw new ZipFormatError(`ชื่อรายการ ${n + 1} เกินขนาดไฟล์`)
    const name = decoder.decode(b.subarray(p + 46, p + 46 + nameLen))
    entries.push({ name, size, compressedSize, method, encrypted: (flags & 1) === 1 })
    p += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

export function inventoryZip(input: ToolInput): ToolResult {
  const entries = readZipEntries(input.bytes)
  const files = entries.filter((e) => !e.name.endsWith('/'))

  let totalSize = 0
  let totalCompressed = 0
  for (const f of files) {
    totalSize += f.size
    totalCompressed += f.compressedSize
  }

  // ข้อสังเกตด้านความปลอดภัยของโครงสร้าง (ไม่ได้ตรวจเนื้อหา)
  const suspiciousPaths = entries
    .filter((e) => e.name.startsWith('/') || e.name.split('/').includes('..') || e.name.includes('\\..'))
    .map((e) => e.name)
    .slice(0, 20)
  const encryptedCount = entries.filter((e) => e.encrypted).length
  const ratio = totalCompressed > 0 ? totalSize / totalCompressed : 0

  // ลักษณะของ APK: อ่านจากชื่อรายการเท่านั้น
  const names = files.map((f) => f.name)
  const hasManifest = names.includes('AndroidManifest.xml')
  const dexFiles = names.filter((n) => /^classes\d*\.dex$/.test(n))
  const abis = [...new Set(names.map((n) => /^lib\/([^/]+)\//.exec(n)?.[1]).filter((v): v is string => !!v))].sort()
  const signatures = names.filter((n) => /^META-INF\/.+\.(RSA|DSA|EC|SF|MF)$/i.test(n))
  const isApkLike = hasManifest && dexFiles.length > 0

  const listed = files.slice(0, MAX_LISTED).map((f) => ({
    name: f.name,
    size: f.size,
    compressed_size: f.compressedSize,
    method: f.method === 0 ? 'stored' : f.method === 8 ? 'deflate' : `method-${f.method}`,
    encrypted: f.encrypted,
  }))

  const summaryParts = [`${files.length} ไฟล์`, `ขนาดหลังคลาย ${totalSize} ไบต์`]
  if (isApkLike) summaryParts.push(`โครงสร้างแบบ APK (dex ${dexFiles.length}, ABI: ${abis.join(', ') || 'ไม่มี'})`)
  if (suspiciousPaths.length) summaryParts.push(`พบพาธน่าสงสัย ${suspiciousPaths.length} รายการ`)

  return {
    summary: summaryParts.join(' · '),
    data: {
      name: input.name,
      file_count: files.length,
      directory_count: entries.length - files.length,
      total_uncompressed_bytes: totalSize,
      total_compressed_bytes: totalCompressed,
      compression_ratio: Number(ratio.toFixed(2)),
      encrypted_entries: encryptedCount,
      suspicious_paths: suspiciousPaths,
      apk_structure: {
        // ตรวจจากชื่อรายการเท่านั้น ไม่ได้แปลง AndroidManifest.xml หรือตรวจลายเซ็น
        looks_like_apk: isApkLike,
        has_android_manifest: hasManifest,
        dex_files: dexFiles,
        native_abis: abis,
        signature_files: signatures.slice(0, 20),
        has_resources_arsc: names.includes('resources.arsc'),
      },
      entries: listed,
      entries_truncated: files.length > MAX_LISTED,
    },
  }
}

// สร้าง ZIP ตัวอย่างแบบ stored (ไม่บีบอัด) ในหน่วยความจำ สำหรับ self-test ที่ควบคุมได้
function buildSampleZip(files: { name: string; content: string }[]): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const w16 = (v: number) => [v & 0xff, (v >> 8) & 0xff]
  const w32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
  for (const f of files) {
    const name = enc.encode(f.name)
    const data = enc.encode(f.content)
    const local = new Uint8Array([
      ...w32(0x04034b50), ...w16(20), ...w16(0), ...w16(0), ...w16(0), ...w16(0),
      ...w32(0), ...w32(data.length), ...w32(data.length), ...w16(name.length), ...w16(0), ...name, ...data,
    ])
    central.push(new Uint8Array([
      ...w32(0x02014b50), ...w16(20), ...w16(20), ...w16(0), ...w16(0), ...w16(0), ...w16(0),
      ...w32(0), ...w32(data.length), ...w32(data.length), ...w16(name.length), ...w16(0), ...w16(0),
      ...w16(0), ...w16(0), ...w32(0), ...w32(offset), ...name,
    ]))
    chunks.push(local)
    offset += local.length
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0)
  const eocd = new Uint8Array([
    ...w32(0x06054b50), ...w16(0), ...w16(0), ...w16(files.length), ...w16(files.length),
    ...w32(cdSize), ...w32(offset), ...w16(0),
  ])
  const all = [...chunks, ...central, eocd]
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0))
  let p = 0
  for (const c of all) {
    out.set(c, p)
    p += c.length
  }
  return out
}

export const zipInventoryAdapter: ToolAdapter = {
  version: VERSION,
  descriptor: {
    id: 'zip-inventory',
    name: 'ZIP Inventory',
    description: 'ไล่รายการใน ZIP / APK / JAR จาก central directory โดยไม่คลายไฟล์ พร้อมข้อสังเกตโครงสร้าง',
    executionMode: 'builtin',
    fileKinds: ['zip'],
    limits: { maxInputBytes: MAX_ARTIFACT_BYTES, timeoutMs: BUILTIN_TIMEOUT_MS },
  },
  async probe(): Promise<ToolProbe> {
    try {
      const sample = buildSampleZip([
        { name: 'AndroidManifest.xml', content: 'x' },
        { name: 'classes.dex', content: 'yy' },
        { name: 'lib/arm64-v8a/libfoo.so', content: 'zzz' },
      ])
      const r = inventoryZip({ bytes: sample, name: 'self-test.zip' })
      const apk = r.data.apk_structure as { looks_like_apk: boolean; native_abis: string[] }
      const ok = r.data.file_count === 3 && apk.looks_like_apk && apk.native_abis[0] === 'arm64-v8a'
      return {
        installed: true,
        healthy: ok,
        version: VERSION,
        detail: ok ? 'self-test ผ่าน (ZIP ตัวอย่าง 3 ไฟล์)' : 'self-test ไม่ผ่าน: ผลลัพธ์ไม่ตรงที่คาดไว้',
      }
    } catch (e) {
      return { installed: true, healthy: false, version: VERSION, detail: `self-test error: ${(e as Error).message}` }
    }
  },
  async run(input) {
    return inventoryZip(input)
  },
}
