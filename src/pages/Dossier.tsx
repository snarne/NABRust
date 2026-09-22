import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Avatar, Bar, Card, Chip, Sect, Stat, T, initialsOf, threatColor } from '../components/ui'
import { MapCanvas } from '../components/MapCanvas'
import { Empty } from '../components/Empty'
import { useServer } from '../state/ServerProvider'
import { linkConfidence } from '../../shared/inference/clanEvidence'

const HEAT_COLORS = ['var(--surf3)', 'rgba(210,113,47,.35)', 'rgba(210,113,47,.6)', 'var(--rust)']
const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const WEAPON_COLORS = [T.rust, T.steel, T.amber, T.txt2, T.txt3]
/** A link below this isn't worth listing as a possible teammate. */
const SHOW_LINK = 0.15

/** Rust item shortnames read poorly; tidy the common ones. */
function weaponName(w: string): string {
  const known: Record<string, string> = {
    'rifle.ak': 'AK-47', 'rifle.bolt': 'Bolt Action', 'rifle.lr300': 'LR-300', 'rifle.l96': 'L96',
    'rifle.m39': 'M39', 'rifle.semiauto': 'SAR', 'smg.mp5': 'MP5', 'smg.thompson': 'Thompson',
    'smg.2': 'Custom SMG', 'shotgun.double': 'Double Barrel', 'shotgun.pump': 'Pump Shotgun',
    'pistol.python': 'Python', 'pistol.revolver': 'Revolver', 'pistol.semiauto': 'P2', 'pistol.m92': 'M92',
    'lmg.m249': 'M249', 'hmlmg': 'HMLMG', 'bow.hunting': 'Bow', 'crossbow': 'Crossbow',
  }
  return known[w] ?? w
}

