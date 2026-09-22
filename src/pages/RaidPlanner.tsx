import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, Chip, PageHeader, Sect, Stat, T } from '../components/ui'
import { Empty } from '../components/Empty'
import { useServer } from '../state/ServerProvider'
import {
  affordability, DOORS, EXPLOSIVE_LABEL, planRaid, RAID_TABLE_SOURCE, SULFUR_PER, WALLS,
  type Explosive, type Inventory,
} from '../../shared/raid'

const INVENTORY_KEY = 'nabrust.raid.inventory'
const INV_FIELDS: { key: Explosive | 'sulfur'; label: string }[] = [
  { key: 'c4', label: 'C4' }, { key: 'rocket', label: 'Rockets' }, { key: 'satchel', label: 'Satchels' },
  { key: 'explo', label: 'Explosive 5.56' }, { key: 'sulfur', label: 'Raw sulfur' },
]

/** A path with at least one wall or door to get through. */
function hasPath(b: { raidPath?: { walls: object; doors: object } | null }): boolean {
  return !!b.raidPath && (Object.values(b.raidPath.walls).some((n) => n > 0) || Object.values(b.raidPath.doors).some((n) => n > 0))
}

/** What you're holding is per-viewer and optional; storage may be blocked. */
function loadInventory(): Inventory {
  try { return JSON.parse(localStorage.getItem(INVENTORY_KEY) ?? '{}') as Inventory } catch { return {} }
}

function mixText(mix: Partial<Record<Explosive, number>>): string {
  return (Object.entries(mix) as [Explosive, number][])
    .map(([x, n]) => `${n} ${EXPLOSIVE_LABEL[x].toLowerCase()}`).join(' + ')
}

