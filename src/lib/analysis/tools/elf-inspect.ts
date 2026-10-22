import { BUILTIN_TIMEOUT_MS, MAX_ARTIFACT_BYTES } from '../limits'
import type { ToolAdapter, ToolInput, ToolProbe, ToolResult } from '../tool-adapter'
import { topFamilies } from './symbol-families'

const VERSION = '1.1.0'

const MAX_SECTIONS_LISTED = 120
const MAX_SYMBOLS_LISTED = 400
const MAX_SYMBOL_ROWS = 600_000 // เพดานจำนวนแถว symbol ที่อ่าน (กันตารางที่ออกแบบมาให้ใหญ่ผิดปกติ)
const MAX_STRING_SCAN_BYTES = 24 * 1024 * 1024
const MIN_STRING_LEN = 6
const MAX_PER_CATEGORY = 100
const MAX_SAMPLE_STRINGS = 200

export class ElfFormatError extends Error {}

const TYPES: Record<number, string> = { 1: 'relocatable (ET_REL)', 2: 'executable (ET_EXEC)', 3: 'shared object / PIE (ET_DYN)', 4: 'core (ET_CORE)' }
const MACHINES: Record<number, string> = {
  0x03: 'x86', 0x3e: 'x86-64', 0x28: 'ARM', 0xb7: 'ARM64', 0x08: 'MIPS', 0xf3: 'RISC-V', 0x14: 'PowerPC', 0x15: 'PowerPC64', 0x2a: 'SuperH',
}
const OSABI: Record<number, string> = { 0: 'System V', 3: 'Linux', 9: 'FreeBSD', 97: 'ARM EABI' }
const PT: Record<number, string> = {
  0: 'NULL', 1: 'LOAD', 2: 'DYNAMIC', 3: 'INTERP', 4: 'NOTE', 5: 'SHLIB', 6: 'PHDR', 7: 'TLS',
  0x6474e550: 'GNU_EH_FRAME', 0x6474e551: 'GNU_STACK', 0x6474e552: 'GNU_RELRO', 0x6474e553: 'GNU_PROPERTY',
}
const SHT = { PROGBITS: 1, SYMTAB: 2, STRTAB: 3, NOTE: 7, DYNAMIC: 6, DYNSYM: 11 }
const SHT_NAMES: Record<number, string> = {
  0: 'NULL', 1: 'PROGBITS', 2: 'SYMTAB', 3: 'STRTAB', 4: 'RELA', 5: 'HASH', 6: 'DYNAMIC', 7: 'NOTE', 8: 'NOBITS', 9: 'REL', 11: 'DYNSYM',
  14: 'INIT_ARRAY', 15: 'FINI_ARRAY', 0x6ffffff6: 'GNU_HASH', 0x6ffffffe: 'VERNEED', 0x6fffffff: 'VERSYM',
}
const SHF_WRITE = 1, SHF_ALLOC = 2, SHF_EXEC = 4
const DT = { NULL: 0, NEEDED: 1, STRTAB: 5, STRSZ: 10, SONAME: 14, RPATH: 15, BIND_NOW: 24, RUNPATH: 29, FLAGS: 30, FLAGS_1: 0x6ffffffb }

class Reader {
  readonly dv: DataView
  constructor(readonly b: Uint8Array, readonly is64: boolean, readonly le: boolean) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  }
  u8(o: number) { return this.dv.getUint8(o) }
  u16(o: number) { return this.dv.getUint16(o, this.le) }
  u32(o: number) { return this.dv.getUint32(o, this.le) }
  u64(o: number) {
    const lo = this.dv.getUint32(o + (this.le ? 0 : 4), this.le)
    const hi = this.dv.getUint32(o + (this.le ? 4 : 0), this.le)
    return hi * 4294967296 + lo
  }
  /** ที่อยู่/offset ตามขนาด class ของไฟล์ */
  word(o: number) { return this.is64 ? this.u64(o) : this.u32(o) }
  hex(o: number) {
    return '0x' + (this.is64 ? this.dv.getBigUint64(o, this.le) : BigInt(this.dv.getUint32(o, this.le))).toString(16)
  }
  cstr(o: number, max = 2048): string {
    if (o < 0 || o >= this.b.length) return ''
    let e = o
    const lim = Math.min(this.b.length, o + max)
    while (e < lim && this.b[e] !== 0) e++
    return new TextDecoder('utf-8').decode(this.b.subarray(o, e))
  }
}

