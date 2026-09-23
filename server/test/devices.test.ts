// ---------------------------------------------------------------------------
// Paired Rust+ devices: the codec, the state machine, and the API.
//
// The protocol half matters most here. These messages were written against a
// published copy of rustplus.proto without a live server to check against, so
// the tests pin the wire format itself: what we send for a switch, and what we
// make of the bytes a server would send back.
// ---------------------------------------------------------------------------

import assert from 'node:assert/strict'
import { openDb, nowIso } from '../src/db/index.ts'
import { Reader, Writer, asNumber, asBool } from '../src/rustplus/protobuf.ts'
import {
  decodeMessage, encodeRequest, entityKindOf, ENTITY_TYPE, type AppEntityInfo,
} from '../src/rustplus/messages.ts'
import {
  addDevice, contentsSummary, deviceLabel, DeviceError, listDevices,
  recordDeviceState, removeDevice, upkeepSummary,
} from '../src/rustplus/entities.ts'
import { recentTeamChat, recordTeamChat } from '../src/rustplus/sync.ts'
import { itemName, itemShortname, UPKEEP_ITEMS } from '../src/rustplus/items.ts'
import { createApi } from '../src/api/server.ts'
import { datasetFor } from '../src/api/dataset.ts'

const CRED = { playerId: 76561198000000001n, playerToken: -1717986918 }

/** Build the AppEntityInfo a server would send for a device. */
function entityResponse(
  seq: number,
  type: number,
  payload: { value?: boolean; items?: [number, number][]; capacity?: number; expiry?: number },
): Uint8Array {
  const w = new Writer()
  w.message(1, (res) => {
    res.uint32Always(1, seq)
    res.message(11, (info) => {
      info.int32(1, type)
      info.message(3, (p) => {
        if (payload.value) p.bool(1, true)
        for (const [id, qty] of payload.items ?? []) {
          p.message(2, (item) => item.int32(1, id).int32(2, qty))
        }
        if (payload.capacity) p.int32(3, payload.capacity)
        if (payload.expiry) p.int32(4, 1).int32(5, payload.expiry)
      })
    })
  })
  return w.finish()
}

/** AppBroadcast { AppEntityChanged entityChanged = 6 } */
function entityChangedBroadcast(entityId: number, value: boolean): Uint8Array {
  const w = new Writer()
  w.message(2, (b) => {
    b.message(6, (ch) => {
      ch.uint32Always(1, entityId)
      ch.message(2, (p) => { if (value) p.bool(1, true) })
    })
  })
  return w.finish()
}

