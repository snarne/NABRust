import { useState, type ReactNode } from 'react'
import { Avatar, Card, Chip, PageHeader, Sect, T, initialsOf } from '../components/ui'
import { Icon, type IconKey } from '../components/icons'
import { useServer } from '../state/ServerProvider'
import { resolveMapSource } from '../../shared/mapSource'

function Integration({ name, sub, status, color, icon }: {
  name: string; sub: string; status: string; color: string; icon: IconKey
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, padding: '15px 16px',
      borderBottom: `1px solid ${T.border}`,
    }}>
      <span style={{
        width: 38, height: 38, borderRadius: 9, background: T.surf2,
        border: `1px solid ${T.border}`, display: 'flex', alignItems: 'center',
        justifyContent: 'center', color, flexShrink: 0,
      }}>{Icon[icon]()}</span>
      <span style={{ flexGrow: 1, minWidth: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 600, display: 'block' }}>{name}</span>
        <span className="mono" style={{ fontSize: 11, color: T.txt3, marginTop: 3, display: 'block' }}>{sub}</span>
      </span>
      <Chip color={color}>{status}</Chip>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <div className="label">{title}</div>
      <Card flush>{children}</Card>
    </>
  )
}

/**
 * Where the app gets its data. On the box running NABRust nothing needs
 * setting — the dev server proxies to the local API. A teammate's browser
 * points at the box's tunnel address with the team token.
 */
function ConnectionCard() {
  const { connection, setApiConfig, refresh } = useServer()
  const [base, setBase] = useState(connection.config.base)
  const [token, setToken] = useState(connection.config.token ?? '')
  const dirty = base !== connection.config.base || (token || null) !== connection.config.token

  const status =
    connection.mode === 'live' ? { text: 'LIVE', color: T.green }
      : connection.mode === 'connecting' ? { text: 'CONNECTING', color: T.amber }
        : { text: 'DEMO DATA', color: T.amber }

  return (
    <Card style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 600, flexGrow: 1 }}>NABRust API</span>
        <Chip color={status.color}>{status.text}</Chip>
      </div>
      <p className="mono" style={{ fontSize: 11, color: T.txt3, lineHeight: 1.6, margin: '0 0 12px' }}>
        {connection.mode === 'live'
          ? `${connection.config.base || 'this machine (dev proxy)'} · synced ${
            connection.lastSync ? new Date(connection.lastSync).toLocaleTimeString() : '—'}`
          : connection.error ?? 'Not connected.'}
        {connection.mode === 'demo' && ' Every screen is showing bundled demo servers, not real ones.'}
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="label" style={{ margin: 0 }}>ADDRESS</span>
          <input className="input" type="url" value={base} placeholder="blank = this machine"
            onChange={(e) => setBase(e.target.value.trim())} aria-label="API address" />
        </label>
        <label style={{ display: 'grid', gap: 5 }}>
          <span className="label" style={{ margin: 0 }}>TEAM TOKEN</span>
          <input className="input" type="password" value={token} placeholder="only for a remote address"
            onChange={(e) => setToken(e.target.value.trim())} aria-label="API token" autoComplete="off" />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button className="btn btn--primary" style={{ height: 32 }} disabled={!dirty}
          onClick={() => setApiConfig({ base: base.replace(/\/+$/, ''), token: token || null })}>
          Save & connect
        </button>
        <button className="btn" style={{ height: 32 }} onClick={refresh}>Retry now</button>
        {(connection.config.base || connection.config.token) && (
          <button className="btn" style={{ height: 32 }}
            onClick={() => { setBase(''); setToken(''); setApiConfig({ base: '', token: null }) }}>
            Use this machine
          </button>
        )}
      </div>
    </Card>
  )
}

function ago(iso: string | null): string {
  if (!iso) return 'never'
  const d = Date.now() - Date.parse(iso)
  if (d < 60_000) return 'just now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  return `${Math.floor(d / 86_400_000)}d ago`
}

const FRESH_MS = 10 * 60_000
const recent = (iso: string | null) => !!iso && Date.now() - Date.parse(iso) < FRESH_MS