interface Section { name: string; type: number; flags: number; addr: number; offset: number; size: number; link: number; info: number; entsize: number }
interface Phdr { type: number; flags: number; offset: number; vaddr: number; filesz: number; memsz: number }
interface Sym { name: string; bind: number; type: number; shndx: number; value: string; size: number }

function readSections(r: Reader, shoff: number, shnum: number, shentsize: number, shstrndx: number): Section[] {
  const rows: { nameOff: number; s: Omit<Section, 'name'> }[] = []
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize
    if (o + shentsize > r.b.length) throw new ElfFormatError('ตาราง section header เกินขนาดไฟล์')
    rows.push(
      r.is64
        ? { nameOff: r.u32(o), s: { type: r.u32(o + 4), flags: r.u64(o + 8), addr: r.u64(o + 16), offset: r.u64(o + 24), size: r.u64(o + 32), link: r.u32(o + 40), info: r.u32(o + 44), entsize: r.u64(o + 56) } }
        : { nameOff: r.u32(o), s: { type: r.u32(o + 4), flags: r.u32(o + 8), addr: r.u32(o + 12), offset: r.u32(o + 16), size: r.u32(o + 20), link: r.u32(o + 24), info: r.u32(o + 28), entsize: r.u32(o + 36) } }
    )
  }
  const str = rows[shstrndx]?.s
  return rows.map(({ nameOff, s }) => ({ ...s, name: str ? r.cstr(str.offset + nameOff, 256) : '' }))
}

function readPhdrs(r: Reader, phoff: number, phnum: number, phentsize: number): Phdr[] {
  const out: Phdr[] = []
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize
    if (o + phentsize > r.b.length) throw new ElfFormatError('ตาราง program header เกินขนาดไฟล์')
    out.push(
      r.is64
        ? { type: r.u32(o), flags: r.u32(o + 4), offset: r.u64(o + 8), vaddr: r.u64(o + 16), filesz: r.u64(o + 32), memsz: r.u64(o + 40) }
        : { type: r.u32(o), offset: r.u32(o + 4), vaddr: r.u32(o + 8), filesz: r.u32(o + 16), memsz: r.u32(o + 20), flags: r.u32(o + 24) }
    )
  }
  return out
}

function readSymbols(r: Reader, sec: Section, strtab: Section | undefined): { syms: Sym[]; truncated: boolean } {
  if (!strtab) return { syms: [], truncated: false }
  const ent = sec.entsize || (r.is64 ? 24 : 16)
  const total = Math.floor(sec.size / ent)
  const n = Math.min(total, MAX_SYMBOL_ROWS)
  if (sec.offset + n * ent > r.b.length) throw new ElfFormatError('ตาราง symbol เกินขนาดไฟล์')
  const syms: Sym[] = []
  for (let i = 1; i < n; i++) {
    const o = sec.offset + i * ent
    const nameOff = r.u32(o)
    const info = r.is64 ? r.u8(o + 4) : r.u8(o + 12)
    const shndx = r.is64 ? r.u16(o + 6) : r.u16(o + 14)
    const value = r.is64 ? r.hex(o + 8) : r.hex(o + 4)
    const size = r.is64 ? r.u64(o + 16) : r.u32(o + 8)
    syms.push({ name: r.cstr(strtab.offset + nameOff, 1024), bind: info >> 4, type: info & 0xf, shndx, value, size })
  }
  return { syms, truncated: total > n }
}

interface DynInfo { needed: string[]; soname: string; rpath: string; runpath: string; bindNow: boolean; flags1: number }

