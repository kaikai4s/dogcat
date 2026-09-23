const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createStaffPrivacyDb() {
  return createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', phone: '13800000001', nickname: '隐私客户' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active', phone: '13900000002', nickname: '接单托师' }
    ],
    staff_profiles: [
      {
        _id: 'sp_staff',
        openid: 'openid_staff',
        realName: '李托师',
        auditStatus: 'approved',
        staffLevel: 'certified',
        status: 'active',
        serviceCity: '上海市',
        serviceAddress: '上海市徐汇区',
        serviceLatitude: 31.200000,
        serviceLongitude: 121.500000,
        currentLatitude: 31.200000,
        currentLongitude: 121.500000
      }
    ],
    orders: [
      {
        _id: 'ord_open_pool',
        orderNo: 'MO202609230001',
        clientOpenid: 'openid_client',
        clientUserId: 'u_client',
        staffOpenid: '',
        publishMode: 'open',
        status: 'paid',
        paymentStatus: 'paid',
        serviceSummary: '上门遛狗 60分钟',
        petName: '多多',
        city: '上海市',
        serviceAddress: '保利国际社区',
        addressDetail: '8栋2单元1602室',
        doorplate: '1602',
        addressLatitude: 31.215000,
        addressLongitude: 121.520000,
        startTime: '2099-09-24 10:00',
        endTime: '2099-09-24 11:00',
        amount: 80,
        payAmount: 80,
        requiredCheckins: []
      }
    ],
    platform_configs: [
      {
        _id: 'cfg1',
        key: 'system_settings',
        value: {
          staffDeposit: { minDepositAmount: 0 },
          homePage: { ctaTitle: '预约' }
        }
      }
    ],
    order_timeline: []
  })
}

test('staff order preview privacy: listNearbyOrders masks GPS coordinates while preserving distanceText', async () => {
  const db = createStaffPrivacyDb()
  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  // 1. 员工在抢单大厅查看附近可接订单
  const nearbyRes = await staffFn.main({
    module: 'staff',
    action: 'listNearbyOrders',
    data: {
      latitude: 31.200000,
      longitude: 121.500000
    }
  })

  assert.equal(nearbyRes.ok, true)
  assert.equal(nearbyRes.data.length, 1)

  const previewOrder = nearbyRes.data[0]
  // 验证距离已在服务端正确计算并返回
  assert.ok(previewOrder.distanceText, 'distanceText must be calculated and returned')
  assert.ok(previewOrder.distanceKm > 0, 'distanceKm must be computed')

  // 核心安全验证：尚未接单前，客户的精确家庭经纬度必须被严格脱敏清空
  assert.equal(previewOrder.addressLatitude, null, 'addressLatitude must be masked to null in staff preview')
  assert.equal(previewOrder.addressLongitude, null, 'addressLongitude must be masked to null in staff preview')
  assert.equal(previewOrder.addressDetail, '接单后可见', 'addressDetail must remain masked')
  assert.equal(previewOrder.doorplate, '接单后可见', 'doorplate must remain masked')

  // 2. 员工在接单前预览订单详情（getOrderDetail preview 状态）
  const detailPreviewRes = await staffFn.main({
    module: 'order',
    action: 'getOrderDetail',
    data: { id: 'ord_open_pool', role: 'staff' }
  })
  assert.equal(detailPreviewRes.ok, true)
  assert.equal(detailPreviewRes.data.addressLatitude, null, 'Detail preview must mask addressLatitude')
  assert.equal(detailPreviewRes.data.addressLongitude, null, 'Detail preview must mask addressLongitude')
  assert.equal(detailPreviewRes.data.addressDetail, '接单后可见')

  // 3. 员工确认接单
  const acceptRes = await staffFn.main({
    module: 'staff',
    action: 'acceptOrder',
    data: { orderId: 'ord_open_pool' }
  })
  assert.equal(acceptRes.ok, true)

  // 4. 接单成功成为正式履约人后，查看订单详情能够获取真实地址与经纬度供上门导航
  const acceptedDetailRes = await staffFn.main({
    module: 'order',
    action: 'getOrderDetail',
    data: { id: 'ord_open_pool', role: 'staff' }
  })
  assert.equal(acceptedDetailRes.ok, true)
  assert.equal(acceptedDetailRes.data.addressLatitude, 31.215000, 'Real latitude must be visible after accepted')
  assert.equal(acceptedDetailRes.data.addressLongitude, 121.520000, 'Real longitude must be visible after accepted')
  assert.equal(acceptedDetailRes.data.addressDetail, '8栋2单元1602室', 'Real address must be visible after accepted')
  assert.equal(acceptedDetailRes.data.doorplate, '1602')
})
