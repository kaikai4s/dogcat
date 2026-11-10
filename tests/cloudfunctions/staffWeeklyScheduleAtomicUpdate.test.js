const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('staff profile weeklySchedule atomic update when database has null weeklySchedule', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_staff1', openid: 'staff1', roles: ['staff'], status: 'active' }],
    staff_profiles: [{
      _id: 'sp1',
      openid: 'staff1',
      userId: 'u_staff1',
      auditStatus: 'approved',
      weeklySchedule: null,
      serviceAddress: '原服务地址',
      serviceLatitude: 30.6,
      serviceLongitude: 104.0,
      serviceRadiusKm: 5
    }]
  }, { cloudObjectUpdates: true })

  const api = loadCloudFunction('api', db, 'staff1')

  // 1. 从个人中心更新接单配置（包含添加的时间段），原 weeklySchedule: null 应原子替换成功
  const updateRes = await api.main({
    module: 'staff',
    action: 'updateStaffProfileConfig',
    data: {
      serviceAddress: '原服务地址',
      serviceLatitude: 30.6,
      serviceLongitude: 104.0,
      serviceRadiusKm: 5,
      rejectUnvaccinatedPets: true,
      weeklySchedule: {
        '1': [{ start: 19, end: 23 }]
      }
    }
  })

  assert.equal(updateRes.ok, true, updateRes.message)
  assert.deepEqual(db.state.staff_profiles[0].weeklySchedule['1'], [{ start: 19, end: 23 }])
  assert.equal(updateRes.data.weeklyScheduleText, '周一 19:00-23:00')
  assert.equal(updateRes.data.vaccineServicePolicyText, '仅服务已接种认证宠物')

  // 2. 验证 getStaffProfile 也返回正确的 weeklyScheduleText 与 vaccineServicePolicyText
  const profileRes = await api.main({
    module: 'staff',
    action: 'getStaffProfile'
  })
  assert.equal(profileRes.ok, true, profileRes.message)
  assert.equal(profileRes.data.weeklyScheduleText, '周一 19:00-23:00')
  assert.equal(profileRes.data.vaccineServicePolicyText, '仅服务已接种认证宠物')

  // 3. 从排班日历仅更新 weeklySchedule
  const scheduleOnlyRes = await api.main({
    module: 'staff',
    action: 'updateStaffProfileConfig',
    data: {
      weeklySchedule: {
        '1': [{ start: 9, end: 12 }],
        '2': [{ start: 14, end: 18 }]
      }
    }
  })

  assert.equal(scheduleOnlyRes.ok, true, scheduleOnlyRes.message)
  assert.deepEqual(db.state.staff_profiles[0].weeklySchedule['1'], [{ start: 9, end: 12 }])
  assert.deepEqual(db.state.staff_profiles[0].weeklySchedule['2'], [{ start: 14, end: 18 }])
  assert.equal(scheduleOnlyRes.data.weeklyScheduleText, '周一 09:00-12:00；周二 14:00-18:00')

  // 4. 清空所有排班时，变为 null，并能安全再次更新
  const clearRes = await api.main({
    module: 'staff',
    action: 'updateStaffProfileConfig',
    data: {
      weeklySchedule: { '1': [], '2': [], '3': [], '4': [], '5': [], '6': [], '7': [] }
    }
  })
  assert.equal(clearRes.ok, true, clearRes.message)
  assert.equal(db.state.staff_profiles[0].weeklySchedule, null)
  assert.equal(clearRes.data.weeklyScheduleText, '全天可预约')

  // 5. 当已是 null 时，仅修改服务半径，不传 weeklySchedule，不会触发写错误
  const radiusRes = await api.main({
    module: 'staff',
    action: 'updateStaffProfileConfig',
    data: {
      serviceAddress: '原服务地址',
      serviceLatitude: 30.6,
      serviceLongitude: 104.0,
      serviceRadiusKm: 8
    }
  })
  assert.equal(radiusRes.ok, true, radiusRes.message)
  assert.equal(db.state.staff_profiles[0].serviceRadiusKm, 8)
  assert.equal(db.state.staff_profiles[0].weeklySchedule, null)
  assert.equal(radiusRes.data.weeklyScheduleText, '全天可预约')
})
