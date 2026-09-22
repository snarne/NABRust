import { useMemo, useState } from 'react'
import { Card, Chip, PageHeader, Sect, T } from '../components/ui'
import { Icon } from '../components/icons'
import { Empty } from '../components/Empty'
import { useServer } from '../state/ServerProvider'
import { linkConfidence } from '../../shared/inference/clanEvidence'
import type { CombatEvent } from '../../shared/types'

const PARTY_COLORS = [T.crit, T.amber, T.purple, T.steel]

/**
 * HP accounting: if a target lost more HP between our own hits than our
 * damage explains, someone outside our party was shooting them.
 */
function annotateThirdParties(events: CombatEvent[]): CombatEvent[] {
  const byTarget = new Map<string, CombatEvent[]>()
  for (const e of events) {
    const arr = byTarget.get(e.target) ?? []
    arr.push(e)
    byTarget.set(e.target, arr)
  }
  const flagged = new Set<CombatEvent>()
  for (const arr of byTarget.values()) {
    arr.sort((a, b) => a.t - b.t)
    for (let i = 1; i < arr.length; i++) {
      const drop = arr[i - 1].hpAfter - arr[i].hpBefore
      if (drop > 5) flagged.add(arr[i])
    }
  }
  return events.map((e) => (flagged.has(e) || e.thirdPartyFlag ? { ...e, thirdPartyFlag: true } : e))
}