export function RaidPlanner() {
  const { server, data } = useServer()
  const targets = useMemo(
    () => data.bases.filter((b) => !b.ours).sort((a, b) => Number(hasPath(b)) - Number(hasPath(a))),
    [data.bases],
  )
  const [pick, setPick] = useState<string | null>(null)
  const target = targets.find((b) => b.id === pick) ?? targets[0] ?? null
  const plans = useMemo(() => (target?.raidPath ? planRaid(target.raidPath) : []), [target])
  const [chosen, setChosen] = useState<string>('cheapest')
  const plan = plans.find((p) => p.key === chosen) ?? plans[0]

  const [inv, setInv] = useState<Inventory>(() => loadInventory())
  useEffect(() => {
    try { localStorage.setItem(INVENTORY_KEY, JSON.stringify(inv)) } catch { /* not persisted */ }
  }, [inv])
  const hasInventory = Object.values(inv).some((v) => (v ?? 0) > 0)
  const afford = plan && hasInventory ? affordability(plan, inv) : null

  const clan = target?.ownerClanId ? data.clans.find((c) => c.id === target.ownerClanId) : undefined

  if (!target) {
    return (
      <Empty
        title="Nothing to plan against here"
        detail={`No enemy base is marked on ${server.name}. Mark one in the Base Library with the walls and doors between outside and the loot, and it gets costed here.`}
        action={<Link className="btn btn--primary" to="/bases">Open the Base Library</Link>}
      />
    )
  }

  const layers = target.raidPath
    ? [
      ...Object.entries(target.raidPath.walls).flatMap(([t, n]) => Array.from({ length: n ?? 0 }, () => `${t} wall`)),
      ...Object.entries(target.raidPath.doors).flatMap(([t, n]) => Array.from({ length: n ?? 0 }, () => `${t} door`)),
    ]
    : []

  return (
    <>
      <div className="col">
        <PageHeader
          title={`Raid plan · ${target.ownerClan ?? target.owner ?? 'unattributed'}`}
          sub={`grid ${target.grid} · ${target.tier} · ${target.turrets} turret${target.turrets === 1 ? '' : 's'} · ${target.status}`}
          actions={targets.length > 1 ? (
            <select className="input" value={target.id} onChange={(e) => { setPick(e.target.value); setChosen('cheapest') }} aria-label="Target base">
              {targets.map((b) => (
                <option key={b.id} value={b.id}>{b.ownerClan ?? b.owner ?? 'unattributed'} · {b.grid}{hasPath(b) ? '' : ' (no path)'}</option>
              ))}
            </select>
          ) : undefined}
        />

        {!target.raidPath || layers.length === 0 ? (
          <Card>
            <p style={{ fontSize: 13, color: T.txt2, margin: 0, lineHeight: 1.6 }}>
              No raid path recorded for this base. Edit it in the <Link to="/bases">Base Library</Link> and
              add the walls and doors between the outside and the loot — that is what gets costed.
            </p>
          </Card>
        ) : (
          <>
            <Card style={{ padding: 18 }}>
              <Sect title="The way in" />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <Chip color={T.txt3}>OUTSIDE</Chip>
                {layers.map((l, i) => {
                  const [tier, kind] = l.split(' ')
                  const need = kind === 'wall' ? WALLS[tier as keyof typeof WALLS] : DOORS[tier as keyof typeof DOORS]
                  const cheapestX = (Object.keys(need) as Explosive[])
                    .reduce((a, b) => (need[a] * SULFUR_PER[a] <= need[b] * SULFUR_PER[b] ? a : b))
                  return (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: T.txt3 }}>→</span>
                      <span style={{ padding: '6px 10px', borderRadius: 7, background: T.surf2, border: `1px solid ${T.border}` }}>
                        <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>{l}</span>
                        <span className="mono" style={{ fontSize: 10, color: T.txt3, display: 'block' }}>
                          {need[cheapestX]} {EXPLOSIVE_LABEL[cheapestX].toLowerCase()}
                        </span>
                      </span>
                    </span>
                  )
                })}
                <span style={{ color: T.txt3 }}>→</span>
                <Chip color={T.rust} bg={T.rustDim}>LOOT</Chip>
              </div>
              {target.note && <p style={{ fontSize: 12, color: T.txt2, margin: '12px 0 0' }}>{target.note}</p>}
            </Card>

            <div className="label">WAYS TO DO IT</div>
            <div className="grid3">
              {plans.map((p) => {
                const active = p.key === plan?.key
                return (
                  <button key={p.key} onClick={() => setChosen(p.key)}
                    style={{
                      textAlign: 'left', background: T.surf1, borderRadius: 10, padding: 15, cursor: 'pointer',
                      border: `1px solid ${active ? T.rust : T.border}`,
                      boxShadow: active ? `0 0 0 1px ${T.rust}` : 'none', color: 'inherit',
                    }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{p.label}</span>
                      {p === plans[0] && <Chip color={T.green} bg="rgba(87,176,111,.13)">CHEAPEST</Chip>}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 10 }}>
                      <span className="rjd" style={{ fontSize: 28, fontWeight: 700, color: active ? T.rustBr : T.txt }}>
                        {p.sulfur.toLocaleString()}
                      </span>
                      <span className="mono" style={{ fontSize: 12, color: T.txt3 }}>sulfur</span>
                    </div>
                    <div style={{ fontSize: 12, color: T.txt2, marginTop: 4 }}>{mixText(p.mix)}</div>
                    <div className="mono" style={{ fontSize: 10, color: T.txt3, marginTop: 4 }}>{p.description}</div>
                  </button>
                )
              })}
            </div>
            <p className="mono" style={{ fontSize: 10, color: T.txt3, margin: 0 }}>
              Explosives per wall and door from {RAID_TABLE_SOURCE}. Turrets, honeycomb and hidden layers you
              didn&apos;t record aren&apos;t in these numbers.
            </p>
          </>
        )}
      </div>

      <aside className="panel" style={{ width: 312 }}>
        <Card style={{ padding: 15 }}>
          <Sect title="What you have" />
          {INV_FIELDS.map((f) => (
            <label key={f.key} className="row" style={{ justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: T.txt2 }}>{f.label}</span>
              <input className="input" type="number" min={0} value={inv[f.key] ?? ''} placeholder="0"
                onChange={(e) => setInv({ ...inv, [f.key]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
                style={{ width: 90, height: 28, textAlign: 'right' }} aria-label={f.label} />
            </label>
          ))}
          {plan && afford && (
            <div className={afford.ok ? 'note note--ok' : 'note'} style={{ marginTop: 12 }}>
              {afford.ok
                ? <>You can do the <b style={{ color: T.txt }}>{plan.label.toLowerCase()}</b> plan with what you have.</>
                : <>Short by <b style={{ color: T.crit }}>{afford.shortSulfur.toLocaleString()} sulfur</b> for the {plan.label.toLowerCase()} plan.</>}
            </div>
          )}
          <p className="mono" style={{ fontSize: 10, color: T.txt3, margin: '10px 0 0' }}>
            Kept in this browser only.
          </p>
        </Card>

        {plan && (
          <div className="grid2">
            <Stat label="Explosives" value={String(Object.values(plan.mix).reduce((s, n) => s + (n ?? 0), 0))} sub={plan.label.toLowerCase()} color={T.rust} />
            <Stat label="Layers" value={String(layers.length)} sub="between you and loot" color={T.steel} />
          </div>
        )}

        <Card style={{ padding: 15 }}>
          <Sect title="When they're on" />
          <p style={{ fontSize: 13, color: T.txt2, lineHeight: 1.55, margin: 0 }}>
            {clan
              ? <>{clan.label} is mostly on <b style={{ color: T.txt }}>{clan.activityWindow}</b>, up to{' '}
                <b style={{ color: T.txt }}>{clan.peakConcurrent}</b> at once over the last week. Raid outside that window.</>
              : 'Link this base to a roster in the Base Library to see when its owners are usually online.'}
          </p>
        </Card>
      </aside>
    </>
  )
}
