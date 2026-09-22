import { useEffect, useMemo, useState } from 'react'
import type { Monument, ServerRecord, Vec2 } from '../../shared/types'
import { resolveMapSource, type MapSource } from '../../shared/mapSource'
import { syntheticTerrain } from '../../shared/inference/localize'
import { gridCount } from '../../shared/world'
import { T } from './ui'

export interface MapMarker {
  pos: Vec2 // normalised 0..1
  label?: string
  kind: 'home' | 'enemy' | 'death' | 'shooter' | 'turret' | 'teammate' | 'event'
  color?: string
}

export interface HeatBlob {
  pos: Vec2
  radius: number // normalised
  color: string
  intensity?: number
}

export interface MapLine {
  from: Vec2
  to: Vec2
  color: string
  dashed?: boolean
}

interface Props {
  server: ServerRecord
  width?: number | string
  height?: number | string
  markers?: MapMarker[]
  heat?: HeatBlob[]
  lines?: MapLine[]
  /** Posterior field from localizeShooter. */
  field?: { values: number[]; size: number; color: string }
  showMonuments?: boolean
  showGrid?: boolean
  /** Hide the placeholder banner in small embeds. */
  compact?: boolean
  /** Click-to-place: called with the normalised map position clicked. */
  onPick?: (pos: Vec2) => void
  /** 'slice' fills the box and crops; 'meet' shows the whole map. */
  fit?: 'slice' | 'meet'
}

const V = 1000 // viewBox units across the world square

/** Height bands for the seed-derived placeholder terrain. */
function bandColor(h: number): string | null {
  if (h < 0.3) return null // ocean, painted by the backdrop
  if (h < 0.34) return '#2e2a1e'
  if (h < 0.52) return '#1f2a1a'
  if (h < 0.68) return '#1b2119'
  if (h < 0.82) return '#232a22'
  return '#2c3138'
}

/**
 * Stand-in terrain generated from the server's own seed, so switching servers
 * visibly changes the map even before the real render has loaded. It is
 * labelled as a placeholder and never passed off as the server's actual map.
 */
function PlaceholderTerrain({ seed }: { seed: number }) {
  const cells = useMemo(() => {
    const t = syntheticTerrain(56, seed)
    const cell = V / t.size
    const out: { x: number; y: number; fill: string }[] = []
    for (let y = 0; y < t.size; y++) {
      for (let x = 0; x < t.size; x++) {
        const fill = bandColor(t.height[y][x])
        if (fill) out.push({ x: x * cell, y: y * cell, fill })
      }
    }
    return { cell, out }
  }, [seed])

  return (
    <g filter="url(#softland)">
      {cells.out.map((c, i) => (
        <rect key={i} x={c.x} y={c.y} width={cells.cell + 0.6} height={cells.cell + 0.6} fill={c.fill} />
      ))}
    </g>
  )
}

/** Metres across, for a label — a footprint radius stored normalised. */
function acrossMetres(m: Monument, worldSize: number): number {
  return Math.round(((m.radius ?? 0) * 2 * worldSize) / 10) * 10
}

function MonumentPins({ monuments, worldSize }: { monuments: Monument[]; worldSize: number }) {
  return (
    <>
      {monuments.map((m, i) => {
        const c = { x: m.pos.x * V, y: m.pos.y * V }

        // Parsed monuments: draw the footprint the world file gave us, named
        // when the prefab is known and labelled by measured size otherwise.
        if (m.kind === 'large' || m.kind === 'medium' || (m.kind === 'small' && m.radius)) {
          const r = Math.max(4, (m.radius ?? 0) * V)
          const strong = m.kind === 'large'
          const text = m.named === false
            ? (strong ? `LARGE · ${acrossMetres(m, worldSize)}m` : null)
            : (strong || m.kind === 'medium' ? m.name : null)
          return (
            <g key={i}>
              <title>{`${m.name}${m.radius ? ` · ~${acrossMetres(m, worldSize)} m across` : ''}`}</title>
              <circle cx={c.x} cy={c.y} r={r} fill={T.rust} fillOpacity={strong ? 0.1 : 0.06}
                stroke={T.rust} strokeOpacity={strong ? 0.85 : m.kind === 'medium' ? 0.55 : 0.3}
                strokeWidth={strong ? 2 : 1.25} strokeDasharray={strong ? undefined : '4 3'} />
              <circle cx={c.x} cy={c.y} r={strong ? 3 : 2} fill={T.rust} />
              {text && (
                <text x={c.x + r + 6} y={c.y + 4} fill="var(--txt2)" fontFamily="Barlow, system-ui, sans-serif"
                  fontSize={strong ? 12 : 11} fontWeight="600" paintOrder="stroke"
                  stroke="rgba(12,14,15,.75)" strokeWidth={3}>
                  {text}
                </text>
              )}
            </g>
          )
        }
        if (m.kind === 'offshore') {
          return (
            <g key={i}>
              <title>{m.name}</title>
              <rect x={c.x - 5} y={c.y - 5} width="11" height="11" rx="2" fill={T.steel}
                stroke="#0c0e0f" strokeWidth="1" transform={`rotate(45 ${c.x} ${c.y})`} />
              <text x={c.x + 12} y={c.y + 4} fill="var(--txt2)" fontFamily="Barlow, system-ui, sans-serif" fontSize="12" fontWeight="600">
                {m.named === false ? 'OFFSHORE' : m.name}
              </text>
            </g>
          )
        }

        const col =
          m.kind === 'safezone' ? T.green : m.kind === 'water' ? T.steel : T.rust
        return (
          <g key={i}>
            <title>{m.name}</title>
            <rect x={c.x - 4} y={c.y - 4} width="9" height="9" rx="1.5" fill={col} stroke="#0c0e0f" strokeWidth="1" />
            {m.kind !== 'small' && (
              <text x={c.x + 9} y={c.y + 4} fill="var(--txt2)" fontFamily="Barlow, system-ui, sans-serif" fontSize="12" fontWeight="600">
                {m.name}
              </text>
            )}
          </g>
        )
      })}
    </>
  )
}

