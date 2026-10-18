import type { ReactNode } from 'react'

// ไอคอนเส้นบางชุดเดียวกับ Project Mode (ไม่ใช้อิโมจิ) — สีตาม currentColor
function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
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

export const ArrowLeftIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </Svg>
)

export const PlusIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
)

export const ScanIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M4 12h16" />
  </Svg>
)

export const FileIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Svg>
)

export const GraphIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="18" cy="8" r="2.2" />
    <circle cx="12" cy="18" r="2.2" />
    <path d="M8 7l8 .8M7.2 8l3.6 8M16.8 10l-3.6 6" />
  </Svg>
)

export const EvidenceIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />
    <path d="M9 12l2 2 4-4" />
  </Svg>
)

export const ToolIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-2.3-.7-.7-2.3z" />
  </Svg>
)

export const ReportIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M9 12h7M9 16h7M9 8h3" />
  </Svg>
)

export const OverviewIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <rect x="4" y="4" width="7" height="7" rx="1" />
    <rect x="13" y="4" width="7" height="7" rx="1" />
    <rect x="4" y="13" width="7" height="7" rx="1" />
    <rect x="13" y="13" width="7" height="7" rx="1" />
  </Svg>
)

export const InfoIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
)

export const EditIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="M13.5 6.5l4 4" />
  </Svg>
)

export const TrashIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </Svg>
)

export const StopIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="9" />
    <rect x="9" y="9" width="6" height="6" rx="1" />
  </Svg>
)

export const CheckIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Svg>
)

export const DownloadIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
  </Svg>
)

export const OpenIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />
    <path d="M14 4h6v6M20 4l-9 9" />
  </Svg>
)

export const BracesIcon = ({ size }: IconProps) => (
  <Svg size={size}>
    <path d="M9 4C7 4 6 5 6 7v2c0 1.5-1 3-3 3 2 0 3 1.5 3 3v2c0 2 1 3 3 3M15 4c2 0 3 1 3 3v2c0 1.5 1 3 3 3-2 0-3 1.5-3 3v2c0 2-1 3-3 3" />
  </Svg>
)
