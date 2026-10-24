const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function fixture({ orders = 0, invites = 0, mode = 'either', supplies = {}, profile = {}, purchased = true, applied = false } = {}) {
  const db = createCollectionStore({
    users: [
      { _id: 'staff_user', openid: 'staff', status: 'active', roles: ['staff'] },
      { _id: 'admin_user', openid: 'admin', status: 'active', roles: ['admin'] }
    ],
    staff_profiles: [{ _id: 'profile', openid: 'staff', auditStatus: 'approved', staffLevel: 'certified', ...profile }],
    orders: [
      ...Array.from({ length: orders }, (_, i) => ({ _id: `done_${i}`, staffOpenid: 'staff', status: 'completed' })),
      { _id: 'unfinished', staffOpenid: 'staff', status: 'in_service' },
      { _id: 'other_staff', staffOpenid: 'other', status: 'completed' }
    ],
    user_invites: [
      ...Array.from({ length: invites }, (_, i) => ({ _id: `invite_${i}`, inviterOpenid: 'staff', eligibleForSupplyReimbursement: true })),
      { _id: 'ineligible_invite', inviterOpenid: 'staff', eligibleForSupplyReimbursement: false },
      { _id: 'other_invite', inviterOpenid: 'other', eligibleForSupplyReimbursement: true }
    ],
    mall_orders: purchased ? [{ _id: 'purchase', clientOpenid: 'staff', status: 'paid' }] : [],
    staff_supply_reimbursements: applied ? [{ _id: 'previous', staffOpenid: 'staff', status: 'pending' }] : [],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { staffSupplies: {
      reimbursementEnabled: true,
      reimbursementMode: mode,
      reimbursementOrderCount: 3,
      reimbursementInviteCount: 2,
      reimbursementAmount: 100,
      purchaseRequired: true,
      ...supplies
    } } }]
  })
  const api = loadCloudFunction('api', db, 'staff')
  return {
    db,
    api,
    status: () => api.main({ module: 'staff', action: 'getSupplyReimbursementStatus', data: {} }),
    submit: () => api.main({ module: 'staff', action: 'submitSupplyReimbursement', data: { mallOrderId: purchased ? 'purchase' : '' } })
  }
}

for (const scenario of [
  { name: 'only completed orders qualify', orders: 3, invites: 0, allowed: true },
  { name: 'only eligible invitations qualify', orders: 0, invites: 2, allowed: true },
  { name: 'both qualify', orders: 3, invites: 2, allowed: true },
  { name: 'neither qualifies', orders: 2, invites: 1, allowed: false }
]) {
  test(`supplies either condition: ${scenario.name}`, async () => {
    const f = fixture(scenario)
    const status = await f.status()
    assert.equal(status.ok, true, status.message)
    assert.equal(status.data.supplies.reimbursementMode, 'either')
    assert.equal(status.data.qualification.mode, 'either')
    assert.equal(status.data.qualification.completedOrderCount, scenario.orders)
    assert.equal(status.data.qualification.eligibleInviteCount, scenario.invites)
    assert.deepEqual(status.data.qualification.conditions.map(condition => condition.met), [scenario.orders >= 3, scenario.invites >= 2])
    assert.equal(status.data.qualification.qualificationMet, scenario.allowed)
    assert.equal(status.data.canApply, scenario.allowed)

    const submitted = await f.submit()
    assert.equal(submitted.ok, scenario.allowed, submitted.message)
    assert.equal(f.db.state.staff_supply_reimbursements.length, scenario.allowed ? 1 : 0)
    if (scenario.allowed) {
      assert.equal(submitted.data.amount, 100)
      const again = await f.submit()
      assert.equal(again.ok, false)
      assert.match(again.message, /仅限申请一次/)
      assert.equal(f.db.state.staff_supply_reimbursements.length, 1)
    } else {
      assert.match(submitted.message, /完成 1 笔订单，或邀请 1 人绑定邀请码，满足任一条件/)
    }
  })
}

