import { unzipSync } from 'fflate'
import { MAX_ARTIFACT_BYTES } from '../limits'
import type { ToolAdapter, ToolInput, ToolProbe, ToolResult } from '../tool-adapter'
import { ElfFormatError, buildSampleElf, inspectElf } from './elf-inspect'
import { readZipEntries } from './zip-inventory'

const VERSION = '1.0.0'
const MAX_MEMBERS = 40 // จำนวน .so/ELF สูงสุดที่ตรวจต่อ ZIP
const MAX_MEMBER_BYTES = 64 * 1024 * 1024 // ขนาดหลังคลายของแต่ละไฟล์ (กัน zip bomb)
const MAX_TOTAL_BYTES = 256 * 1024 * 1024 // ขนาดหลังคลายรวมที่ยอมคลาย
const TIME_BUDGET_MS = 20_000 // เกินนี้หยุดตรวจไฟล์ที่เหลือ (บอกในผลลัพธ์) — ปล่อยเวลาให้เขียนผลลัพธ์ก่อน timeout ของระบบ
const TOOL_TIMEOUT_MS = 25_000

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const isCandidate = (n: string) => /\.so(\.\d+)*$/i.test(n) || /(^|\/)lib\/[^/]+\/[^/]+$/.test(n)

type Inspected = {
  file: { class: string; machine: string; type: string; size_bytes: number }
  hardening: Record<string, unknown>
  identity: { soname: string; build_id: string; compiler_comments: string[] }
  dependencies: { needed_libraries: string[] }
  counts: { exported_symbols: number; imported_symbols: number; jni_exports: number; strings_found: number }
  stripped: boolean | null
  jni_exports: string[]
  export_families: unknown
  import_families: unknown
  unusual_sections: { name: string; size: number }[]
  interesting_strings: { urls: string[] }
}

/**
 * ตรวจไฟล์ ELF (.so) ทุกไฟล์ใน ZIP ในครั้งเดียว — คลายทีละไฟล์ในหน่วยความจำ ไม่เขียนลงดิสก์ ไม่รันโค้ดใด ๆ
 * ผลลัพธ์เป็นตารางสรุปต่อไลบรารี (กระชับพอให้ AI หลายตัวอ่านแบ่งกันได้) + ความสัมพันธ์ dependency ระหว่างไลบรารีใน ZIP
 */
export function inspectZipElf(input: ToolInput): ToolResult {
  const started = Date.now()
  const entries = readZipEntries(input.bytes).filter((e) => !e.name.endsWith('/'))
  const candidates = entries.filter((e) => isCandidate(e.name))

  const libraries: Record<string, unknown>[] = []
  const skipped: { path: string; size: number; reason: string }[] = []
  const neededByPath = new Map<string, string[]>()
  let totalBytes = 0

  for (const e of candidates) {
    if (libraries.length >= MAX_MEMBERS) {
      skipped.push({ path: e.name, size: e.size, reason: `เกินเพดาน ${MAX_MEMBERS} ไฟล์` })
      continue
    }
    if (Date.now() - started > TIME_BUDGET_MS) {
      skipped.push({ path: e.name, size: e.size, reason: 'หมดเวลาตรวจ (ตรวจใหม่แยกไฟล์ได้)' })
      continue
    }
    if (e.encrypted) {
      skipped.push({ path: e.name, size: e.size, reason: 'ไฟล์ถูกเข้ารหัสใน ZIP' })
      continue
    }
    if (e.size > MAX_MEMBER_BYTES || totalBytes + e.size > MAX_TOTAL_BYTES) {
      skipped.push({ path: e.name, size: e.size, reason: 'ใหญ่เกินเพดานการคลาย' })
      continue
    }
    if (e.method !== 0 && e.method !== 8) {
      skipped.push({ path: e.name, size: e.size, reason: `วิธีบีบอัด method-${e.method} ไม่รองรับ` })
      continue
    }
    try {
      const out = unzipSync(input.bytes, { filter: (f) => f.name === e.name })
      const bytes = out[e.name]
      totalBytes += e.size
      if (!bytes) {
        skipped.push({ path: e.name, size: e.size, reason: 'คลายไม่สำเร็จ' })
        continue
      }
      const d = inspectElf({ bytes, name: e.name }).data as unknown as Inspected
      neededByPath.set(e.name, d.dependencies.needed_libraries)
      libraries.push({
        path: e.name,
        size_bytes: bytes.length,
        machine: `${d.file.machine} ${d.file.class}`,
        soname: d.identity.soname,
        build_id: d.identity.build_id,
        stripped: d.stripped,
        hardening: Object.fromEntries(Object.entries(d.hardening).filter(([k]) => k !== 'note')),
        needed_libraries: d.dependencies.needed_libraries,
        counts: { exported: d.counts.exported_symbols, imported: d.counts.imported_symbols, jni: d.counts.jni_exports },
        jni_exports: d.jni_exports.slice(0, 25),
        export_families: d.export_families,
        import_families: d.import_families,
        unusual_sections: d.unusual_sections,
        urls: d.interesting_strings.urls.slice(0, 4),
        compilers: d.identity.compiler_comments.slice(0, 2).map((c) => clip(c, 110)),
      })
    } catch (err) {
      skipped.push({
        path: e.name,
        size: e.size,
        reason: err instanceof ElfFormatError ? err.message : 'อ่านไฟล์นี้ไม่สำเร็จ',
      })
    }
  }

  // ความสัมพันธ์ระหว่างไลบรารีใน ZIP: ตัวไหนต้องใช้ตัวไหน (จับคู่ด้วยชื่อไฟล์) และไลบรารีระบบ/ภายนอกที่ต้องใช้
  const inZip = new Set(candidates.map((c) => baseName(c.name)))
  const internalDeps: Record<string, string[]> = {}
  const external = new Map<string, number>()
  for (const [path, needed] of neededByPath) {
    const inside = needed.filter((n) => inZip.has(n))
    if (inside.length > 0) internalDeps[path] = inside
    for (const n of needed) if (!inZip.has(n)) external.set(n, (external.get(n) ?? 0) + 1)
  }
  const externalNeeded = [...external.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([lib, used_by]) => ({ lib, used_by }))

  libraries.sort((a, b) => (b.size_bytes as number) - (a.size_bytes as number))
  const jniTotal = libraries.reduce((n, l) => n + (l.counts as { jni: number }).jni, 0)
  const nonElf = entries.length - candidates.length

  return {
    summary:
      `ตรวจ ELF ใน ZIP ${libraries.length}/${candidates.length} ไฟล์` +
      (skipped.length ? ` (ข้าม ${skipped.length})` : '') +
      ` · JNI รวม ${jniTotal}` +
      (Object.keys(internalDeps).length ? ` · มี dependency กันเองในแพ็ก ${Object.keys(internalDeps).length} ไฟล์` : ''),
    data: {
      name: input.name,
      zip_file_count: entries.length,
      candidate_so_count: candidates.length,
      inspected_count: libraries.length,
      other_files_not_inspected: nonElf,
      skipped,
      internal_dependencies: internalDeps,
      external_needed_libraries: externalNeeded,
      libraries,
      note: 'สรุปจากโครงสร้าง ELF ของแต่ละไฟล์เท่านั้น (ไม่ได้ถอดรหัสหรืออ่านตรรกะในฟังก์ชัน) ตระกูล symbol เดาจากชื่อ ไม่ใช่การยืนยันว่าเป็นไลบรารีใด',
    },
  }
}

