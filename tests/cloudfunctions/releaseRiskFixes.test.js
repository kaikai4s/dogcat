const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createMallCatalog = require('../../cloudfunctions/api/services/mallCatalog')

const users = () => [
  { _id: 'a', openid: 'admin', roles: ['admin'], status: 'active' },
  { _id: 'u', openid: 'user', nickname: '用户', roles: ['client', 'staff'], status: 'active' }
]
function caller(db, openid = 'admin', overrides) {
  const api = loadCloudFunction('api', db, openid, overrides)
  return (module, action, data = {}) => api.main({ module, action, data })
}

for (const status of ['pending', 'approved', 'transferring', 'transfer_failed']) {
  for (const assetType of ['user', 'staff']) {
    test(`account deletion protects ${assetType} withdrawals in ${status}`, async () => {
      const withdrawal = { _id: 'w', status, assetType, amount: 88, ...(assetType === 'user' ? { userOpenid: 'user' } : { staffOpenid: 'user' }) }
      const db = createCollectionStore({ users: users(), withdraw_requests: [withdrawal],
        user_asset_earnings: [{ _id: 'e', userOpenid: 'user', status: 'withdrawing', withdrawRequestId: 'w', amount: 88 }] })
      const call = caller(db)
      for (const action of ['deleteUser', 'hardDeleteUser']) {
        const result = await call('admin', action, { openid: 'user' })
        assert.equal(result.ok, false)
        assert.match(result.message, /提现申请，无法删除/)
        assert.equal(db.state.users.find(u => u.openid === 'user').status, 'active')
        assert.equal(db.state.user_asset_earnings.length, 1)
      }
    })
  }
}

test('deleting a settled account retains the financial ledger and monthly award idempotency', async () => {
  const earning = { _id: 'beauty_prize_2026-10_pet', sourceType: 'pet_beauty_champion_prize', monthKey: '2026-10', userOpenid: 'user', amount: 88, status: 'withdrawn' }
  const db = createCollectionStore({ users: users(), user_asset_earnings: [earning],
    withdraw_requests: [{ _id: 'w', assetType: 'user', userOpenid: 'user', status: 'paid', amount: 88 }] })
  const result = await caller(db)('admin', 'hardDeleteUser', { openid: 'user' })
  assert.equal(result.ok, true, result.message)
  assert.equal(db.state.users.some(u => u.openid === 'user'), false)
  assert.deepEqual(db.state.user_asset_earnings, [earning])
  assert.equal(db.state.withdraw_requests[0].status, 'paid')
})

test('failed safety queries cannot be treated as no pending withdrawals', async () => {
  const db = createCollectionStore({ users: users() })
  const collection = db.collection
  db.collection = name => { if (name === 'withdraw_requests') throw new Error('withdrawal lookup failed'); return collection(name) }
  const result = await caller(db)('admin', 'hardDeleteUser', { openid: 'user' })
  assert.equal(result.ok, false)
  assert.equal(db.state.users.length, 2)
})

function contestSetup() {
  const db = createCollectionStore({ users: users(),
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { petBeautyContest: { enabled: true, firstPrizeAmount: 500 } } }],
    pets: ['p1', 'p2'].map((id, i) => ({ _id: id, openid: 'user', name: id, exclusiveId: 'P0000' + i, beautyPhotos: [{ fileId: 'cloud://photo' }], createdAt: '2026-10-01' })),
    pet_beauty_votes: [{ _id: 'v1', petId: 'p1', monthKey: '2026-10' }, { _id: 'v2', petId: 'p1', monthKey: '2026-10' }, { _id: 'v3', petId: 'p2', monthKey: '2026-10' }] })
  const call = caller(db)
  return { db, call: (action, data) => call('petBeauty', action, { monthKey: '2026-10', ...data }) }
}
for (const legacy of [false, true]) {
  test(`a corrected monthly champion cannot receive a second cash award (${legacy ? 'legacy' : 'current'} ledger)`, async () => {
    const { db, call } = contestSetup()
    assert.equal((await call('settleMonthlyRanking')).ok, true)
    if (legacy) {
      db.state.user_asset_earnings = [{ _id: 'beauty_prize_2026-10_p1', sourceType: 'pet_beauty_champion_prize', monthKey: '2026-10', petId: 'p1', amount: 500, status: 'withdrawn' }]
    } else {
      const first = await call('grantPetBeautyChampionPrize')
      assert.equal(first.ok, true, first.message)
    }
    db.state.pet_beauty_votes.push({ _id: 'v4', petId: 'p2', monthKey: '2026-10' }, { _id: 'v5', petId: 'p2', monthKey: '2026-10' })
    assert.equal((await call('settleMonthlyRanking', { force: true })).ok, true)
    assert.equal(db.state.pet_beauty_month_rankings.find(r => r.petId === 'p2').rank, 1)
    const second = await call('grantPetBeautyChampionPrize')
    assert.equal(second.ok, false)
    assert.match(second.message, /请勿重复发放/)
    assert.equal(db.state.user_asset_earnings.length, 1)
    assert.equal(db.state.user_asset_earnings[0].amount, 500)
  })
}

