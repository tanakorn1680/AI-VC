import { createHash } from 'node:crypto'
import { MAX_ARTIFACT_BYTES, BUILTIN_TIMEOUT_MS } from '../limits'
import type {
  DetectedKind,
  ToolAdapter,
  ToolInput,
  ToolProbe,
  ToolResult,
} from '../tool-adapter'

const VERSION = '1.0.0'

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  if (b.length < offset + sig.length) return false
  return sig.every((v, i) => b[offset + i] === v)
}

const u16 = (b: Uint8Array, o: number) => (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
const u32 = (b: Uint8Array, o: number) =>
  ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0
const u32be = (b: Uint8Array, o: number) =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0

const PE_MACHINES: Record<number, string> = {
  0x014c: 'x86', 0x8664: 'x86-64', 0x01c0: 'ARM', 0x01c4: 'ARMv7 (Thumb-2)', 0xaa64: 'ARM64',
}
const ELF_MACHINES: Record<number, string> = {
  0x03: 'x86', 0x3e: 'x86-64', 0x28: 'ARM', 0xb7: 'ARM64', 0x08: 'MIPS', 0xf3: 'RISC-V',
}

function looksLikeText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 4096)
  if (n === 0) return false
  for (let i = 0; i < n; i++) {
    const c = b[i] as number
    if (c === 0) return false
    if (c < 9 || (c > 13 && c < 32)) return false
  }
  return true
}

/** เอนโทรปี Shannon (บิต/ไบต์, 0–8) — ค่าสูงมาก (>7.2) มักเป็นข้อมูลบีบอัดหรือเข้ารหัส */
function entropy(b: Uint8Array): number {
  if (b.length === 0) return 0
  const counts = new Array<number>(256).fill(0)
  for (let i = 0; i < b.length; i++) counts[b[i] as number]!++
  let h = 0
  for (const c of counts) {
    if (c === 0) continue
    const p = c / b.length
    h -= p * Math.log2(p)
  }
  return h
}

export interface Identification {
  kind: DetectedKind
  label: string
  details: Record<string, string>
}

/** ระบุชนิดไฟล์จาก magic bytes (ใช้ซ้ำตอน finalize artifact) */
export function identifyBytes(b: Uint8Array): Identification {
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06])) {
    return { kind: 'zip', label: 'ZIP archive (รวมถึง APK / JAR)', details: {} }
  }
  if (startsWith(b, [0x7f, 0x45, 0x4c, 0x46])) {
    const is64 = b[4] === 2
    const little = b[5] === 1
    const machine = little ? u16(b, 18) : ((b[18] ?? 0) << 8) | (b[19] ?? 0)
    return {
      kind: 'elf',
      label: 'ELF executable / shared object',
      details: {
        class: is64 ? '64-bit' : '32-bit',
        endianness: little ? 'little' : 'big',
        machine: ELF_MACHINES[machine] ?? `0x${machine.toString(16)}`,
      },
    }
  }
  if (startsWith(b, [0x4d, 0x5a])) {
    const peOffset = u32(b, 0x3c)
    if (peOffset > 0 && peOffset + 6 <= b.length && startsWith(b, [0x50, 0x45, 0, 0], peOffset)) {
      const machine = u16(b, peOffset + 4)
      return {
        kind: 'pe',
        label: 'Windows PE (EXE / DLL)',
        details: { machine: PE_MACHINES[machine] ?? `0x${machine.toString(16)}` },
      }
    }
    return { kind: 'unknown', label: 'DOS MZ header (ไม่พบ PE header)', details: {} }
  }
  if (startsWith(b, [0x64, 0x65, 0x78, 0x0a]) && b[7] === 0) {
    return {
      kind: 'dex',
      label: 'Android DEX',
      details: { version: String.fromCharCode(b[4] ?? 0, b[5] ?? 0, b[6] ?? 0) },
    }
  }
  const magic32 = u32be(b, 0)
  if (magic32 === 0xcafebabe) {
    // Java class (version >= 45) ใช้ magic เดียวกับ Mach-O fat binary (จำนวน arch น้อย)
    const second = u32be(b, 4)
    return second >= 45
      ? { kind: 'unknown', label: 'Java class file', details: { major: String(u16Be(b, 6)) } }
      : { kind: 'macho', label: 'Mach-O universal binary', details: { architectures: String(second) } }
  }
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic32)) {
    return { kind: 'macho', label: 'Mach-O binary', details: {} }
  }
  if (startsWith(b, [0x1f, 0x8b])) return { kind: 'gzip', label: 'gzip compressed', details: {} }
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { kind: 'pdf', label: 'PDF document', details: {} }
  if (startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { kind: 'sevenzip', label: '7-Zip archive', details: {} }
  if (startsWith(b, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return { kind: 'rar', label: 'RAR archive', details: {} }
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'png', label: 'PNG image', details: {} }
  if (looksLikeText(b)) return { kind: 'text', label: 'ข้อความ (ไม่พบไบต์ควบคุม)', details: {} }
  return { kind: 'unknown', label: 'ไม่ทราบชนิด', details: {} }
}

function u16Be(b: Uint8Array, o: number) {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0)
}

