const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const { DEFAULT } = require('../../cloudfunctions/api/services/memorialGardens')
function fixture() {
  let clock = Date.parse('2026-11-13T15:59:59.000Z')
  const db = createCollectionStore({
    users: ['owner', 'visitor', 'other'].map(openid => ({ _id: openid, openid, roles: ['client'], status: 'active' })),
    platform_configs: [0, 1].flatMap(n => [
      { _id: 'app' + n, key: 'memorial_application', ownerOpenid: 'owner', status: 'approved', plotKey: 'plot' + n, petName: '宠物' + n },
      { _id: 'plot' + n, key: 'memorial_plot', applicationId: 'app' + n, status: 'approved', plotId: 'cell' + n, x: 224 + n * 160, y: 224, portrait: { uploadId: 'portrait' + n }, footprint: 2 }
    ])
  }, { cloudObjectUpdates: true })
  const context = createContext({ db, cloud: {} })
  context.nowMs = () => clock
  const handler = require('../../cloudfunctions/api/handlers/memorial')(context)
  const call = (who, action, data = {}) => context.runAdminRequest('memorial', action, data, () => handler(who, action, data))
  const give = (who, id, kind, day = '2026-11-13') => call(who, 'placeOffering', { id, kind, day, gardenId: DEFAULT })
  return { db, call, give, advance: ms => { clock += ms } }
}
test('each visitor including the owner can give each kind once to every memorial; totals remain public', async () => {
  const f = fixture()
  for (const who of ['owner', 'visitor', 'other']) for (const id of ['app0', 'app1']) {
    assert.deepEqual((await f.call(who, 'offeringStatus', { id })).given, { flower: false, snack: false })
    for (const kind of ['flower', 'snack']) {
      assert.equal((await f.give(who, id, kind)).duplicate, false)
      assert.equal((await f.give(who, id, kind)).duplicate, true)
    }
  }
  for (const row of (await f.call('visitor', 'world')).memorials) assert.deepEqual(row.offerings, { flower: 3, snack: 3 })
  const plot = f.db.state.platform_configs.find(r => r._id === 'plot0')
  assert.equal(plot.portrait.uploadId, 'portrait0'); assert.equal(plot.footprint, 2)
  const publicStatus = await f.call('visitor', 'offeringStatus', { id: 'app0' })
  assert.equal(publicStatus.day, '2026-11-13')
  assert.equal(publicStatus.resetAt, Date.parse('2026-11-13T16:00:00Z'))
  assert.equal(JSON.stringify(publicStatus).includes('openid'), false)
})
test('concurrent repeated and independent gifts increment totals exactly once per visitor and kind', async () => {
  const f = fixture()
  const results = await Promise.all(Array.from({ length: 12 }, () => f.give('visitor', 'app0', 'flower')))
  assert.equal(results.filter(r => !r.duplicate).length, 1)
  await Promise.all([f.give('visitor', 'app0', 'snack'), f.give('other', 'app0', 'flower'), f.give('owner', 'app0', 'snack')])
  assert.deepEqual((await f.call('visitor', 'offeringStatus', { id: 'app0' })).counts, { flower: 2, snack: 2 })
  assert.equal(f.db.state.pet_memorial_live.find(r => r._id === 'world_' + DEFAULT).revision, 4)
})
test('Beijing midnight resets personal allowance without resetting totals or accepting yesterday retries', async () => {
  const f = fixture()
  await f.give('visitor', 'app0', 'flower')
  f.advance(1000)
  const status = await f.call('visitor', 'offeringStatus', { id: 'app0' })
  assert.equal(status.day, '2026-11-14'); assert.deepEqual(status.given, { flower: false, snack: false })
  assert.deepEqual(status.counts, { flower: 1, snack: 0 })
  await assert.rejects(f.give('visitor', 'app0', 'flower'), /日期已更新/)
  await f.give('visitor', 'app0', 'flower', status.day)
  assert.deepEqual((await f.call('other', 'offeringStatus', { id: 'app0' })).counts, { flower: 2, snack: 0 })
})
test('forged kind, date, garden, unpublished memorial and released or reassigned plot cannot receive gifts', async () => {
  const f = fixture()
  for (const kind of ['invalid', '__proto__', 'constructor']) await assert.rejects(f.give('visitor', 'app0', kind), /鲜花或零食/)
  await assert.rejects(f.give('visitor', 'app0', 'flower', '2099-01-01'), /日期已更新/)
  await assert.rejects(f.call('visitor', 'placeOffering', { id: 'app0', kind: 'flower', day: '2026-11-13', gardenId: 'wrong' }), /园区/)
  await assert.rejects(f.give('visitor', 'missing', 'flower'), /不可探望/)
  const change = (id, data) => Object.assign(f.db.state.platform_configs.find(r => r._id === id), data)
  change('app0', { status: 'pending' }); await assert.rejects(f.give('visitor', 'app0', 'flower'), /不可探望/); change('app0', { status: 'approved' })
  change('plot0', { status: 'released' }); await assert.rejects(f.give('visitor', 'app0', 'flower'), /位置已变化/); change('plot0', { status: 'approved' })
  change('plot0', { applicationId: 'app1' }); await assert.rejects(f.give('visitor', 'app0', 'flower'), /位置已变化/)
  const plot = f.db.state.platform_configs.find(r => r._id === 'plot0')
  assert.equal(f.db.state.platform_configs.filter(r => r.key === 'memorial_offering').length, 0)
  assert.equal(plot.offerings, undefined)
})
test('transaction failure rolls back allowance and totals together and allows retry', async () => {
  const f = fixture(), run = f.db.runTransaction
  f.db.runTransaction = callback => run(async tx => { await callback(tx); throw new Error('simulated failure') })
  await assert.rejects(f.give('visitor', 'app0', 'flower'), /simulated failure/)
  f.db.runTransaction = run
  assert.deepEqual((await f.call('visitor', 'offeringStatus', { id: 'app0' })).counts, { flower: 0, snack: 0 })
  assert.equal((await f.give('visitor', 'app0', 'flower')).duplicate, false)
})
test('expired scene gifts disappear while permanent counts and daily receipts survive', async () => {
  const f = fixture()
  f.db.state.platform_configs.push({ _id: 'memorial_offering_settings', key: 'memorial_offering_settings', flowerMinutes: 1, snackMinutes: 3, revision: 1 })
  await f.give('visitor', 'app0', 'flower'); await f.give('other', 'app0', 'flower'); await f.give('visitor', 'app0', 'snack')
  let status = await f.call('visitor', 'offeringStatus', { id: 'app0' })
  assert.equal(status.display.flower.length, 1)
  assert.equal(status.display.flower[0][1], 2)
  f.advance(61000)
  status = await f.call('visitor', 'offeringStatus', { id: 'app0' })
  assert.deepEqual(status.counts, { flower: 2, snack: 1 })
  assert.deepEqual(status.display.flower, [])
  assert.equal(status.display.snack[0][1], 1)
  const world = await f.call('visitor', 'world')
  assert.deepEqual(world.memorials[0].offeringScene, status.display)
  f.advance(120000)
  assert.deepEqual((await f.call('visitor', 'offeringStatus', { id: 'app0' })).display, { flower: [], snack: [] })
})
test('display settings require admin permission and optimistic revision; changes apply to subsequent gifts', async () => {
  const f = fixture()
  await assert.rejects(f.call('visitor', 'getOfferingSettings'), /管理|权限/)
  await assert.rejects(f.call('visitor', 'saveOfferingSettings', { revision: 0, flowerMinutes: 1, snackMinutes: 2 }), /管理|权限/)
  f.db.state.users.push({ _id: 'root', openid: 'root', roles: ['admin'], status: 'active', adminSuper: true })
  const previous = await f.call('root', 'getOfferingSettings')
  assert.equal(previous.flowerMinutes, 1440)
  await f.give('visitor', 'app0', 'flower')
  const first = (await f.call('visitor', 'offeringStatus', { id: 'app0' })).display.flower[0][0]
  const next = await f.call('root', 'saveOfferingSettings', { revision: 0, flowerMinutes: 1, snackMinutes: 2 })
  assert.equal(next.revision, 1)
  assert.deepEqual(await f.call('root', 'saveOfferingSettings', { revision: 0, flowerMinutes: 1, snackMinutes: 2 }), next)
  await assert.rejects(f.call('root', 'saveOfferingSettings', { revision: 0, flowerMinutes: 2, snackMinutes: 2 }), /其他管理员/)
  for (const flowerMinutes of [0, -1, 10081, 1.5, '20']) await assert.rejects(f.call('root', 'saveOfferingSettings', { revision: 1, flowerMinutes, snackMinutes: 2 }), /时长/)
  await f.give('other', 'app0', 'flower')
  const display = (await f.call('visitor', 'offeringStatus', { id: 'app0' })).display.flower
  assert.equal(display.length, 2); assert.equal(display[1][0], first); assert.equal(display[0][0], first - 1439)
})
