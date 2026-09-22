import { useMemo, useState } from 'react'
import { MapCanvas, type MapLine, type MapMarker } from '../components/MapCanvas'
import { Card, Chip, Sect, Stat, T } from '../components/ui'
import { Empty } from '../components/Empty'
import { Icon } from '../components/icons'
import { localizeShooter, syntheticTerrain, type Terrain } from '../../shared/inference/localize'
import { normToGrid } from '../../shared/world'
import { useServer } from '../state/ServerProvider'
import { useSolverTerrain } from '../data/useSolverTerrain'
import type { DeathRecord } from '../../shared/types'

/**
 * Demo-only: one death on the bundled demo servers. Real deaths come from
 * the dataset — the combat log's range for each hit, paired with where Rust+
 * last saw the victim at that moment.
 */
const DEMO_DEATH: DeathRecord = {
  id: 'demo', at: new Date().toISOString(), victim: 'demo', grid: null, pos: { x: 0.41, y: 0.57 },
  killer: null, weapon: 'rifle.bolt', distance: 152, headshot: true, positionErrorMetres: 20,
  fixes: [
    { from: { x: 0.41, y: 0.57 }, distance: 152, weight: 1, errorMetres: 20 },
    { from: { x: 0.44, y: 0.60 }, distance: 141, weight: 1, errorMetres: 20 },
    { from: { x: 0.38, y: 0.55 }, distance: 168, weight: 1, errorMetres: 20 },
  ],
}

/** Flat open ground: used when a server has no parsed world file yet. */
function flatTerrain(size = 96): Terrain {
  const t = syntheticTerrain(size, 1)
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) { t.height[j][i] = 0.3; t.buildable[j][i] = true }
  return { ...t, heightScale: 1 }
}

const KILLER_COLORS = [T.crit, T.amber, T.red, T.purple, T.steel]

