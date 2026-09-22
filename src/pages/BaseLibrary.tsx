import { useMemo, useState } from 'react'
import { Card, Chip, PageHeader, Sect, T } from '../components/ui'
import { Icon } from '../components/icons'
import { MapCanvas, type MapMarker } from '../components/MapCanvas'
import { useServer } from '../state/ServerProvider'
import { sendJson } from '../data/live'
import { normToGrid } from '../../shared/world'
import { planRaid } from '../../shared/raid'
import type { BaseRecord, BaseStatus, DoorTier, RaidPath, Vec2, WallTier } from '../../shared/types'

const STATUS_COLOR: Record<BaseStatus, string> = { confirmed: T.crit, inferred: T.amber, weak: T.txt2 }
const WALL_TIERS: WallTier[] = ['wood', 'stone', 'metal', 'armored']
const DOOR_TIERS: DoorTier[] = ['wood', 'sheet', 'garage', 'armored']

interface Draft {
  id: string | null
  pos: Vec2 | null
  status: BaseStatus
  tier: WallTier | ''
  turrets: number
  ours: boolean
  ownerClanId: string
  note: string
  raidPath: RaidPath
}

const EMPTY: Draft = {
  id: null, pos: null, status: 'confirmed', tier: 'stone', turrets: 0, ours: false,
  ownerClanId: '', note: '', raidPath: { walls: {}, doors: {} },
}

function fromBase(b: BaseRecord): Draft {
  return {
    id: b.id, pos: b.pos, status: b.status, tier: b.tier === 'unknown' ? '' : b.tier, turrets: b.turrets,
    ours: !!b.ours, ownerClanId: b.ownerClanId ?? '', note: b.note ?? '',
    raidPath: b.raidPath ?? { walls: {}, doors: {} },
  }
}

function Counter({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '3px 0' }}>
      <span style={{ fontSize: 12, color: T.txt2, textTransform: 'capitalize' }}>{label}</span>
      <input className="input" type="number" min={0} max={50} value={value}
        onChange={(e) => onChange(Math.max(0, Math.min(50, Math.floor(Number(e.target.value) || 0))))}
        style={{ width: 64, height: 28 }} aria-label={label} />
    </label>
  )
}