for (const scenario of [
  { mode: 'order_count', orders: 2, invites: 2, allowed: false },
  { mode: 'order_count', orders: 3, invites: 0, allowed: true },
  { mode: 'invite_count', orders: 3, invites: 1, allowed: false },
  { mode: 'invite_count', orders: 0, invites: 2, allowed: true }
]) {
  test(`single reimbursement condition remains enforced: ${JSON.stringify(scenario)}`, async () => {
    const f = fixture(scenario)
    const status = await f.status()
    assert.equal(status.ok, true, status.message)
    assert.equal(status.data.qualification.conditions.length, 1)
    assert.equal(status.data.canApply, scenario.allowed)
    const submitted = await f.submit()
    assert.equal(submitted.ok, scenario.allowed, submitted.message)
  })
}

test('selected zero threshold still means no minimum, without counting ineligible invitations', async () => {
  const f = fixture({ supplies: { reimbursementInviteCount: 0 } })
  const status = await f.status()
  assert.equal(status.ok, true, status.message)
  assert.equal(status.data.qualification.eligibleInviteCount, 0)
  assert.equal(status.data.canApply, true)
  assert.equal((await f.submit()).ok, true)
})

for (const scenario of [
  { name: 'intern', profile: { staffLevel: 'intern' } },
  { name: 'unapproved', profile: { auditStatus: 'pending' } },
  { name: 'closed', supplies: { reimbursementEnabled: false } },
  { name: 'no purchase', purchased: false },
  { name: 'already applied', applied: true }
]) {
  test(`either reimbursement condition retains prerequisite: ${scenario.name}`, async () => {
    const f = fixture({ ...scenario, invites: 2 })
    const status = await f.status()
    assert.equal(status.ok, true, status.message)
    assert.equal(status.data.qualification.qualificationMet, true)
    assert.equal(status.data.canApply, false)
    assert.equal((await f.submit()).ok, false)
  })
}

test('saving system settings preserves both reimbursement conditions and their thresholds', async () => {
  const f = fixture({ mode: 'order_count' })
  const admin = loadCloudFunction('api', f.db, 'admin')
  const current = await admin.main({ module: 'admin', action: 'getSystemSettings', data: {} })
  assert.equal(current.ok, true, current.message)
  const saved = await admin.main({ module: 'admin', action: 'saveSystemSettings', data: {
    ...current.data,
    staffSupplies: { ...current.data.staffSupplies, reimbursementMode: 'either', reimbursementOrderCount: 5, reimbursementInviteCount: 4 }
  } })
  assert.equal(saved.ok, true, saved.message)
  assert.equal(saved.data.staffSupplies.reimbursementMode, 'either')
  const status = await f.status()
  assert.equal(status.ok, true, status.message)
  assert.equal(status.data.qualification.mode, 'either')
  assert.deepEqual(status.data.qualification.conditions.map(condition => condition.requiredCount), [5, 4])
})

test('invalid reimbursement thresholds cannot be saved as a zero minimum', async () => {
  const f = fixture()
  const admin = loadCloudFunction('api', f.db, 'admin')
  const original = JSON.stringify(f.db.state.platform_configs)
  for (const field of ['reimbursementOrderCount', 'reimbursementInviteCount']) {
    for (const value of ['', ' ', 'invalid', -1, 1.5, null, true, [], Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const saved = await admin.main({ module: 'admin', action: 'saveSystemSettings', data: {
        staffSupplies: { ...f.db.state.platform_configs[0].value.staffSupplies, [field]: value }
      } })
      assert.equal(saved.ok, false, `${field}=${JSON.stringify(value)} must be rejected`)
      assert.match(saved.message, /用品报销设置.*非负整数/)
      assert.equal(JSON.stringify(f.db.state.platform_configs), original)
    }
  }
})

test('corrupted stored reimbursement thresholds never grant application eligibility', async () => {
  const f = fixture({ supplies: { reimbursementInviteCount: 'invalid', purchaseRequired: false } })
  const status = await f.status()
  assert.equal(status.ok, false)
  assert.match(status.message, /用品报销设置.*非负整数/)
  const submitted = await f.submit()
  assert.equal(submitted.ok, false)
  assert.match(submitted.message, /用品报销设置.*非负整数/)
  assert.equal(f.db.state.staff_supply_reimbursements.length, 0)
})

test('legacy missing thresholds default to zero and integer input strings remain supported', async () => {
  const f = fixture({ supplies: { reimbursementOrderCount: undefined, reimbursementInviteCount: '2' } })
  const status = await f.status()
  assert.equal(status.ok, true, status.message)
  assert.deepEqual(status.data.qualification.conditions.map(condition => condition.requiredCount), [0, 2])
  assert.equal(status.data.canApply, true)
})
