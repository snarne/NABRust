// Raid costing: the sourced table, the plans built from it, and affordability.

import assert from 'node:assert/strict'
import { affordability, DOORS, planRaid, SULFUR_PER, WALLS } from '../../shared/raid.ts'

type TestFn = (name: string, fn: () => void | Promise<void>) => void

export function run(test: TestFn) {
  console.log('\nraid costing')

  test('the table matches the sourced 2026 chart', () => {
    assert.deepEqual(WALLS.stone, { c4: 2, rocket: 4, satchel: 10, explo: 185 })
    assert.deepEqual(DOORS.garage, { c4: 2, rocket: 3, satchel: 9, explo: 150 })
    assert.deepEqual(SULFUR_PER, { c4: 2200, rocket: 1400, satchel: 480, explo: 25 })
  })

  test('a stone wall is cheapest with C4 on the current chart', () => {
    // 2 C4 = 4400, 185 ammo = 4625, 10 satchels = 4800, 4 rockets = 5600
    const [best] = planRaid({ walls: { stone: 1 }, doors: {} })
    assert.equal(best.key, 'cheapest')
    assert.deepEqual(best.mix, { c4: 2 })
    assert.equal(best.sulfur, 4400)
  })

  test('each layer gets its own cheapest explosive', () => {
    const [best] = planRaid({ walls: { stone: 2 }, doors: { sheet: 1, garage: 1 } })
    // sheet door: explo 63*25 = 1575 beats satchels 1920, C4 2200
    // garage: satchels 9*480 = 4320 beats C4 4400 and explo 3750? no: 150*25 = 3750 wins
    assert.equal(best.sulfur, 2 * 4400 + 1575 + 3750)
    assert.deepEqual(best.mix, { c4: 4, explo: 63 + 150 })
  })

  test('plans are sorted cheapest first and include single-explosive options', () => {
    const plans = planRaid({ walls: { metal: 1 }, doors: { armored: 1 } })
    for (let i = 1; i < plans.length; i++) assert.ok(plans[i].sulfur >= plans[i - 1].sulfur)
    const rockets = plans.find((p) => p.key === 'rocket')!
    assert.deepEqual(rockets.mix, { rocket: 8 + 5 })
    assert.equal(rockets.sulfur, 13 * 1400)
  })

  test('an empty path has no plan', () => {
    assert.deepEqual(planRaid({ walls: {}, doors: {} }), [])
  })

  test('affordability uses crafted explosives first, then raw sulfur', () => {
    const [best] = planRaid({ walls: { stone: 1 }, doors: {} }) // 2 C4
    assert.deepEqual(affordability(best, { c4: 2 }), { ok: true, shortSulfur: 0 })
    assert.deepEqual(affordability(best, { c4: 1, sulfur: 2200 }), { ok: true, shortSulfur: 0 })
    assert.deepEqual(affordability(best, { c4: 1, sulfur: 1000 }), { ok: false, shortSulfur: 1200 })
  })
}
