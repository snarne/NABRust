import { useMemo, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Icon, type IconKey } from './icons'
import { Avatar, Chip, T, initialsOf } from './ui'
import { useServer } from '../state/ServerProvider'
import { resolveMapSource } from '../../shared/mapSource'

const NAV: { to: string; label: string; icon: IconKey }[] = [
  { to: '/', label: 'Command', icon: 'command' },
  { to: '/dossier', label: 'Dossiers', icon: 'dossier' },
  { to: '/timeline', label: 'Timeline', icon: 'timeline' },
  { to: '/retracer', label: 'Death Retracer', icon: 'retracer' },
  { to: '/raid', label: 'Raid Planner', icon: 'raid' },
  { to: '/bases', label: 'Base Library', icon: 'base' },
  { to: '/servers', label: 'Servers', icon: 'servers' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
]

const TITLES: Record<string, string> = {
  '/': 'Command', '/dossier': 'Dossiers', '/timeline': 'Timeline',
  '/retracer': 'Death Retracer', '/raid': 'Raid Planner',
  '/bases': 'Base Library', '/servers': 'Servers', '/settings': 'Settings',
}

export function Shell() {
  const { pathname } = useLocation()
  const { server, servers, serverId, setServerId, connection, data, nameOf, status, isUs } = useServer()
  const mapSource = resolveMapSource(server)
  const demo = connection.mode === 'demo'
  const navigate = useNavigate()
  const [q, setQ] = useState('')

  // Search players by any name they've used, or by id, and clans by label.
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (s.length < 2) return []
    const players = Object.values(data.players)
      .filter((p) => p.steamId.toLowerCase().includes(s) || p.names.some((n) => n.name.toLowerCase().includes(s)))
      .slice(0, 6)
      .map((p) => ({ key: p.steamId, label: nameOf(p.steamId), sub: isUs(p.steamId) ? 'your team' : p.online ? 'online' : 'player', to: `/dossier?p=${encodeURIComponent(p.steamId)}` }))
    const clans = data.clans.filter((c) => c.label.toLowerCase().includes(s)).slice(0, 3)
      .map((c) => ({ key: c.id, label: c.label, sub: `${c.members.length} members`, to: `/dossier?p=${encodeURIComponent(c.members[0].steamId)}` }))
    return [...players, ...clans]
  }, [q, data, nameOf, isUs])
  const teamName = status?.team.name ?? (demo ? 'demo team' : 'your team')
  const teamSize = status?.team.members ?? data.team.length

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail__brand">
          <span className="rail__mark">{Icon.bolt()}</span>
          <span className="rjd" style={{ fontWeight: 700, fontSize: 21, letterSpacing: 1.5, lineHeight: 1 }}>
            NAB<span style={{ color: T.rust }}>RUST</span>
          </span>
        </div>

        <nav className="rail__nav">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}
              className={({ isActive }) => 'rail__item' + (isActive ? ' is-active' : '')}>
              {Icon[n.icon]()}
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="rail__foot">
          <Avatar initials={initialsOf(teamName)} color={T.rust} size={30} />
          <span style={{ flexGrow: 1, lineHeight: 1.2 }}>
            <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>{teamName}</span>
            <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>
              {teamSize ? `${teamSize} member${teamSize === 1 ? '' : 's'}` : 'set NABRUST_TEAM'}
            </span>
          </span>
          <NavLink to="/settings" aria-label="Settings" style={{ color: T.txt3, display: 'flex' }}>
            {Icon.settings()}
          </NavLink>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="rjd" style={{ fontWeight: 600, fontSize: 18, letterSpacing: .5 }}>
            {TITLES[pathname] ?? 'NABRust'}
          </span>
          <span className="topbar__sep" />

          {/* Switching server reloads the map and every server-scoped panel. */}
          <label className="serverpick" title="Active server">
            {Icon.servers({ size: 15 })}
            <select value={serverId} onChange={(e) => setServerId(e.target.value)} aria-label="Active server">
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {Icon.chev({ size: 14 })}
          </label>

          {server.simulated && (
            <span title="Built by `nab simulate` for testing — nothing on this server is real">
              <Chip color={T.steel} bg={T.steelDim}>SIMULATED</Chip>
            </span>
          )}
          {demo && (
            <NavLink to="/settings" title={connection.error ?? 'Not connected to a NABRust API'}
              style={{ display: 'inline-flex' }}>
              <Chip color={T.amber} bg="rgba(217,164,65,.13)">DEMO DATA</Chip>
            </NavLink>
          )}
          <Chip color={T.rust} bg={T.rustDim}>
            {server.wipeDay > 0 ? `WIPE DAY ${server.wipeDay}` : 'WIPE DAY ?'}
          </Chip>
          <Chip
            color={mapSource.kind === 'placeholder' ? T.amber : T.green}
            bg={mapSource.kind === 'placeholder' ? 'rgba(217,164,65,.13)' : 'rgba(87,176,111,.13)'}
          >
            MAP {mapSource.label}
          </Chip>

          <span style={{ flexGrow: 1 }} />
          <div style={{ position: 'relative' }}>
            <label className="topbar__search">
              {Icon.search()}
              <input type="text" placeholder="Search player, clan, id…" aria-label="Search"
                value={q} onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && hits[0]) { navigate(hits[0].to); setQ('') }
                  if (e.key === 'Escape') setQ('')
                }} />
            </label>
            {hits.length > 0 && (
              <div role="listbox" style={{
                position: 'absolute', top: 40, left: 0, right: 0, zIndex: 20, background: T.surf2,
                border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden',
              }}>
                {hits.map((h) => (
                  <button key={h.key} role="option" aria-selected={false}
                    onClick={() => { navigate(h.to); setQ('') }}
                    style={{
                      display: 'flex', width: '100%', justifyContent: 'space-between', gap: 10, padding: '8px 12px',
                      background: 'none', border: 'none', color: T.txt, cursor: 'pointer', fontSize: 13, textAlign: 'left',
                    }}>
                    <span>{h.label}</span>
                    <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>{h.sub}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: T.txt2 }}>
            {(() => {
              // Only "live" if the collector polled recently.
              const fresh = demo || status?.battlemetrics.fresh
              return (
                <span title={fresh ? 'players online now' : 'collector not running — last known count'}
                  style={{ width: 7, height: 7, borderRadius: '50%', background: fresh ? T.green : T.txt3, boxShadow: fresh ? `0 0 6px ${T.green}` : 'none' }} />
              )
            })()}
            {server.pop}/{server.maxPop}
          </span>
        </header>

        {/* key forces a clean remount so no stale server state survives a switch */}
        <div className="content" key={serverId}>
          {/* Hold the pages until the first API answer, so demo intel never
              flashes up on a machine that is actually connected. */}
          {connection.mode === 'connecting'
            ? (
              <div style={{ margin: 'auto', color: T.txt3 }} className="mono" role="status">
                connecting to NABRust…
              </div>
            )
            : <Outlet />}
        </div>
      </div>
    </div>
  )
}
