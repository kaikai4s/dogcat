const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const world = require('../../cloudfunctions/api/config/memorial-world.json')
const available = require('../../cloudfunctions/api/config/memorial-plots.json').ids.map((id) => world.cells.find((p) => p.id === id))

function fixture(extra = {}) {
  const db = createCollectionStore({
    users: ['a', 'b', 'admin'].map((openid) => ({
      _id: openid,
      openid,
      nickname: openid,
      roles: [openid === 'admin' ? 'admin' : 'client'],
      status: 'active'
    })),
    ...extra
  })
  const context = createContext({
    db,
    cloud: {
      openapi: {
        subscribeMessage: { send: async () => ({ errCode: 0 }) },
        security: { msgSecCheck: async () => ({ errCode: 0, result: { suggest: 'pass' } }) }
      }
    }
  })
  const handler = require('../../cloudfunctions/api/handlers/memorial')(context)
  const call = (who, action, data = {}) => context.runAdminRequest('memorial', action, data, () => handler(who, action, data))
  return { db, call, context }
}

const baseApp = (i = 0, extra = {}) => ({
  requestId: `years_req_${i}`,
  version: world.version,
  plotId: available[i].id,
  petName: `小宠${i}`,
  epitaph: '永远留在回忆里',
  date: '2025-05-01',
  ...extra
})

test('memorial submit supports birthYear/passingYear including unknown and projects lifeSpanText across endpoints', async () => {
  const cases = [
    { birthYear: '2016', passingYear: '2025', expected: '2016 — 2025' },
    { birthYear: 'unknown', passingYear: '2025', expected: '未知 — 2025' },
    { birthYear: '2018', passingYear: 'unknown', expected: '2018 — 未知' },
    { birthYear: 'unknown', passingYear: 'unknown', expected: '未知 — 未知' }
  ]
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i]
    const { call } = fixture()
    const { id } = await call('a', 'submit', baseApp(i, { birthYear: c.birthYear, passingYear: c.passingYear }))
    const mine = (await call('a', 'listMine')).list[0]
    assert.equal(mine.birthYear, c.birthYear)
    assert.equal(mine.passingYear, c.passingYear)
    assert.equal(mine.lifeSpanText, c.expected)

    await call('admin', 'review', { id, status: 'approved' })
    const worldRes = await call('b', 'world')
    assert.equal(worldRes.memorials[0].birthYear, c.birthYear)
    assert.equal(worldRes.memorials[0].passingYear, c.passingYear)
    assert.equal(worldRes.memorials[0].lifeSpanText, c.expected)

    const detail = await call('a', 'detail', { id })
    assert.equal(detail.birthYear, c.birthYear)
    assert.equal(detail.passingYear, c.passingYear)
    assert.equal(detail.lifeSpanText, c.expected)

    const adminDetail = await call('admin', 'getMemorialAdmin', { id })
    assert.equal(adminDetail.lifeSpanText, c.expected)
  }
})

test('memorial rejects invalid birth/passing year order, out-of-range years, and changed retry years', async () => {
  const { call } = fixture()
  await assert.rejects(call('a', 'submit', baseApp(0, { birthYear: '2025', passingYear: '2020' })), /出生年份不能晚于去世年份/)
  await assert.rejects(call('a', 'submit', baseApp(0, { birthYear: '2099', passingYear: 'unknown' })), /出生年份/)
  await assert.rejects(call('a', 'submit', baseApp(0, { birthYear: '1975', passingYear: '2024' })), /出生年份/)

  await call('a', 'submit', baseApp(0, { birthYear: '2016', passingYear: '2024' }))
  await assert.rejects(
    call('a', 'submit', baseApp(0, { birthYear: 'unknown', passingYear: '2024' })),
    /内容已改变/
  )
})

test('owner can edit memorial years on already created monuments and survive relocate/recycle', async () => {
  const { call } = fixture()
  // Legacy application submitted without explicit birth/passing year.
  const { id } = await call('a', 'submit', baseApp(0))
  await assert.rejects(call('a', 'updateYears', { id, birthYear: '2015', passingYear: '2024' }), /暂不可编辑/)

  await call('admin', 'review', { id, status: 'approved' })
  await assert.rejects(call('b', 'updateYears', { id, birthYear: '2015', passingYear: '2024' }), /只有主人/)
  await assert.rejects(call('a', 'updateYears', { id, birthYear: '2025', passingYear: '2020' }), /出生年份不能晚于去世年份/)

  const updated = await call('a', 'updateYears', { id, birthYear: 'unknown', passingYear: '2024' })
  assert.equal(updated.birthYear, 'unknown')
  assert.equal(updated.passingYear, '2024')
  assert.equal(updated.lifeSpanText, '未知 — 2024')

  const worldAfter = await call('b', 'world')
  assert.equal(worldAfter.memorials[0].lifeSpanText, '未知 — 2024')
  const detailAfter = await call('a', 'detail', { id })
  assert.equal(detailAfter.lifeSpanText, '未知 — 2024')

  // Demolish -> recycleDetail -> restore preserves birthYear & passingYear.
  await call('a', 'demolish', {
    id,
    locationRevision: detailAfter.locationRevision,
    requestId: 'demolish_years_1',
    confirm: true,
    confirmName: detailAfter.petName
  })
  const recycle = await call('a', 'recycleDetail', { id })
  assert.equal(recycle.birthYear, 'unknown')
  assert.equal(recycle.passingYear, '2024')
  assert.equal(recycle.lifeSpanText, '未知 — 2024')

  await call('a', 'restore', {
    id,
    locationRevision: recycle.locationRevision,
    requestId: 'restore_years_1',
    original: true
  })
  const worldRestored = await call('b', 'world')
  assert.equal(worldRestored.memorials[0].lifeSpanText, '未知 — 2024')
})
