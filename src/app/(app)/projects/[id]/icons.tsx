import type { ReactNode } from 'react'

// ไอคอนเส้นบางชุดเดียวกันทั้งหน้า (ไม่ใช้อิโมจิ) — สีตาม currentColor
function Svg({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

type IconProps = { size?: number }

export const MenuIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
)

export const CloseIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Svg>
)

export const ChatIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
  </Svg>
)

export const AgentsIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.3c1.9.8 3 2.6 3 5.7" />
  </Svg>
)

export const TasksIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M9 6h11M9 12h11M9 18h11" />
    <path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
  </Svg>
)

export const FilesIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Svg>
)

export const UsageIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M5 20V10M12 20V4M19 20v-7" />
  </Svg>
)

export const SendIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </Svg>
)

export const ArrowDownIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 5v14M5 12l7 7 7-7" />
  </Svg>
)

export const FolderIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
)

export const LogoutIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <path d="M16 17l5-5-5-5M21 12H9" />
  </Svg>
)

export function Spinner({ size = 16 }: IconProps) {
  return (
    <svg className="animate-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

export const MemoryIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 3a9 9 0 1 0 9 9" />
    <path d="M12 7v5l3 2" />
    <path d="M17 3h4v4" />
  </Svg>
)
