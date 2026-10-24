import { unzipSync } from 'fflate'
import { MAX_ARTIFACT_BYTES } from '../limits'
import type { ToolAdapter, ToolInput, ToolProbe, ToolResult } from '../tool-adapter'
import { demangle, demangleTypeName, isRuntimeName } from './cxx-names'
import { ElfFormatError, buildSampleElf, readElfNames } from './elf-inspect'
import { readZipEntries } from './zip-inventory'

const VERSION = '1.0.0'
const MAX_MEMBERS = 40
const MAX_MEMBER_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const TIME_BUDGET_MS = 20_000
const TOOL_TIMEOUT_MS = 25_000
/** ขนาดผลลัพธ์ (JSON ย่อ) ที่ตั้งเป้า — ต้องต่ำกว่างบที่ AI อ่านได้ต่อหนึ่ง run (96,000 ตัวอักษร) */
const OUTPUT_BUDGET_CHARS = 78_000
const MAX_SCAN_BYTES = 40 * 1024 * 1024
const MIN_RUN = 4 // สตริงสั้นสุดที่สนใจ (สำหรับชื่อคลาส RTTI)
const MAX_RUN = 600
const MIN_TEXT = 8 // สตริงข้อความทั่วไปต้องยาวอย่างน้อยเท่านี้

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const isCandidate = (n: string) => /\.so(\.\d+)*$/i.test(n) || /(^|\/)lib\/[^/]+\/[^/]+$/.test(n)
const isElf = (b: Uint8Array) => b.length > 52 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46

// ---------- หัวข้อ (จัดกลุ่มสตริงด้วยคำสำคัญ — เป็นการเดาจากข้อความ ไม่ใช่การยืนยันพฤติกรรม) ----------
const TOPICS: { id: string; re: RegExp }[] = [
  { id: 'network', re: /\b(?:socket|ssl|tls|https?|curl|dns|proxy|certificate|handshake|websocket|connection|hostname|endpoint|download|upload)\b/i },
  { id: 'crypto', re: /\b(?:aes|rsa|sha-?\d*|md5|hmac|crc-?32|cipher|encrypt\w*|decrypt\w*|signature|x509|pkcs\d*|base64|obfuscat\w*|checksum|digest|nonce|secret|private key|public key)\b/i },
  { id: 'integrity', re: /\b(?:rooted|jailbr\w+|emulator|xposed|frida|substrate|debugger|tamper\w*|safetynet|play ?integrity|attest\w*|cheat\w*|anti-?cheat|anti-?debug|magisk|tracerpid|piracy|pirated|genuine)\b|\/proc\/self\/|isroot|ptrace/i },
  { id: 'storage', re: /\b(?:save[ds]?|savegame|persist\w*|database|sqlite\w*|backup|restore[ds]?|snapshot|serializ\w+|deserializ\w+|checkpoint|cache[ds]?|preferences?|keychain)\b|\.(?:db|sav|dat|sqlite)\b/i },
  { id: 'formats', re: /\b(?:json|xml|protobuf|plist|lua|yaml|csv|zlib|gzip|lz4|zstd|msgpack)\b/i },
  { id: 'purchase', re: /\b(?:purchase[ds]?|iap|billing|receipt|currency|premium|subscription|entitlement|transaction|price|checkout|refund|sku|voucher|coupon)\b/i },
  { id: 'game', re: /\b(?:simoleons?|simcash|simcity|city|building|population|mayor|neighbou?r|club|trade|market|warehouse|factory|production|resource|upgrade|disaster|region|citizen|quest|reward|achievement|leaderboard|inventory|player|score|multiplayer|matchmak\w*)\b/i },
  { id: 'telemetry', re: /\b(?:analytics|telemetry|tracking|advertis\w*|idfa|gaid|android_?id|device_?id|udid|user_?id|session|metrics?|consent|gdpr|privacy|attribution|campaign)\b/i },
]

