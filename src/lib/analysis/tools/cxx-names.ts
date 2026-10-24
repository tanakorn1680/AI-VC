/**
 * ถอดชื่อ C++ (Itanium ABI) แบบย่อ สำหรับงานสรุปให้ AI อ่าน
 * - เอาเฉพาะ "ชื่อเต็มของ entity" (namespace::Class::method) ไม่ถอดชนิดพารามิเตอร์/ชนิดที่ return
 * - template argument แทนด้วย <> เพื่อให้ instantiation ต่าง ๆ ของคลาสเดียวกันรวมเป็นชื่อเดียว
 * - ไม่แน่ใจเมื่อไรคืน null (ไม่เดา) — ผู้เรียกต้องรับมือกับ null
 * ใช้กับ 2 แหล่ง: (1) ชื่อ symbol `_Z...` (2) สตริง RTTI ใน .rodata (typeinfo name เช่น "N4Game8CityViewE") ซึ่งยังอยู่ในไฟล์ที่ strip แล้ว
 */

const OPS: Record<string, string> = {
  nw: ' new', na: ' new[]', dl: ' delete', da: ' delete[]', ps: '+', ng: '-', ad: '&', de: '*', co: '~', pl: '+', mi: '-', ml: '*',
  dv: '/', rm: '%', an: '&', or: '|', eo: '^', aS: '=', pL: '+=', mI: '-=', mL: '*=', dV: '/=', rM: '%=', aN: '&=', oR: '|=', eO: '^=',
  ls: '<<', rs: '>>', lS: '<<=', rS: '>>=', eq: '==', ne: '!=', lt: '<', gt: '>', le: '<=', ge: '>=', ss: '<=>', nt: '!', aa: '&&',
  oo: '||', pp: '++', mm: '--', cm: ',', pm: '->*', pt: '->', cl: '()', ix: '[]', qu: '?:',
}

