import { Bar, Card, Chip, PageHeader, Sect, Stat, T } from '../components/ui'
import { Icon } from '../components/icons'
import { useServer } from '../state/ServerProvider'
import { resolveMapSource } from '../../shared/mapSource'
import type { ServerRecord } from '../../shared/types'

const HEAT_COLOR: Record<ServerRecord['heat'], string> = {
  casual: T.green, moderate: T.amber, sweaty: T.red, extreme: T.crit,
  unknown: T.txt3,
}

function PopChart({ points, max }: { points: number[]; max: number }) {
  const w = 980, h = 170
  const poly = points.map((v, i) => `${(i * w) / (points.length - 1)},${h - (v / max) * h}`).join(' ')
  return (
    <svg viewBox="0 0 980 190" width="100%" height="190" preserveAspectRatio="none"
      style={{ display: 'block' }} role="img" aria-label="Server population over 7 days">
      <g stroke={T.border} strokeWidth="1" opacity="0.5">
        {[42, 85, 128, 170].map((y) => <line key={y} x1="0" y1={y} x2="980" y2={y} />)}
      </g>
      <polyline points={`${poly} 980,170 0,170`} fill={T.rust} opacity="0.12" />
      <polyline points={poly} fill="none" stroke={T.rust} strokeWidth="2.5" strokeLinejoin="round" />
    </svg>
  )
}