function parseDynamic(r: Reader, off: number, size: number, strOff: (v: number) => number | null): DynInfo {
  const info: DynInfo = { needed: [], soname: '', rpath: '', runpath: '', bindNow: false, flags1: 0 }
  const ent = r.is64 ? 16 : 8
  const count = Math.min(Math.floor(size / ent), 4096)
  const neededOffs: number[] = []
  let sonameOff = -1, rpathOff = -1, runpathOff = -1
  for (let i = 0; i < count; i++) {
    const o = off + i * ent
    if (o + ent > r.b.length) break
    const tag = r.word(o)
    const val = r.word(o + (r.is64 ? 8 : 4))
    if (tag === DT.NULL) break
    if (tag === DT.NEEDED) neededOffs.push(val)
    else if (tag === DT.SONAME) sonameOff = val
    else if (tag === DT.RPATH) rpathOff = val
    else if (tag === DT.RUNPATH) runpathOff = val
    else if (tag === DT.BIND_NOW) info.bindNow = true
    else if (tag === DT.FLAGS && (val & 0x8) !== 0) info.bindNow = true
    else if (tag === DT.FLAGS_1) { info.flags1 = val; if ((val & 0x1) !== 0) info.bindNow = true }
  }
  const str = (v: number) => { const o = strOff(v); return o === null ? '' : r.cstr(o, 512) }
  info.needed = neededOffs.map(str).filter(Boolean).slice(0, 100)
  if (sonameOff >= 0) info.soname = str(sonameOff)
  if (rpathOff >= 0) info.rpath = str(rpathOff)
  if (runpathOff >= 0) info.runpath = str(runpathOff)
  return info
}

function parseBuildId(r: Reader, sec: Section): string {
  let o = sec.offset
  const end = Math.min(sec.offset + sec.size, r.b.length)
  while (o + 12 <= end) {
    const namesz = r.u32(o), descsz = r.u32(o + 4), type = r.u32(o + 8)
    const nameStart = o + 12
    const descStart = nameStart + ((namesz + 3) & ~3)
    if (descStart + descsz > end) break
    if (type === 3 && r.cstr(nameStart, namesz) === 'GNU') {
      return [...r.b.subarray(descStart, descStart + descsz)].map((x) => x.toString(16).padStart(2, '0')).join('')
    }
    o = descStart + ((descsz + 3) & ~3)
  }
  return ''
}

const isPrintable = (c: number) => (c >= 0x20 && c <= 0x7e) || c === 0x09

