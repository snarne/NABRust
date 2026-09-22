import type { ReactNode, CSSProperties } from 'react'

export const T = {
  rust: 'var(--rust)', rustBr: 'var(--rust-br)', rustDim: 'var(--rust-dim)',
  steel: 'var(--steel)', steelDim: 'var(--steel-dim)',
  green: 'var(--green)', amber: 'var(--amber)', red: 'var(--red)',
  crit: 'var(--crit)', purple: 'var(--purple)',
  txt: 'var(--txt)', txt2: 'var(--txt2)', txt3: 'var(--txt3)',
  surf1: 'var(--surf1)', surf2: 'var(--surf2)', surf3: 'var(--surf3)',
  border: 'var(--border)',
}

export function Card({ children, style, flush }: { children: ReactNode; style?: CSSProperties; flush?: boolean }) {
  return <div className={flush ? 'card card--flush' : 'card'} style={style}>{children}</div>
}

export function Sect({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="sect">
      <span className="label">{title.toUpperCase()}</span>
      {right}
    </div>
  )
}

export function Chip({ children, color, bg }: { children: ReactNode; color: string; bg?: string }) {
  return <span className="chip" style={{ color, background: bg ?? 'rgba(255,255,255,.06)' }}>{children}</span>
}

export function Avatar({ initials, color, size = 32 }: { initials: string; color: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, color, fontSize: Math.round(size * 0.42) }}>
      {initials}
    </span>
  )
}

export function Bar({ pct, color }: { pct: number; color: string }) {
  return <span className="bar" style={{ display: 'block' }}><i style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }} /></span>
}

export function Stat({ label, value, sub, color = 'var(--txt)' }: { label: string; value: string; sub: string; color?: string }) {
  return (
    <Card>
      <div className="label">{label.toUpperCase()}</div>
      <div className="stat__v" style={{ color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--txt2)', marginTop: 2 }}>{sub}</div>
    </Card>
  )
}

export function PageHeader({ title, sub, actions }: { title: string; sub: string; actions?: ReactNode }) {
  return (
    <div className="hdr">
      <div>
        <h1>{title}</h1>
        <div className="sub">{sub}</div>
      </div>
      {actions ? <div style={{ display: 'flex', gap: 8 }}>{actions}</div> : null}
    </div>
  )
}

export function threatColor(pct: number): string {
  if (pct >= 85) return T.crit
  if (pct >= 65) return T.red
  if (pct >= 40) return T.amber
  return T.green
}

export function initialsOf(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, '')
  return (clean.slice(0, 2) || '??').toUpperCase()
}
