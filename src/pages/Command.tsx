import { useMemo, useState } from 'react'
import { MapCanvas, type HeatBlob, type MapMarker } from '../components/MapCanvas'
import { Avatar, Bar, Card, Chip, Sect, T, initialsOf, threatColor } from '../components/ui'
import { Icon } from '../components/icons'
import { useServer } from '../state/ServerProvider'
import { linkConfidence } from '../../shared/inference/clanEvidence'
import type { GameEvent } from '../../shared/types'

const LAYERS = [
  { key: 'deaths', label: 'Where we died', color: T.crit },
  { key: 'bases', label: 'Enemy bases', color: T.red },
  { key: 'events', label: 'Live events', color: T.amber },
  { key: 'team', label: 'Team positions', color: T.steel },
] as const

type LayerKey = (typeof LAYERS)[number]['key']

/** "07:41" to go, or how long ago it ended. */
function when(e: GameEvent): string {
  if (e.ended) {
    const s = e.sinceSeconds ?? 0
    return s < 60 ? 'ended' : `ended ${Math.round(s / 60)}m`
  }
  if (e.etaSeconds > 0) {
    const m = Math.floor(e.etaSeconds / 60)
    return `${String(m).padStart(2, '0')}:${String(e.etaSeconds % 60).padStart(2, '0')}`
  }
  const s = e.sinceSeconds ?? 0
  return s < 60 ? 'now' : `${Math.round(s / 60)}m`
}

const EVENT_STYLE: Record<GameEvent['kind'], { color: string; icon: keyof typeof Icon }> = {
  cargo: { color: T.steel, icon: 'ship' },
  heli: { color: T.amber, icon: 'heli' },
  chinook: { color: T.amber, icon: 'heli' },
  crate: { color: T.rust, icon: 'crate' },
  explosion: { color: T.crit, icon: 'heli' },
}

/** Most of a 300-player server doesn't belong on a dashboard. */
const BOARD_CLANS = 6
const BOARD_SOLOS = 6

