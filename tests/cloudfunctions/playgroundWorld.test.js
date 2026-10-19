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

test('optional plot reads distinguish missing documents from database failures and retain SDK details', async () => {
  let error
  const db = {
    collection: () => ({
      doc: () => ({
        get: async () => {
          throw error
        }
      })
    })
  }
  error = {
    message: 'resource system error',
    errMsg: 'document with _id plot_test does not exist',
    errCode: -501001
  }
  assert.equal(await world.read(db, 'plot_test'), null)
  error = {
    message: 'document.get:fail resource system error',
    errMsg: 'collection pet_playground_plots does not exist',
    errCode: -501001
  }
  await assert.rejects(
    () => world.read(db, 'plot_test'),
    (e) => {
      assert.match(e.message, /检查草坪占地失败/)
      assert.match(e.message, /collection pet_playground_plots does not exist/)
      assert.equal(e.code, -501001)
      return true
    }
  )
  error = {
    message: 'document.get:fail resource system error',
    errMsg: 'transaction expired; requestId: test-request',
    errCode: -501001
  }
  await assert.rejects(
    () => world.read(db, world.CONFIG_ID),
    /读取场景设置失败.*transaction expired.*test-request/
  )
})
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
    1
  )
  assert.equal(
    db.state.pet_playground_plots.find((p) => p._id === world.CONFIG_ID)
      .usedHeight,
    196
  )
})