export function Dossier() {
  const { server, data, nameOf, isUs } = useServer()
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState('')

  // Opponents worth a dossier first: people who fought us, then by threat.
  const candidates = useMemo(
    () => Object.values(data.players)
      .filter((p) => !isUs(p.steamId))
      .sort((a, b) =>
        (b.vsUs?.encounters ?? 0) - (a.vsUs?.encounters ?? 0) ||
        Number(b.online) - Number(a.online) ||
        b.threatPercentile - a.threatPercentile),
    [data, isUs],
  )
  const wanted = params.get('p')
  const subject = (wanted && data.players[wanted] ? wanted : null) ?? candidates[0]?.steamId ?? null
  const select = (id: string) => setParams((ps) => { ps.set('p', id); return ps }, { replace: true })

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return candidates.filter((p) =>
      p.steamId.toLowerCase().includes(q) || p.names.some((n) => n.name.toLowerCase().includes(q)),
    ).slice(0, 8)
  }, [candidates, query])

  const teammates = useMemo(() => {
    if (!subject) return []
    return data.pairLinks
      .filter((l) => l.a === subject || l.b === subject)
      .map((l) => ({ steamId: l.a === subject ? l.b : l.a, conf: linkConfidence(l), evidence: l.evidence }))
      .filter((t) => t.conf >= SHOW_LINK)
      .sort((a, b) => b.conf - a.conf)
  }, [data, subject])

  const clan = subject ? data.clans.find((c) => c.members.some((m) => m.steamId === subject)) : undefined
  const base = subject
    ? data.bases.find((b) => !b.ours && (b.ownerSteamId === subject || (clan && b.ownerClanId === clan.id))) ?? null
    : null

  if (!subject) {
    return (
      <Empty
        title="No players tracked on this server"
        detail={`Nothing has been collected for ${server.name} yet. Leave \`nab serve\` running — the Battlemetrics collector builds session history, and combat logs arrive once someone on your team plays here.`}
      />
    )
  }

  const p = data.players[subject]
  const current = nameOf(subject)
  const formerNames = p.names.filter((n) => n.lastSeen).map((n) => n.name)
  const c = p.vsUs
  const idLabel = subject.startsWith('bm:')
    ? `battlemetrics ${subject.slice(3)} · steam id not seen yet`
    : `steam ${subject}`
  const weaponTotal = c?.weapons.reduce((s, w) => s + w.hits, 0) ?? 0

  return (
    <>
      <div className="col">
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
            <Avatar initials={initialsOf(current)} color={threatColor(p.threatPercentile)} size={64} />
            <div style={{ flexGrow: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span className="rjd" style={{ fontSize: 26, fontWeight: 700 }}>{current}</span>
                <Chip color={threatColor(p.threatPercentile)} bg="rgba(176,52,43,.15)">
                  THREAT {p.threatPercentile} · PERCENTILE ON THIS SERVER
                </Chip>
              </div>
              <div className="mono" style={{ fontSize: 12, color: T.txt3, marginTop: 5 }}>
                {idLabel}
                {formerNames.length > 0 && ` · formerly ${formerNames.join(', ')}`}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <Chip color={T.steel} bg={T.steelDim}>
                  {p.hoursPlayed !== null ? `${p.hoursPlayed.toLocaleString()} h Rust` : 'Rust hours private/unknown'}
                </Chip>
                {p.accountAgeYears !== null && <Chip color={T.steel} bg={T.steelDim}>acct {p.accountAgeYears} yrs</Chip>}
                {(p.vacBans > 0 || p.gameBans > 0) && (
                  <Chip color={T.red} bg="rgba(176,52,43,.15)">{p.vacBans} VAC · {p.gameBans} game bans</Chip>
                )}
                <Chip color={T.txt2}>{p.serverHoursThisWipe} h this wipe</Chip>
                {clan && <Chip color={T.rust} bg={T.rustDim}>{clan.label}</Chip>}
                {p.online && <Chip color={T.green} bg="rgba(87,176,111,.13)">online now</Chip>}
              </div>
            </div>
            <div style={{ position: 'relative', width: 230 }}>
              <input className="input" style={{ width: '100%' }} value={query} placeholder={`Find among ${candidates.length} players…`}
                onChange={(e) => setQuery(e.target.value)} aria-label="Find a player" />
              {matches.length > 0 && (
                <div role="listbox" style={{
                  position: 'absolute', top: 38, left: 0, right: 0, zIndex: 5, background: T.surf2,
                  border: `1px solid ${T.border}`, borderRadius: 8, overflow: 'hidden',
                }}>
                  {matches.map((m) => (
                    <button key={m.steamId} role="option" aria-selected={m.steamId === subject}
                      onClick={() => { select(m.steamId); setQuery('') }}
                      style={{
                        display: 'flex', width: '100%', justifyContent: 'space-between', padding: '8px 10px',
                        background: 'none', border: 'none', color: T.txt, cursor: 'pointer', fontSize: 13, textAlign: 'left',
                      }}>
                      <span>{nameOf(m.steamId)}</span>
                      <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>{m.online ? 'online' : ''} {m.threatPercentile}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Card>

        <div className="grid4">
          <Stat label="Encounters" value={String(c?.encounters ?? 0)} sub="with your team this wipe" />
          <Stat label="Record" value={c ? `${c.deathsToUs}–${c.killsOnUs}` : '—'} sub="we killed / they killed"
            color={c && c.killsOnUs > c.deathsToUs ? T.red : T.green} />
          <Stat label="Headshots" value={c?.hitsOnUs ? `${Math.round(c.headshotRate * 100)}%` : '—'} sub={`of ${c?.hitsOnUs ?? 0} hits on us`} color={T.amber} />
          <Stat label="Avg range" value={c?.avgRangeMetres ? `${c.avgRangeMetres}m` : '—'} sub="when they hit us" color={T.steel} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
          <Card>
            <Sect title="Activity · last 28 days · UTC" />
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-around', padding: '2px 0' }}>
                {['00', '06', '12', '18'].map((h) => (
                  <span key={h} className="mono" style={{ fontSize: 9, color: T.txt3 }}>{h}</span>
                ))}
              </div>
              <div style={{ flexGrow: 1 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
                  {[0, 1, 2, 3].map((block) =>
                    p.activity.map((day, d) => (
                      <span key={`${block}-${d}`} style={{ height: 26, borderRadius: 4, background: HEAT_COLORS[day[block]] }} />
                    )),
                  )}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4, marginTop: 5 }}>
                  {DAYS.map((d, i) => (
                    <span key={i} className="mono" style={{ fontSize: 9, color: T.txt3, textAlign: 'center' }}>{d}</span>
                  ))}
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <Sect title="Name history" />
            {p.names.length === 0 && <p style={{ fontSize: 13, color: T.txt3, margin: 0 }}>No names recorded.</p>}
            {p.names.map((n, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0' }}>
                <span className="mono" style={{ fontSize: 11, color: T.txt3, width: 78 }}>
                  {n.lastSeen === null ? 'current' : n.firstSeen.slice(5, 10)}
                </span>
                <span style={{ fontSize: 13, fontWeight: n.lastSeen === null ? 600 : 400, color: n.lastSeen === null ? T.txt : T.txt2 }}>
                  {n.name}
                </span>
                <span className="mono" style={{ fontSize: 9, color: T.txt3 }}>{n.source}</span>
              </div>
            ))}
            <p className="mono" style={{ fontSize: 10, color: T.txt3, lineHeight: 1.5, marginBottom: 0 }}>
              Identity is keyed on the id, so renames never orphan history.
            </p>
          </Card>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Card>
            <Sect title="Weapons they hit us with" />
            {!c?.weapons.length && (
              <p style={{ fontSize: 13, color: T.txt3, margin: 0 }}>
                No hits on your team logged. This fills in from your combat logs.
              </p>
            )}
            {c?.weapons.slice(0, 5).map((w, i) => {
              const pct = Math.round((w.hits / weaponTotal) * 100)
              return (
                <div key={w.weapon} style={{ marginBottom: 11 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{weaponName(w.weapon)}</span>
                    <span className="mono" style={{ fontSize: 11, color: T.txt3 }}>{w.hits} hits · {pct}%</span>
                  </div>
                  <Bar pct={pct} color={WEAPON_COLORS[i]} />
                </div>
              )
            })}
          </Card>

          <Card>
            <Sect title="Why this threat score" />
            {(p.threatFactors ?? []).map((f) => (
              <div key={f.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${T.border}` }}>
                <span style={{ fontSize: 13, color: T.txt2 }}>{f.label}</span>
                <span className="mono" style={{ fontSize: 12 }}>{f.value}</span>
              </div>
            ))}
            <p className="mono" style={{ fontSize: 10, color: T.txt3, lineHeight: 1.5, margin: '8px 0 0' }}>
              Ranked against everyone on this server this wipe. Missing inputs don&apos;t count against anyone.
            </p>
          </Card>
        </div>
      </div>

      <aside className="panel">
        <Card style={{ padding: 15 }}>
          <Sect title="Possible teammates" right={<Chip color={T.rust} bg={T.rustDim}>{teammates.length}</Chip>} />
          {teammates.length === 0 && (
            <p style={{ fontSize: 13, color: T.txt3, margin: 0 }}>
              Nobody has moved with this player often enough to say. Rosters need days of session history.
            </p>
          )}
          {teammates.slice(0, 10).map((t) => (
            <button className="row" key={t.steamId} onClick={() => select(t.steamId)}
              style={{ width: '100%', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
              <Avatar initials={initialsOf(nameOf(t.steamId))} color={threatColor(data.players[t.steamId]?.threatPercentile ?? 50)} size={30} />
              <span style={{ flexGrow: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>{nameOf(t.steamId)}</span>
                <span className="mono" style={{ fontSize: 10, color: T.txt3, display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  title={t.evidence.map((e) => e.note ?? e.kind).join('\n')}>
                  {t.evidence.map((e) => e.note ?? e.kind)[0]}
                </span>
              </span>
              <span className="rjd" style={{ fontSize: 18, fontWeight: 700, color: t.conf > 0.6 ? T.green : T.txt3 }}>
                {(t.conf * 100).toFixed(0)}%
              </span>
            </button>
          ))}
          <p className="mono" style={{ fontSize: 10, color: T.txt3, lineHeight: 1.5, marginBottom: 0 }}>
            Probability they&apos;re on the same team. On simulated servers these land within
            4 points of how often it&apos;s true.
          </p>
        </Card>

        <Card style={{ padding: 15 }}>
          <Sect title="Known base" />
          {base ? (
            <>
              <div style={{ borderRadius: 8, overflow: 'hidden', border: `1px solid ${T.border}`, aspectRatio: '1 / 1' }}>
                <MapCanvas server={server} compact showMonuments={false} fit="meet"
                  heat={[{ pos: base.pos, radius: 0.1, color: T.red }]}
                  markers={[{ pos: base.pos, kind: 'enemy' }]} />
              </div>
              <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, fontSize: 11, color: T.txt2 }}>
                <span>grid {base.grid} · {base.tier}</span>
                <span style={{ color: T.amber }}>{base.status} · {base.lastEvidence}</span>
              </div>
            </>
          ) : (
            <p style={{ fontSize: 13, color: T.txt3, margin: 0 }}>
              No base marked for this player or their group. Mark one from the Base Library.
            </p>
          )}
        </Card>
      </aside>
    </>
  )
}