// ---------- ความสามารถที่อนุมานจากชื่อฟังก์ชันที่ import (ข้อเท็จจริงจากตาราง symbol ไม่ใช่การเดา) ----------
const CAPABILITIES: { id: string; re: RegExp }[] = [
  { id: 'network', re: /^(?:socket|connect|bind|listen|accept|accept4|send|sendto|sendmsg|recv|recvfrom|recvmsg|getaddrinfo|gethostbyname|freeaddrinfo|getsockopt|setsockopt|getsockname|getpeername|shutdown|inet_\w+|SSL_\w+|TLS_\w+|X509_\w+|BIO_\w+|curl_\w+)$/ },
  { id: 'crypto', re: /^(?:EVP_\w+|AES_\w+|SHA\d*_\w+|MD5_\w+|HMAC\w*|RSA_\w+|EC_\w+|ECDSA_\w+|RAND_\w+|PKCS\w+|CRYPTO_\w+|BN_\w+|DES_\w+|arc4random\w*|getrandom)$/ },
  { id: 'filesystem', re: /^(?:open|open64|openat|fopen|fopen64|fread|fwrite|lseek|lseek64|stat|stat64|fstat|fstat64|lstat|access|unlink|remove|rename|mkdir|rmdir|opendir|readdir|readdir64|mmap|mmap64|ftruncate|fsync|realpath|statfs\w*|AAssetManager_\w+|AAsset_\w+)$/ },
  { id: 'process_and_debug', re: /^(?:ptrace|fork|vfork|execve|execv|execvp|execl\w*|system|popen|kill|raise|prctl|syscall|mprotect|inotify_\w+|__system_property_get|waitpid|clone)$/ },
  { id: 'dynamic_loading', re: /^(?:dlopen|dlsym|dladdr|dlclose|dl_iterate_phdr|android_dlopen_ext)$/ },
]

