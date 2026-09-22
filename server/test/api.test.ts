// ---------------------------------------------------------------------------
// Bases, status and the Steam collector — through the real HTTP API where it
// matters, with fetch injected for Steam so nothing touches the network.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { openDb, nowIso, setServerState } from '../src/db/index.ts'
import { createApi } from '../src/api/server.ts'
import { statusFor } from '../src/api/status.ts'
import { refreshSteamProfiles, RUST_APP_ID } from '../src/collectors/steam.ts'
import { recordSnapshot } from '../src/collectors/battlemetrics.ts'

type TestFn = (name: string, fn: () => void | Promise<void>) => void

function freshDb() {
  const db = openDb(':memory:', { quiet: true })
  db.prepare(`INSERT INTO servers (id, name, world_size, battlemetrics_id, created_at) VALUES ('srv', 'TEST TRIO', 3750, '42', ?)`).run(nowIso())
  db.prepare(`INSERT INTO wipes (server_id, started_at) VALUES ('srv', ?)`).run(nowIso())
  return db
}

async function withApi(db: ReturnType<typeof freshDb>, fn: (call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>) => Promise<void>) {
  const api = createApi({ db, token: 't', port: 0 })
  const port = await api.listen()
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  try { await fn(call) } finally { await api.close() }
}

