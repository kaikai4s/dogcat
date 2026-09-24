const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')

const oldAward = { monthKey: '2026-07', rank: 1, title: '7月最美爱宠' }
const newAward = { monthKey: '2026-08', rank: 2, title: '8月第2爱宠' }
function setup(petFields = {}) {
  const db = createCollectionStore({
    users: [{ _id: 'owner', openid: 'owner', roles: ['client'], status: 'active' }],
    pets: [{ _id: 'pet', openid: 'owner', name: '咪咪', exclusiveId: 'P123456', avatarFileId: 'cloud://photo', beautyPhotos: [{ fileId: 'cloud://photo' }], beautyTitle: newAward, ...petFields }],
    pet_beauty_month_rankings: [oldAward, newAward].map((award, i) => ({ ...award, _id: `award_${i}`, petId: 'pet', locked: true, petSnapshot: { name: '咪咪' } }))
  })
  const fn = loadCloudFunction('api', db, 'owner')
  const call = (action, data = {}, module = 'petBeauty') => fn.main({ module, action, data: { petId: 'pet', ...data } })
  return { db, call }
}

test('monthly titles can be removed and historical awards re-equipped without losing ownership', async () => {
  const { db, call } = setup()
  assert.equal((await call('listMyBeautyTitles')).data.titles.length, 2)
  assert.equal((await call('unequipBeautyTitle')).ok, true)
  assert.equal(db.state.pets[0].beautyTitle, null)
  assert.equal((await call('listMyBeautyTitles')).data.titles.length, 2)
  assert.equal(db.state.pet_beauty_month_rankings.length, 2)
  const result = await call('equipBeautyTitle', { awardMonthKey: oldAward.monthKey, beautyTitle: { title: 'forged' } })
  assert.equal(result.ok, true)
  assert.equal(result.data.beautyTitle.title, oldAward.title)
  assert.equal((await call('getPet', {}, 'pet')).data.beautyTitle.title, oldAward.title)
  const ranking = await call('listRanking', { monthKey: '2026-09' })
  assert.equal(ranking.data.list[0].beautyTitle.title, oldAward.title)
})

test('monthly title can be equipped when current beautyTitle is null', async () => {
  const { db, call } = setup({ beautyTitle: null })
  const result = await call('equipBeautyTitle', { awardMonthKey: oldAward.monthKey })
  assert.equal(result.ok, true)
  assert.equal(result.data.beautyTitle.title, oldAward.title)
  assert.equal(db.state.pets[0].beautyTitle.title, oldAward.title)
  assert.equal(db.state.pets[0].beautyTitleSelectionSet, true)
})

test('monthly title operations enforce pet ownership and earned awards', async () => {
  const { db, call } = setup()
  db.state.pets.push({ _id: 'other', openid: 'someone_else', beautyTitle: oldAward })
  db.state.pet_beauty_month_rankings.push({ _id: 'other_award', petId: 'other', monthKey: '2026-06', title: 'Other award', locked: true })
  for (const action of ['listMyBeautyTitles', 'equipBeautyTitle', 'unequipBeautyTitle']) {
    assert.equal((await call(action, { petId: 'other', awardMonthKey: oldAward.monthKey })).ok, false)
  }
  assert.equal((await call('equipBeautyTitle', { awardMonthKey: '2026-06' })).ok, false)
  assert.equal((await call('equipBeautyTitle')).ok, false)
  assert.equal(db.state.pets[0].beautyTitle.title, newAward.title)
})

test('legacy monthly title survives removal even without archived ranking', async () => {
  const { db, call } = setup({ beautyTitle: oldAward })
  db.state.pet_beauty_month_rankings.length = 0
  await call('unequipBeautyTitle')
  await call('unequipBeautyTitle')
  const owned = await call('listMyBeautyTitles')
  assert.equal(owned.data.beautyTitle, null)
  assert.equal(owned.data.titles[0].title, oldAward.title)
  assert.equal((await call('equipBeautyTitle', { awardMonthKey: oldAward.monthKey })).ok, true)
})

test('monthly award inventory paginates beyond database page limit', async () => {
  const { db, call } = setup({ beautyTitle: null })
  db.state.pet_beauty_month_rankings = Array.from({ length: 125 }, (_, i) => ({
    _id: `award_${String(i).padStart(3, '0')}`, petId: 'pet', locked: true,
    monthKey: `${2010 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, '0')}`, rank: 1, title: `award ${i}`
  }))
  const result = await call('listMyBeautyTitles')
  assert.equal(result.data.titles.length, 125)
  assert.equal(result.data.titles[0].title, 'award 124')
})

test('monthly settlement retains explicit selection or removal and still awards new honors', async () => {
  for (const mode of ['automatic', 'selected', 'removed']) {
    const { db, call } = setup()
    if (mode === 'selected') await call('equipBeautyTitle', { awardMonthKey: oldAward.monthKey })
    if (mode === 'removed') await call('unequipBeautyTitle')
    db.state.pet_beauty_votes = [{ _id: 'vote', petId: 'pet', monthKey: '2026-09', createdAt: '2026-09-12T00:00:00+08:00' }]
    const context = createContext({ db, cloud: {} })
    await context.settlePetBeautyMonthlyRanking('2026-09')
    const selected = db.state.pets[0].beautyTitle
    assert.equal(selected && selected.monthKey, mode === 'removed' ? null : mode === 'selected' ? '2026-07' : '2026-09')
    assert.equal((await call('listMyBeautyTitles')).data.titles.length, 3)
    const historical = await call('listRanking', { monthKey: '2026-10', historyMonthKey: '2026-09' })
    assert.equal(historical.data.list[0].beautyTitle.monthKey, '2026-09')
  }
})

test('normal pet saves cannot forge awards or undo removal', async () => {
  const { db, call } = setup()
  await call('unequipBeautyTitle')
  const fields = { name: '咪咪', avatarFileId: 'cloud://photo', beautyPhotos: [{ fileId: 'cloud://photo' }], beautyTitle: oldAward, legacyBeautyTitle: oldAward, beautyTitleSelectionSet: false }
  assert.equal((await call('updatePet', fields, 'pet')).ok, true)
  assert.equal(db.state.pets[0].beautyTitle, null)
  assert.equal(db.state.pets[0].beautyTitleSelectionSet, true)
  const created = await call('createPet', fields, 'pet')
  assert.equal(created.ok, true)
  assert.equal(created.data.beautyTitle, null)
  assert.equal(created.data.legacyBeautyTitle, undefined)
})

test('live order and leaderboard displays do not resurrect an unequipped monthly award', async () => {
  const { db, call } = setup()
  await call('unequipBeautyTitle')
  db.state.orders = [{ _id: 'order', clientOpenid: 'owner', clientUserId: 'owner', petId: 'pet', status: 'assigned', petSnapshot: { beautyTitle: newAward } }]
  const orders = await call('listOrders', { role: 'client', page: 1, pageSize: 10 }, 'order')
  assert.equal(orders.ok, true)
  assert.equal(orders.data.list[0].petSnapshot.beautyTitle, null)
  const ranking = await call('listRanking', { monthKey: '2026-09' })
  assert.equal(ranking.data.list[0].beautyTitle, null)
  const history = await call('listRanking', { monthKey: '2026-09', historyMonthKey: '2026-08' })
  assert.equal(history.data.list[0].beautyTitle.title, newAward.title)
})