export function BaseLibrary() {
  const { server, data, connection, refresh, nameOf, status } = useServer()
  const live = connection.mode === 'live'
  const bases = data.bases
  const [filter, setFilter] = useState<BaseStatus | 'all'>('all')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const shown = filter === 'all' ? bases : bases.filter((b) => b.status === filter)

  const markers: MapMarker[] = useMemo(() => {
    const out: MapMarker[] = bases.map((b) => ({
      pos: b.pos, kind: b.ours ? 'home' : 'enemy',
      label: b.ours ? 'HOME' : b.ownerClan ?? b.owner ?? b.grid,
      color: b.ours ? undefined : STATUS_COLOR[b.status],
    }))
    if (draft?.pos) out.push({ pos: draft.pos, kind: 'shooter', label: 'NEW', color: T.green })
    return out
  }, [bases, draft])

  const save = async () => {
    if (!draft?.pos) return
    setBusy(true)
    setError(null)
    const body = {
      x: draft.pos.x, y: draft.pos.y, status: draft.status, tier: draft.tier || null,
      turrets: draft.turrets, ours: draft.ours, ownerClanId: draft.ownerClanId || null,
      note: draft.note.trim() || null, raidPath: draft.raidPath,
      reportedBy: status?.team.self ?? null,
    }
    try {
      if (draft.id) {
        await sendJson(connection.config, 'PATCH', `/api/bases/${encodeURIComponent(draft.id)}?serverId=${encodeURIComponent(server.id)}`,
          { ...body, observation: { kind: 'sighting', note: 'edited in the base library' } })
      } else {
        await sendJson(connection.config, 'POST', '/api/bases', { ...body, serverId: server.id })
      }
      setDraft(null)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    setBusy(true)
    try {
      await sendJson(connection.config, 'DELETE', `/api/bases/${encodeURIComponent(id)}?serverId=${encodeURIComponent(server.id)}`)
      setConfirmDelete(null)
      if (draft?.id === id) setDraft(null)
      refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const setPath = (kind: 'walls' | 'doors', tier: string, n: number) =>
    setDraft((d) => d && ({ ...d, raidPath: { ...d.raidPath, [kind]: { ...d.raidPath[kind], [tier]: n } } }))

  const cheapest = draft ? planRaid(draft.raidPath)[0] : undefined

  return (
    <>
      <div className="col">
        <PageHeader
          title="Base Library"
          sub={`${server.name} · ${bases.length} tracked · ${bases.filter((b) => b.status === 'confirmed').length} confirmed`}
          actions={
            <>
              <button className="btn" onClick={() => setFilter(filter === 'all' ? 'confirmed' : 'all')}>
                {Icon.filter({ size: 15 })} {filter === 'all' ? 'Confirmed only' : 'Show all'}
              </button>
              <button className="btn btn--primary" disabled={!live || !!draft}
                title={live ? 'Click the map to place it' : 'Connect to your NABRust API to mark bases'}
                onClick={() => { setDraft({ ...EMPTY }); setError(null) }}>
                {Icon.plus({ size: 15 })} Mark a base
              </button>
            </>
          }
        />

        {(draft || bases.length > 0) && (
          <Card flush>
            <div style={{ height: 460, position: 'relative' }}>
              <MapCanvas server={server} markers={markers} compact showMonuments={false} fit="meet"
                onPick={draft ? (pos) => setDraft((d) => d && ({ ...d, pos })) : undefined} />
              {draft && !draft.pos && (
                <div style={{
                  position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', padding: '7px 13px',
                  borderRadius: 7, background: 'rgba(12,14,15,.85)', border: `1px solid ${T.green}`,
                }}>
                  <span style={{ fontSize: 12, color: T.green, fontWeight: 600 }}>Click the map where the base is</span>
                </div>
              )}
            </div>
          </Card>
        )}

        {shown.length === 0 && !draft && (
          <Card>
            <p style={{ fontSize: 13, color: T.txt3, margin: 0, lineHeight: 1.6 }}>
              No bases tracked on {server.name} yet. Mark one your team has found — or drop a note on the
              in-game map: with Rust+ paired, map notes arrive here as weak sightings on their own.
            </p>
          </Card>
        )}

        <div className="grid4">
          {shown.map((b) => {
            const plan = b.raidPath ? planRaid(b.raidPath)[0] : undefined
            return (
              <Card key={b.id} flush>
                <div style={{ padding: '13px 15px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {b.ours ? 'Our base' : b.ownerClan ?? b.owner ?? 'Unattributed'}
                    </span>
                    <span style={{ flexGrow: 1 }} />
                    <Chip color={b.ours ? T.steel : STATUS_COLOR[b.status]}>{b.ours ? 'HOME' : b.status.toUpperCase()}</Chip>
                  </div>
                  <div className="mono" style={{ fontSize: 11, color: T.txt3, marginTop: 5 }}>
                    grid {b.grid} · {b.tier} · {b.turrets} turret{b.turrets === 1 ? '' : 's'}
                  </div>
                  {b.note && <p style={{ fontSize: 12, color: T.txt2, margin: '8px 0 0', lineHeight: 1.4 }}>{b.note}</p>}
                  <div className="mono" style={{ fontSize: 11, marginTop: 8, color: plan ? T.rustBr : T.txt3 }}>
                    {plan ? `raid from ${plan.sulfur.toLocaleString()} sulfur` : 'no raid path recorded'}
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: T.txt3, marginTop: 6 }}>
                    {b.reportedBy ? `${b.reportedBy === 'map-note' ? 'in-game map note' : `marked by ${nameOf(b.reportedBy)}`} · ` : ''}
                    {b.lastEvidence}{b.observations ? ` · ${b.observations} sighting${b.observations === 1 ? '' : 's'}` : ''}
                  </div>
                  {live && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                      <button className="btn" style={{ height: 28 }} onClick={() => { setDraft(fromBase(b)); setError(null) }}>Edit</button>
                      {confirmDelete === b.id
                        ? <button className="btn" style={{ height: 28, color: T.crit }} disabled={busy} onClick={() => void remove(b.id)}>Really delete</button>
                        : <button className="btn" style={{ height: 28 }} onClick={() => setConfirmDelete(b.id)}>Delete</button>}
                    </div>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      </div>

      <aside className="panel" style={{ width: 316 }}>
        {draft ? (
          <Card style={{ padding: 15 }}>
            <Sect title={draft.id ? 'Edit base' : 'New base'} />
            <p className="mono" style={{ fontSize: 11, color: draft.pos ? T.txt2 : T.amber, margin: '0 0 10px' }}>
              {draft.pos ? `grid ${normToGrid(draft.pos, server.worldSize)} — click the map to move it` : 'click the map to place it'}
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
              <input type="checkbox" checked={draft.ours} onChange={(e) => setDraft({ ...draft, ours: e.target.checked })} />
              <span style={{ fontSize: 13 }}>This is our base</span>
            </label>
            {!draft.ours && (
              <>
                <div className="label" style={{ margin: '8px 0 4px' }}>HOW SURE</div>
                <select className="input" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as BaseStatus })} style={{ width: '100%' }}>
                  <option value="confirmed">confirmed — someone saw it</option>
                  <option value="inferred">inferred — strong guess</option>
                  <option value="weak">weak — a hunch</option>
                </select>
                <div className="label" style={{ margin: '8px 0 4px' }}>WHOSE</div>
                <select className="input" value={draft.ownerClanId} onChange={(e) => setDraft({ ...draft, ownerClanId: e.target.value })} style={{ width: '100%' }}>
                  <option value="">unknown</option>
                  {data.clans.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                </select>
              </>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span className="label" style={{ margin: 0 }}>BUILT FROM</span>
                <select className="input" value={draft.tier} onChange={(e) => setDraft({ ...draft, tier: e.target.value as WallTier | '' })}>
                  <option value="">unknown</option>
                  {WALL_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span className="label" style={{ margin: 0 }}>TURRETS</span>
                <input className="input" type="number" min={0} max={99} value={draft.turrets}
                  onChange={(e) => setDraft({ ...draft, turrets: Math.max(0, Math.min(99, Math.floor(Number(e.target.value) || 0))) })} />
              </label>
            </div>
            <div className="label" style={{ margin: '10px 0 4px' }}>NOTE</div>
            <textarea className="input" value={draft.note} maxLength={500} rows={2}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              style={{ width: '100%', height: 'auto', padding: 8, resize: 'vertical' }}
              placeholder="loot room north side, garage door on the core…" />
            {!draft.ours && (
              <>
                <div className="label" style={{ margin: '10px 0 2px' }}>RAID PATH · OUTSIDE TO LOOT</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: 12 }}>
                  <div>
                    {WALL_TIERS.map((t) => (
                      <Counter key={t} label={`${t} walls`} value={draft.raidPath.walls[t] ?? 0} onChange={(n) => setPath('walls', t, n)} />
                    ))}
                  </div>
                  <div>
                    {DOOR_TIERS.map((t) => (
                      <Counter key={t} label={`${t} doors`} value={draft.raidPath.doors[t] ?? 0} onChange={(n) => setPath('doors', t, n)} />
                    ))}
                  </div>
                </div>
                <p className="mono" style={{ fontSize: 11, color: cheapest ? T.rustBr : T.txt3, margin: '8px 0 0' }}>
                  {cheapest ? `cheapest raid: ${cheapest.sulfur.toLocaleString()} sulfur` : 'add the walls and doors in the way'}
                </p>
              </>
            )}
            {error && <div className="note" style={{ marginTop: 10, color: T.crit }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn btn--primary" disabled={!draft.pos || busy} onClick={() => void save()}>
                {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Save base'}
              </button>
              <button className="btn" onClick={() => { setDraft(null); setError(null) }}>Cancel</button>
            </div>
          </Card>
        ) : (
          <>
            <Card style={{ padding: 15 }}>
              <Sect title="Where bases come from" />
              {[
                ['Marked here', 'by anyone on your team, with walls and doors for raid costing'],
                ['In-game map notes', 'with Rust+ paired, a note on the map becomes a weak sighting'],
                ['Your deaths', 'the retracer shows where shots came from — often a base window'],
              ].map(([t, d]) => (
                <div key={t} className="row" style={{ display: 'block' }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{t}</div>
                  <div style={{ fontSize: 12, color: T.txt2, marginTop: 2, lineHeight: 1.4 }}>{d}</div>
                </div>
              ))}
            </Card>
            <Card style={{ padding: 15 }}>
              <Sect title="Not built yet" />
              <p style={{ fontSize: 13, color: T.txt2, lineHeight: 1.5, margin: 0 }}>
                Predicting a base&apos;s interior from its outside needs a corpus of real layouts to match
                against. Until that exists, raid costs come from the walls and doors your team records.
              </p>
            </Card>
          </>
        )}
      </aside>
    </>
  )
}