export function run(test: (name: string, fn: () => void | Promise<void>) => void) {
  const freshDb = () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO servers (id, name, seed, world_size, created_at) VALUES (?,?,?,?,?)`)
      .run('srv', 'TEST', 1994823, 4250, nowIso())
    db.prepare(`INSERT INTO wipes (server_id, started_at, seed, world_size) VALUES (?,?,?,?)`)
      .run('srv', '2026-09-16T00:00:00Z', 1994823, 4250)
    return db
  }
  const wipeId = 1

  console.log('\ndevices')

  test('a switch request carries the entity id and the value', () => {
    const on = encodeRequest(7, CRED, 'setEntityValue', { entityId: 4242, value: true })
    const fields = new Map<number, unknown>()
    new Reader(on).each((f) => {
      if (f.field === 4) fields.set(4, asNumber(f))
      if (f.field === 15) {
        new Reader(f.bytes!).each((v) => { if (v.field === 1) fields.set(15, asBool(v)) })
      }
    })
    assert.equal(fields.get(4), 4242, 'entity id rides on AppRequest field 4')
    assert.equal(fields.get(15), true)

    // Off is an empty AppSetEntityValue: proto3 omits false, and the server
    // reads an absent bool as false.
    const off = encodeRequest(8, CRED, 'setEntityValue', { entityId: 4242, value: false })
    let sawField15 = false
    new Reader(off).each((f) => { if (f.field === 15) sawField15 = true })
    assert.ok(sawField15, 'the setEntityValue message is still present when turning off')
  })

  test('a storage monitor reports contents and an upkeep window', () => {
    const expiry = Math.floor(Date.now() / 1000) + 26 * 3600
    const bytes = entityResponse(1, ENTITY_TYPE.storage, {
      items: [[UPKEEP_ITEMS.wood, 12_400], [UPKEEP_ITEMS.stones, 3_200]],
      capacity: 24,
      expiry,
    })
    const info = decodeMessage(bytes).response?.entityInfo
    assert.ok(info)
    assert.equal(info.kind, 'storage')
    assert.equal(info.items.length, 2)
    assert.equal(info.items[0].quantity, 12_400)
    assert.equal(info.capacity, 24)
    assert.equal(info.hasProtection, true)
    assert.equal(info.protectionExpiry, expiry)

    const db = freshDb()
    addDevice(db, 'srv', wipeId, { entityId: 11, kind: 'storage', name: 'TC' })
    recordDeviceState(db, 'srv', wipeId, 11, info)
    const row = listDevices(db, 'srv', wipeId)[0]
    assert.equal(upkeepSummary(row), '26 h of upkeep left')
    assert.equal(contentsSummary(row), '12,400 wood · 3,200 stone')
    assert.equal(deviceLabel(row), 'TC')
  })

  test('upkeep that has run out says so rather than showing a negative number', () => {
    const db = freshDb()
    addDevice(db, 'srv', wipeId, { entityId: 12, kind: 'storage', name: null })
    const info: AppEntityInfo = {
      type: ENTITY_TYPE.storage, kind: 'storage', value: false, items: [], capacity: 24,
      hasProtection: true, protectionExpiry: Math.floor(Date.now() / 1000) - 60,
    }
    recordDeviceState(db, 'srv', wipeId, 12, info)
    const row = listDevices(db, 'srv', wipeId)[0]
    assert.equal(upkeepSummary(row), 'upkeep ran out — the base is decaying')
    assert.equal(deviceLabel(row), 'storage #12')
  })

  test('an alarm going off is reported once, not on every poll', () => {
    const db = freshDb()
    addDevice(db, 'srv', wipeId, { entityId: 5, kind: 'alarm', name: 'front door' })
    const quiet: AppEntityInfo = {
      type: ENTITY_TYPE.alarm, kind: 'alarm', value: false, items: [], capacity: 0,
      hasProtection: false, protectionExpiry: 0,
    }
    const loud = { ...quiet, value: true }

    assert.equal(recordDeviceState(db, 'srv', wipeId, 5, quiet).alarmTriggered, false)
    assert.equal(recordDeviceState(db, 'srv', wipeId, 5, loud).alarmTriggered, true, 'first trigger fires')
    assert.equal(recordDeviceState(db, 'srv', wipeId, 5, loud).alarmTriggered, false, 'still on is not news')
    assert.equal(recordDeviceState(db, 'srv', wipeId, 5, quiet).alarmTriggered, false)
    assert.equal(recordDeviceState(db, 'srv', wipeId, 5, loud).alarmTriggered, true, 'it can fire again')
  })

  test('an entityChanged broadcast is understood', () => {
    const msg = decodeMessage(entityChangedBroadcast(4242, true))
    assert.equal(msg.broadcast?.entityChanged?.entityId, 4242)
    assert.equal(msg.broadcast?.entityChanged?.payload.value, true)
  })

  test('the payload is read whether it sits in field 2 or field 3', () => {
    // Published copies of the proto disagree; a device must not come back
    // blank because of it.
    for (const field of [2, 3]) {
      const w = new Writer()
      w.message(1, (res) => {
        res.uint32Always(1, 1)
        res.message(11, (info) => {
          info.int32(1, ENTITY_TYPE.switch)
          info.message(field, (p) => p.bool(1, true))
        })
      })
      const info = decodeMessage(w.finish()).response?.entityInfo
      assert.equal(info?.value, true, `payload in field ${field}`)
      assert.equal(info?.kind, 'switch')
    }
  })

  test('unknown entity types and item ids are shown as unknown, not guessed', () => {
    assert.equal(entityKindOf(99), null)
    assert.equal(itemShortname(424242), null)
    assert.equal(itemName(424242), 'item #424242')
    assert.equal(itemName(UPKEEP_ITEMS['metal.refined']), 'HQM')
  })

  test('adding a device validates what it is told', () => {
    const db = freshDb()
    assert.throws(() => addDevice(db, 'srv', wipeId, { entityId: 0, kind: 'switch' }), DeviceError)
    assert.throws(() => addDevice(db, 'srv', wipeId, { entityId: 3, kind: 'toaster' }), DeviceError)
    addDevice(db, 'srv', wipeId, { entityId: 3, kind: 'switch', name: 'lights' })
    // Re-adding renames rather than duplicating.
    addDevice(db, 'srv', wipeId, { entityId: 3, kind: 'switch', name: 'base lights' })
    assert.equal(listDevices(db, 'srv', wipeId).length, 1)
    assert.equal(listDevices(db, 'srv', wipeId)[0].name, 'base lights')
    assert.equal(removeDevice(db, 'srv', wipeId, 3), true)
    assert.equal(removeDevice(db, 'srv', wipeId, 3), false)
  })

  test('devices and team chat reach the dashboard payload', () => {
    const db = freshDb()
    addDevice(db, 'srv', wipeId, { entityId: 9, kind: 'switch', name: 'turrets' })
    recordDeviceState(db, 'srv', wipeId, 9, {
      type: ENTITY_TYPE.switch, kind: 'switch', value: true, items: [], capacity: 0,
      hasProtection: false, protectionExpiry: 0,
    })
    recordTeamChat(db, wipeId, [
      { steamId: '76561198000000001', name: 'nomad', message: 'roof', time: 1_700_000_000 },
      { steamId: '76561198000000002', name: 'ridgeline', message: 'on it', time: 1_700_000_060 },
    ])
    // The same message arriving twice (broadcast, then backfill) is one row.
    recordTeamChat(db, wipeId, [
      { steamId: '76561198000000001', name: 'nomad', message: 'roof', time: 1_700_000_000 },
    ])

    const ds = datasetFor(db, 'srv')!
    assert.equal(ds.devices?.length, 1)
    assert.equal(ds.devices![0].value, true)
    assert.equal(ds.teamChat?.length, 2)
    assert.equal(ds.teamChat![0].message, 'roof', 'oldest first, so it reads like a conversation')
    assert.equal(recentTeamChat(db, wipeId).length, 2)
  })

  test('flipping a switch without Rust+ connected says so', async () => {
    const db = freshDb()
    addDevice(db, 'srv', wipeId, { entityId: 9, kind: 'switch', name: 'turrets' })
    const api = createApi({ db, token: 'secret', port: 0 })
    const port = await api.listen()
    const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/devices/9/set`, {
        method: 'POST', headers: auth, body: JSON.stringify({ serverId: 'srv', value: true }),
      })
      assert.equal(res.status, 503)
      assert.match((await res.json() as { error: string }).error, /not running/)
    } finally { await api.close() }
  })

  test('the API adds, sets and removes a device end to end', async () => {
    const db = freshDb()
    const flipped: { entityId: number; value: boolean }[] = []
    const api = createApi({
      db, token: 'secret', port: 0,
      setSwitch: async (serverId, entityId, value) => {
        assert.equal(serverId, 'srv')
        flipped.push({ entityId, value })
      },
    })
    const port = await api.listen()
    const auth = { authorization: 'Bearer secret', 'content-type': 'application/json' }
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }
    try {
      assert.equal((await call('POST', '/api/devices', { serverId: 'srv', entityId: 77, kind: 'alarm', name: 'door' })).status, 201)
      assert.equal((await call('POST', '/api/devices', { serverId: 'srv', entityId: 5, kind: 'toaster' })).status, 400)
      assert.equal((await call('POST', '/api/devices/77/set', { serverId: 'srv', value: true })).status, 200)
      assert.deepEqual(flipped, [{ entityId: 77, value: true }])
      assert.equal((await call('DELETE', '/api/devices/77?serverId=srv')).status, 200)
      assert.equal((await call('DELETE', '/api/devices/77?serverId=srv')).status, 404)
      assert.equal(listDevices(db, 'srv', wipeId).length, 0)
    } finally { await api.close() }
  })
}
