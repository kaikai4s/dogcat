const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createTestDb() {
  return createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', nickname: '系统管理员', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', nickname: '客户小王', phone: '13800001234', roles: ['client'], status: 'active' }
    ],
    coupon_templates: [
      {
        _id: 'tmpl_in_lottery',
        name: '新人立减20元券',
        discountAmount: 20,
        minOrderAmount: 80,
        validType: 'relative_days',
        validDays: 30,
        usageScope: 'service',
        enabled: true,
        issuedCount: 5,
        sortOrder: 10
      },
      {
        _id: 'tmpl_standalone',
        name: '全场满100减30券',
        discountAmount: 30,
        minOrderAmount: 100,
        validType: 'relative_days',
        validDays: 15,
        usageScope: 'all',
        enabled: true,
        issuedCount: 2,
        sortOrder: 20
      }
    ],
    lottery_activities: [
      {
        _id: 'lottery_mid_autumn',
        name: '中秋宠粉大转盘',
        description: '每日抽奖一次',
        enabled: true,
        prizes: [
          { templateId: 'tmpl_in_lottery', name: '新人立减20元券', probability: 50, stockLeft: 100 },
          { templateId: '', name: '谢谢参与', probability: 50, stockLeft: 9999 }
        ],
        createdAt: '2026-09-10 10:00:00'
      }
    ],
    user_coupons: [
      {
        _id: 'uc_client_1',
        openid: 'openid_client',
        userId: 'u_client',
        templateId: 'tmpl_in_lottery',
        templateSnapshot: {
          templateId: 'tmpl_in_lottery',
          name: '新人立减20元券',
          discountAmount: 20,
          minOrderAmount: 80,
          validType: 'relative_days',
          validDays: 30,
          usageScope: 'service',
          usageScopeText: '服务券'
        },
        status: 'available',
        validFrom: '2026-09-10 10:00:00',
        validTo: '2026-10-10 10:00:00'
      },
      {
        _id: 'uc_client_2',
        openid: 'openid_client',
        userId: 'u_client',
        templateId: 'tmpl_standalone',
        templateSnapshot: {
          templateId: 'tmpl_standalone',
          name: '全场满100减30券',
          discountAmount: 30,
          minOrderAmount: 100,
          validType: 'relative_days',
          validDays: 15,
          usageScope: 'all',
          usageScopeText: '通用券'
        },
        status: 'available',
        validFrom: '2026-09-15 10:00:00',
        validTo: '2026-09-30 10:00:00'
      }
    ],
    lottery_records: [
      {
        _id: 'rec_1',
        openid: 'openid_client',
        activityId: 'lottery_mid_autumn',
        prizeTemplateId: 'tmpl_in_lottery',
        prizeName: '新人立减20元券',
        createdAt: '2026-09-10 12:00:00'
      }
    ]
  })
}

