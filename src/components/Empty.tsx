import type { ReactNode } from 'react'
import { T } from './ui'

/**
 * Shown when the active server simply has no data of this kind yet — a server
 * we track but have never played on, or one whose seed we haven't read.
 * Better than rendering another server's numbers under the wrong name.
 */
export function Empty({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="rjd" style={{ fontSize: 20, fontWeight: 700, color: T.txt2 }}>{title}</div>
      <p style={{ fontSize: 13, color: T.txt3, lineHeight: 1.6, maxWidth: 380, margin: 0 }}>{detail}</p>
      {action}
    </div>
  )
}