const STD_SUBST: Record<string, string> = {
  Sa: 'std::allocator', Sb: 'std::basic_string', Ss: 'std::string', Si: 'std::istream', So: 'std::ostream', Sd: 'std::iostream',
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'
const isSubstChar = (c: string | undefined) => c !== undefined && ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z'))

function readIdent(s: string, i: number): { id: string; end: number } | null {
  let j = i
  while (j < s.length && isDigit(s[j])) j++
  if (j === i || j - i > 4) return null
  const n = Number(s.slice(i, j))
  if (n <= 0 || j + n > s.length) return null
  return { id: s.slice(j, j + n), end: j + n }
}

const prettyIdent = (id: string) => (/^_GLOBAL__N_\d*$/.test(id) ? '(anonymous)' : id)

/** ข้าม template argument `I...E` โดยนับวงเล็บ; คืนตำแหน่งหลัง `E` ที่ปิด หรือ -1 เมื่ออ่านไม่ได้ */
function skipTemplateArgs(s: string, start: number): number {
  let i = start
  let depth = 0
  const n = s.length
  while (i < n) {
    const c = s[i]!
    if (isDigit(c)) {
      const id = readIdent(s, i)
      if (!id) return -1
      i = id.end
      continue
    }
    switch (c) {
      case 'I': case 'N': case 'X': case 'J': case 'F': case 'Z':
        depth++
        i++
        break
      case 'E':
        depth--
        i++
        if (depth === 0) return i
        break
      case 'L': {
        // literal: L <type> <value> E (ค่าเป็นตัวเลข/hex ไม่ใช่ความยาวชื่อ จึงต้องข้ามเอง)
        i++
        if (s[i] === '_' && s[i + 1] === 'Z') {
          depth++
          i += 2
          break
        }
        if (isDigit(s[i])) {
          const id = readIdent(s, i)
          if (!id) return -1
          i = id.end
        } else if (s[i] === 'N') {
          const nested = parseNested(s, i)
          if (!nested) return -1
          i = nested.end
        } else if (s[i] === 'S') {
          i++
          if (s[i] === 't') i++
          else {
            while (i < n && isSubstChar(s[i])) i++
            if (s[i] !== '_') return -1
            i++
          }
        } else if (s[i] === 'D') i += 2
        else i += 1
        while (i < n && s[i] !== 'E') i++
        if (i >= n) return -1
        i++
        break
      }
      case 'S':
        i++
        if (s[i] === 't' || s[i] === 'a' || s[i] === 'b' || s[i] === 's' || s[i] === 'i' || s[i] === 'o' || s[i] === 'd') i++
        else {
          while (i < n && isSubstChar(s[i])) i++
          if (s[i] !== '_') return -1
          i++
        }
        break
      case 'A': // อาร์เรย์: A <ขนาด> _ <ชนิด> — ขนาดเป็นตัวเลขไม่ใช่ความยาวชื่อ
        i++
        while (i < n && isDigit(s[i])) i++
        if (s[i] === '_') i++
        break
      case 'T': // template parameter T_ / T0_
        i++
        while (i < n && isDigit(s[i])) i++
        if (s[i] === '_') i++
        break
      case 'D': {
        const c2 = s[i + 1]
        if (c2 === 'v') {
          while (i < n && s[i] !== '_') i++
          i++
        } else if (c2 === 't' || c2 === 'T' || c2 === 'O' || c2 === 'w') {
          depth++
          i += 2
        } else i += 2
        break
      }
      case 'U':
        if (s[i + 1] === 'l') depth++
        i += 2
        break
      default:
        i++
    }
  }
  return -1
}

interface NameRes {
  parts: string[]
  end: number
  ctorOf?: string
  dtorOf?: string
}

const stripTemplate = (p: string) => p.replace(/<>$/, '')

function parseNested(s: string, i: number): NameRes | null {
  let j = i + 1
  while (s[j] === 'r' || s[j] === 'V' || s[j] === 'K') j++
  if (s[j] === 'R' || s[j] === 'O') j++
  const parts: string[] = []
  let ctorOf: string | undefined
  let dtorOf: string | undefined
  for (let guard = 0; guard < 64 && j < s.length; guard++) {
    const c = s[j]!
    if (c === 'E') return parts.length > 0 ? { parts, end: j + 1, ctorOf, dtorOf } : null
    if (isDigit(c)) {
      const id = readIdent(s, j)
      if (!id) return null
      parts.push(prettyIdent(id.id))
      j = id.end
      continue
    }
    if (c === 'I') {
      const e = skipTemplateArgs(s, j)
      if (e < 0 || parts.length === 0) return null
      const last = parts.length - 1
      if (!parts[last]!.endsWith('<>')) parts[last] += '<>'
      j = e
      continue
    }
    if (c === 'S') {
      if (s[j + 1] === 't') {
        parts.push('std')
        j += 2
        continue
      }
      const std = STD_SUBST[s.slice(j, j + 2)]
      if (std) {
        parts.push(...std.split('::'))
        j += 2
        continue
      }
      let k = j + 1
      while (k < s.length && isSubstChar(s[k])) k++
      if (s[k] !== '_') return null
      parts.push('…') // อ้างถึงชื่อที่เคยปรากฏ — ไม่ย้อนกลับไปถอด
      j = k + 1
      continue
    }
    if (c === 'C' && (s[j + 1] === '1' || s[j + 1] === '2' || s[j + 1] === '3')) {
      const owner = stripTemplate(parts[parts.length - 1] ?? '')
      if (!owner || owner === '…') return null
      parts.push(owner)
      ctorOf = owner
      j += 2
      continue
    }
    if (c === 'D' && s[j + 1] !== undefined && s[j + 1]! >= '0' && s[j + 1]! <= '5') {
      const owner = stripTemplate(parts[parts.length - 1] ?? '')
      if (!owner || owner === '…') return null
      parts.push(`~${owner}`)
      dtorOf = owner
      j += 2
      continue
    }
    if (c === 'B') {
      const t = readIdent(s, j + 1)
      if (!t) return null
      j = t.end
      continue
    }
    if (c === 'L') {
      j++
      continue
    }
    if (c >= 'a' && c <= 'z') {
      const two = s.slice(j, j + 2)
      if (two === 'cv') {
        parts.push('operator cast')
        return { parts, end: j + 2 }
      }
      const op = OPS[two]
      if (!op) return null
      parts.push(`operator${op}`)
      j += 2
      continue
    }
    if (c === 'a' || c === 'o' || c === 'd' || c === 'p' || c === 'n') return null
    return null
  }
  return null
}

function parseName(s: string, i: number): NameRes | null {
  const c = s[i]
  if (c === 'N') return parseNested(s, i)
  const parts: string[] = []
  let j = i
  if (c === 'S' && s[j + 1] === 't') {
    parts.push('std')
    j += 2
  }
  const id = readIdent(s, j)
  if (!id) return null
  parts.push(prettyIdent(id.id))
  j = id.end
  if (s[j] === 'I') {
    const e = skipTemplateArgs(s, j)
    if (e < 0) return null
    parts[parts.length - 1] += '<>'
    j = e
  }
  while (s[j] === 'B') {
    const t = readIdent(s, j + 1)
    if (!t) break
    j = t.end
  }
  return { parts, end: j }
}

export type DemangledKind = 'symbol' | 'ctor' | 'dtor' | 'vtable' | 'typeinfo'

export interface Demangled {
  /** ชื่อเต็ม เช่น Game::CityView::Update */
  name: string
  /** ส่วนหน้าสุดท้าย (namespace หรือคลาส) เช่น Game::CityView — ว่างถ้าเป็นฟังก์ชันอิสระ */
  scope: string
  /** ชื่อสุดท้าย เช่น Update */
  leaf: string
  kind: DemangledKind
  /** คลาสที่ยืนยันได้ (จาก constructor/destructor/vtable/typeinfo) */
  owner?: string
}

/** ถอดชื่อ symbol `_Z...`; คืน null ถ้าไม่ใช่ชื่อ C++ หรือถอดไม่ได้อย่างมั่นใจ */
export function demangle(sym: string): Demangled | null {
  if (sym.charCodeAt(0) !== 95 || sym.charCodeAt(1) !== 90 || sym.length < 4) return null // "_Z"
  if (sym[2] === 'T') {
    const k = sym[3]
    if (k !== 'V' && k !== 'I' && k !== 'S') return null
    const r = parseName(sym, 4)
    if (!r) return null
    const name = r.parts.join('::')
    return { name, scope: name, leaf: r.parts[r.parts.length - 1]!, kind: k === 'V' ? 'vtable' : 'typeinfo', owner: name }
  }
  if (sym[2] === 'G' || sym[2] === 'Z') return null // guard variable / ชื่อภายในฟังก์ชัน
  const r = parseName(sym, 2)
  if (!r) return null
  const name = r.parts.join('::')
  const scope = r.parts.slice(0, -1).join('::')
  const kind: DemangledKind = r.ctorOf ? 'ctor' : r.dtorOf ? 'dtor' : 'symbol'
  const owner = r.ctorOf ?? r.dtorOf
  return {
    name,
    scope,
    leaf: r.parts[r.parts.length - 1]!,
    kind,
    ...(owner ? { owner: r.parts.slice(0, -1).join('::') } : {}),
  }
}

/**
 * ถอดสตริง RTTI (typeinfo name) ที่เป็นชื่อชนิดแบบ mangled ไม่มี `_Z` นำหน้า เช่น "10CBuilding", "N4Game8CityViewE"
 * ต้องอ่านได้ตลอดทั้งสตริงจึงนับ (ลดการจับสตริงทั่วไปผิด) — คืนชื่อคลาสเต็มหรือ null
 */
export function demangleTypeName(s: string): string | null {
  if (s.length < 4 || s.length > 400) return null
  const c = s.charCodeAt(0)
  const startsOk = c === 78 || c === 83 || (c >= 48 && c <= 57) // N, S, digit
  if (!startsOk) return null
  const r = parseName(s, 0)
  if (!r || r.end !== s.length || r.ctorOf || r.dtorOf) return null
  if (r.parts.some((p) => p === '…' || p.length < 2)) return null
  const first = stripTemplate(r.parts[r.parts.length - 1]!)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(first)) return null
  return r.parts.join('::')
}

/** ชื่อที่เป็นของ C++ runtime/stdlib — ไม่นับเป็นคลาสของตัวโปรแกรม */
export const isRuntimeName = (name: string) =>
  name.startsWith('std::') || name === 'std' || name.startsWith('__cxxabiv1') || name.startsWith('__gnu') || name.startsWith('__ndk1') || name.startsWith('__1::')