export function run(test: TestFn) {
  console.log('\nbases')

  test('a marked base appears in the dataset with its grid and raid path', async () => {
    const db = freshDb()
    await withApi(db, async (call) => {
      const made = await call('POST', '/api/bases', {
        serverId: 'srv', x: 0.5, y: 0.5, tier: 'stone', turrets: 3,
        raidPath: { walls: { stone: 2 }, doors: { garage: 1 } }, note: 'loot NE corner',
      })
      assert.equal(made.status, 201)
      const ds = await call('GET', '/api/dataset/srv')
      const b = ds.body.bases.find((x: { id: string }) => x.id === made.body.id)
      assert.ok(b, 'base missing from dataset')
      assert.equal(b.tier, 'stone')
      assert.equal(b.turrets, 3)
      assert.deepEqual(b.raidPath, { walls: { stone: 2 }, doors: { garage: 1 } })
      assert.match(b.grid, /^[A-Z]+\d+$/)
      assert.equal(b.observations, 1)
    })
  })

  test('bad base input is refused with a reason, not a 500', async () => {
    const db = freshDb()
    await withApi(db, async (call) => {
      for (const bad of [
        { serverId: 'srv', x: 2, y: 0.5 },
        { serverId: 'srv', x: 0.5, y: 0.5, tier: 'cardboard' },
        { serverId: 'srv', x: 0.5, y: 0.5, raidPath: { walls: { glass: 1 } } },
        { serverId: 'srv', x: 0.5, y: 0.5, turrets: -1 },
      ]) {
        const r = await call('POST', '/api/bases', bad)
        assert.equal(r.status, 400, JSON.stringify(bad))
        assert.ok(r.body.error)
      }
      assert.equal((await call('POST', '/api/bases', '{not json')).status, 400)
    })
  })

  test('editing a base records an observation and moves its grid', async () => {
    const db = freshDb()
    await withApi(db, async (call) => {
      const { body } = await call('POST', '/api/bases', { serverId: 'srv', x: 0.1, y: 0.1 })
      const r = await call('PATCH', `/api/bases/${body.id}?serverId=srv`, {
        x: 0.9, status: 'weak', observation: { kind: 'raided', note: 'we got the TC' },
      })
      assert.equal(r.status, 200)
      const row = db.prepare(`SELECT x, grid, status FROM bases WHERE id = ?`).get(body.id) as { x: number; grid: string; status: string }
      assert.equal(row.x, 0.9)
      assert.equal(row.status, 'weak')
      const obs = db.prepare(`SELECT kind FROM base_observations WHERE base_id = ? ORDER BY id`).all(body.id) as { kind: string }[]
      assert.deepEqual(obs.map((o) => o.kind), ['sighting', 'raided'])
    })
  })

  test('an all-zero raid path is stored as no path', async () => {
    const db = freshDb()
    await withApi(db, async (call) => {
      const { body } = await call('POST', '/api/bases', {
        serverId: 'srv', x: 0.2, y: 0.2, raidPath: { walls: { stone: 0 }, doors: {} },
      })
      const row = db.prepare(`SELECT raid_path FROM bases WHERE id = ?`).get(body.id) as { raid_path: string | null }
      assert.equal(row.raid_path, null)
    })
  })

  test('only one base can be ours', async () => {
    const db = freshDb()
    await withApi(db, async (call) => {
      const a = await call('POST', '/api/bases', { serverId: 'srv', x: 0.2, y: 0.2, ours: true })
      const b = await call('POST', '/api/bases', { serverId: 'srv', x: 0.3, y: 0.3, ours: true })
      const ours = db.prepare(`SELECT id FROM bases WHERE ours = 1`).all() as { id: string }[]
      assert.deepEqual(ours.map((r) => r.id), [b.body.id])
      const ds = await call('GET', '/api/dataset/srv')
      assert.deepEqual(ds.body.homePos, { x: 0.3, y: 0.3 })
      assert.ok(a.body.id)
    })
  })

  test('a base on another server cannot be edited or deleted through this one', async () => {
    const db = freshDb()
    db.prepare(`INSERT INTO servers (id, name, created_at) VALUES ('other', 'OTHER', ?)`).run(nowIso())
    db.prepare(`INSERT INTO wipes (server_id, started_at) VALUES ('other', ?)`).run(nowIso())
    await withApi(db, async (call) => {
      const { body } = await call('POST', '/api/bases', { serverId: 'srv', x: 0.5, y: 0.5 })
      assert.equal((await call('PATCH', `/api/bases/${body.id}?serverId=other`, { status: 'weak' })).status, 404)
      assert.equal((await call('DELETE', `/api/bases/${body.id}?serverId=other`)).status, 404)
      assert.equal((await call('DELETE', `/api/bases/${body.id}?serverId=srv`)).status, 200)
    })
  })

  console.log('\nstatus')

  test('status reports what actually happened, not what is configured', () => {
    const db = freshDb()
    const env = { BATTLEMETRICS_TOKEN: 'x' }
    let st = statusFor(db, 'srv', { env, now: Date.now() })!
    assert.equal(st.battlemetrics.configured, true)
    assert.equal(st.battlemetrics.lastPoll, null)
    assert.equal(st.battlemetrics.fresh, false)

    const at = new Date().toISOString()
    recordSnapshot(db, 'srv', 1, [{ steamId: 'bm:1', name: 'x', steamIdKnown: false }], at)
    st = statusFor(db, 'srv', { env, now: Date.parse(at) + 60_000 })!
    assert.equal(st.battlemetrics.fresh, true)
    assert.equal(st.battlemetrics.online, 1)
    st = statusFor(db, 'srv', { env, now: Date.parse(at) + 3_600_000 })!
    assert.equal(st.battlemetrics.fresh, false, 'an hour-old poll is not live')

    assert.equal(st.rustplus.lastTeamSync, null)
    setServerState(db, 'srv', 'rustplus_team', { members: 3 }, at)
    assert.equal(statusFor(db, 'srv', { env })!.rustplus.lastTeamSync, at)
    assert.deepEqual(st.sinks, { discord: false, teamspeak: false })
  })

  console.log('\nsteam')

  test('steam profiles fill in bans, account age and public Rust hours', async () => {
    const db = freshDb()
    const pub = '76561198000000011'
    const priv = '76561198000000022'
    for (const id of [pub, priv, 'bm:999']) db.prepare(`INSERT INTO players (steam_id, first_seen) VALUES (?, ?)`).run(id, nowIso())
    const urls: string[] = []
    const fake = (async (u: string) => {
      urls.push(u)
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 })
      if (u.includes('GetPlayerSummaries')) return json({ response: { players: [
        { steamid: pub, personaname: 'pubguy', communityvisibilitystate: 3, timecreated: 1400000000 },
        { steamid: priv, personaname: 'ghost', communityvisibilitystate: 1 },
      ] } })
      if (u.includes('GetPlayerBans')) return json({ players: [
        { SteamId: pub, NumberOfVACBans: 0, NumberOfGameBans: 0 },
        { SteamId: priv, NumberOfVACBans: 1, NumberOfGameBans: 2 },
      ] })
      if (u.includes('GetOwnedGames')) return json({ response: { games: [{ appid: RUST_APP_ID, playtime_forever: 6000 * 60 }] } })
      return new Response('{}', { status: 404 })
    }) as unknown as typeof fetch

    const n = await refreshSteamProfiles(db, { key: 'k', fetchImpl: fake })
    assert.equal(n, 2, 'battlemetrics ids are skipped — they are not steam ids')
    const p = db.prepare(`SELECT hours_played, profile_public, account_created_at FROM players WHERE steam_id = ?`).get(pub) as
      { hours_played: number; profile_public: number; account_created_at: string }
    assert.equal(p.hours_played, 6000)
    assert.equal(p.profile_public, 1)
    assert.ok(p.account_created_at.startsWith('2014'))
    const q = db.prepare(`SELECT hours_played, vac_bans, game_bans FROM players WHERE steam_id = ?`).get(priv) as
      { hours_played: number | null; vac_bans: number; game_bans: number }
    assert.equal(q.hours_played, null, 'private means unknown, not zero')
    assert.deepEqual([q.vac_bans, q.game_bans], [1, 2])
    assert.equal(urls.filter((u) => u.includes('GetOwnedGames')).length, 1, 'no owned-games call for private profiles')
    assert.equal(await refreshSteamProfiles(db, { key: 'k', fetchImpl: fake }), 0, 'fresh profiles are not refetched')
  })

  test('a rejected steam key stops the run with a clear message', async () => {
    const db = freshDb()
    db.prepare(`INSERT INTO players (steam_id, first_seen) VALUES ('76561198000000033', ?)`).run(nowIso())
    const fake = (async () => new Response('', { status: 403 })) as unknown as typeof fetch
    await assert.rejects(refreshSteamProfiles(db, { key: 'bad', fetchImpl: fake }), /rejected the API key/)
  })
}