export const zipElfInspectAdapter: ToolAdapter = {
  version: VERSION,
  descriptor: {
    id: 'zip-elf-inspect',
    name: 'ZIP Native Library Inspect',
    description:
      'ตรวจไฟล์ ELF (.so) ทุกไฟล์ที่อยู่ใน ZIP / APK ในครั้งเดียว (คลายในหน่วยความจำ ไม่รันโค้ด): ต่อไลบรารีสรุปสถาปัตยกรรม soname ไลบรารีที่ต้องใช้ ' +
      'JNI export ตระกูลชื่อ symbol ที่ export/import มาตรการป้องกัน และ section ที่ผิดปกติ พร้อมความสัมพันธ์ dependency ระหว่างไลบรารีในแพ็ก ' +
      'ใช้เมื่อผู้ใช้อัปโหลด ZIP/APK ที่มี .so หลายไฟล์ (ไม่ใช่ Disassembler/Decompiler)',
    executionMode: 'builtin',
    fileKinds: ['zip'],
    limits: { maxInputBytes: MAX_ARTIFACT_BYTES, timeoutMs: TOOL_TIMEOUT_MS },
  },
  async probe(): Promise<ToolProbe> {
    try {
      // สร้าง ZIP (แบบ stored) ที่มี ELF ตัวอย่างจริง 1 ไฟล์ + ไฟล์ที่ไม่ใช่ ELF 1 ไฟล์
      const elf = buildSampleElf(true)
      const zipBytes = buildSampleZipBytes([
        { name: 'lib/arm64-v8a/libtest.so', bytes: elf },
        { name: 'assets/readme.txt', bytes: new TextEncoder().encode('hi') },
      ])
      const r = inspectZipElf({ bytes: zipBytes, name: 'self-test.zip' })
      const libs = r.data.libraries as { soname: string }[]
      const ok = libs.length === 1 && libs[0]!.soname === 'libtest.so' && r.data.other_files_not_inspected === 1
      return {
        installed: true,
        healthy: ok,
        version: VERSION,
        detail: ok ? 'self-test ผ่าน (ZIP ตัวอย่างที่มี ELF 1 ไฟล์)' : 'self-test ไม่ผ่าน: ผลลัพธ์ไม่ตรงที่คาดไว้',
      }
    } catch (e) {
      return { installed: true, healthy: false, version: VERSION, detail: `self-test error: ${(e as Error).message}` }
    }
  },
  async run(input) {
    return inspectZipElf(input)
  },
}

// ZIP แบบ stored ที่รับไบต์ดิบ (buildSampleZip ของ zip-inventory รับเฉพาะข้อความ)
function buildSampleZipBytes(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder()
  const w16 = (v: number) => [v & 0xff, (v >> 8) & 0xff]
  const w32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]
  const parts: number[][] = []
  const central: number[][] = []
  let offset = 0
  for (const f of files) {
    const name = [...enc.encode(f.name)]
    const local = [
      ...w32(0x04034b50), ...w16(20), ...w16(0), ...w16(0), ...w16(0), ...w16(0),
      ...w32(0), ...w32(f.bytes.length), ...w32(f.bytes.length), ...w16(name.length), ...w16(0), ...name, ...f.bytes,
    ]
    central.push([
      ...w32(0x02014b50), ...w16(20), ...w16(20), ...w16(0), ...w16(0), ...w16(0), ...w16(0),
      ...w32(0), ...w32(f.bytes.length), ...w32(f.bytes.length), ...w16(name.length), ...w16(0), ...w16(0),
      ...w16(0), ...w16(0), ...w32(0), ...w32(offset), ...name,
    ])
    parts.push(local)
    offset += local.length
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0)
  const eocd = [...w32(0x06054b50), ...w16(0), ...w16(0), ...w16(files.length), ...w16(files.length), ...w32(cdSize), ...w32(offset), ...w16(0)]
  return new Uint8Array([...parts.flat(), ...central.flat(), ...eocd])
}
