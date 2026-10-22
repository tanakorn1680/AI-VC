/**
 * จัดกลุ่มชื่อ symbol เป็น "ตระกูล" จากชื่ออย่างเดียว (ไม่ใช่การยืนยันว่าเป็นไลบรารีใด)
 * ใช้สรุป export/import นับหมื่นรายการให้ AI อ่านได้ภายในไม่กี่บรรทัด เช่น ImGui*, cv, tbb, CTask*, png*, gl*
 */

function readIdent(s: string, i: number): string | null {
  const m = /^(\d+)/.exec(s.slice(i, i + 6))
  if (!m) return null
  const n = Number(m[1])
  const start = i + m[1].length
  return n > 0 && start + n <= s.length ? s.slice(start, start + n) : null
}

const WORD = /^(?:[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z][a-z0-9]*)/

/** ชื่อคลาส/namespace: คลาสเกมแบบ C+ตัวใหญ่ (CTaskSimpleX, CVehicle) จัดตามคำแรก ที่เหลือใช้ชื่อเต็ม (ImGui, ZXing, cv, tbb) */
function classFamily(id: string): string {
  if (/^C[A-Z]/.test(id)) {
    const w = WORD.exec(id.slice(1))?.[0] ?? id.slice(1)
    return `C${w}`.length < id.length ? `C${w}*` : id
  }
  return id.length > 18 ? `${id.slice(0, 18)}*` : id
}

/** ชื่อฟังก์ชันธรรมดา (C): ตามคำนำหน้า เช่น png_*, glBindBuffer → gl*, RpLightSetRadius → Rp* */
function plainFamily(name: string): string {
  const w = WORD.exec(name)?.[0]
  if (!w) return 'อื่น ๆ'
  return w.length < name.length ? `${w}*` : w
}

export function symbolFamily(name: string): string {
  if (/^_Z(?:T[VISC])?N?K?St/.test(name)) return 'std (libc++/libstdc++)'
  if (name.startsWith('_Z')) {
    // _ZN..., _ZTV/_ZTI/_ZTS... = สมาชิก/ตารางของคลาส; _Z<len>name = ฟังก์ชันอิสระ
    const nestedOrTable = /^_Z(?:T[VISC]|Th\d+_|Thn\d+_)?N?[KV]*(?=\d)/.exec(name)
    if (!nestedOrTable) return 'C++ อื่น ๆ'
    const prefix = nestedOrTable[0]
    const id = readIdent(name, prefix.length)
    if (!id) return 'C++ อื่น ๆ'
    const isFree = prefix === '_Z' // ไม่มี N/T ข้างหน้า
    return isFree ? plainFamily(id) : classFamily(id)
  }
  if (name.startsWith('_') || name.startsWith('.')) return 'runtime (_*)'
  return plainFamily(name)
}

export interface FamilyCount {
  family: string
  count: number
}

/** ตระกูลที่พบซ้ำมากสุด n อันดับ (ตระกูลที่มีตัวเดียวและที่เหลือรวมเป็น other) */
export function topFamilies(names: string[], n = 12): { top: FamilyCount[]; other: number } {
  const counts = new Map<string, number>()
  for (const nm of names) {
    const f = symbolFamily(nm)
    counts.set(f, (counts.get(f) ?? 0) + 1)
  }
  const top = [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([family, count]) => ({ family, count }))
  return { top, other: names.length - top.reduce((s, t) => s + t.count, 0) }
}