function scanStrings(b: Uint8Array, ranges: [number, number][]) {
  const urls = new Set<string>(), paths = new Set<string>(), libs = new Set<string>(), ips = new Set<string>()
  const sample = new Set<string>()
  let total = 0
  let budget = MAX_STRING_SCAN_BYTES
  const dec = new TextDecoder('latin1')
  const urlRe = /\b(?:https?|wss?|ftp):\/\/[^\s'"<>\\]{3,200}/gi
  const pathRe = /(?:^|[\s"'=:])(\/(?:data|sdcard|storage|system|proc|dev|mnt|etc|vendor|sys|apex)\/[\w.\-/%]{2,200})/g
  const libRe = /\b[\w.\-]{1,100}\.(?:so|dex|jar|apk|dll)\b/gi
  const ipRe = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g

  const handle = (s: string) => {
    total++
    if (sample.size < MAX_SAMPLE_STRINGS && s.length >= 12) sample.add(s.slice(0, 160))
    const t = s.length > 400 ? s.slice(0, 400) : s
    if (urls.size < MAX_PER_CATEGORY) for (const m of t.matchAll(urlRe)) urls.add(m[0].slice(0, 200))
    if (paths.size < MAX_PER_CATEGORY) for (const m of t.matchAll(pathRe)) paths.add((m[1] as string).slice(0, 200))
    if (libs.size < MAX_PER_CATEGORY) for (const m of t.matchAll(libRe)) libs.add(m[0].slice(0, 100))
    if (ips.size < MAX_PER_CATEGORY) {
      for (const m of t.matchAll(ipRe)) {
        const octets = m[0].split(':')[0]!.split('.').map(Number)
        // ตัดสตริงที่หน้าตาเหมือนเวอร์ชัน (0.x.x.x) หรือเลขเกิน 255
        if (octets.every((x) => x <= 255) && octets[0]! > 0) ips.add(m[0])
      }
    }
  }

  for (const [start, end] of ranges) {
    const lo = Math.max(0, start), hi = Math.min(b.length, end)
    let runStart = -1
    for (let i = lo; i < hi && budget > 0; i++, budget--) {
      if (isPrintable(b[i] as number)) {
        if (runStart < 0) runStart = i
      } else if (runStart >= 0) {
        if (i - runStart >= MIN_STRING_LEN) handle(dec.decode(b.subarray(runStart, Math.min(i, runStart + 4000))))
        runStart = -1
      }
    }
    if (runStart >= 0 && hi - runStart >= MIN_STRING_LEN) handle(dec.decode(b.subarray(runStart, Math.min(hi, runStart + 4000))))
  }
  return { total, urls: [...urls], paths: [...paths], libraries: [...libs], ip_like: [...ips], sample: [...sample], scanned_bytes: MAX_STRING_SCAN_BYTES - budget }
}

/**
 * อ่านโครงสร้าง ELF โดยไม่รันหรือคลายอะไร — ทุกค่ามาจากข้อมูลในไฟล์ ไม่มีการเดา
 * ลำดับคีย์ใน data ตั้งใจให้ข้อมูลสำคัญและกระชับอยู่ต้น (AI อ่านผลได้จำกัดความยาว ส่วนท้ายจะถูกตัด)
 */
export function inspectElf(input: ToolInput): ToolResult {
  const b = input.bytes
  if (b.length < 52 || b[0] !== 0x7f || b[1] !== 0x45 || b[2] !== 0x4c || b[3] !== 0x46) {
    throw new ElfFormatError('ไม่ใช่ไฟล์ ELF (ไม่พบ magic bytes)')
  }
  const cls = b[4], data = b[5]
  if ((cls !== 1 && cls !== 2) || (data !== 1 && data !== 2)) throw new ElfFormatError('ELF header ไม่ถูกต้อง (class/endianness)')
  const r = new Reader(b, cls === 2, data === 1)
  const notes: string[] = []

  try {
    const eType = r.u16(16), machine = r.u16(18)
    const entry = r.hex(24)
    const phoff = r.is64 ? r.u64(32) : r.u32(28)
    let shoff = r.is64 ? r.u64(40) : r.u32(32)
    const phentsize = r.is64 ? r.u16(54) : r.u16(42)
    const phnum = r.is64 ? r.u16(56) : r.u16(44)
    const shentsize = r.is64 ? r.u16(58) : r.u16(46)
    let shnum = r.is64 ? r.u16(60) : r.u16(48)
    let shstrndx = r.is64 ? r.u16(62) : r.u16(50)

    // ค่าพิเศษเมื่อจำนวน section เกิน 65535 (เก็บใน section header แรก)
    if (shnum === 0 && shoff > 0 && shoff + shentsize <= b.length) shnum = r.is64 ? r.u64(shoff + 32) : r.u32(shoff + 20)
    if (shstrndx === 0xffff && shoff > 0 && shoff + shentsize <= b.length) shstrndx = r.is64 ? r.u32(shoff + 40) : r.u32(shoff + 24)
    if (shnum > 65535) throw new ElfFormatError('จำนวน section ผิดปกติ')

    const phdrs = phnum > 0 && phoff > 0 ? readPhdrs(r, phoff, phnum, phentsize) : []
    const hasSections = shnum > 0 && shoff > 0 && shentsize >= (r.is64 ? 64 : 40)
    const sections = hasSections ? readSections(r, shoff, shnum, shentsize, shstrndx) : []
    if (!hasSections) {
      notes.push('ไฟล์ไม่มี section header (มักถูกตัดออกด้วยเครื่องมือแพ็ก/ป้องกัน) จึงอ่านตาราง symbol และรายละเอียด section ไม่ได้ คงเหลือข้อมูลจาก program header')
      shoff = 0
    }

    // ---------- dynamic (ไลบรารีที่ต้องใช้ ฯลฯ) ----------
    let dyn: DynInfo | null = null
    const dynSec = sections.find((s) => s.type === SHT.DYNAMIC)
    if (dynSec) {
      const str = sections[dynSec.link]
      dyn = parseDynamic(r, dynSec.offset, dynSec.size, (v) => (str ? str.offset + v : null))
    } else {
      const pd = phdrs.find((p) => p.type === 2)
      if (pd && pd.offset + pd.filesz <= b.length) {
        const loads = phdrs.filter((p) => p.type === 1)
        const toOff = (va: number) => {
          const seg = loads.find((p) => va >= p.vaddr && va < p.vaddr + p.filesz)
          return seg ? seg.offset + (va - seg.vaddr) : null
        }
        // หา DT_STRTAB ก่อน เพราะ DT_NEEDED เป็น offset ภายใน string table นั้น
        let strtabVa = 0
        const ent = r.is64 ? 16 : 8
        for (let i = 0; i < Math.min(Math.floor(pd.filesz / ent), 4096); i++) {
          const o = pd.offset + i * ent
          const tag = r.word(o)
          if (tag === DT.NULL) break
          if (tag === DT.STRTAB) strtabVa = r.word(o + (r.is64 ? 8 : 4))
        }
        const base = strtabVa ? toOff(strtabVa) : null
        dyn = parseDynamic(r, pd.offset, pd.filesz, (v) => (base === null ? null : base + v))
        if (base === null) notes.push('หา string table ของ dynamic section ไม่พบ จึงอ่านชื่อไลบรารีไม่ได้')
      }
    }

    // ---------- symbols ----------
    const dynsymSec = sections.find((s) => s.type === SHT.DYNSYM)
    const symtabSec = sections.find((s) => s.type === SHT.SYMTAB)
    const dynRes = dynsymSec ? readSymbols(r, dynsymSec, sections[dynsymSec.link]) : { syms: [] as Sym[], truncated: false }
    const stripped = hasSections ? !symtabSec : null
    const imports = dynRes.syms.filter((s) => s.shndx === 0 && s.name)
    const exports = dynRes.syms.filter((s) => s.shndx !== 0 && (s.bind === 1 || s.bind === 2) && s.name && s.type !== 4)
    const jni = exports.filter((s) => s.name.startsWith('Java_') || s.name === 'JNI_OnLoad' || s.name === 'JNI_OnUnload')
    const importNames = imports.map((s) => s.name)

    let localFunctions: string[] = []
    let symtabCount = 0
    if (symtabSec) {
      const res = readSymbols(r, symtabSec, sections[symtabSec.link])
      symtabCount = res.syms.length
      localFunctions = res.syms.filter((s) => s.type === 2 && s.shndx !== 0 && s.name).map((s) => s.name).slice(0, MAX_SYMBOLS_LISTED)
    }

    // ---------- hardening (จากข้อมูลจริงใน header/symbol เท่านั้น) ----------
    const stackSeg = phdrs.find((p) => p.type === 0x6474e551)
    const relroSeg = phdrs.find((p) => p.type === 0x6474e552)
    const hardening = {
      position_independent: eType === 3,
      nx_stack: stackSeg ? (stackSeg.flags & 1) === 0 : null,
      relro: relroSeg ? (dyn?.bindNow ? 'full' : 'partial') : phdrs.length > 0 ? 'none' : null,
      stack_protector: dynsymSec ? importNames.some((n) => n === '__stack_chk_fail' || n === '__stack_chk_guard') : null,
      fortify_source: dynsymSec ? importNames.some((n) => /^__\w+_chk$/.test(n)) : null,
      note: 'ตัวบ่งชี้เหล่านี้อนุมานจาก header และชื่อ symbol ที่นำเข้า ไม่ใช่การตรวจโค้ดจริง null = ข้อมูลไม่พอ',
    }

    // ---------- identity ----------
    const noteSec = sections.find((s) => s.type === SHT.NOTE && s.name === '.note.gnu.build-id')
    const commentSec = sections.find((s) => s.name === '.comment')
    const comment = commentSec
      ? r.b.subarray(commentSec.offset, Math.min(commentSec.offset + Math.min(commentSec.size, 4096), b.length))
      : null
    const compilers = comment
      ? [...new Set(new TextDecoder('utf-8').decode(comment).split('\0').map((x) => x.trim()).filter(Boolean))].slice(0, 6).map((x) => x.slice(0, 240))
      : []

    // ---------- strings ----------
    let ranges: [number, number][]
    if (hasSections) {
      ranges = sections
        .filter((s) => s.type === SHT.PROGBITS && (s.flags & SHF_ALLOC) !== 0 && (s.flags & SHF_EXEC) === 0 && (s.name.startsWith('.rodata') || s.name.startsWith('.data')))
        .map((s) => [s.offset, s.offset + s.size] as [number, number])
    } else {
      ranges = phdrs.filter((p) => p.type === 1 && (p.flags & 1) === 0).map((p) => [p.offset, p.offset + p.filesz] as [number, number])
    }
    if (ranges.length === 0) {
      ranges = [[0, b.length]]
      notes.push('ไม่พบส่วนข้อมูลแบบอ่านอย่างเดียวให้สแกนสตริงโดยเฉพาะ จึงสแกนทั้งไฟล์ (อาจมีสตริงปะปนจากส่วนโค้ด)')
    }
    const strings = scanStrings(b, ranges)
    if (strings.scanned_bytes >= MAX_STRING_SCAN_BYTES) notes.push('สแกนสตริงครบเพดานขนาดแล้ว อาจยังมีสตริงในส่วนท้ายที่ไม่ได้สแกน')
    if (dynRes.truncated) notes.push(`ตาราง dynamic symbol ใหญ่เกิน ${MAX_SYMBOL_ROWS} แถว อ่านเฉพาะส่วนต้น`)
    if (stripped === true) notes.push('ไฟล์ถูก strip (ไม่มี .symtab) จึงไม่มีชื่อฟังก์ชันภายใน เหลือเฉพาะ symbol ที่ export/import แบบ dynamic')

    const mach = MACHINES[machine] ?? `0x${machine.toString(16)}`
    const typeLabel = TYPES[eType] ?? `type ${eType}`
    const summaryParts = [`${mach} ${r.is64 ? '64-bit' : '32-bit'}`, typeLabel]
    if (dyn?.soname) summaryParts.push(`soname ${dyn.soname}`)
    summaryParts.push(`export ${exports.length} (JNI ${jni.length}) · import ${imports.length}`)
    if (dyn?.needed.length) summaryParts.push(`ต้องใช้ ${dyn.needed.join(', ')}`)
    if (stripped !== null) summaryParts.push(stripped ? 'strip แล้ว' : 'มี .symtab')

    return {
      summary: summaryParts.join(' · '),
      data: {
        name: input.name,
        file: {
          class: r.is64 ? '64-bit' : '32-bit',
          endianness: r.le ? 'little' : 'big',
          type: typeLabel,
          machine: mach,
          os_abi: OSABI[b[7] as number] ?? String(b[7]),
          entry_point: entry,
          size_bytes: b.length,
          has_section_headers: hasSections,
        },
        hardening,
        identity: {
          soname: dyn?.soname ?? '',
          build_id: noteSec ? parseBuildId(r, noteSec) : '',
          compiler_comments: compilers,
        },
        dependencies: {
          needed_libraries: dyn?.needed ?? [],
          rpath: dyn?.rpath ?? '',
          runpath: dyn?.runpath ?? '',
        },
        counts: {
          sections: sections.length,
          program_headers: phdrs.length,
          dynamic_symbols: dynRes.syms.length,
          exported_symbols: exports.length,
          imported_symbols: imports.length,
          jni_exports: jni.length,
          symtab_symbols: symtabCount,
          strings_found: strings.total,
        },
        stripped,
        // สรุปทั้งตาราง symbol (ไม่ใช่แค่ตัวอย่าง): ตระกูลชื่อที่พบมากสุด และ section ที่ชื่อไม่ขึ้นต้นด้วยจุด (ไม่ใช่ section มาตรฐาน)
        export_families: topFamilies(exports.map((s) => s.name), 12),
        import_families: topFamilies(importNames, 12),
        unusual_sections: sections.filter((s) => s.name && !s.name.startsWith('.')).map((s) => ({ name: s.name, size: s.size })).slice(0, 20),
        notes,
        jni_exports: jni.slice(0, MAX_SYMBOLS_LISTED).map((s) => s.name),
        interesting_strings: {
          urls: strings.urls,
          ip_like: strings.ip_like,
          paths: strings.paths,
          library_references: strings.libraries,
          note: 'ip_like อาจเป็นเลขเวอร์ชันหรือค่าคงที่ ไม่ได้แปลว่าเป็นที่อยู่เครือข่ายจริง',
        },
        imported_symbols: importNames.slice(0, MAX_SYMBOLS_LISTED),
        imported_symbols_truncated: importNames.length > MAX_SYMBOLS_LISTED,
        exported_symbols: exports.slice(0, MAX_SYMBOLS_LISTED).map((s) => ({ name: s.name, type: s.type === 2 ? 'FUNC' : s.type === 1 ? 'OBJECT' : `type${s.type}`, size: s.size, address: s.value })),
        exported_symbols_truncated: exports.length > MAX_SYMBOLS_LISTED,
        local_function_symbols: localFunctions,
        string_sample: strings.sample,
        program_headers: phdrs.slice(0, 40).map((p) => ({ type: PT[p.type] ?? `0x${p.type.toString(16)}`, flags: `${p.flags & 4 ? 'R' : '-'}${p.flags & 2 ? 'W' : '-'}${p.flags & 1 ? 'X' : '-'}`, file_offset: p.offset, file_size: p.filesz, memory_size: p.memsz })),
        sections: sections.slice(0, MAX_SECTIONS_LISTED).map((s) => ({ name: s.name, type: SHT_NAMES[s.type] ?? `0x${s.type.toString(16)}`, flags: `${s.flags & SHF_ALLOC ? 'A' : ''}${s.flags & SHF_WRITE ? 'W' : ''}${s.flags & SHF_EXEC ? 'X' : ''}`, size: s.size })),
      },
    }
  } catch (e) {
    if (e instanceof ElfFormatError) throw e
    // อ่านเกินขอบเขตข้อมูล (DataView) = โครงสร้างในไฟล์เสียหายหรือถูกตัด
    throw new ElfFormatError('โครงสร้างของไฟล์ ELF เสียหายหรือถูกตัด จึงอ่านต่อไม่ได้')
  }
}

// ---------- ELF ตัวอย่างขนาดเล็กสำหรับ self-test (สร้างในหน่วยความจำ ทั้ง 32 และ 64 บิต) ----------
export function buildSampleElf(is64: boolean): Uint8Array {
  const enc = new TextEncoder()
  const strs = (list: string[]) => {
    const offs: number[] = []
    const out: number[] = [0]
    for (const s of list) { offs.push(out.length); out.push(...enc.encode(s), 0) }
    return { bytes: new Uint8Array(out), offs }
  }
  const dynstr = strs(['libc.so', 'libtest.so', 'puts', 'Java_test_hello'])
  const names = ['.dynstr', '.dynsym', '.dynamic', '.shstrtab']
  const shstr = strs(names)

  const w = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => Math.floor(n / 2 ** (8 * i)) & 0xff)
  const word = (n: number) => w(n, is64 ? 8 : 4)

  const symEnt = is64 ? 24 : 16
  const sym = (nameOff: number, info: number, shndx: number, value: number, size: number) =>
    is64 ? [...w(nameOff, 4), info, 0, ...w(shndx, 2), ...word(value), ...word(size)] : [...w(nameOff, 4), ...word(value), ...word(size), info, 0, ...w(shndx, 2)]
  const dynsym = new Uint8Array([
    ...new Array(symEnt).fill(0),
    ...sym(dynstr.offs[2]!, 0x12, 0, 0, 0), // puts: GLOBAL FUNC, UND
    ...sym(dynstr.offs[3]!, 0x12, 1, 0x1000, 16), // Java_test_hello: GLOBAL FUNC, defined
  ])
  const dynamic = new Uint8Array([
    ...word(1), ...word(dynstr.offs[0]!), // DT_NEEDED libc.so
    ...word(14), ...word(dynstr.offs[1]!), // DT_SONAME libtest.so
    ...word(0), ...word(0), // DT_NULL
  ])

  const ehsize = is64 ? 64 : 52
  const shentsize = is64 ? 64 : 40
  const blobs = [dynstr.bytes, dynsym, dynamic, shstr.bytes]
  const offsets: number[] = []
  let cur = ehsize
  for (const bl of blobs) { cur = (cur + 7) & ~7; offsets.push(cur); cur += bl.length }
  const shoff = (cur + 7) & ~7
  const total = shoff + shentsize * 5
  const out = new Uint8Array(total)
  out.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, 1, 1, 0])
  out.set(w(3, 2), 16) // ET_DYN
  out.set(w(is64 ? 0xb7 : 0x28, 2), 18) // ARM64 / ARM
  out.set(w(1, 4), 20)
  if (is64) {
    out.set(w(shoff, 8), 40); out.set(w(64, 2), 52); out.set(w(0, 2), 54); out.set(w(0, 2), 56)
    out.set(w(64, 2), 58); out.set(w(5, 2), 60); out.set(w(4, 2), 62)
  } else {
    out.set(w(shoff, 4), 32); out.set(w(52, 2), 40); out.set(w(0, 2), 42); out.set(w(0, 2), 44)
    out.set(w(40, 2), 46); out.set(w(5, 2), 48); out.set(w(4, 2), 50)
  }
  blobs.forEach((bl, i) => out.set(bl, offsets[i]!))

  const sh = (nameOff: number, type: number, flags: number, offset: number, size: number, link: number, entsize: number) =>
    is64
      ? [...w(nameOff, 4), ...w(type, 4), ...w(flags, 8), ...w(0, 8), ...w(offset, 8), ...w(size, 8), ...w(link, 4), ...w(0, 4), ...w(8, 8), ...w(entsize, 8)]
      : [...w(nameOff, 4), ...w(type, 4), ...w(flags, 4), ...w(0, 4), ...w(offset, 4), ...w(size, 4), ...w(link, 4), ...w(0, 4), ...w(8, 4), ...w(entsize, 4)]
  const headers = [
    new Array(shentsize).fill(0),
    sh(shstr.offs[0]!, 3, 2, offsets[0]!, dynstr.bytes.length, 0, 0), // .dynstr
    sh(shstr.offs[1]!, 11, 2, offsets[1]!, dynsym.length, 1, symEnt), // .dynsym (link -> .dynstr)
    sh(shstr.offs[2]!, 6, 3, offsets[2]!, dynamic.length, 1, is64 ? 16 : 8), // .dynamic (link -> .dynstr)
    sh(shstr.offs[3]!, 3, 0, offsets[3]!, shstr.bytes.length, 0, 0), // .shstrtab
  ]
  headers.forEach((h, i) => out.set(h, shoff + i * shentsize))
  return out
}

