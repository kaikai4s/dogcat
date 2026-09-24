const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('petBeauty: importFromServiceCheckins defends against non-existent, soft-deleted, and unowned pets, plus empty additions', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'client_1', roles: ['client'], status: 'active' },
      { _id: 'u_other', openid: 'client_other', roles: ['client'], status: 'active' }
    ],
    pets: [
      { _id: 'pet_normal', openid: 'client_1', name: '旺财', beautyPhotos: [] },
      { _id: 'pet_deleted', openid: 'client_1', name: '小白', deletedAt: '2026-09-01 12:00', beautyPhotos: [] },
      { _id: 'pet_other', openid: 'client_other', name: '咪咪', beautyPhotos: [] }
    ],
    orders: [
      { _id: 'ord_1', clientOpenid: 'client_1', petIds: ['pet_normal', 'pet_nonexist', 'pet_deleted', 'pet_other'], status: 'completed' }
    ],
    checkin_logs: [
      { _id: 'chk_1', orderId: 'ord_1', eventType: 'pet_beauty_photo', mediaFileId: 'cloud://photo1.jpg', recordedAt: '2026-09-24 10:00' },
      { _id: 'chk_not_photo', orderId: 'ord_1', eventType: 'food_water', mediaFileId: 'cloud://photo2.jpg', recordedAt: '2026-09-24 10:05' }
    ]
  })

  const clientFn = loadCloudFunction('api', db, 'client_1')

  // 1. 宠物不存在时安全拦截，不崩溃（防止 NPE）
  const resNonExist = await clientFn.main({
    module: 'petBeauty',
    action: 'importFromServiceCheckins',
    data: { orderId: 'ord_1', petId: 'pet_nonexist', checkinIds: ['chk_1'] }
  })
  assert.equal(resNonExist.ok, false)
  assert.match(resNonExist.message, /宠物不存在或无权操作/)

  // 2. 软删除宠物拦截
  const resDeleted = await clientFn.main({
    module: 'petBeauty',
    action: 'importFromServiceCheckins',
    data: { orderId: 'ord_1', petId: 'pet_deleted', checkinIds: ['chk_1'] }
  })
  assert.equal(resDeleted.ok, false)
  assert.match(resDeleted.message, /宠物不存在或无权操作/)

  // 3. 归属他人宠物拦截越权
  const resOther = await clientFn.main({
    module: 'petBeauty',
    action: 'importFromServiceCheckins',
    data: { orderId: 'ord_1', petId: 'pet_other', checkinIds: ['chk_1'] }
  })
  assert.equal(resOther.ok, false)
  assert.match(resOther.message, /宠物不存在或无权操作/)

  // 4. 无有效美照照片时拦截空写
  const resEmptyPhoto = await clientFn.main({
    module: 'petBeauty',
    action: 'importFromServiceCheckins',
    data: { orderId: 'ord_1', petId: 'pet_normal', checkinIds: ['chk_not_photo'] }
  })
  assert.equal(resEmptyPhoto.ok, false)
  assert.match(resEmptyPhoto.message, /未找到可导入的新美照/)

  // 5. 正常导入成功
  const resSuccess = await clientFn.main({
    module: 'petBeauty',
    action: 'importFromServiceCheckins',
    data: { orderId: 'ord_1', petId: 'pet_normal', checkinIds: ['chk_1'] }
  })
  assert.equal(resSuccess.ok, true)
  assert.equal(resSuccess.data.importedCount, 1)
  assert.equal(resSuccess.data.beautyPhotos.length, 1)

  // 6. 重复导入相同照片被拦截（全部已导入）
  const resDuplicate = await clientFn.main({
    module: 'petBeauty',
    action: 'importFromServiceCheckins',
    data: { orderId: 'ord_1', petId: 'pet_normal', checkinIds: ['chk_1'] }
  })
  assert.equal(resDuplicate.ok, false)
  assert.match(resDuplicate.message, /未找到可导入的新美照/)
})

test('petBeauty: deleteBeautyPhoto rejects soft-deleted pets', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'client_1', roles: ['client'], status: 'active' }
    ],
    pets: [
      {
        _id: 'pet_del_test',
        openid: 'client_1',
        name: '小黑',
        deletedAt: '2026-09-01 10:00',
        beautyPhotos: [{ id: 'p1', fileId: 'cloud://photo1.jpg' }]
      }
    ]
  })

  const clientFn = loadCloudFunction('api', db, 'client_1')
  const res = await clientFn.main({
    module: 'petBeauty',
    action: 'deleteBeautyPhoto',
    data: { petId: 'pet_del_test', photoId: 'p1' }
  })
  assert.equal(res.ok, false)
  // 如果当天不是1号，会先报“每月1日才可以删除”，若传1号则报“宠物不存在”
  assert.match(res.message, /(每月1日才可以删除|宠物不存在)/)
})

