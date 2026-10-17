const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const world = require('../../cloudfunctions/api/services/playground-world')
const handlerFactory = require('../../cloudfunctions/api/handlers/playground')
function fixture() {
  const users = ['a', 'b', 'c'].map((openid, i) => ({
    _id: 'user_' + openid,
    openid,
    nickname: openid,
    residentialCommunity: {
      name: i === 2 ? '另一个小区' : '阳光花园',
      address: '中山路1号'
    }
  }))
  const db = createCollectionStore({ users })
  const context = {
    db,
    nowText: () => new Date().toISOString(),
    safeText: (v) => String(v || ''),
    getUser: async (id) => db.state.users.find((u) => u.openid === id)
  }
  return {
    db,
    users,
    context,
    service: world.create(context),
    handler: handlerFactory(context)
  }
}
test('simultaneous claims of the same grass commit one plot and one permanent owner record', async () => {
  const { db, users, service } = fixture()
  const result = await Promise.allSettled(
    users
      .slice(0, 2)
      .map((u) => service.claim(u.openid, u, { cellX: 1, cellZ: 2 }))
  )
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(
    db.state.pet_playground_plots.filter((p) => p.kind === 'plot').length,
    2
  )
  assert.equal(
    db.state.pet_playground_plots.find((p) => p._id === world.CONFIG_ID)
      .usedHeight,
    168
  )
})
test('one owner cannot move through repeat claims or community changes; rejected writes roll back', async () => {
  const { db, users, service, handler } = fixture()
  const p = await service.claim('a', users[0], { cellX: 1, cellZ: 1 })
  assert.deepEqual(
    await service.claim('a', users[0], { cellX: 1, cellZ: 1 }),
    p
  )
  await assert.rejects(
    () => service.claim('a', users[0], { cellX: 2, cellZ: 1 }),
    /不能更改/
  )
  await assert.rejects(
    () => handler('a', 'saveCommunity', { community: { name: '另一个小区' } }),
    /不能更换/
  )
  assert.equal(db.state.users[0].residentialCommunity.name, '阳光花园')
  assert.equal((await service.own('a')).plotId, p.id)
})
test('regions share houses within the community and hide other communities and owner identifiers', async () => {
  const { users, service } = fixture()
  await service.claim('a', users[0], { cellX: 0, cellZ: 0 })
  const shared = await service.region('b', users[1], { chunkX: 0, chunkZ: 0 })
  assert.equal(shared.plots.length, 1)
  assert.equal(shared.plots[0].mine, false)
  assert.equal(shared.plots[0].ownerOpenid, undefined)
  assert.equal(
    (await service.region('c', users[2], { chunkX: 0, chunkZ: 0 })).plots
      .length,
    0
  )
  await service.claim('c', users[2], { cellX: 0, cellZ: 0 })
})
test('invalid coordinates, invalid dimensions, no community and world overflow are rejected', async () => {
  const { db, users, service } = fixture()
  for (const data of [
    { cellX: -1, cellZ: 0 },
    { cellX: NaN, cellZ: 0 },
    { cellX: 40, cellZ: 0 },
    { cellX: 1.1, cellZ: 0 }
  ])
    await assert.rejects(() => service.claim('a', users[0], data))
  await assert.rejects(
    () => service.region('a', users[0], { chunkX: 20, chunkZ: 0 }),
    /边界/
  )
  assert.throws(() => world.dimensions({ width: 300.5, height: 2240 }))
  assert.throws(() => world.dimensions({ width: Infinity }))
  assert.deepEqual(world.dimensions({ width: 224, height: 11200 }), {
    width: 224,
    height: 11200
  })
  db.state.users[0].residentialCommunity = null
  await assert.rejects(
    () => service.claim('a', users[0], { cellX: 0, cellZ: 0 }),
    /设置常住小区/
  )
})
test('profile and community APIs enforce the same permanent community binding', async () => {
  const { users, service, context } = fixture()
  await service.claim('a', users[0], { cellX: 1, cellZ: 1 })
  const auth = require('../../cloudfunctions/api/handlers/auth')({
    ...context,
    now: context.nowText,
    safeFileId: (v) => v || ''
  })
  await assert.rejects(
    () => auth('a', 'updateCommunity', { community: { name: '另一个小区' } }),
    /不能更换/
  )
  await assert.rejects(
    () =>
      auth('a', 'updateProfile', { nickname: 'a', residentialCommunity: null }),
    /不能更换/
  )
  const saved = await auth('a', 'updateProfile', { nickname: 'a' })
  assert.equal(saved.residentialCommunity.name, '阳光花园')
})
test('admin dimensions persist and cannot shrink past a permanently placed house', async () => {
  const { db, users, service } = fixture()
  const settings = require('../../cloudfunctions/api/services/settings')({
    db,
    defaultHomeModules: {},
    normalizeStaffDepositConfig: (v) => v || {},
    normalizeStaffSuppliesConfig: (v) => v || {},
    normalizeStaffTrainingConfig: (v) => v || {},
    now: () => new Date(),
    safeNumber: (v) => Number(v) || 0,
    safeText: (v) => String(v || '')
  })
  await settings.saveSystemSettings({ playground: { width: 448, height: 560 } })
  assert.equal((await service.config()).width, 448)
  await service.claim('a', users[0], { cellX: 7, cellZ: 8 })
  await assert.rejects(
    () =>
      settings.saveSystemSettings({ playground: { width: 392, height: 560 } }),
    /已有房屋/
  )
  assert.deepEqual((await settings.getSystemSettings()).playground, {
    width: 448,
    height: 560
  })
  await settings.saveSystemSettings({ enablePetBreedAi: false })
  assert.deepEqual((await settings.getSystemSettings()).playground, {
    width: 448,
    height: 560
  })
})
