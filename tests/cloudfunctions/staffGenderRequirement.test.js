const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createStaffHandler = require('../../cloudfunctions/api/handlers/staff')

function profile(gender = 'female') {
  return { _id: 'sp', openid: 'staff', userId: 's', gender, auditStatus: 'approved', staffLevel: 'certified', depositStatus: 'paid', serviceAddress: '测试服务点', serviceLatitude: 31.2, serviceLongitude: 121.5, serviceRadiusKm: 5 }
}
function order(id, requirement, extra = {}) {
  return { _id: id, clientOpenid: 'client', status: 'paid', paymentStatus: 'paid', publishMode: 'open', staffOpenid: '', staffGenderRequirement: requirement, startTime: '2099-09-30 10:00', endTime: '2099-09-30 11:00', ...extra }
}
function setup({ gender = 'female', orders = [], staffProfile } = {}) {
  const db = createCollectionStore({
    users: [
      { _id: 's', openid: 'staff', roles: ['client', 'staff'], status: 'active', phone: '13800000000' },
      { _id: 'c', openid: 'client', roles: ['client'], status: 'active', phone: '13800000001' },
      { _id: 'a', openid: 'admin', roles: ['admin'], status: 'active' }
    ],
    staff_profiles: [staffProfile || profile(gender)], orders,
    pets: [{ _id: 'p', openid: 'client', name: '可乐', species: 'dog', weight: 12 }]
  })
  const context = createContext({ db, cloud: {} })
  return { db, context, api: (openid) => loadCloudFunction('api', db, openid) }
}

for (const gender of ['female', 'male', '']) {
  test(`all reception lists filter gender before pagination for ${gender || 'legacy unknown'} staff`, async () => {
    const orders = ['any', 'male', 'female', undefined].flatMap((requirement, i) => [
      order(`open-${i}`, requirement),
      order(`direct-${i}`, requirement, { publishMode: 'direct', requestedStaffOpenid: 'staff' }),
      order(`urgent-${i}`, requirement, { isUrgent: true })
    ])
    const { context } = setup({ gender, orders })
    const enriched = []
    const handler = createStaffHandler({ ...context,
      expireDueUnacceptedOrders: async () => {},
      validateStaffTakeOrderAbility: () => ({ can: true }),
      getSystemSettings: async () => ({}),
      attachOrderDisplayData: async (o) => { enriched.push(o); return o },
      calculateStaffEarningForOrder: async () => ({ earningAmount: 20 })
    })
    for (const action of ['listAvailableOrders', 'listNearbyOrders', 'listDirectOrders', 'listUrgentOrders']) {
      const result = await handler('staff', action, { page: 1, pageSize: 1 })
      assert.equal(result.total, gender ? 3 : 2, action)
      assert.equal(result.hasMore, true)
      const remainder = await handler('staff', action, { page: 2, pageSize: 1 })
      assert.ok(remainder.list.length)
    }
    assert.ok(enriched.every((o) => !o.staffGenderRequirement || o.staffGenderRequirement === 'any' || o.staffGenderRequirement === gender))
  })
}

test('mismatched staff cannot preview, risk-confirm or accept an order by ID', async () => {
  const { api, db } = setup({ orders: [order('o', 'male')] })
  for (const [module, action] of [['order', 'getOrderDetail'], ['staff', 'checkAcceptOrderRisk'], ['staff', 'acceptOrder']]) {
    const res = await api('staff').main({ module, action, data: { orderId: 'o', riskConfirmed: true, gender: 'male' } })
    assert.equal(res.ok, false, action)
    assert.match(res.message, /无权|性别/)
  }
  assert.equal(db.state.orders[0].status, 'paid')
  const owner = await api('client').main({ module: 'order', action: 'getOrderDetail', data: { orderId: 'o' } })
  assert.equal(owner.ok, true)
})

test('atomic assignment enforces current gender for staff and admins and accepts matching profiles', async () => {
  const { context, db } = setup({ orders: [order('o', 'male')] })
  const patch = { staffUserId: 's', staffOpenid: 'staff', staffProfileId: 'sp', status: 'assigned' }
  for (const admin of [false, true]) {
    await assert.rejects(context.assignOrderAtomically('o', db.state.orders[0], patch, { admin, riskConfirmed: true }), /性别/)
  }
  db.state.staff_profiles[0].gender = 'male'
  const assigned = await context.assignOrderAtomically('o', db.state.orders[0], patch, { riskConfirmed: true })
  assert.equal(assigned.status, 'assigned')
})