export function MapCanvas({
  server, width = '100%', height = '100%',
  markers = [], heat = [], lines = [], field,
  showMonuments = true, showGrid = true, compact = false, onPick, fit = 'slice',
}: Props) {
  const resolved: MapSource = useMemo(() => resolveMapSource(server), [server])

  // If the image itself fails (API went down, file moved), say so and fall
  // back to the placeholder rather than leaving a blank ocean that looks like
  // a loaded map.
  const imageUrl = resolved.kind === 'placeholder' ? null : resolved.url
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  useEffect(() => { setFailedUrl(null) }, [imageUrl])
  const source: MapSource = imageUrl && failedUrl === imageUrl
    ? { kind: 'placeholder', reason: 'the map image failed to load from the API', label: 'PLACEHOLDER' }
    : resolved
  const cells = gridCount(server.worldSize)
  const monuments = server.map.monuments

  return (
    <div style={{ position: 'relative', width, height, background: 'var(--ocean)' }}>
      <svg viewBox={`0 0 ${V} ${V}`} width="100%" height="100%"
        preserveAspectRatio={`xMidYMid ${fit}`} style={{ display: 'block', cursor: onPick ? 'crosshair' : undefined }}
        onClick={onPick ? (e) => {
          // Invert the screen transform, so "slice" scaling and any container
          // size map back to world coordinates exactly.
          const svg = e.currentTarget
          const ctm = svg.getScreenCTM()
          if (!ctm) return
          const pt = svg.createSVGPoint()
          pt.x = e.clientX
          pt.y = e.clientY
          const p = pt.matrixTransform(ctm.inverse())
          const x = p.x / V
          const y = p.y / V
          if (x >= 0 && x <= 1 && y >= 0 && y <= 1) onPick({ x, y })
        } : undefined}
        role="img"
        aria-label={
          source.kind === 'placeholder'
            ? `Placeholder map for ${server.name}; real map not loaded`
            : `${server.name} map with tracked positions`
        }>
        <defs>
          <filter id="softland"><feGaussianBlur stdDeviation="3.5" /></filter>
          {heat.map((h, i) => (
            <radialGradient key={i} id={`heat${i}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor={h.color} stopOpacity={(h.intensity ?? 1) * 0.55} />
              <stop offset="60%" stopColor={h.color} stopOpacity={(h.intensity ?? 1) * 0.2} />
              <stop offset="100%" stopColor={h.color} stopOpacity="0" />
            </radialGradient>
          ))}
        </defs>

        <rect x="0" y="0" width={V} height={V} fill="var(--ocean)" />

        {/* --- base layer: the server's real map, or a seed-derived stand-in --- */}
        {source.kind === 'placeholder'
          ? <PlaceholderTerrain seed={server.seed ?? 0} />
          : <image href={source.url} x="0" y="0" width={V} height={V} preserveAspectRatio="none"
              onError={() => setFailedUrl(source.url)} />}

        {showGrid && (
          <g stroke="#39413a" strokeWidth="1" opacity="0.3">
            {Array.from({ length: Math.max(0, cells - 1) }, (_, i) => {
              const c = ((i + 1) * V) / cells
              return <g key={i}><line x1={c} y1="0" x2={c} y2={V} /><line x1="0" y1={c} x2={V} y2={c} /></g>
            })}
          </g>
        )}

        {/* Rust+ images already carry monument icons, so we don't double-draw. */}
        {showMonuments && !(source.kind !== 'placeholder' && source.monumentsBaked) && (
          <MonumentPins monuments={monuments} worldSize={server.worldSize} />
        )}

        {field && (() => {
          const n = field.size
          const max = Math.max(...field.values) || 1
          const cell = V / n
          const out = []
          for (let i = 0; i < field.values.length; i++) {
            const v = field.values[i] / max
            if (v < 0.06) continue
            out.push(<rect key={i} x={(i % n) * cell} y={Math.floor(i / n) * cell}
              width={cell} height={cell} fill={field.color} opacity={Math.min(0.75, v)} />)
          }
          return <g>{out}</g>
        })()}

        {heat.map((h, i) => (
          <circle key={i} cx={h.pos.x * V} cy={h.pos.y * V} r={h.radius * V} fill={`url(#heat${i})`} />
        ))}

        {lines.map((l, i) => (
          <line key={i} x1={l.from.x * V} y1={l.from.y * V} x2={l.to.x * V} y2={l.to.y * V}
            stroke={l.color} strokeWidth="2" strokeDasharray={l.dashed ? '5 4' : undefined} opacity="0.85" />
        ))}

        {markers.map((m, i) => {
          const c = { x: m.pos.x * V, y: m.pos.y * V }
          const col = m.color ?? (
            m.kind === 'home' || m.kind === 'teammate' ? T.steel
              : m.kind === 'death' ? T.crit
              : T.red)
          return (
            <g key={i}>
              {m.kind === 'death' ? (
                <g stroke={col} strokeWidth="2.5" fill="none">
                  <line x1={c.x - 7} y1={c.y - 7} x2={c.x + 7} y2={c.y + 7} />
                  <line x1={c.x + 7} y1={c.y - 7} x2={c.x - 7} y2={c.y + 7} />
                </g>
              ) : m.kind === 'enemy' ? (
                <rect x={c.x - 7} y={c.y - 7} width="14" height="14" rx="2" fill={col} stroke="#0c0e0f" strokeWidth="2" />
              ) : m.kind === 'event' ? (
                <g>
                  <circle cx={c.x} cy={c.y} r="11" fill="none" stroke={col} strokeWidth="1.5" strokeDasharray="3 3" />
                  <circle cx={c.x} cy={c.y} r="4" fill={col} />
                </g>
              ) : m.kind === 'turret' ? (
                <circle cx={c.x} cy={c.y} r="6" fill="none" stroke={col} strokeWidth="2.5" />
              ) : (
                <>
                  <circle cx={c.x} cy={c.y} r="8" fill={col} stroke="#0c0e0f" strokeWidth="2" />
                  {m.kind === 'home' && <circle cx={c.x} cy={c.y} r="15" fill="none" stroke={col} strokeWidth="1.5" opacity="0.6" />}
                </>
              )}
              {m.label && (
                <text x={c.x + 15} y={c.y + 4} fill={col} fontFamily="Barlow, system-ui, sans-serif" fontSize="12" fontWeight="700">{m.label}</text>
              )}
            </g>
          )
        })}
      </svg>

      {/* Source badge — the map never pretends to be something it isn't. */}
      {!compact && (
        <div style={{
          position: 'absolute', bottom: 12, right: 12, display: 'flex',
          alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 7,
          background: 'rgba(12,14,15,.82)',
          border: `1px solid ${source.kind === 'placeholder' ? 'rgba(217,164,65,.45)' : T.border}`,
          backdropFilter: 'blur(4px)',
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: source.kind === 'placeholder' ? T.amber : T.green,
          }} />
          <span className="mono" style={{
            fontSize: 10, letterSpacing: 1, fontWeight: 600,
            color: source.kind === 'placeholder' ? T.amber : T.green,
          }}>
            {source.label}
          </span>
          <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>
            {server.worldSize}{server.seed !== null ? ` · seed ${server.seed}` : ' · seed unknown'}
          </span>
        </div>
      )}

      {source.kind === 'placeholder' && !compact && (
        <div style={{
          position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
          padding: '7px 13px', borderRadius: 7,
          background: 'rgba(12,14,15,.85)', border: '1px solid rgba(217,164,65,.35)',
          backdropFilter: 'blur(4px)', maxWidth: 420, textAlign: 'center',
        }}>
          <span style={{ fontSize: 12, color: T.amber, fontWeight: 600 }}>
            Placeholder terrain — {source.reason}
          </span>
        </div>
      )}
    </div>
  )
}