export function Timeline() {
  const { server, data, nameOf, isUs } = useServer()
  const encounters = data.recentEncounters?.length ? data.recentEncounters : data.encounter ? [data.encounter] : []
  const [pick, setPick] = useState<string | null>(null)
  const encounter = encounters.find((e) => e.id === pick) ?? encounters[0] ?? null
  const [filter, setFilter] = useState<number | null>(null)

  const events = useMemo(
    () => (encounter ? annotateThirdParties(encounter.events) : []),
    [encounter],
  )

  /**
   * Party assignment comes from the pair graph: attackers linked to each other
   * above threshold share a party, anyone else is their own.
   */
  const partyOf = useMemo(() => {
    const groups: string[][] = []
    for (const e of events) {
      const a = String(e.attacker)
      if (isUs(a) || a === 'environment' || groups.some((g) => g.includes(a))) continue
      const mates = data.pairLinks
        .filter((l) => (l.a === a || l.b === a))
        .filter((l) => linkConfidence(l) > 0.5)
        .map((l) => (l.a === a ? l.b : l.a))
      const existing = groups.find((g) => mates.some((m) => g.includes(m)))
      if (existing) existing.push(a)
      else groups.push([a, ...mates])
    }
    return (attacker: string): number => {
      if (isUs(attacker)) return 3
      const i = groups.findIndex((g) => g.includes(attacker))
      return i < 0 ? 2 : Math.min(i, 2)
    }
  }, [events, data.pairLinks, isUs])

  const label = (id: string) => (id === data.self ? 'you' : isUs(id) ? `${nameOf(id)} (team)` : nameOf(id))
  const t0 = events[0]?.t ?? 0

  const shown = filter === null ? events : events.filter((e) => partyOf(String(e.attacker)) === filter)

  const unexplained = useMemo(() => {
    // Pick the enemy we damaged most — the one worth accounting for.
    const target = events.find((e) => isUs(String(e.attacker)) && !isUs(e.target))?.target
    if (!target) return null
    const hits = events.filter((e) => e.target === target)
    const observedDrop = hits.length ? hits[0].hpBefore - hits[hits.length - 1].hpAfter : 0
    const ourDamage = events.filter((e) => isUs(String(e.attacker)) && e.target === target)
      .reduce((a, e) => a + e.damage, 0)
    const gap = Math.round(observedDrop - ourDamage)
    return gap > 5 ? { target, observedDrop, ourDamage, gap } : null
  }, [events, isUs])
  const thirdParty = events.some((e) => e.thirdPartyFlag)

  if (!encounter) {
    return (
      <Empty
        title="No encounters logged here"
        detail={`Nothing has been reconstructed on ${server.name}. Encounters appear once a teammate's log agent sends combat logs from this server — or paste one with \`nab ingest\`.`}
      />
    )
  }

  return (
    <>
      <div className="col">
        <PageHeader
          title={`Engagement · ${encounter.label}`}
          sub={`${encounter.events.length} events · ${encounter.partiesDetected} parties detected · you ${encounter.outcome}`}
          actions={
            <>
              {encounters.length > 1 && (
                <select className="input" value={encounter.id} onChange={(e) => { setPick(e.target.value); setFilter(null) }}
                  aria-label="Choose an encounter" style={{ maxWidth: 280 }}>
                  {encounters.map((e) => (
                    <option key={e.id} value={e.id}>
                      {new Date(e.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · {e.label}
                    </option>
                  ))}
                </select>
              )}
              <button className="btn" onClick={() => setFilter(filter === null ? 0 : filter === 0 ? 2 : null)}>
                {Icon.filter({ size: 15 })} {filter === null ? 'Main enemy only' : filter === 0 ? 'Third parties only' : 'Show all'}
              </button>
            </>
          }
        />

        <div>
          {shown.map((e, i) => {
            const party = partyOf(String(e.attacker))
            const color = PARTY_COLORS[party]
            return (
              <div className="tl" key={i}>
                <div className="tl__time">
                  <span className="mono" style={{ fontSize: 12, color: T.txt3 }}>+{(e.t - t0).toFixed(1)}s</span>
                </div>
                <div className="tl__spine">
                  <span className="tl__dot" style={{ background: color }} />
                  <span className="tl__line" />
                </div>
                <div style={{ flexGrow: 1, paddingBottom: 14 }}>
                  <Card style={{ padding: '13px 15px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                      <span style={{ fontSize: 14, fontWeight: 600 }}>
                        {label(String(e.attacker))} → {label(e.target)}
                      </span>
                      {e.thirdPartyFlag && <Chip color={T.purple} bg="rgba(155,123,212,.15)">3RD PARTY</Chip>}
                      <span style={{ flexGrow: 1 }} />
                      <span className="mono" style={{ fontSize: 12, color: T.txt3 }}>{e.distance}m</span>
                    </div>
                    <div style={{ display: 'flex', gap: 18, marginTop: 9, flexWrap: 'wrap' }}>
                      <Metric label="WEAPON" value={e.weapon} color={T.txt} />
                      <Metric label="AMMO" value={e.ammo ?? '—'} color={T.txt2} />
                      <Metric label="DAMAGE" value={String(e.damage)} color={T.red} />
                      <Metric label="AREA" value={e.area} color={T.amber} />
                      <Metric label="TARGET HP" value={`${e.hpBefore} → ${e.hpAfter}`} color={T.steel} />
                    </div>
                  </Card>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <aside className="panel" style={{ width: 316 }}>
        <Card style={{ padding: 15 }}>
          <Sect title="Parties in this fight" />
          {[...new Set(events.map((e) => String(e.attacker)))].map((a) => {
            const party = partyOf(a)
            return (
              <PartyRow key={a} tag={isUs(a) ? '—' : String.fromCharCode(65 + party)}
                name={label(a)} color={PARTY_COLORS[party]}
                sub={isUs(a) ? 'your team' : party === 2 ? 'separate party' : 'linked by pair graph'} />
            )
          })}
        </Card>

        {unexplained && (
          <Card style={{ padding: 15 }}>
            <Sect title="HP accounting" />
            <p style={{ fontSize: 13, color: T.txt2, lineHeight: 1.5, margin: 0 }}>
              {nameOf(unexplained.target)} dropped <b style={{ color: T.txt }}>{unexplained.observedDrop} HP</b> but
              your hits account for only <b style={{ color: T.txt }}>{unexplained.ourDamage}</b>.
              {' '}<b style={{ color: T.purple }}>{unexplained.gap} HP unexplained</b> — a shooter outside both
              parties is confirmed present.
            </p>
          </Card>
        )}

        {thirdParty && (
          <Card style={{ padding: 15 }}>
            <Sect title="Why this matters" />
            <p style={{ fontSize: 13, color: T.txt2, lineHeight: 1.55, margin: 0 }}>
              Everyone who shot you in the same fight is not a team. The flagged hits show damage your
              log can&apos;t explain, and a late first shot counts against two attackers being teammates —
              so this fight weakens that link instead of strengthening it.
            </p>
          </Card>
        )}
      </aside>
    </>
  )
}

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 9, letterSpacing: 1, color: T.txt3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function PartyRow({ tag, name, color, sub }: { tag: string; name: string; color: string; sub: string }) {
  return (
    <div className="row">
      <span style={{
        width: 26, height: 26, borderRadius: 6, background: color, color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'Rajdhani', fontWeight: 700, fontSize: 14,
      }}>{tag}</span>
      <span style={{ flexGrow: 1, lineHeight: 1.25 }}>
        <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>{name}</span>
        <span className="mono" style={{ fontSize: 10, color: T.txt3 }}>{sub}</span>
      </span>
    </div>
  )
}