const orderPayload = { petId: 'p', serviceTypes: ['visit_fee', 'walk'], serviceAddress: '测试地址', addressDetail: '1栋101', doorplate: '101', startTime: '2099-07-28 10:00', endTime: '2099-07-28 11:00' }
test('order creation defaults to any, persists explicit gender and rejects invalid or mismatched direct bookings', async () => {
  const { api, db } = setup()
  for (const requirement of [undefined, 'any', 'male', 'female']) {
    const res = await api('client').main({ module: 'order', action: 'createOrder', data: { ...orderPayload, staffGenderRequirement: requirement } })
    assert.equal(res.ok, true, res.message)
    assert.equal(res.data.staffGenderRequirement, requirement || 'any')
  }
  const count = db.state.orders.length
  for (const action of ['createOrder', 'quoteOrder']) {
    const invalid = await api('client').main({ module: 'order', action, data: { ...orderPayload, staffGenderRequirement: 'invalid' } })
    assert.equal(invalid.ok, false)
    const mismatch = await api('client').main({ module: 'order', action, data: { ...orderPayload, publishMode: 'direct', staffProfileId: 'sp', staffGenderRequirement: 'male' } })
    assert.equal(mismatch.ok, false)
    assert.match(mismatch.message, /性别/)
  }
  assert.equal(db.state.orders.length, count)
})

const application = { realName: '测试姓名', phone: '13800000000', gender: 'female', serviceAddress: '服务点', serviceLatitude: 31.2, serviceLongitude: 121.5, idCardFrontFileId: 'cloud://front', idCardBackFileId: 'cloud://back', facePhotoFileId: 'cloud://face' }
test('certification requires valid gender and approval locks authenticated fields against API edits', async () => {
  const { db, api } = setup({ staffProfile: { _id: 'sp', openid: 'staff', auditStatus: 'pending' } })
  for (const gender of [undefined, '', 'any', 'invalid']) {
    const res = await api('staff').main({ module: 'staff', action: 'submitStaffProfile', data: { ...application, gender } })
    assert.equal(res.ok, false)
    assert.match(res.message, /性别/)
  }
  const missing = await api('admin').main({ module: 'admin', action: 'auditStaff', data: { staffProfileId: 'sp', auditStatus: 'approved' } })
  assert.equal(missing.ok, false)
  const submitted = await api('staff').main({ module: 'staff', action: 'submitStaffProfile', data: application })
  assert.equal(submitted.ok, true, submitted.message)
  assert.equal(db.state.staff_profiles[0].gender, 'female')
  const approved = await api('admin').main({ module: 'admin', action: 'auditStaff', data: { staffProfileId: 'sp', auditStatus: 'approved' } })
  assert.equal(approved.ok, true, approved.message)
  assert.ok(db.state.staff_profiles[0].certificationLockedAt)
  for (const field of ['gender', 'realName', 'phone', 'idCardFrontFileId', 'facePhotoFileId']) {
    const res = await api('staff').main({ module: 'staff', action: 'updateStaffProfileConfig', data: { weeklySchedule: {}, [field]: 'changed' } })
    assert.equal(res.ok, false)
    assert.match(res.message, /锁定/)
  }
  const resubmit = await api('staff').main({ module: 'staff', action: 'submitStaffProfile', data: { ...application, gender: 'male' } })
  assert.equal(resubmit.ok, false)
  assert.equal(db.state.staff_profiles[0].gender, 'female')
  const schedule = await api('staff').main({ module: 'staff', action: 'updateStaffProfileConfig', data: { weeklySchedule: { '1': [{ start: 8, end: 20 }] } } })
  assert.equal(schedule.ok, true)
})

test('legacy gender can only be verified once by an authorized admin with an audit note', async () => {
  const { api, db } = setup({ gender: '' })
  const request = { module: 'admin', action: 'completeStaffGender', data: { staffProfileId: 'sp', gender: 'female', reason: '核对实名材料' } }
  assert.equal((await api('staff').main(request)).ok, false)
  const missingNote = await api('admin').main({ ...request, data: { ...request.data, reason: '' } })
  assert.equal(missingNote.ok, false)
  const completed = await api('admin').main(request)
  assert.equal(completed.ok, true, completed.message)
  assert.equal(db.state.staff_profiles[0].gender, 'female')
  assert.equal(db.state.staff_profiles[0].genderVerifiedBy, 'admin')
  assert.ok(db.state.admin_operation_logs.some((log) => log.action === 'completeStaffGender'))
  assert.equal((await api('admin').main({ ...request, data: { ...request.data, gender: 'male' } })).ok, false)
})