export function Command() {
  const { server, data, nameOf, isUs, status, connection } = useServer()
  const [on, setOn] = useState<Record<LayerKey, boolean>>({
    deaths: true, bases: true, events: true, team: true,
  })
  const deaths = data.deaths ?? []

  const heat: HeatBlob[] = useMemo(() => {
    if (!on.deaths) return []
    // Each death is a small blob; where they pile up is where we keep losing.
    return deaths.filter((d) => d.pos).map((d) => ({
      pos: d.pos!, radius: 0.035, color: T.crit, intensity: 0.8,
    }))
  }, [on.deaths, deaths])

  const markers: MapMarker[] = useMemo(() => {
    const out: MapMarker[] = []
    if (data.homePos) out.push({ pos: data.homePos, kind: 'home', label: 'HOME' })
    if (on.deaths) for (const d of deaths) if (d.pos) out.push({ pos: d.pos, kind: 'death' })
    if (on.bases) {
      for (const b of data.bases) {
        if (b.ours || b.status === 'weak') continue
        out.push({ pos: b.pos, kind: 'enemy', label: b.ownerClan ?? b.owner ?? b.grid })
      }
    }
    if (on.events) {
      for (const e of data.liveEvents) {
        if (!e.pos || e.ended) continue
        out.push({ pos: e.pos, kind: 'event', label: e.kind.toUpperCase(), color: EVENT_STYLE[e.kind].color })
      }
    }
    if (on.team) {
      for (const t of data.team) {
        if (!t.pos || !t.alive || t.online === false) continue
        out.push({ pos: t.pos, kind: 'teammate' })
      }
    }
    return out
  }, [on, data.bases, data.team, data.homePos, data.liveEvents, deaths])

  const board = useMemo(() => {
    return data.clans
      .filter((c) => !c.members.some((m) => isUs(m.steamId)))
      .map((c) => {
        const links = data.pairLinks.filter(
          (l) => c.members.some((m) => m.steamId === l.a) && c.members.some((m) => m.steamId === l.b),
        )
        const cohesion = links.length ? links.reduce((a, l) => a + linkConfidence(l), 0) / links.length : 0
        const online = c.members.filter((m) => data.players[m.steamId]?.online).length
        return { clan: c, cohesion, online }
      })
      .sort((a, b) => b.online - a.online || b.clan.threat - a.clan.threat)
      .slice(0, BOARD_CLANS)
  }, [data, isUs])

  // Solos worth watching: online now, not us, not already in a clan above.
  const solos = useMemo(() => {
    const inClan = new Set(data.clans.flatMap((c) => c.members.map((m) => m.steamId)))
    return Object.values(data.players)
      .filter((p) => !isUs(p.steamId) && !inClan.has(p.steamId) && p.online)
      .sort((a, b) => b.threatPercentile - a.threatPercentile)
      .slice(0, BOARD_SOLOS)
  }, [data, isUs])
  const onlineCount = Object.values(data.players).filter((p) => p.online && !isUs(p.steamId)).length

  const live = connection.mode === 'live'
  const eventsHint = !live
    ? 'Demo data.'
    : server.map.pairedWithRustPlus
      ? 'Rust+ is paired — events appear as the server reports them.'
      : 'Pair Rust+ on this server to see cargo, heli, Chinook and crate timers.'

  return (
    <>
      <div className="maparea">
        <div className="map-fill">
          <MapCanvas server={server} heat={heat} markers={markers} />
        </div>

        <div className="float float--tl" style={{ width: 232 }}>
          <Card style={{ padding: 15 }}>
            <Sect title="Map layers" />
            {LAYERS.map((l) => (
              <label key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={on[l.key]}
                  onChange={() => setOn((s) => ({ ...s, [l.key]: !s[l.key] }))}
                  style={{ accentColor: l.color }} />
                <span style={{ width: 11, height: 11, borderRadius: 3, background: l.color }} />
                <span style={{ fontSize: 13, color: on[l.key] ? T.txt : T.txt2 }}>{l.label}</span>
              </label>
            ))}
            <p className="mono" style={{ fontSize: 10, color: T.txt3, lineHeight: 1.5, margin: '8px 0 0' }}>
              {server.map.monuments.length
                ? `${server.map.monuments.length} monuments from the world file. Ore spawns at runtime, so no ore layer.`
                : 'No monuments — this server\'s world file hasn\'t been parsed.'}
            </p>
          </Card>
        </div>
      </div>

      <aside className="panel" style={{ width: 326 }}>
        <Card style={{ padding: 15 }}>
          <Sect title="Live events" right={
            <Chip color={data.liveEvents.length ? T.green : T.txt3}
              bg={data.liveEvents.length ? 'rgba(87,176,111,.13)' : undefined}>
              {data.liveEvents.length ? 'SYNCED' : 'NO FEED'}
            </Chip>
          } />
          {data.gameTime && (
            <p className="mono" style={{ fontSize: 11, color: T.txt2, margin: '0 0 8px' }}>
              in-game {Math.floor(data.gameTime.time)}:{String(Math.floor((data.gameTime.time % 1) * 60)).padStart(2, '0')}
              {' · '}{data.gameTime.time >= data.gameTime.sunset || data.gameTime.time < data.gameTime.sunrise ? 'night' : 'day'}
            </p>
          )}
          {data.liveEvents.length === 0 && (
            <p style={{ fontSize: 13, color: T.txt3, margin: 0 }}>{eventsHint}</p>
          )}
          {data.liveEvents.map((e, i) => {
            const st = EVENT_STYLE[e.kind]
            return (
              <div className="row" key={i} style={{ opacity: e.ended ? 0.55 : 1 }}>
                <span style={{
                  width: 30, height: 30, borderRadius: 7, background: 'rgba(255,255,255,.05)',
                  color: st.color, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{Icon[st.icon]()}</span>
                <span style={{ flexGrow: 1, lineHeight: 1.25 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>{e.label}</span>
                  <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>
                    {e.source} · conf {(e.confidence * 100).toFixed(0)}%
                  </span>
                </span>
                <span className="mono" style={{ fontSize: 12, fontWeight: 600, color: st.color }}>{when(e)}</span>
              </div>
            )
          })}
        </Card>

        {data.team.length > 0 && (
          <Card style={{ padding: 15 }}>
            <Sect title={status?.team.name ?? 'Team'} right={
              <span className="mono" style={{ fontSize: 10, color: T.txt2 }}>
                {data.team.filter((t) => t.alive && t.online !== false).length}/{data.team.length} up
              </span>
            } />
            {data.team.map((t) => (
              <div className="row" key={t.steamId ?? t.name} style={{ borderBottom: 'none', padding: '8px 0' }}>
                <Avatar initials={initialsOf(t.name)} color={T.steel} size={28} />
                <span style={{ flexGrow: 1, lineHeight: 1.2 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>{t.name}</span>
                  <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>grid {t.grid}</span>
                </span>
                <span className="mono" style={{
                  fontSize: 10, fontWeight: 600,
                  color: t.online === false ? T.txt3 : t.alive ? T.green : T.crit,
                }}>
                  {t.online === false ? 'OFFLINE' : t.alive ? 'ALIVE' : 'DEAD'}
                </span>
              </div>
            ))}
          </Card>
        )}

        <Card style={{ padding: 15 }}>
          <Sect title="Threat board" right={
            <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>{onlineCount} online</span>
          } />
          {board.length === 0 && solos.length === 0 && (
            <p style={{ fontSize: 13, color: T.txt3, margin: 0 }}>
              {Object.keys(data.players).length
                ? 'Nobody online right now — or the collector has stopped.'
                : 'Nothing tracked yet. Rosters need a few days of session history.'}
            </p>
          )}
          {board.map(({ clan, cohesion, online }) => (
            <div className="row" key={clan.id}>
              <Avatar initials={clan.label.slice(0, 2)} color={threatColor(clan.threat)} size={30} />
              <span style={{ flexGrow: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{clan.label}</span>
                <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>
                  {online}/{clan.members.length} online · roster conf {(cohesion * 100).toFixed(0)}%
                </span>
                <span style={{ display: 'block', marginTop: 6 }}>
                  <Bar pct={clan.threat} color={threatColor(clan.threat)} />
                </span>
              </span>
              <span className="rjd" style={{ fontSize: 22, fontWeight: 700, color: threatColor(clan.threat) }}>
                {clan.threat}
              </span>
            </div>
          ))}
          {solos.map((p) => (
            <div className="row" key={p.steamId}>
              <Avatar initials={initialsOf(nameOf(p.steamId))} color={threatColor(p.threatPercentile)} size={30} />
              <span style={{ flexGrow: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameOf(p.steamId)}</span>
                <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>
                  {p.hoursPlayed !== null ? `${p.hoursPlayed.toLocaleString()} h Rust · ` : ''}
                  {p.serverHoursThisWipe} h this wipe · no group found
                </span>
                <span style={{ display: 'block', marginTop: 6 }}>
                  <Bar pct={p.threatPercentile} color={threatColor(p.threatPercentile)} />
                </span>
              </span>
              <span className="rjd" style={{ fontSize: 22, fontWeight: 700, color: threatColor(p.threatPercentile) }}>
                {p.threatPercentile}
              </span>
            </div>
          ))}
        </Card>
      </aside>
    </>
  )
}