export function Settings() {
  const { server, servers, status, connection } = useServer()
  const src = resolveMapSource(server)
  const live = connection.mode === 'live'
  const st = status

  const bm = st?.battlemetrics
  const rp = st?.rustplus
  const steam = st?.steam
  const teams = st?.teams
  const rpLive = recent(rp?.lastTeamSync ?? null) || recent(rp?.lastMarkers ?? null)

  return (
    <>
      <div className="col">
        <PageHeader title="Settings" sub={live && st
          ? `${st.team.name} · ${st.team.members} member${st.team.members === 1 ? '' : 's'} · scoped to ${server.name}`
          : `not connected · showing demo servers`} />

        <div className="label">CONNECTION</div>
        <ConnectionCard />

        {live && st ? (
          <Group title="DATA SOURCES · ACTIVE SERVER">
            <Integration
              name="Battlemetrics sessions"
              sub={!bm?.configured
                ? 'set BATTLEMETRICS_TOKEN and `nab init --battlemetrics <id>`'
                : `last poll ${ago(bm.lastPoll)}${bm.online !== null ? ` · ${bm.online} online` : ''}`}
              status={!bm?.configured ? 'NOT SET UP' : bm.fresh ? 'LIVE' : 'STOPPED'}
              color={!bm?.configured ? T.txt3 : bm.fresh ? T.green : T.amber} icon="servers" />
            <Integration
              name="Rust+ companion"
              sub={!rp?.paired
                ? `not paired on ${server.name} — see SETUP.md step 6`
                : `team sync ${ago(rp.lastTeamSync)} · events ${ago(rp.lastMarkers)}`}
              status={!rp?.paired ? 'NOT PAIRED' : rpLive ? 'LIVE' : 'QUIET'}
              color={!rp?.paired ? T.txt3 : rpLive ? T.green : T.amber} icon="bolt" />
            <Integration
              name="Steam Web API"
              sub={!steam?.configured
                ? 'optional — set STEAM_API_KEY for bans, account age and public Rust hours'
                : `${steam.profiles} profiles fetched · ${steam.public} public`}
              status={steam?.configured ? 'ON' : 'OFF'}
              color={steam?.configured ? T.green : T.txt3} icon="users" />
            <Integration
              name="Map"
              sub={server.map.parsedAt
                ? `seed ${server.seed ?? '?'} · ${server.worldSize}m · parsed ${ago(server.map.parsedAt)} · ${st.map.monuments} monuments${st.map.terrain ? ' · terrain ready' : ''}`
                : 'run `nab map --world` then `nab parse-map`'}
              status={src.kind === 'placeholder' ? 'PLACEHOLDER' : src.label}
              color={src.kind === 'placeholder' ? T.amber : T.green} icon="command" />
            <Integration
              name="Teammate detection"
              sub={teams?.lastRun
                ? `${teams.watchedHours?.toFixed(1)} h watched · ${teams.population} players · ${teams.rosters} rosters · updated ${ago(teams.lastRun)}`
                : 'runs every 15 min while `nab serve` is up'}
              status={teams?.lastRun ? `${teams.rosters} ROSTERS` : 'WAITING'}
              color={teams?.rosters ? T.green : T.txt3} icon="users" />
          </Group>
        ) : (
          <Card>
            <p style={{ fontSize: 13, color: T.txt3, margin: 0 }}>
              Integration status appears once the app is connected to your NABRust API.
            </p>
          </Card>
        )}

        <Group title="MAP STATUS · ALL TRACKED SERVERS">
          {servers.map((s) => {
            const ss = resolveMapSource(s)
            const ok = ss.kind !== 'placeholder'
            return (
              <Integration key={s.id} name={s.name}
                sub={ok ? `${s.worldSize}m · seed ${s.seed}` : ss.reason}
                status={ss.label} color={ok ? T.green : T.amber} icon="base" />
            )
          })}
        </Group>

        <Group title="OUTPUTS">
          <Integration name="In-game team chat" sub="/nab commands, answered by Rust+ · needs pairing"
            status={rp?.paired ? 'ACTIVE' : 'NEEDS RUST+'} color={rp?.paired ? T.green : T.txt3} icon="command" />
          <Integration name="Discord" sub="not built yet" status="—" color={T.txt3} icon="users" />
          <Integration name="TeamSpeak" sub="not built yet" status="—" color={T.txt3} icon="users" />
        </Group>
      </div>

      <aside className="panel">
        <Card style={{ padding: 15 }}>
          <Sect title="Log agents" right={st ? <Chip color={T.txt2}>{st.agents.length}</Chip> : undefined} />
          {(!st || st.agents.length === 0) && (
            <p style={{ fontSize: 13, color: T.txt3, margin: 0, lineHeight: 1.5 }}>
              No combat logs received yet. Run the agent on each gaming PC (SETUP.md step 7).
            </p>
          )}
          {st?.agents.map((a) => (
            <div className="row" key={a.reporter}>
              <Avatar initials={initialsOf(a.name ?? a.reporter)} color={T.steel} size={28} />
              <span style={{ flexGrow: 1, lineHeight: 1.25, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>{a.name ?? `…${a.reporter.slice(-5)}`}</span>
                <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>
                  {a.lines} lines{a.rejected ? ` · ${a.rejected} rejected` : ''}
                </span>
              </span>
              <span className="mono" style={{ fontSize: 10, color: recent(a.last) ? T.green : T.txt3 }}>{ago(a.last)}</span>
            </div>
          ))}
          <p className="mono" style={{ fontSize: 10, color: T.txt3, lineHeight: 1.5, margin: '10px 0 0' }}>
            File tail only — no GPU, no memory reads, no injection.
          </p>
        </Card>

        <Card style={{ padding: 15 }}>
          <Sect title="Retention" />
          <p style={{ fontSize: 13, color: T.txt2, lineHeight: 1.55, margin: 0 }}>
            A wipe clears map state, bases, events and threat state. Identity, name history, fight records
            and rosters carry over, so the app gets sharper every wipe.
          </p>
        </Card>
      </aside>
    </>
  )
}