export function Retracer() {
  const { server, data, nameOf, connection } = useServer()
  const [losOn, setLosOn] = useState(true)
  const [pick, setPick] = useState<string | null>(null)
  const [killerFilter, setKillerFilter] = useState<string | null>(null)
  const live = connection.mode === 'live'

  const real = useSolverTerrain(
    connection.config,
    live && server.map.terrainAvailable ? server.id : null,
    server.worldSize,
  )

  const deaths: DeathRecord[] = live ? data.deaths ?? [] : server.seed !== null ? [DEMO_DEATH] : []
  const shown = killerFilter ? deaths.filter((d) => d.killer === killerFilter) : deaths
  const death = shown.find((d) => d.id === pick) ?? shown[0] ?? null
  const solvable = (d: DeathRecord) => d.fixes.length >= 2

  // Which terrain the solve runs on, and whether it's the real one.
  const { terrain, terrainLabel } = useMemo(() => {
    if (!live) return { terrain: syntheticTerrain(64, server.seed ?? 0), terrainLabel: 'demo terrain' }
    if (real.state === 'ready') return { terrain: real.terrain, terrainLabel: 'real heightmap' }
    return { terrain: flatTerrain(), terrainLabel: 'flat — no world file parsed' }
  }, [live, real, server.seed])
  const realTerrain = live && real.state === 'ready'

  const result = useMemo(() => {
    if (!death || !solvable(death)) return null
    return localizeShooter(death.fixes, {
      terrain,
      worldSize: server.worldSize,
      // Sightlines only mean something on a real heightmap.
      requireLineOfSight: losOn && (realTerrain || !live),
      sigmaMetres: 12,
    })
  }, [death, terrain, losOn, realTerrain, live, server.worldSize])

  const killers = useMemo(() => {
    const counts = new Map<string, number>()
    for (const d of deaths) if (d.killer) counts.set(d.killer, (counts.get(d.killer) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, KILLER_COLORS.length)
      .map(([id, n], i) => ({ id, name: nameOf(id), count: n, color: KILLER_COLORS[i] }))
  }, [deaths, nameOf])

  if (!death) {
    const terrainLine =
      real.state === 'ready'
        ? `Real terrain is loaded (${real.terrain.size}² grid, ${(real.buildableFraction * 100).toFixed(0)}% buildable).`
        : server.map.terrainAvailable
          ? 'Terrain is available once the page finishes loading.'
          : 'Run `nab map --world` then `nab parse-map` to give the solver real terrain.'
    return (
      <Empty
        title={live ? `No deaths logged on ${server.name} yet` : 'Map not loaded for this server'}
        detail={live
          ? `A death becomes a retrace when Rust+ is paired (it reports where you were) and the log agent sends the combat log (it reports the range of each hit). ${terrainLine}`
          : `${server.name} has no seed on record, so there's no terrain to solve against.`}
      />
    )
  }

  const markers: MapMarker[] = []
  const lines: MapLine[] = []
  if (death.pos) markers.push({ pos: death.pos, kind: 'death' })
  for (const f of death.fixes) markers.push({ pos: f.from, kind: 'teammate', color: T.steel })
  if (result) {
    markers.push({ pos: result.best, kind: 'enemy', label: 'SHOOTER EST.' })
    if (death.pos) lines.push({ from: death.pos, to: result.best, color: T.red, dashed: true })
  }
  const heat = result ? [{ pos: result.best, radius: Math.min(0.2, (2 * result.sigma) / server.worldSize), color: T.red, intensity: 0.5 }] : []

  const solvedCount = deaths.filter(solvable).length

  return (
    <>
      <div className="maparea">
        <div className="map-fill">
          <MapCanvas server={server} markers={markers} lines={lines} heat={heat}
            field={result?.field ? { values: result.field, size: terrain.size, color: T.red } : undefined} />
        </div>

        {killers.length > 0 && (
          <div className="float float--tl" style={{ width: 240 }}>
            <Card style={{ padding: 15 }}>
              <Sect title="Who killed us" />
              {killers.map((k) => (
                <label key={k.id} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 0', cursor: 'pointer' }}>
                  <input type="radio" name="killer" checked={killerFilter === k.id}
                    onChange={() => { setKillerFilter(k.id); setPick(null) }} style={{ accentColor: k.color }} />
                  <span style={{ width: 11, height: 11, borderRadius: 3, background: k.color }} />
                  <span style={{ fontSize: 13, flexGrow: 1 }}>{k.name}</span>
                  <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>{k.count}×</span>
                </label>
              ))}
              {killerFilter && (
                <button className="btn" style={{ height: 28, marginTop: 6 }} onClick={() => { setKillerFilter(null); setPick(null) }}>
                  Show everyone
                </button>
              )}
            </Card>
          </div>
        )}

        <div className="float float--bl" style={{ width: 250, bottom: 62 }}>
          <Card style={{ padding: 15 }}>
            <Sect title="Solver" />
            <label style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', cursor: realTerrain || !live ? 'pointer' : 'not-allowed', opacity: realTerrain || !live ? 1 : 0.5 }}>
              <input type="checkbox" checked={losOn} disabled={live && !realTerrain} onChange={() => setLosOn(!losOn)} style={{ accentColor: T.rust }} />
              <span style={{ fontSize: 13 }}>Line-of-sight from terrain</span>
            </label>
            <p className="mono" style={{ fontSize: 10, color: T.txt3, lineHeight: 1.5, margin: '8px 0 0' }}>
              Solving on: {terrainLabel}. Each hit&apos;s range is a ring around where you stood; the rings
              intersect at the shooter. Blocked sightlines count against a spot, not rule it out.
            </p>
          </Card>
        </div>

        <div className="float float--tr" style={{ width: 250, top: 62 }}>
          <Card style={{ padding: 15 }}>
            <div className="label">{live ? new Date(death.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'DEMO DEATH'}</div>
            <div style={{ fontSize: 14, fontWeight: 600, marginTop: 6 }}>
              {result ? `Shot from around ${normToGrid(result.best, server.worldSize)}` : 'Not enough to solve'}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {death.distance !== null && <Chip color={T.steel} bg={T.steelDim}>{Math.round(death.distance)}m</Chip>}
              {death.headshot && <Chip color={T.amber} bg="rgba(217,164,65,.13)">HEADSHOT</Chip>}
              {death.killer && <Chip color={T.red} bg="rgba(176,52,43,.15)">{nameOf(death.killer)}</Chip>}
            </div>
            <div className="mono" style={{ fontSize: 11, color: T.txt2, lineHeight: 1.6, marginTop: 10 }}>
              {result
                ? <>±{result.sigma.toFixed(0)} m (1σ) · {death.fixes.length} hits<br /></>
                : <>{death.fixes.length} usable hit{death.fixes.length === 1 ? '' : 's'} — needs 2+, each with a Rust+ position<br /></>}
              {death.weapon ?? 'weapon unknown'}
              {death.positionErrorMetres !== null && <><br />your position ±{death.positionErrorMetres} m</>}
            </div>
          </Card>
        </div>
      </div>

      <aside className="panel" style={{ width: 312 }}>
        <div className="grid2">
          <Stat label="Deaths" value={String(deaths.length)} sub={live ? 'this wipe' : 'demo'} color={T.crit} />
          <Stat label="Solvable" value={String(solvedCount)} sub="2+ positioned hits" color={T.green} />
        </div>

        <Card style={{ padding: 15 }}>
          <Sect title="Deaths" />
          {shown.map((d) => (
            <button className="row" key={d.id} onClick={() => setPick(d.id)}
              style={{
                width: '100%', background: d.id === death.id ? 'rgba(255,255,255,.04)' : 'none', border: 'none',
                color: 'inherit', cursor: 'pointer', textAlign: 'left',
              }}>
              <span style={{ color: solvable(d) ? T.crit : T.txt3, display: 'flex' }}>{Icon.retracer({ size: 16 })}</span>
              <span style={{ flexGrow: 1, lineHeight: 1.25, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>
                  {d.killer ? nameOf(d.killer) : 'unknown killer'}
                </span>
                <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>
                  {live ? new Date(d.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'demo'}
                  {d.grid ? ` · ${d.grid}` : ''}{solvable(d) ? '' : ' · not solvable'}
                </span>
              </span>
              <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: T.steel }}>
                {d.distance !== null ? `${Math.round(d.distance)}m` : '—'}
              </span>
            </button>
          ))}
        </Card>

        <Card style={{ padding: 15 }}>
          <Sect title="How accurate is this?" />
          <p style={{ fontSize: 13, color: T.txt2, lineHeight: 1.5, margin: 0 }}>
            On simulated deaths on a real Rust map, the estimate landed a median 21 m from the true shooter,
            and the true spot was inside ±2σ every time. A curving run gives a sharp answer; a dead-straight
            one leaves two mirror-image spots.
          </p>
        </Card>

        <Card style={{ padding: 15 }}>
          <Sect title="Scope" />
          <p className="mono" style={{ fontSize: 10, color: T.txt3, lineHeight: 1.6, margin: 0 }}>
            After-action only. Reconstructs where shots that already hit you came from. Never shows a live
            position of anyone you cannot see.
          </p>
        </Card>
      </aside>
    </>
  )
}

