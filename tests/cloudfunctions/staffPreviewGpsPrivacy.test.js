const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const createContext = require('../../cloudfunctions/api/services/context')

test('preview area coordinates are stable, coarse, bounded and do not modify stored coordinates', () => {
  const context = createContext({ db: createStaffPrivacyDb(), cloud: {} })
  const order = { addressLatitude: 31.213456, addressLongitude: 121.523456, addressDetail: '101室' }
  const preview = context.maskOrderForStaffPreview(order)
  assert.equal(preview.addressLatitude, 31.21)
  assert.equal(preview.addressLongitude, 121.52)
  assert.equal(preview.locationIsApproximate, true)
  assert.equal(preview.addressDetail, '接单后可见')
  assert.equal(preview.serviceLatitude, null)
  assert.equal(preview.latitude, null)
  assert.deepEqual(context.maskOrderForStaffPreview(order), preview)
  const sameArea = context.maskOrderForStaffPreview({ addressLatitude: 31.2139, addressLongitude: 121.5239 })
  assert.equal(sameArea.addressLatitude, preview.addressLatitude)
  assert.equal(sameArea.addressLongitude, preview.addressLongitude)
  assert.equal(order.addressLatitude, 31.213456)
  assert.equal(order.addressDetail, '101室')
  for (const latitude of [null, undefined, '', 'bad', 0, 91, Infinity]) {
    const invalid = context.maskOrderForStaffPreview({ addressLatitude: latitude, addressLongitude: 121 })
    assert.equal(invalid.addressLatitude, null)
    assert.equal(invalid.addressLongitude, null)
    assert.equal(invalid.locationIsApproximate, false)
  }
})

function loadStaffHome() {
  let page
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/staff/home/index.js'), 'utf8'), {
    require: () => ({}), Page(config) { page = config }
  })
  page.data.selectedCity = '上海市'
  return page
}

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

test('staff order preview privacy: listNearbyOrders returns coarse GPS coordinates while preserving distanceText', async () => {
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
  assert.equal(previewOrder.inRange, true)

  // 页面消费真实脱敏响应时，必须保留距离和范围，开启范围筛选也不能误删订单。
  const home = loadStaffHome()
  home.data.inServiceRange = true
  const visibleOrders = home.normalizeNearbyOrders(nearbyRes.data, { latitude: 31.2, longitude: 121.5 })
  assert.equal(visibleOrders.length, 1)
  assert.equal(visibleOrders[0].inRange, true)
  assert.equal(visibleOrders[0].distanceKm, previewOrder.distanceKm)
  assert.equal(visibleOrders[0].distanceText, previewOrder.distanceText)
  assert.equal(visibleOrders[0].addressLatitude, previewOrder.addressLatitude)

  // 核心安全验证：尚未接单前，客户的家庭经纬度必须被量化为区域坐标
  assert.equal(previewOrder.addressLatitude, Number((31.215).toFixed(2)))
  assert.equal(previewOrder.locationIsApproximate, true)
  assert.equal(previewOrder.addressLongitude, 121.52)
  assert.equal(previewOrder.addressDetail, '接单后可见', 'addressDetail must remain masked')
  assert.equal(previewOrder.doorplate, '接单后可见', 'doorplate must remain masked')

  // 2. 员工在接单前预览订单详情（getOrderDetail preview 状态）
  const detailPreviewRes = await staffFn.main({
    module: 'order',
    action: 'getOrderDetail',
    data: { id: 'ord_open_pool', role: 'staff' }
  })
  assert.equal(detailPreviewRes.ok, true)
  assert.equal(detailPreviewRes.data.addressLatitude, previewOrder.addressLatitude)
  assert.equal(detailPreviewRes.data.addressLongitude, previewOrder.addressLongitude)
  assert.equal(detailPreviewRes.data.locationIsApproximate, true)
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
  assert.notEqual(acceptedDetailRes.data.locationIsApproximate, true)
  assert.equal(acceptedDetailRes.data.addressLatitude, 31.215000, 'Real latitude must be visible after accepted')
  assert.equal(acceptedDetailRes.data.addressLongitude, 121.520000, 'Real longitude must be visible after accepted')
  assert.equal(acceptedDetailRes.data.addressDetail, '8栋2单元1602室', 'Real address must be visible after accepted')
  assert.equal(acceptedDetailRes.data.doorplate, '1602')
})

test('staff range flags follow each refreshed server response and still exclude genuinely distant orders', async () => {
  const staffFn = loadCloudFunction('api', createStaffPrivacyDb(), 'openid_staff')
  const home = loadStaffHome()
  for (const [location, expectedInRange] of [
    [{ latitude: 31.2, longitude: 121.5 }, true],
    [{ latitude: 30.8, longitude: 121.0 }, false],
    [{ latitude: 31.2, longitude: 121.5 }, true]
  ]) {
    const response = await staffFn.main({ module: 'staff', action: 'listNearbyOrders', data: location })
    assert.equal(response.ok, true)
    home.data.inServiceRange = false
    const visible = home.normalizeNearbyOrders(response.data, location)
    assert.equal(visible.length, 1)
    assert.equal(visible[0].inRange, expectedInRange)
    assert.equal(visible[0].distanceText, response.data[0].distanceText)
    assert.equal(visible[0].locationIsApproximate, true)
    home.data.inServiceRange = true
    assert.equal(home.normalizeNearbyOrders(response.data, location).length, expectedInRange ? 1 : 0)
  }
})

test('staff preview without a range verdict or distance remains unknown instead of claiming out of range', () => {
  const home = loadStaffHome()
  const orders = home.normalizeNearbyOrders([{ _id: 'unknown', addressLatitude: null, addressLongitude: null }], { latitude: 31.2, longitude: 121.5 })
  assert.equal(orders[0].inRange, null)
})