function selfTest(is64: boolean): string | null {
  const r = inspectElf({ bytes: buildSampleElf(is64), name: 'self-test.so' })
  const d = r.data as {
    file: { class: string }
    dependencies: { needed_libraries: string[] }
    identity: { soname: string }
    imported_symbols: string[]
    jni_exports: string[]
    counts: { exported_symbols: number }
  }
  if (d.file.class !== (is64 ? '64-bit' : '32-bit')) return `class ไม่ตรง (${is64 ? 64 : 32}-bit)`
  if (d.dependencies.needed_libraries.join() !== 'libc.so') return 'อ่าน DT_NEEDED ไม่ถูกต้อง'
  if (d.identity.soname !== 'libtest.so') return 'อ่าน DT_SONAME ไม่ถูกต้อง'
  if (d.imported_symbols.join() !== 'puts') return 'อ่าน import symbol ไม่ถูกต้อง'
  if (d.jni_exports.join() !== 'Java_test_hello' || d.counts.exported_symbols !== 1) return 'อ่าน export/JNI symbol ไม่ถูกต้อง'
  return null
}

export const elfInspectAdapter: ToolAdapter = {
  version: VERSION,
  descriptor: {
    id: 'elf-inspect',
    name: 'ELF Inspect',
    description:
      'อ่านโครงสร้างภายในของไฟล์ ELF (.so / executable): สถาปัตยกรรม ไลบรารีที่ต้องใช้ ฟังก์ชันที่ export/import (รวม JNI) ' +
      'มาตรการป้องกัน (PIE/NX/RELRO/stack protector) และสตริงสำคัญ เช่น URL และพาธ โดยไม่รันหรือถอดรหัสโค้ด (ไม่ใช่ Disassembler/Decompiler)',
    executionMode: 'builtin',
    fileKinds: ['elf'],
    limits: { maxInputBytes: MAX_ARTIFACT_BYTES, timeoutMs: BUILTIN_TIMEOUT_MS },
  },
  async probe(): Promise<ToolProbe> {
    try {
      const failure = selfTest(true) ?? selfTest(false)
      return {
        installed: true,
        healthy: failure === null,
        version: VERSION,
        detail: failure === null ? 'self-test ผ่าน (ELF ตัวอย่าง 64-bit และ 32-bit)' : `self-test ไม่ผ่าน: ${failure}`,
      }
    } catch (e) {
      return { installed: true, healthy: false, version: VERSION, detail: `self-test error: ${(e as Error).message}` }
    }
  },
  async run(input) {
    return inspectElf(input)
  },
}