// ---------- สกัดข้อมูลจากสตริง ----------
const URL_RE = /\b(?:https?|wss?|ftp):\/\/([^\s/'"<>\\:?#]{3,100})[^\s'"<>\\]{0,160}/gi
const TOKEN_RE = /[^\s'"<>()[\],;=|*?!]{4,200}/g
const QUALIFIED_RE = /\b[A-Za-z_]\w*(?:::~?[A-Za-z_]\w*)+/g
const SRC_EXT_RE = /\.(?:cpp|cc|cxx|c|h|hpp|hh|inl|mm|m|java|kt|lua)$/i
const FILE_EXT_RE = /\.(json|xml|plist|db|sqlite|dat|sav|bin|png|jpg|jpeg|ogg|mp3|wav|tga|pvr|csv|txt|cfg|ini|zip|pak|obb|dex|apk|ttf|otf|atlas|group|tmx|bundle|manifest|cer|pem|crt|html|js|mp4|webp)$/i
const JAVA_RE = /^L?(?:com|org|net|io|android|androidx|java|javax|kotlin|dalvik)\/[\w$]+(?:\/[\w$]+)+;?$/
const RTTI_CHARS = /^[A-Za-z0-9_]+$/

function meaningful(s: string): boolean {
  if (s.length < MIN_TEXT || s.length > 220) return false
  let alpha = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 32) alpha++
  }
  return alpha / s.length >= 0.6 && !/(.)\1{5,}/.test(s)
}

/** Reservoir sampling แบบกำหนดผลได้ (ไม่ใช้ Math.random) — ได้ตัวอย่างกระจายทั่วไฟล์ ไม่กระจุกอยู่ต้นไฟล์ */
class Reservoir {
  items: string[] = []
  seen = 0
  private x: number
  constructor(private cap: number, seed: number) {
    this.x = (seed | 0) || 123456789
  }
  private rnd() {
    let x = this.x
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.x = x | 0
    return x >>> 0
  }
  add(s: string) {
    this.seen++
    if (this.items.length < this.cap) this.items.push(s)
    else {
      const j = this.rnd() % this.seen
      if (j < this.cap) this.items[j] = s
    }
  }
}

interface ScopeStat {
  n: number
  methods: Set<string>
}

class LibScan {
  stringsTotal = 0
  scannedBytes = 0
  classes = new Set<string>()
  rtti = new Set<string>()
  scopes = new Map<string, ScopeStat>()
  symbolCount = 0
  capabilities = new Map<string, Set<string>>()
  topicCount = new Map<string, number>()
  topicSamples = new Map<string, Reservoir>()
  qualified = new Set<string>()
  srcDirs = new Map<string, { n: number; files: Set<string> }>()
  javaPkgs = new Map<string, { n: number; classes: Set<string> }>()
  extCount = new Map<string, number>()
  fileSamples = new Set<string>()
  hosts = new Map<string, number>()
  urls = new Set<string>()
  notes: string[] = []

  constructor(readonly path: string, readonly size: number) {
    for (const t of TOPICS) this.topicSamples.set(t.id, new Reservoir(120, size + t.id.length * 7919))
  }

  addRun(s: string) {
    this.stringsTotal++
    const len = s.length
    const c0 = s.charCodeAt(0)

    // ชื่อคลาส RTTI (typeinfo name) — ยังอยู่ในไฟล์ที่ strip แล้ว ถ้าไม่ได้ปิด RTTI ตอนคอมไพล์
    if (len <= 400 && (c0 === 78 || c0 === 83 || (c0 >= 48 && c0 <= 57)) && RTTI_CHARS.test(s)) {
      const t = demangleTypeName(s)
      if (t) {
        if (!isRuntimeName(t) && this.classes.size < 60_000) {
          this.rtti.add(t)
          this.classes.add(t)
        }
        return
      }
    }
    if (len < MIN_TEXT) return
    const text = len > 300 ? s.slice(0, 300) : s

    if (text.includes('://')) {
      URL_RE.lastIndex = 0
      for (const m of text.matchAll(URL_RE)) {
        const host = (m[1] as string).toLowerCase()
        if (this.hosts.has(host) || this.hosts.size < 300) this.hosts.set(host, (this.hosts.get(host) ?? 0) + 1)
        if (this.urls.size < 200) this.urls.add(clip(m[0], 160))
      }
    }

    if (text.includes('::') && this.qualified.size < 3000) {
      for (const m of text.matchAll(QUALIFIED_RE)) {
        const q = m[0]
        if (q.length >= 6 && q.length <= 120 && !isRuntimeName(q)) this.qualified.add(q)
      }
    }

    if (text.includes('.') || text.includes('/')) {
      for (const m of text.matchAll(TOKEN_RE)) {
        const tok = m[0].replace(/(?::\d+)?[:;,.]*$/, '').replace(/^["']+|["']+$/g, '')
        if (tok.length < 4) continue
        if (SRC_EXT_RE.test(tok) && /[A-Za-z]{2}/.test(tok)) {
          const norm = tok.replace(/^(?:\.\.?\/)+/, '')
          const slash = norm.lastIndexOf('/')
          const dir = slash >= 0 ? norm.slice(0, slash) : '(ไม่ระบุโฟลเดอร์)'
          let d = this.srcDirs.get(dir)
          if (!d && this.srcDirs.size < 2000) {
            d = { n: 0, files: new Set() }
            this.srcDirs.set(dir, d)
          }
          if (d) {
            d.n++
            if (d.files.size < 40) d.files.add(norm.slice(slash + 1))
          }
        } else if (JAVA_RE.test(tok)) {
          const cls = tok.replace(/^L/, '').replace(/;$/, '')
          const pkg = cls.split('/').slice(0, 3).join('/')
          let p = this.javaPkgs.get(pkg)
          if (!p && this.javaPkgs.size < 500) {
            p = { n: 0, classes: new Set() }
            this.javaPkgs.set(pkg, p)
          }
          if (p) {
            p.n++
            if (p.classes.size < 30) p.classes.add(cls.slice(pkg.length + 1) || cls)
          }
        } else {
          const em = FILE_EXT_RE.exec(tok)
          if (em && /[A-Za-z]/.test(tok.slice(0, -em[0].length))) {
            const ext = (em[1] as string).toLowerCase()
            this.extCount.set(ext, (this.extCount.get(ext) ?? 0) + 1)
            if (this.fileSamples.size < 300) this.fileSamples.add(clip(tok, 100))
          }
        }
      }
    }

    const good = meaningful(text)
    for (const t of TOPICS) {
      if (t.re.test(text)) {
        this.topicCount.set(t.id, (this.topicCount.get(t.id) ?? 0) + 1)
        if (good) this.topicSamples.get(t.id)!.add(text)
      }
    }
  }

  addSymbols(names: string[]) {
    for (const name of names) {
      this.symbolCount++
      if (name.charCodeAt(0) !== 95 || name.charCodeAt(1) !== 90) continue
      const d = demangle(name)
      if (!d || isRuntimeName(d.name)) continue
      if (d.owner && !isRuntimeName(d.owner) && this.classes.size < 60_000) this.classes.add(d.owner)
      if (!d.scope) continue
      let sc = this.scopes.get(d.scope)
      if (!sc) {
        if (this.scopes.size >= 20_000) continue
        sc = { n: 0, methods: new Set() }
        this.scopes.set(d.scope, sc)
      }
      sc.n++
      if (sc.methods.size < 12) sc.methods.add(d.leaf)
    }
  }

  addImports(names: string[]) {
    for (const name of names) {
      for (const c of CAPABILITIES) {
        if (c.re.test(name)) {
          let set = this.capabilities.get(c.id)
          if (!set) {
            set = new Set()
            this.capabilities.set(c.id, set)
          }
          if (set.size < 20) set.add(name)
          break
        }
      }
    }
  }
}

// ---------- สแกนสตริงจากช่วงไบต์ ----------
const LATIN1 = new TextDecoder('latin1')

function scanStrings(b: Uint8Array, ranges: [number, number][], handle: (s: string) => void): number {
  let budget = MAX_SCAN_BYTES
  for (const [start, end] of ranges) {
    const lo = Math.max(0, start)
    const hi = Math.min(b.length, end)
    let runStart = -1
    for (let i = lo; i < hi && budget > 0; i++, budget--) {
      const c = b[i] as number
      if ((c >= 0x20 && c <= 0x7e) || c === 0x09) {
        if (runStart < 0) runStart = i
      } else if (runStart >= 0) {
        if (i - runStart >= MIN_RUN) handle(LATIN1.decode(b.subarray(runStart, Math.min(i, runStart + MAX_RUN))))
        runStart = -1
      }
    }
    if (runStart >= 0 && hi - runStart >= MIN_RUN) handle(LATIN1.decode(b.subarray(runStart, Math.min(hi, runStart + MAX_RUN))))
  }
  return MAX_SCAN_BYTES - budget
}

function scanLibrary(path: string, bytes: Uint8Array): { scan: LibScan; machine: string; stripped: boolean | null; soname: string } {
  const names = readElfNames(bytes)
  const scan = new LibScan(path, bytes.length)
  scan.notes.push(...names.notes)
  scan.addImports(names.imports)
  scan.addSymbols(names.exports)
  scan.addSymbols(names.locals)
  scan.scannedBytes = scanStrings(bytes, names.stringRanges, (s) => scan.addRun(s))
  if (scan.scannedBytes >= MAX_SCAN_BYTES) scan.notes.push('สแกนสตริงครบเพดานขนาดแล้ว อาจยังมีสตริงในส่วนท้ายที่ไม่ได้สแกน')
  if (names.stripped === true) scan.notes.push('ไฟล์ถูก strip จึงไม่มีชื่อฟังก์ชันภายใน ข้อมูลคลาสมาจาก RTTI และ symbol ที่ export เท่านั้น')
  return { scan, machine: names.machine, stripped: names.stripped, soname: names.soname }
}

// ---------- จัดรูปผลลัพธ์ (ปรับความยาวตามขนาดไฟล์และงบรวม) ----------
const WORD = /^(?:[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z][a-z0-9]*)/

/** กลุ่มของคลาสที่ไม่มี namespace: คลาสแบบ C+ตัวใหญ่ใช้ 'C'+คำแรก, อื่น ๆ ใช้คำแรก */
function plainClassGroup(cls: string): string {
  const base = cls.replace(/<>$/, '')
  if (/^C[A-Z]/.test(base)) {
    const w = WORD.exec(base.slice(1))?.[0] ?? base.slice(1)
    return `C${w}*`
  }
  const w = WORD.exec(base)?.[0] ?? base
  return w.length < base.length ? `${w}*` : '(คลาสเดี่ยว)'
}

function classGroupKey(qualified: string): string {
  const parts = qualified.split('::')
  if (parts.length > 1) return parts.slice(0, Math.min(2, parts.length - 1)).join('::').replace(/<>/g, '')
  return plainClassGroup(parts[0]!)
}

/** เลือก k รายการกระจายทั่วลิสต์ที่เรียงแล้ว (ได้ความหลากหลายแทนที่จะได้แต่ตัวอักษรต้นลิสต์) */
function spread<T>(sorted: T[], k: number): T[] {
  if (sorted.length <= k) return sorted
  const out: T[] = []
  for (let i = 0; i < k; i++) out.push(sorted[Math.floor((i * sorted.length) / k)] as T)
  return out
}

function pickSamples(items: string[], k: number): string[] {
  const seen = new Set<string>()
  const uniq: { s: string; score: number }[] = []
  for (const s of items) {
    const key = s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 28)
    if (!key || seen.has(key)) continue
    seen.add(key)
    uniq.push({ s, score: (/\s/.test(s) ? 2 : 0) + (s.length >= 15 && s.length <= 90 ? 1 : 0) })
  }
  uniq.sort((a, b) => b.score - a.score)
  return uniq.slice(0, k).map((u) => clip(u.s.trim(), 130))
}

function libWeight(size: number): number {
  const w = Math.log2(Math.max(size, 1) / 16384) / 8
  return Math.min(1, Math.max(0.3, w * w))
}

interface LibEntry {
  path: string
  size: number
  machine: string
  stripped: boolean | null
  soname: string
  scan: LibScan
}

function formatLibrary(e: LibEntry, scale: number): Record<string, unknown> {
  const s = e.scan
  const w = libWeight(e.size) * scale
  const cap = (base: number) => Math.max(2, Math.round(base * w))

  const out: Record<string, unknown> = {
    path: e.path,
    size_bytes: e.size,
    stripped: e.stripped,
    counts: { strings: s.stringsTotal, classes: s.classes.size, classes_from_rtti: s.rtti.size, symbols_demangled: s.scopes.size },
  }

  if (s.capabilities.size > 0) {
    out.import_capabilities = Object.fromEntries([...s.capabilities.entries()].map(([k, v]) => [k, [...v].slice(0, 10)]))
  }

  // ---- คลาส จัดกลุ่มตาม namespace ----
  if (s.classes.size > 0) {
    const groups = new Map<string, string[]>()
    for (const c of s.classes) {
      const key = classGroupKey(c)
      let g = groups.get(key)
      if (!g) {
        g = []
        groups.set(key, g)
      }
      g.push(c.split('::').pop() as string)
    }
    const multi = [...groups.entries()].filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length)
    const singles = [...groups.entries()].filter(([, v]) => v.length < 2)
    const top = multi.slice(0, cap(24)).map(([ns, names]) => ({
      ns,
      n: names.length,
      sample: spread([...new Set(names)].sort(), cap(6)),
    }))
    const restN = multi.slice(cap(24)).reduce((n, [, v]) => n + v.length, 0) + singles.length
    out.classes = {
      note: 'ชื่อคลาสจาก RTTI และ symbol (vtable/typeinfo/constructor) ไม่รวม std::',
      groups: top,
      other_count: restN,
      other_sample: spread(singles.map(([, v]) => v[0] as string).sort(), cap(10)),
    }
  }

  // ---- ฟังก์ชันที่ export แยกตาม scope ----
  if (s.scopes.size > 0) {
    const top = [...s.scopes.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, cap(14))
      .map(([scope, st]) => ({ scope, n: st.n, sample: [...st.methods].slice(0, cap(5)) }))
    out.symbol_scopes = top
  }

  if (s.qualified.size > 0) {
    out.qualified_names_in_strings = { count: s.qualified.size, sample: spread([...s.qualified].sort(), cap(28)) }
  }

  if (s.srcDirs.size > 0) {
    const top = [...s.srcDirs.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, cap(14))
      .map(([dir, d]) => ({ dir: clip(dir, 90), n: d.n, files: [...d.files].slice(0, cap(4)) }))
    out.source_paths = { dirs: s.srcDirs.size, top }
  }

  if (s.javaPkgs.size > 0) {
    const top = [...s.javaPkgs.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, cap(12))
      .map(([pkg, p]) => ({ pkg, n: p.n, classes: [...p.classes].slice(0, cap(3)) }))
    out.java_references = top
  }

  if (s.hosts.size > 0) {
    out.hosts = [...s.hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, cap(10)).map(([host, n]) => ({ host, n }))
    out.urls = spread([...s.urls].sort(), cap(6))
  }

  if (s.extCount.size > 0) {
    out.file_references = {
      extensions: [...s.extCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([ext, n]) => ({ ext, n })),
      sample: spread([...s.fileSamples].sort(), cap(14)),
    }
  }

  const topics: Record<string, unknown> = {}
  for (const t of TOPICS) {
    const n = s.topicCount.get(t.id) ?? 0
    if (n === 0) continue
    topics[t.id] = { n, sample: pickSamples(s.topicSamples.get(t.id)!.items, cap(10)) }
  }
  if (Object.keys(topics).length > 0) out.string_topics = topics

  if (s.notes.length > 0) out.notes = s.notes
  return out
}

function buildResult(name: string, libs: LibEntry[], candidates: number, skipped: { path: string; size: number; reason: string }[], scale: number) {
  const overview = libs.map((l) => {
    const topics: Record<string, number> = {}
    for (const t of TOPICS) {
      const n = l.scan.topicCount.get(t.id)
      if (n) topics[t.id] = n
    }
    const groups = new Map<string, number>()
    for (const c of l.scan.classes) {
      const k = classGroupKey(c)
      groups.set(k, (groups.get(k) ?? 0) + 1)
    }
    return {
      path: l.path,
      size_bytes: l.size,
      classes: l.scan.classes.size,
      rtti: l.scan.rtti.size,
      topics,
      top_class_groups: [...groups.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} (${n})`),
    }
  })

  const hostMap = new Map<string, { n: number; libs: string[] }>()
  for (const l of libs) {
    for (const [h, n] of l.scan.hosts) {
      const cur = hostMap.get(h) ?? { n: 0, libs: [] }
      cur.n += n
      if (cur.libs.length < 4) cur.libs.push(baseName(l.path))
      hostMap.set(h, cur)
    }
  }
  const hostsAll = [...hostMap.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 40).map(([host, v]) => ({ host, n: v.n, in: v.libs }))

  return {
    name,
    scanned_count: libs.length,
    candidate_count: candidates,
    skipped,
    overview,
    hosts_all: hostsAll,
    libraries: libs.map((l) => formatLibrary(l, scale)),
    note:
      'ผลจากการอ่านสตริงและตารางชื่อในไฟล์ ELF โดยไม่รันโค้ดและไม่ได้ถอดรหัสตรรกะ: ชื่อคลาสมาจาก RTTI/symbol (ถอดชื่อ C++ แบบย่อ ไม่รวมพารามิเตอร์), ' +
      'หัวข้อใน string_topics จัดจากคำสำคัญ (heuristic ไม่ใช่การยืนยันพฤติกรรม), import_capabilities มาจากชื่อฟังก์ชันที่ import จริง, ตัวอย่างสตริงเป็นการสุ่มกระจายทั่วไฟล์ ไม่ใช่รายการครบ',
  }
}

export function inspectNative(input: ToolInput): ToolResult {
  const started = Date.now()
  const libs: LibEntry[] = []
  const skipped: { path: string; size: number; reason: string }[] = []
  let candidates = 0

  if (isElf(input.bytes)) {
    candidates = 1
    const r = scanLibrary(input.name, input.bytes)
    libs.push({ path: input.name, size: input.bytes.length, machine: r.machine, stripped: r.stripped, soname: r.soname, scan: r.scan })
  } else {
    const entries = readZipEntries(input.bytes).filter((e) => !e.name.endsWith('/'))
    const cands = entries.filter((e) => isCandidate(e.name)).sort((a, b) => b.size - a.size) // ตัวใหญ่ก่อน — ถ้าหมดเวลาจะเหลือแต่ไฟล์เล็ก
    candidates = cands.length
    let totalBytes = 0
    for (const e of cands) {
      if (libs.length >= MAX_MEMBERS) {
        skipped.push({ path: e.name, size: e.size, reason: `เกินเพดาน ${MAX_MEMBERS} ไฟล์` })
        continue
      }
      if (Date.now() - started > TIME_BUDGET_MS) {
        skipped.push({ path: e.name, size: e.size, reason: 'หมดเวลาตรวจ' })
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
        const r = scanLibrary(e.name, bytes)
        libs.push({ path: e.name, size: bytes.length, machine: r.machine, stripped: r.stripped, soname: r.soname, scan: r.scan })
      } catch (err) {
        skipped.push({ path: e.name, size: e.size, reason: err instanceof ElfFormatError ? err.message : 'อ่านไฟล์นี้ไม่สำเร็จ' })
      }
    }
  }

  // ปรับความยาวให้อยู่ในงบ: ลดจำนวนตัวอย่างทุกไลบรารีทีละขั้นจนพอดี (ข้อมูลที่รวบรวมไว้ครบเสมอ ตัดเฉพาะตอนจัดรูป)
  let scale = 1
  let result = buildResult(input.name, libs, candidates, skipped, scale)
  for (let k = 0; k < 10 && JSON.stringify(result).length > OUTPUT_BUDGET_CHARS; k++) {
    scale *= 0.75
    result = buildResult(input.name, libs, candidates, skipped, scale)
  }

  const classTotal = libs.reduce((n, l) => n + l.scan.classes.size, 0)
  const rttiTotal = libs.reduce((n, l) => n + l.scan.rtti.size, 0)
  const strTotal = libs.reduce((n, l) => n + l.scan.stringsTotal, 0)
  return {
    summary:
      `สแกนสตริง/ชื่อคลาส ${libs.length}/${candidates} ไฟล์` +
      (skipped.length ? ` (ข้าม ${skipped.length})` : '') +
      ` · คลาส ${classTotal} (จาก RTTI ${rttiTotal}) · สตริง ${strTotal}`,
    data: result as unknown as Record<string, unknown>,
  }
}

export const nativeStringsAdapter: ToolAdapter = {
  version: VERSION,
  descriptor: {
    id: 'native-strings',
    name: 'Native Strings & Class Map',
    description:
      'อ่านชื่อและสตริงในไฟล์ ELF (.so) — ทั้งไฟล์เดี่ยวและทุกไฟล์ใน ZIP/APK (คลายในหน่วยความจำ ไม่รันโค้ด): ถอดชื่อ C++ และอ่านชื่อคลาสจาก RTTI ' +
      '(ใช้ได้แม้ไฟล์ถูก strip) จัดกลุ่มตาม namespace, พาธไฟล์ซอร์สที่ฝังในสตริง, คลาส Java ที่โค้ดเรียก, host/URL, ' +
      'และหัวข้อสตริง (เครือข่าย เข้ารหัส ป้องกันการแก้ไข ไฟล์เซฟ การซื้อ เกม ฯลฯ) พร้อมความสามารถที่อนุมานจากฟังก์ชันที่ import ' +
      'ใช้เมื่อต้องการรู้ว่าไลบรารีนี้ทำอะไร/มีคลาสอะไร (ไม่ใช่ Disassembler/Decompiler)',
    executionMode: 'builtin',
    fileKinds: ['zip', 'elf'],
    limits: { maxInputBytes: MAX_ARTIFACT_BYTES, timeoutMs: TOOL_TIMEOUT_MS },
  },
  async probe(): Promise<ToolProbe> {
    try {
      const d = demangle('_ZN4Game8CityView6UpdateEf')
      if (d?.name !== 'Game::CityView::Update' || d.scope !== 'Game::CityView') throw new Error('ถอดชื่อ C++ ไม่ถูกต้อง')
      if (demangleTypeName('N4Game8CityViewE') !== 'Game::CityView' || demangleTypeName('9CBuilding') !== 'CBuilding') throw new Error('ถอดชื่อ RTTI ไม่ถูกต้อง')
      if (demangleTypeName('Hello world') !== null) throw new Error('จับสตริงทั่วไปเป็น RTTI ผิด')

      const scan = new LibScan('self-test.so', 4096)
      for (const s of [
        'N4Game8CityViewE',
        'Failed to connect to https://api.example.com/v1/login',
        'Game::CityView::Update failed',
        '../src/city/CityView.cpp',
        'com/example/app/NativeBridge',
      ]) {
        scan.addRun(s)
      }
      scan.addImports(['socket', 'connect', 'puts'])
      if (!scan.classes.has('Game::CityView')) throw new Error('ไม่พบคลาสจาก RTTI')
      if (!scan.hosts.has('api.example.com')) throw new Error('ไม่พบ host')
      if (!scan.qualified.has('Game::CityView::Update')) throw new Error('ไม่พบชื่อ qualified')
      if (!scan.srcDirs.has('src/city')) throw new Error('ไม่พบพาธซอร์ส')
      if (!scan.javaPkgs.has('com/example/app')) throw new Error('ไม่พบคลาส Java')
      if (!scan.capabilities.get('network')?.has('socket')) throw new Error('ไม่พบ capability')

      const names = readElfNames(buildSampleElf(true))
      if (names.exports.join() !== 'Java_test_hello' || names.imports.join() !== 'puts') throw new Error('อ่านชื่อ symbol จาก ELF ไม่ถูกต้อง')
      return { installed: true, healthy: true, version: VERSION, detail: 'self-test ผ่าน (ถอดชื่อ C++/RTTI, จัดกลุ่มสตริง, อ่าน symbol จาก ELF)' }
    } catch (e) {
      return { installed: true, healthy: false, version: VERSION, detail: `self-test ไม่ผ่าน: ${(e as Error).message}` }
    }
  },
  async run(input) {
    return inspectNative(input)
  },
}