test('simultaneous monthly payout requests create exactly one financial entry', async () => {
  const { db, call } = contestSetup()
  await call('settleMonthlyRanking')
  const results = await Promise.all([call('grantPetBeautyChampionPrize'), call('grantPetBeautyChampionPrize')])
  assert.equal(results.filter(r => r.ok).length, 1)
  assert.equal(db.state.user_asset_earnings.length, 1)
})

test('locked monthly prize snapshot controls all public contest amounts after settings change', async () => {
  const { db, call } = contestSetup()
  db.state.platform_configs[0].value.petBeautyContest.enabled = false
  await call('settleMonthlyRanking')
  db.state.platform_configs[0].value.petBeautyContest = { enabled: true, firstPrizeAmount: 888 }
  assert.equal((await call('getActivityHome')).data.contestConfig.firstPrizeAmount, 0)
  assert.equal((await call('getContestConfig')).data.rewardAmount, 0)
  assert.equal((await call('listRanking')).data.list[0].prizeAmount, 0)
  const nextMonth = await call('getContestConfig', { monthKey: '2026-11' })
  assert.equal(nextMonth.data.firstPrizeAmount, 888)
})

for (const relation of ['clientOpenid', 'staffOpenid']) {
  test(`restricted dual-role admin can view their own ${relation} order without admin permissions`, async () => {
    const db = createCollectionStore({ users: [{ _id: 'u', openid: 'mixed', roles: ['admin', 'client', 'staff'], status: 'active' }],
      admin_access_config: [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }],
      admin_groups: [{ _id: 'g', enabled: true, permissions: ['admin.listPayments'] }],
      admin_memberships: [{ _id: 'u', groupIds: ['g'] }],
      orders: [{ _id: 'own', [relation]: 'mixed', status: 'completed', paymentStatus: 'paid' }, { _id: 'other', clientOpenid: 'other', status: 'completed', paymentStatus: 'paid' }] })
    const call = caller(db, 'mixed')
    const own = await call('order', 'getOrderDetail', { id: 'own', role: relation === 'staffOpenid' ? 'staff' : 'client' })
    assert.equal(own.ok, true, own.message)
    const other = await call('order', 'getOrderDetail', { id: 'other' })
    assert.equal(other.ok, false)
    assert.equal(other.code, 'ADMIN_FORBIDDEN')
  })
}