test('coupon deletion: rejects deleting coupon template when used by lottery activities, requires removal first', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 尝试删除正在被抽奖活动【中秋宠粉大转盘】使用的优惠券 tmpl_in_lottery，应被拦截
  const res1 = await adminFn.main({
    module: 'admin',
    action: 'deleteCouponTemplate',
    data: { _id: 'tmpl_in_lottery' }
  })

  assert.equal(res1.ok, false, 'Must reject deleting coupon used in lottery')
  assert.ok(res1.message.includes('抽奖活动'), 'Error must mention lottery activity')
  assert.ok(res1.message.includes('中秋宠粉大转盘'), 'Error must include specific activity name')
  assert.ok(res1.message.includes('请先前往抽奖活动中移除该奖品后再删除'), 'Error must instruct admin to remove prize first')

  // 验证优惠券模板未被删除
  const tmpl = db.state.coupon_templates.find((t) => t._id === 'tmpl_in_lottery')
  assert.ok(tmpl, 'Template must still exist')

  // 2. 尝试删除未被任何抽奖活动使用的优惠券 tmpl_standalone，应允许成功删除
  const res2 = await adminFn.main({
    module: 'admin',
    action: 'deleteCouponTemplate',
    data: { _id: 'tmpl_standalone' }
  })

  assert.equal(res2.ok, true, 'Standalone coupon must be deleted successfully')
  const standaloneAfter = db.state.coupon_templates.find((t) => t._id === 'tmpl_standalone')
  assert.equal(standaloneAfter, undefined, 'Standalone template must be removed from coupon_templates')

  // 3. 核心保障验证：用户已经领取的优惠券不受影响！
  const clientCoupon = db.state.user_coupons.find((uc) => uc._id === 'uc_client_2')
  assert.ok(clientCoupon, 'User coupon uc_client_2 must still exist')
  assert.equal(clientCoupon.status, 'available', 'User coupon status remains available')
  assert.equal(clientCoupon.templateSnapshot.discountAmount, 30, 'Template snapshot remains intact')

  // 4. 将 tmpl_in_lottery 从抽奖活动奖品中移除后，再次删除该优惠券，应允许成功
  await adminFn.main({
    module: 'admin',
    action: 'saveLotteryActivity',
    data: {
      _id: 'lottery_mid_autumn',
      name: '中秋宠粉大转盘',
      description: '每日抽奖一次',
      prizes: [
        { templateId: '', name: '谢谢参与', probability: 100, stockLeft: 9999 }
      ]
    }
  })

  const res3 = await adminFn.main({
    module: 'admin',
    action: 'deleteCouponTemplate',
    data: { _id: 'tmpl_in_lottery' }
  })

  assert.equal(res3.ok, true, 'Coupon must now be deleted after being removed from lottery')
  const tmplInLotteryAfter = db.state.coupon_templates.find((t) => t._id === 'tmpl_in_lottery')
  assert.equal(tmplInLotteryAfter, undefined, 'Template must be removed')

  // 用户领取的 uc_client_1 依然完好
  const clientCoupon1 = db.state.user_coupons.find((uc) => uc._id === 'uc_client_1')
  assert.ok(clientCoupon1, 'User coupon uc_client_1 remains available and untouched')
})

test('lottery activity deletion: deletes activity successfully while keeping lottery records and user coupons', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 删除抽奖活动
  const res = await adminFn.main({
    module: 'admin',
    action: 'deleteLotteryActivity',
    data: { _id: 'lottery_mid_autumn' }
  })

  assert.equal(res.ok, true, 'deleteLotteryActivity must succeed')
  const activityAfter = db.state.lottery_activities.find((a) => a._id === 'lottery_mid_autumn')
  assert.equal(activityAfter, undefined, 'Activity must be removed from lottery_activities')

  // 2. 抽奖历史记录不受影响
  const record = db.state.lottery_records.find((r) => r._id === 'rec_1')
  assert.ok(record, 'Lottery record must remain untouched')

  // 3. 用户之前抽奖获得的优惠券不受影响
  const clientCoupon = db.state.user_coupons.find((uc) => uc._id === 'uc_client_1')
  assert.ok(clientCoupon, 'User coupon must remain available')
})

test('admin frontend templates have delete buttons and methods bound', () => {
  const couponsWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/coupons/index.wxml'), 'utf8')
  const couponsJs = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/coupons/index.js'), 'utf8')
  const lotteryWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/lottery/index.wxml'), 'utf8')
  const lotteryJs = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/lottery/index.js'), 'utf8')

  // 优惠券页面
  assert.ok(couponsWxml.includes('deleteTemplate'), 'Coupons WXML must bind deleteTemplate')
  assert.ok(couponsJs.includes('deleteCouponTemplate'), 'Coupons JS must call deleteCouponTemplate')
  assert.ok(couponsJs.includes('deleteTemplate('), 'Coupons JS must implement deleteTemplate')

  // 抽奖活动页面
  assert.ok(lotteryWxml.includes('deleteActivity'), 'Lottery WXML must bind deleteActivity')
  assert.ok(lotteryJs.includes('deleteLotteryActivity'), 'Lottery JS must call deleteLotteryActivity')
  assert.ok(lotteryJs.includes('deleteActivity('), 'Lottery JS must implement deleteActivity')
})