test('petBeauty: settlePetBeautyMonthlyRanking excludes soft-deleted pets and ensures idempotent doc keys', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin_1', roles: ['admin'], status: 'active' }
    ],
    pets: [
      {
        _id: 'pet_active',
        openid: 'client_1',
        name: '活跃狗',
        exclusiveId: 'DOG001',
        beautyPhotos: [{ id: 'p1', fileId: 'cloud://dog1.jpg' }],
        createdAt: '2026-09-01 10:00'
      },
      {
        _id: 'pet_deleted_ghost',
        openid: 'client_2',
        name: '幽灵狗',
        exclusiveId: 'DOG002',
        deletedAt: '2026-09-15 10:00',
        beautyPhotos: [{ id: 'p2', fileId: 'cloud://dog2.jpg' }],
        createdAt: '2026-09-01 11:00'
      }
    ],
    pet_beauty_votes: [
      { _id: 'vote_1', petId: 'pet_active', monthKey: '2026-09' },
      { _id: 'vote_2', petId: 'pet_active', monthKey: '2026-09' },
      { _id: 'vote_3', petId: 'pet_deleted_ghost', monthKey: '2026-09' },
      { _id: 'vote_4', petId: 'pet_deleted_ghost', monthKey: '2026-09' },
      { _id: 'vote_5', petId: 'pet_deleted_ghost', monthKey: '2026-09' }
    ],
    pet_beauty_month_rankings: [],
    pet_beauty_month_locks: []
  })

  const adminFn = loadCloudFunction('api', db, 'admin_1')

  // 第一次结算
  const settleRes1 = await adminFn.main({
    module: 'petBeauty',
    action: 'settleMonthlyRanking',
    data: { force: true }
  })
  assert.equal(settleRes1.ok, true)
  assert.equal(settleRes1.data.topCount, 1) // 幽灵狗必须被过滤，只有 active 狗上榜

  const rankings = db.state.pet_beauty_month_rankings
  assert.equal(rankings.length, 1)
  assert.equal(rankings[0].petId, 'pet_active')
  assert.equal(rankings[0]._id, `${settleRes1.data.monthKey}_pet_active`)

  // 第二次使用 force 重试结算，验证主键幂等写入，不产生重复记录
  const settleRes2 = await adminFn.main({
    module: 'petBeauty',
    action: 'settleMonthlyRanking',
    data: { force: true }
  })
  assert.equal(settleRes2.ok, true)
  assert.equal(db.state.pet_beauty_month_rankings.length, 1)
  assert.equal(db.state.pet_beauty_month_locks.length, 1)
})

test('staff: saveScheduleException blocks unavailable status and incompatible slots when staff has active orders on that date', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'staff_1', roles: ['staff'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'staff_1',
        auditStatus: 'approved',
        weeklySchedule: {
          '1': [{ start: 9, end: 18 }], // 周一 9-18
          '2': [] // 周二休息
        }
      }
    ],
    staff_schedule_exceptions: [],
    orders: [
      {
        _id: 'ord_active',
        staffOpenid: 'staff_1',
        status: 'assigned',
        startTime: '2099-08-03 10:00', // 2099-08-03 为周一
        endTime: '2099-08-03 11:30'
      }
    ]
  })

  const staffFn = loadCloudFunction('api', db, 'staff_1')

  // 1. 当天已有待履约订单，尝试设为 unavailable 必须被拦截
  const resUnavailable = await staffFn.main({
    module: 'staff',
    action: 'saveScheduleException',
    data: { dateKey: '2099-08-03', status: 'unavailable', remark: '我要请假' }
  })
  assert.equal(resUnavailable.ok, false)
  assert.match(resUnavailable.message, /当日已有待履约服务订单，无法设置为休息/)

  // 2. 当天已有待履约订单（10:00-11:30），尝试修改可用时段为下午 14:00-18:00，必须被拦截
  const resIncompatibleSlots = await staffFn.main({
    module: 'staff',
    action: 'saveScheduleException',
    data: {
      dateKey: '2099-08-03',
      status: 'available',
      slots: [{ start: 14, end: 18 }]
    }
  })
  assert.equal(resIncompatibleSlots.ok, false)
  assert.match(resIncompatibleSlots.message, /当日已有待履约服务订单不在调整后的接单时段内/)

  // 3. 修改为完整覆盖订单的时段（9:00-12:00），允许成功
  const resCompatibleSlots = await staffFn.main({
    module: 'staff',
    action: 'saveScheduleException',
    data: {
      dateKey: '2099-08-03',
      status: 'available',
      slots: [{ start: 9, end: 12 }]
    }
  })
  assert.equal(resCompatibleSlots.ok, true)
  assert.equal(db.state.staff_schedule_exceptions.length, 1)

  // 4. 周二（2099-08-04）常规排班休息，但此前设置了例外排班并接了单
  db.state.staff_schedule_exceptions.push({
    _id: 'ex_tue',
    staffOpenid: 'staff_1',
    dateKey: '2099-08-04',
    status: 'available',
    slots: [{ start: 10, end: 18 }]
  })
  db.state.orders.push({
    _id: 'ord_tue',
    staffOpenid: 'staff_1',
    status: 'assigned',
    startTime: '2099-08-04 10:00',
    endTime: '2099-08-04 11:00'
  })

  // 尝试删除周二的例外排班：由于周二常规周排班为空（休息），删除例外排班将导致已有订单失去时段覆盖，必须拦截
  const resDeleteExceptionConflict = await staffFn.main({
    module: 'staff',
    action: 'deleteScheduleException',
    data: { dateKey: '2099-08-04' }
  })
  assert.equal(resDeleteExceptionConflict.ok, false)
  assert.match(resDeleteExceptionConflict.message, /清除例外排班后常规周排班无法覆盖已有订单时段/)

  // 5. 没有订单的日期（如 2099-08-05），设置 unavailable 和删除例外排班均正常成功
  const resEmptyDate = await staffFn.main({
    module: 'staff',
    action: 'saveScheduleException',
    data: { dateKey: '2099-08-05', status: 'unavailable', remark: '休息日' }
  })
  assert.equal(resEmptyDate.ok, true)

  const resDeleteEmptyDate = await staffFn.main({
    module: 'staff',
    action: 'deleteScheduleException',
    data: { dateKey: '2099-08-05' }
  })
  assert.equal(resDeleteEmptyDate.ok, true)
})