function mall(db) { return createMallCatalog({ db, now: () => new Date('2026-10-23T12:00:00Z') }) }
test('mall receipt scheduler scans past 100 fresh shipments and updates all eligible pages', async () => {
  const orders = Array.from({ length: 100 }, (_, i) => ({ _id: `a${String(i).padStart(3, '0')}`, status: 'shipped', shippedAt: '2026-10-23', refundStatus: 'none' }))
  orders.push(...Array.from({ length: 105 }, (_, i) => ({ _id: `b${String(i).padStart(3, '0')}`, status: 'shipped', shippedAt: '2026-10-01', refundStatus: 'none' })))
  const db = createCollectionStore({ mall_orders: orders })
  const completed = await mall(db).autoCompleteDeliveredMallOrders()
  assert.equal(completed.length, 105)
  assert.equal(db.state.mall_orders.filter(o => o.status === 'completed').length, 105)
  assert.equal(db.state.mall_orders.filter(o => o.status === 'shipped').length, 100)
})
test('mall receipt scheduler rechecks newly applied refunds before updating and does not report failed writes as completed', async () => {
  const db = createCollectionStore({ mall_orders: [{ _id: 'o', status: 'shipped', shippedAt: '2026-10-01', refundStatus: 'none' }] })
  const transaction = db.runTransaction
  db.runTransaction = fn => {
    db.state.mall_orders[0].refundStatus = 'applied'
    return transaction(fn)
  }
  assert.deepEqual(await mall(db).autoCompleteDeliveredMallOrders(), [])
  assert.equal(db.state.mall_orders[0].status, 'shipped')
  db.runTransaction = async () => { throw new Error('write failed') }
  db.state.mall_orders[0].refundStatus = 'none'
  await assert.rejects(() => mall(db).autoCompleteDeliveredMallOrders(), /write failed/)
})

const community = { name: '阳光小区', address: '公园路', city: '上海', district: '浦东', latitude: 31, longitude: 121 }
for (const [module, action] of [['playground', 'saveCommunity'], ['auth', 'updateCommunity'], ['auth', 'updateProfile']]) {
  for (const blocked of [false, true]) {
    test(`${module}.${action} ${blocked ? 'rejects unsafe' : 'checks map-selected'} community text`, async () => {
      const db = createCollectionStore({ users: users() })
      let checked = []
      const call = caller(db, 'user', { security: { msgSecCheck: async options => {
        checked.push(options.content)
        return { errCode: 0, result: { suggest: blocked ? 'risky' : 'pass' } }
      } } })
      const result = await call(module, action, { nickname: '用户', community, residentialCommunity: community })
      assert.equal(result.ok, !blocked, result.message)
      assert.equal(checked.length, 1)
      for (const field of ['name', 'address', 'city', 'district']) assert.ok(checked[0].includes(community[field]))
      assert.equal(Boolean(db.state.users.find(u => u.openid === 'user').residentialCommunity), !blocked)
    })
  }
}

test('community safety service failure and malformed location cannot save public community text', async () => {
  for (const fail of [true, false]) {
    const db = createCollectionStore({ users: users() })
    const call = caller(db, 'user', { security: { msgSecCheck: async () => { throw new Error('unavailable') } } })
    const result = await call('playground', 'saveCommunity', { community: fail ? community : { ...community, latitude: 100 } })
    assert.equal(result.ok, false)
    assert.equal(db.state.users.find(u => u.openid === 'user').residentialCommunity, undefined)
  }
})

for (const permitted of [true, false]) {
  test(`staff preview gender restrictions ${permitted ? 'allow an independently authorized admin' : 'cannot be bypassed by an unprivileged admin role'}`, async () => {
    const db = createCollectionStore({ users: [{ _id: 'u', openid: 'mixed', roles: ['staff', 'admin'], status: 'active' }],
      admin_access_config: [{ _id: 'policy', enabled: true, ownerOpenid: 'owner' }],
      admin_groups: [{ _id: 'g', enabled: true, permissions: permitted ? ['admin.getOrderDetail'] : ['admin.listPayments'] }],
      admin_memberships: [{ _id: 'u', groupIds: ['g'] }],
      staff_profiles: [{ _id: 's', openid: 'mixed', gender: 'male' }],
      orders: [{ _id: 'o', clientOpenid: 'other', status: 'paid', paymentStatus: 'paid', publishMode: 'open', staffGenderRequirement: 'female', startTime: '2099-10-01 10:00', endTime: '2099-10-01 11:00' }] })
    const result = await caller(db, 'mixed')('order', 'getOrderDetail', { id: 'o', role: 'staff' })
    assert.equal(result.ok, permitted, result.message)
    if (!permitted) assert.equal(result.code, 'ADMIN_FORBIDDEN')
  })
}