/** สรุปข้อมูลพื้นฐานของไฟล์: ชนิด (จาก magic bytes), ขนาด, SHA-256, เอนโทรปี */
export function identifyFile(input: ToolInput): ToolResult {
  const id = identifyBytes(input.bytes)
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const ent = entropy(input.bytes)
  const parts = [id.label, `${input.bytes.length} ไบต์`, `เอนโทรปี ${ent.toFixed(2)}`]
  return {
    summary: parts.join(' · '),
    data: {
      name: input.name,
      detected_kind: id.kind,
      label: id.label,
      details: id.details,
      size_bytes: input.bytes.length,
      sha256,
      entropy_bits_per_byte: Number(ent.toFixed(4)),
      // เอนโทรปีเป็นเพียงข้อสังเกต ไม่ใช่หลักฐานว่าไฟล์ถูกแพ็กหรือเข้ารหัส
      entropy_note: 'ค่ามากกว่า 7.2 มักพบในข้อมูลที่บีบอัดหรือเข้ารหัส เป็นเพียงข้อสังเกตเชิงสถิติ',
    },
  }
}

// ตัวอย่างควบคุมสำหรับ probe: ELF 64-bit little-endian x86-64 แบบย่อ (ไม่ใช่ไฟล์ที่รันได้)
const SELF_TEST_SAMPLE = new Uint8Array([
  0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x00, 0x3e, 0x00,
])

export const fileIdentifyAdapter: ToolAdapter = {
  version: VERSION,
  descriptor: {
    id: 'file-identify',
    name: 'File Identify',
    description: 'ระบุชนิดไฟล์จาก magic bytes พร้อมขนาด SHA-256 และเอนโทรปี',
    executionMode: 'builtin',
    fileKinds: ['*'],
    limits: { maxInputBytes: MAX_ARTIFACT_BYTES, timeoutMs: BUILTIN_TIMEOUT_MS },
  },
  async probe(): Promise<ToolProbe> {
    try {
      const r = identifyFile({ bytes: SELF_TEST_SAMPLE, name: 'self-test.bin' })
      const d = r.data.details as Record<string, string>
      const ok = r.data.detected_kind === 'elf' && d.machine === 'x86-64' && d.class === '64-bit'
      return {
        installed: true,
        healthy: ok,
        version: VERSION,
        detail: ok ? 'self-test ผ่าน (ตัวอย่าง ELF x86-64)' : 'self-test ไม่ผ่าน: ผลลัพธ์ไม่ตรงที่คาดไว้',
      }
    } catch (e) {
      return { installed: true, healthy: false, version: VERSION, detail: `self-test error: ${(e as Error).message}` }
    }
  },
  async run(input) {
    return identifyFile(input)
  },
}
