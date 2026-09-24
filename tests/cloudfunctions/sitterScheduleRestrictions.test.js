const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('sitter schedule restrictions: bookableUntilDate and unavailable exceptions prevent bookings', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'staff_1', roles: ['staff'], phone: '13800000001', status: 'active' },
      { _id: 'u_client', openid: 'client_1', roles: ['client'], phone: '13900000002', status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'staff_1',
        realName: '张宠托',
        gender: 'male',
        auditStatus: 'approved',
        serviceAddress: '测试市中区',
        serviceLatitude: 30.65,
        serviceLongitude: 104.06,
        serviceRadiusKm: 20,
        weeklySchedule: {
          '1': [{ start: 9, end: 18 }],
          '2': [{ start: 9, end: 18 }],
          '3': [{ start: 9, end: 18 }],
          '4': [{ start: 9, end: 18 }],
          '5': [{ start: 9, end: 18 }],
          '6': [{ start: 9, end: 18 }],
          '7': [{ start: 9, end: 18 }]
        }
      }
    ],
    pets: [
      { _id: 'pet_1', openid: 'client_1', name: '大黄', species: 'dog' }
    ],
    staff_schedule_exceptions: [],
    orders: []
  })

  const staffFn = loadCloudFunction('api', db, 'staff_1')
  const clientFn = loadCloudFunction('api', db, 'client_1')

  // 1. 宠托师设置接单截止日期为 2026-10-15
  const updateRes = await staffFn.main({
    module: 'staff',
    action: 'updateStaffProfileConfig',
    data: {
      bookableUntilDate: '2026-10-15'
    }
  })
  assert.equal(updateRes.ok, true)
  assert.equal(updateRes.data.bookableUntilDate, '2026-10-15')

  // 2. 宠托师读取排班日历 getScheduleCalendar，验证截止日期返回
  const calRes = await staffFn.main({
    module: 'staff',
    action: 'getScheduleCalendar',
    data: { startDate: '2026-10-10', days: 10 }
  })
  assert.equal(calRes.ok, true)
  assert.equal(calRes.data.bookableUntilDate, '2026-10-15')
  // 2026-10-16 处于截止日期之后，status 应自动标记为 unavailable
  const day16 = calRes.data.availability.find((item) => item.dateKey === '2026-10-16')
  assert.ok(day16, 'availability should contain 2026-10-16')
  assert.equal(day16.status, 'unavailable')
  assert.match(day16.remark, /接单截止至 2026-10-15/)

  // 3. 客户定向预约试算 quoteOrder
  // 3.1 预约 2026-10-12 (在截止日期内，且在接单时段 09:00-18:00 内) -> 允许通过
  const quoteGood = await clientFn.main({
    module: 'order',
    action: 'quoteOrder',
    data: {
      publishMode: 'direct',
      staffProfileId: 'sp_1',
      petIds: ['pet_1'],
      serviceTypes: ['visit_fee', 'walk'],
      startDate: '2026-10-12',
      startClock: '10:00',
      durationMinutes: 60,
      serviceAddress: '测试市中区某小区',
      addressLatitude: 30.65,
      addressLongitude: 104.06,
      startTime: '2026-10-12 10:00',
      endTime: '2026-10-12 11:00'
    }
  })
  assert.equal(quoteGood.ok, true, 'Booking within bookableUntilDate should succeed')

  // 3.2 预约 2026-10-18 (超出截止日期 2026-10-15) -> 拦截报错
  const quoteBeyond = await clientFn.main({
    module: 'order',
    action: 'quoteOrder',
    data: {
      publishMode: 'direct',
      staffProfileId: 'sp_1',
      petIds: ['pet_1'],
      serviceTypes: ['visit_fee', 'walk'],
      startDate: '2026-10-18',
      startClock: '10:00',
      durationMinutes: 60,
      serviceAddress: '测试市中区某小区',
      addressLatitude: 30.65,
      addressLongitude: 104.06,
      startTime: '2026-10-18 10:00',
      endTime: '2026-10-18 11:00'
    }
  })
  assert.equal(quoteBeyond.ok, false)
  assert.match(quoteBeyond.message, /暂未开放 2026-10-15 之后的预约服务/)

  // 4. 宠托师将 2026-10-10 设置为休息不接单 (saveScheduleException unavailable)
  const restRes = await staffFn.main({
    module: 'staff',
    action: 'saveScheduleException',
    data: {
      dateKey: '2026-10-10',
      status: 'unavailable',
      remark: '家中有事休假'
    }
  })
  assert.equal(restRes.ok, true)

  // 4.1 客户预约 2026-10-10 休息日 -> 拦截报错
  const quoteRestDay = await clientFn.main({
    module: 'order',
    action: 'quoteOrder',
    data: {
      publishMode: 'direct',
      staffProfileId: 'sp_1',
      petIds: ['pet_1'],
      serviceTypes: ['visit_fee', 'walk'],
      startDate: '2026-10-10',
      startClock: '10:00',
      durationMinutes: 60,
      serviceAddress: '测试市中区某小区',
      addressLatitude: 30.65,
      addressLongitude: 104.06,
      startTime: '2026-10-10 10:00',
      endTime: '2026-10-10 11:00'
    }
  })
  assert.equal(quoteRestDay.ok, false)
  assert.match(quoteRestDay.message, /当天设置为休息，无法预约/)

  // 5. 宠托师恢复 2026-10-10 接单 (deleteScheduleException)
  const delRestRes = await staffFn.main({
    module: 'staff',
    action: 'deleteScheduleException',
    data: {
      dateKey: '2026-10-10'
    }
  })
  assert.equal(delRestRes.ok, true)

  // 5.1 恢复接单后再次预约 2026-10-10 -> 允许通过
  const quoteRestored = await clientFn.main({
    module: 'order',
    action: 'quoteOrder',
    data: {
      publishMode: 'direct',
      staffProfileId: 'sp_1',
      petIds: ['pet_1'],
      serviceTypes: ['visit_fee', 'walk'],
      startDate: '2026-10-10',
      startClock: '10:00',
      durationMinutes: 60,
      serviceAddress: '测试市中区某小区',
      addressLatitude: 30.65,
      addressLongitude: 104.06,
      startTime: '2026-10-10 10:00',
      endTime: '2026-10-10 11:00'
    }
  })
  assert.equal(quoteRestored.ok, true, 'Booking after deleting exception should succeed')

  // 6. 宠托师清除截止日期（恢复不限截止）
  const clearUntilRes = await staffFn.main({
    module: 'staff',
    action: 'updateStaffProfileConfig',
    data: {
      bookableUntilDate: ''
    }
  })
  assert.equal(clearUntilRes.ok, true)
  assert.equal(clearUntilRes.data.bookableUntilDate, '')

  // 6.1 预约原本超出截止日期的 2026-10-18 -> 此时允许通过
  const quoteAfterClearUntil = await clientFn.main({
    module: 'order',
    action: 'quoteOrder',
    data: {
      publishMode: 'direct',
      staffProfileId: 'sp_1',
      petIds: ['pet_1'],
      serviceTypes: ['visit_fee', 'walk'],
      startDate: '2026-10-18',
      startClock: '10:00',
      durationMinutes: 60,
      serviceAddress: '测试市中区某小区',
      addressLatitude: 30.65,
      addressLongitude: 104.06,
      startTime: '2026-10-18 10:00',
      endTime: '2026-10-18 11:00'
    }
  })
  assert.equal(quoteAfterClearUntil.ok, true, 'Booking after clearing bookableUntilDate should succeed')
})