test('community colors resolve random collisions atomically and survive reloads and relocation', async (t) => {
  t.mock.method(require('crypto'), 'randomInt', () => 0)
  const { db, users, service } = fixture()
  const [a, b] = await Promise.all([
    service.claim('a', users[0], { x: 280, z: 280 }),
    service.claim('b', users[1], { x: 560, z: 280 })
  ])
  assert.notEqual(a.nameColor, b.nameColor)
  assert.match(a.nameColor, /^#[0-9a-f]{6}$/)
  assert.ok(!['#000000', '#ffffff'].includes(a.nameColor))
  assert.equal((await service.own('a')).nameColor, a.nameColor)
  assert.equal((await service.claim('a', users[0], { x: 840, z: 280 })).nameColor, a.nameColor)
  const otherCommunity = await service.claim('c', users[2], { x: 280, z: 280 })
  assert.equal(otherCommunity.nameColor, a.nameColor)
  await service.demolish('b', { plotId: b.id })
  const registry = db.state.pet_playground_plots.find((p) => p._id === 'name_colors_' + world.communityId(users[0]))
  assert.equal(registry.colors[world.hash('b')], undefined)
  assert.equal(registry.colors[world.hash('a')], a.nameColor)
})

test('old courtyards receive persisted colors through map and region reads without owners logging in', async () => {
  const { db, users, service } = fixture()
  const a = await service.claim('a', users[0], { x: 280, z: 280 })
  const b = await service.claim('b', users[1], { x: 560, z: 280 })
  db.state.pet_playground_plots = db.state.pet_playground_plots.filter((p) => p.kind !== 'name_colors')
  for (const row of db.state.pet_playground_plots) delete row.nameColor
  const map = await service.mapOverview('c', users[2], { community: users[0].residentialCommunity })
  assert.equal(new Set(map.plots.map((p) => p.nameColor)).size, 2)
  for (const plot of map.plots) {
    assert.match(plot.nameColor, /^#[0-9a-f]{6}$/)
    const stored = db.state.pet_playground_plots.find((p) => p._id === plot.id)
    const owner = db.state.pet_playground_plots.find((p) => p.plotId === plot.id)
    assert.equal(stored.nameColor, plot.nameColor)
    assert.equal(owner.nameColor, plot.nameColor)
  }
  const region = await service.region('a', users[0], { chunkX: Math.floor(a.x / world.CHUNK), chunkZ: Math.floor(a.z / world.CHUNK) })
  assert.equal(region.plots.find((p) => p.id === a.id).nameColor, map.plots.find((p) => p.id === a.id).nameColor)
  assert.equal((await service.own('b')).nameColor, map.plots.find((p) => p.id === b.id).nameColor)
})
test('one owner cannot move through repeat claims or community changes; rejected writes roll back', async () => {
  const { db, users, service, handler } = fixture()
  const p = await service.claim('a', users[0], { cellX: 1, cellZ: 1 })
  assert.deepEqual(
    await service.claim('a', users[0], { cellX: 1, cellZ: 1 }),
    p
  )
  const previous = process.env.PLAYGROUND_ALLOW_RELOCATION
  process.env.PLAYGROUND_ALLOW_RELOCATION = 'false'
  try {
    await assert.rejects(
      () => service.claim('a', users[0], { cellX: 2, cellZ: 1 }),
      /不能更改/
    )
  } finally {
    if (previous === undefined) delete process.env.PLAYGROUND_ALLOW_RELOCATION
    else process.env.PLAYGROUND_ALLOW_RELOCATION = previous
  }
  await assert.rejects(
    () => handler('a', 'saveCommunity', { community: { name: '另一个小区' } }),
    /不能更换/
  )
  assert.equal(db.state.users[0].residentialCommunity.name, '阳光花园')
  assert.equal((await service.own('a')).plotId, p.id)
})
test('regions share houses within the community and hide other communities and owner identifiers', async () => {
  const { users, service } = fixture()
  await service.claim('a', users[0], { cellX: 1, cellZ: 1 })
  const shared = await service.region('b', users[1], { chunkX: 0, chunkZ: 0 })
  assert.equal(shared.plots.length, 1)
  assert.equal(shared.plots[0].mine, false)
  assert.equal(shared.plots[0].ownerOpenid, undefined)
  assert.equal(
    (await service.region('c', users[2], { chunkX: 0, chunkZ: 0 })).plots
      .length,
    0
  )
  await service.claim('c', users[2], { cellX: 1, cellZ: 1 })
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
    () => service.claim('a', users[0], { cellX: 1, cellZ: 1 }),
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
  await service.claim('a', users[0], { x: 390, z: 490 })
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

test('temporary relocation stores exact preview coordinates and frees the old location atomically', async () => {
  const { db, users, service } = fixture()
  const first = await service.claim('a', users[0], { x: 123.25, z: 221.5 })
  const moved = await service.claim('a', users[0], { x: 401.5, z: 500.25 })
  assert.equal(moved.x, 401.5)
  assert.equal(moved.z, 500.25)
  assert.equal(moved.size, 112)
  assert.equal(
    db.state.pet_playground_plots.some((p) => p._id === first.id),
    false
  )
  assert.equal(
    db.state.pet_playground_plots.filter((p) => p.kind === 'plot').length,
    1
  )
  await service.claim('b', users[1], { x: 123.25, z: 221.5 })
  await assert.rejects(
    () => service.claim('a', users[0], { x: 140, z: 230 }),
    /重叠/
  )
  assert.equal((await service.own('a')).plotId, moved.id)
  await assert.rejects(
    () => service.claim('a', users[0], { x: 35, z: 400 }),
    /边界/
  )
  assert.equal((await service.own('a')).plotId, moved.id)
})

test('claim and relocation use ordered requests within one transaction', async () => {
  const { db, users, context } = fixture()
  const runTransaction = db.runTransaction.bind(db)
  let active = 0
  function guarded(target) {
    return new Proxy(target,{get(object,key){
      if(['get','set','remove','update'].includes(key))return async(...args)=>{
        assert.equal(active,0,'requests on the same transaction must not overlap');active++
        try{await new Promise((resolve)=>setImmediate(resolve));return await object[key](...args)}finally{active--}
      }
      if(['doc','where','orderBy','limit'].includes(key))return (...args)=>guarded(object[key](...args))
      return object[key]
    }})
  }
  db.runTransaction=(callback)=>runTransaction((tx)=>callback({collection:(name)=>guarded(tx.collection(name))}))
  const service = world.create(context)
  const first = await service.claim('a', users[0], { x: 360, z: 360 })
  const moved = await service.claim('a', users[0], { x: 600.25, z: 700.5 })
  assert.equal(moved.x, 600.25)
  assert.equal(moved.z, 700.5)
  assert.equal(
    db.state.pet_playground_plots.some((p) => p._id === first.id),
    false
  )
})
test('enlarged yards cannot overlap across different grid cells', async () => {
  const { users, service } = fixture()
  await service.claim('a', users[0], { x: 360, z: 360 })
  await assert.rejects(
    () => service.claim('b', users[1], { x: 425, z: 410 }),
    /重叠/
  )
  const other = await service.claim('b', users[1], { x: 480, z: 360 })
  assert.equal(other.size, 112)
})

test('expanded yard checks neighbors three index cells away and the entire world boundary', async () => {
  const { users, service } = fixture()
  await service.claim('a', users[0], { x: 167.5, z: 300 })
  // floor(167.5/56)=2 and floor(280/56)=5, but 112m yards overlap.
  await assert.rejects(
    () => service.claim('b', users[1], { x: 280, z: 300 }),
    /重叠/
  )
  const neighbor = await service.claim('b', users[1], { x: 283.5, z: 300 })
  assert.equal(neighbor.size, 112)
  await assert.rejects(
    () => service.claim('a', users[0], { x: 55.9, z: 300 }),
    /边界/
  )
})

test('legacy yard enlargement preserves its original plot when a neighbor blocks expansion', async () => {
  const { db, users, service } = fixture()
  const mine = await service.claim('a', users[0], { x: 360, z: 360 })
  const other = await service.claim('b', users[1], { x: 480, z: 360 })
  for (const p of db.state.pet_playground_plots) {
    if (p._id === mine.id || p.plotId === mine.id) p.size = 48
    if (p._id === other.id || p.plotId === other.id) {
      p.x = 425
      p.size = 48
    }
  }
  await assert.rejects(
    () => service.claim('a', users[0], { x: 360, z: 360 }),
    /重叠/
  )
  assert.equal((await service.own('a')).size, 48)
  await service.claim('b', users[1], { x: 600, z: 360 })
  const upgraded = await service.claim('a', users[0], { x: 360, z: 360 })
  assert.equal(upgraded.id, mine.id)
  assert.equal(upgraded.size, 112)
})
test('overview paginates only the current community and excludes legacy owner copies', async () => {
  const { db, users, service } = fixture()
  const mine = await service.claim('a', users[0], { x: 400, z: 400 })
  const id = world.communityId(users[0])
  for (let i = 0; i < 105; i++)
    db.state.pet_playground_plots.push({
      _id: 'map_' + String(i).padStart(4, '0'),
      communityId: id,
      kind: 'plot',
      ownerOpenid: 'b',
      x: 100 + i * 10,
      z: 600,
      size: 48
    })
  db.state.pet_playground_plots.push({
    _id: 'map_legacy_owner',
    communityId: id,
    kind: 'plot',
    plotId: mine.id,
    ownerOpenid: 'a'
  })
  const first = await service.mapOverview('a', users[0], {})
  assert.equal(first.plots.length, 100)
  assert.ok(first.nextCursor)
  const second = await service.mapOverview('a', users[0], {
    cursor: first.nextCursor
  })
  assert.equal(second.plots.length, 6)
  assert.equal(second.nextCursor, '')
  assert.ok(
    [...first.plots, ...second.plots].every((p) => p.ownerOpenid === undefined)
  )
  assert.equal((await service.mapOverview('c', users[2], {})).plots.length, 0)
})
