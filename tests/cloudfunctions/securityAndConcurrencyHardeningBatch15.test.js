const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { createCollectionStore } = require('./helpers')

function createAssignmentService(db, overrides = {}) {
  const createService = require('../../cloudfunctions/api/services/orderAssignment')
  return createService({
    crypto,
    db,
    now: () => new Date('2026-09-30T10:00:00+08:00'),
    toTimeValue: (value) => new Date(String(value).replace(/-/g, '/')).getTime(),
    getOrderTimeRanges: (order) => [{ startTime: order.startTime, endTime: order.endTime }],
    findStaffOrderConflict: async () => false,
    isOrderConflictCandidate: () => true,
    validateStaffTakeOrderAbility: () => ({ can: true }),
    validateStaffScheduleOnly: () => true,
    getDateKeyFromTime: (value) => String(value || '').slice(0, 10),
    parseDateTimeParts: () => null,
    validateSitterScheduleTime: () => true,
    ...overrides
  })
}

test('assignOrderAtomically: 事务内校验宠托师进行中订单上限', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_staff', openid: 'openid_staff', status: 'active', roles: ['staff'] }],
    staff_profiles: [{ _id: 'sp_1', openid: 'openid_staff', auditStatus: 'approved' }],
    orders: [
      { _id: 'target_order', status: 'paid', startTime: '2026-10-01 10:00', endTime: '2026-10-01 11:00' },
      ...Array.from({ length: 2 }, (_, index) => ({
        _id: `active_${index + 1}`,
        staffOpenid: 'openid_staff',
        status: 'assigned',
        startTime: `2026-10-0${index + 2} 10:00`,
        endTime: `2026-10-0${index + 2} 11:00`
      }))
    ]
  })
  const { assignOrderAtomically } = createAssignmentService(db)
  await assert.rejects(
    () => assignOrderAtomically('target_order', db.state.orders[0], {
      staffUserId: 'u_staff',
      staffOpenid: 'openid_staff',
      staffProfileId: 'sp_1',
      status: 'assigned'
    }, { enforceAcceptLimits: true, dispatchConfig: { maxStaffActiveOrders: 2, maxStaffDailyOrders: 6 } }),
    /进行中订单已有 2 笔/
  )
  assert.equal(db.state.orders.find(o => o._id === 'target_order').staffOpenid, undefined)
})

test('assignOrderAtomically: 事务内重校验疫苗偏好', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_staff', openid: 'openid_staff_vaccine', status: 'active', roles: ['staff'] }],
    staff_profiles: [{ _id: 'sp_1', openid: 'openid_staff_vaccine', auditStatus: 'approved', rejectUnvaccinatedPets: true }],
    orders: [{ _id: 'target_order', status: 'paid', startTime: '2026-10-01 10:00', endTime: '2026-10-01 11:00' }]
  })
  const { assignOrderAtomically } = createAssignmentService(db, {
    attachOrderDisplayData: async (order) => ({ ...order, petVaccineSummary: { hasUnapprovedPets: true } }),
    assertStaffCanAcceptOrderVaccines: (profile, order) => {
      if (profile.rejectUnvaccinatedPets && order.petVaccineSummary && order.petVaccineSummary.hasUnapprovedPets) {
        throw new Error('宠托师设置不服务未接种疫苗的宠物')
      }
    }
  })
  await assert.rejects(
    () => assignOrderAtomically('target_order', db.state.orders[0], {
      staffUserId: 'u_staff',
      staffOpenid: 'openid_staff_vaccine',
      staffProfileId: 'sp_1',
      status: 'assigned'
    }, { enforceAcceptLimits: true, dispatchConfig: { maxStaffActiveOrders: 8, maxStaffDailyOrders: 6 } }),
    /不服务未接种疫苗/
  )
  assert.equal(db.state.orders[0].staffOpenid, undefined)
})
