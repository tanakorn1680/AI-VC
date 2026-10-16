// แสดงวันเวลาตามเวลาไทยเสมอ (server render บน Vercel เป็น UTC จึงต้องระบุ timeZone ชัดเจน)
const FORMATTER = new Intl.DateTimeFormat('th-TH', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Bangkok',
})

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '-' : FORMATTER.format(d)
}
