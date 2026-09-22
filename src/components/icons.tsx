import type { ReactNode } from 'react'

function S({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

export const Icon = {
  command: (p?: { size?: number }) => (
    <S {...p}><circle cx="12" cy="12" r="7" /><line x1="12" y1="1.5" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="22.5" /><line x1="1.5" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="22.5" y2="12" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /></S>
  ),
  dossier: (p?: { size?: number }) => (
    <S {...p}><circle cx="12" cy="8" r="3.6" /><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" /></S>
  ),
  timeline: (p?: { size?: number }) => (<S {...p}><path d="M3 12h4l2.5-7 4 15 2.5-8H21" /></S>),
  retracer: (p?: { size?: number }) => (
    <S {...p}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.4" />
      <line x1="12" y1="1" x2="12" y2="4" /><line x1="12" y1="20" x2="12" y2="23" />
      <line x1="1" y1="12" x2="4" y2="12" /><line x1="20" y1="12" x2="23" y2="12" /></S>
  ),
  raid: (p?: { size?: number }) => (
    <S {...p}><circle cx="11" cy="14" r="6.5" /><path d="M15.5 9.5l3-3M18 6l1.5.4M20 8l.4 1.6M17 4.6l.5 1.6 1.6.5" /></S>
  ),
  base: (p?: { size?: number }) => (
    <S {...p}><path d="M4 11l8-6 8 6" /><path d="M6 10v9h12v-9" /><rect x="10" y="13" width="4" height="6" /></S>
  ),
  servers: (p?: { size?: number }) => (
    <S {...p}><rect x="3.5" y="4" width="17" height="6" rx="1.5" /><rect x="3.5" y="14" width="17" height="6" rx="1.5" />
      <line x1="7" y1="7" x2="7.01" y2="7" /><line x1="7" y1="17" x2="7.01" y2="17" /></S>
  ),
  settings: (p?: { size?: number }) => (
    <S {...p}><circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4L5.3 5.3" /></S>
  ),
  moon: (p?: { size?: number }) => (<S {...p}><path d="M20 13.5A8 8 0 1 1 10.5 4a6.4 6.4 0 0 0 9.5 9.5z" /></S>),
  search: (p?: { size?: number }) => (<S {...p}><circle cx="11" cy="11" r="6.5" /><line x1="16" y1="16" x2="21" y2="21" /></S>),
  bolt: (p?: { size?: number }) => (
    <svg viewBox="0 0 24 24" width={p?.size ?? 18} height={p?.size ?? 18} fill="currentColor" aria-hidden="true">
      <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
    </svg>
  ),
  ship: (p?: { size?: number }) => (
    <S {...p}><path d="M4 15l1-5h14l1 5" />
      <path d="M3 15c1.5 1.5 3 1.5 4.5 0S10.5 13.5 12 15s3 1.5 4.5 0S19.5 13.5 21 15" />
      <path d="M12 10V5M9 5h6" /></S>
  ),
  heli: (p?: { size?: number }) => (
    <S {...p}><rect x="7" y="10" width="9" height="5" rx="2" /><path d="M16 12h4M4 8h16M12 8v2M16 15l2 3" /></S>
  ),
  crate: (p?: { size?: number }) => (
    <S {...p}><rect x="4" y="7" width="16" height="12" rx="1" /><path d="M4 11h16M9 7v12M15 7v12" /></S>
  ),
  users: (p?: { size?: number }) => (
    <S {...p}><circle cx="9" cy="8" r="3" /><path d="M3 19c0-3 2.7-5 6-5s6 2 6 5" />
      <path d="M16 6.2A3 3 0 0 1 16 13M21 19c0-2.4-1.6-4.2-4-4.8" /></S>
  ),
  filter: (p?: { size?: number }) => (<S {...p}><path d="M3 5h18l-7 8v6l-4-2v-4z" /></S>),
  plus: (p?: { size?: number }) => (<S {...p}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></S>),
  chev: (p?: { size?: number }) => (<S {...p}><path d="M9 6l6 6-6 6" /></S>),
  check: (p?: { size?: number }) => (<S {...p}><path d="M5 13l4 4L19 7" /></S>),
}

export type IconKey = keyof typeof Icon