export function Servers() {
  const { server, servers, serverId, setServerId, status, data, connection } = useServer()
  const live = connection.mode === 'live'
  const t = status?.totals
  const since = t?.firstPoll ? Math.max(1, Math.round((Date.now() - Date.parse(t.firstPoll)) / 86_400_000)) : null

  return (
    <>
      <div className="col">
        <PageHeader title="Servers" sub={live
          ? `${servers.length} tracked${since ? ` · first data ${since} day${since === 1 ? '' : 's'} ago` : ''}${t ? ` · ${t.watchedHours} h actually watched` : ''}`
          : `${servers.length} demo servers`} />

        <div className="grid3">
          <Stat label="Players indexed" value={(live ? t?.players ?? 0 : Object.keys(data.players).length).toLocaleString()} sub={live ? 'across all servers' : 'demo'} />
          <Stat label="Rosters" value={String(live ? t?.rosters ?? 0 : data.clans.length)} sub="inferred teams" color={T.rust} />
          <Stat label="Session records" value={(live ? t?.sessions ?? 0 : 0).toLocaleString()} sub="since install" color={T.steel} />
        </div>

        <Card style={{ padding: 18 }}>
          <Sect title={`Population · ${server.name} · last 24 h`} />
          <PopChart points={server.populationCurve} max={server.maxPop} />
        </Card>

        <Card flush>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 14, padding: '11px 16px',
            borderBottom: `1px solid ${T.border}`, background: T.surf2,
          }}>
            <span className="label" style={{ flexGrow: 1 }}>SERVER</span>
            <span className="label" style={{ width: 150 }}>MAP</span>
            <span className="label" style={{ width: 110 }}>POPULATION</span>
            <span className="label" style={{ width: 90, textAlign: 'right' }}>HEAT</span>
            <span style={{ width: 18 }} />
          </div>
          {servers.map((s) => {
            const active = s.id === serverId
            const src = resolveMapSource(s)
            const ok = src.kind !== 'placeholder'
            return (
              <button key={s.id} onClick={() => setServerId(s.id)}
                style={{
                  width: '100%', textAlign: 'left', color: 'inherit',
                  display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px',
                  border: 'none', borderBottom: `1px solid ${T.border}`,
                  borderLeft: `3px solid ${active ? T.rust : 'transparent'}`,
                  background: active ? 'rgba(210,113,47,.08)' : 'transparent',
                }}>
                <span style={{ flexGrow: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, display: 'block' }}>{s.name}</span>
                  <span className="mono" style={{ fontSize: 11, color: T.txt3 }}>
                    wipe day {s.wipeDay} · {s.worldSize}
                    {s.seed !== null ? ` · seed ${s.seed}` : ' · seed unknown'}
                  </span>
                </span>
                <span style={{ width: 150 }}>
                  <Chip color={ok ? T.green : T.amber} bg={ok ? 'rgba(87,176,111,.13)' : 'rgba(217,164,65,.13)'}>
                    {src.label}
                  </Chip>
                </span>
                <span style={{ width: 110 }}>
                  <span className="mono" style={{ fontSize: 12, color: T.txt2, display: 'block', marginBottom: 5 }}>
                    {s.pop}/{s.maxPop}
                  </span>
                  <Bar pct={(s.pop / s.maxPop) * 100} color={T.steel} />
                </span>
                <span className="mono" style={{ width: 90, textAlign: 'right', fontSize: 11, fontWeight: 600, color: HEAT_COLOR[s.heat] }}>
                  {s.heat.toUpperCase()}
                </span>
                <span style={{ color: T.txt3, display: 'flex' }}>{Icon.chev({ size: 16 })}</span>
              </button>
            )
          })}
        </Card>
      </div>

      <aside className="panel" style={{ width: 300 }}>
        <Card style={{ padding: 15 }}>
          <Sect title="Active server" />
          <p style={{ fontSize: 13, color: T.txt2, lineHeight: 1.55, margin: 0 }}>
            Selecting a server swaps the map, monuments, rosters, bases and event feed. Nothing from another
            server is shown under this one.
          </p>
        </Card>

        <Card style={{ padding: 15 }}>
          <Sect title="Collector" right={live && status ? (
            server.simulated
              ? <Chip color={T.steel} bg={T.steelDim}>SIMULATED</Chip>
              : !status.battlemetrics.configured
                ? <Chip color={T.txt3}>OFF</Chip>
                : (
                  <Chip color={status.battlemetrics.fresh ? T.green : T.amber}
                    bg={status.battlemetrics.fresh ? 'rgba(87,176,111,.13)' : 'rgba(217,164,65,.13)'}>
                    {status.battlemetrics.fresh ? 'POLLING' : 'STOPPED'}
                  </Chip>
                )
          ) : undefined} />
          <p style={{ fontSize: 13, color: T.txt2, lineHeight: 1.55, margin: 0 }}>
            {!live
              ? 'Not connected — these are demo servers.'
              : server.simulated
                ? 'Sessions on this server were generated by `nab simulate` and fed through the real collector code. Nothing here was polled.'
              : !status?.battlemetrics.configured
                ? 'Battlemetrics is not configured for this server — run `nab init --battlemetrics <id>` and set BATTLEMETRICS_TOKEN.'
                : status.battlemetrics.fresh
                  ? `Last poll ${new Date(status.battlemetrics.lastPoll!).toLocaleTimeString()} · ${status.battlemetrics.online} online.`
                  : `Last poll ${status.battlemetrics.lastPoll ? new Date(status.battlemetrics.lastPoll).toLocaleString() : 'never'}. Rosters only build while \`nab serve\` runs — every hour it's off is an hour of teams moving together that nobody saw.`}
          </p>
        </Card>

        <Card style={{ padding: 15 }}>
          <Sect title="Rosters online now" />
          {(() => {
            const rows = data.clans
              .map((c) => ({ c, on: c.members.filter((m) => data.players[m.steamId]?.online).length }))
              .filter((r) => r.on > 0)
              .sort((a, b) => b.on - a.on)
              .slice(0, 6)
            if (!rows.length) {
              return (
                <p style={{ fontSize: 13, color: T.txt3, margin: 0 }}>
                  {data.clans.length ? 'None of the known rosters are online.' : 'No rosters yet — they need a few days of session history.'}
                </p>
              )
            }
            return rows.map(({ c, on }) => (
              <div className="row" key={c.id}>
                <span style={{ flexGrow: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                <span className="mono" style={{ fontSize: 11, color: T.txt2 }}>{on}/{c.members.length} on</span>
              </div>
            ))
          })()}
        </Card>
      </aside>
    </>
  )
}
