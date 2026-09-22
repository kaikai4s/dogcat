const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const createContext = require('../../cloudfunctions/api/services/context')
const { createCollectionStore } = require('../cloudfunctions/helpers')

test('public-list and public-detail WXML render stars dynamically according to rating value', () => {
  const listWxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/public-list/index.wxml')
  const listWxssPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/public-list/index.wxss')
  const detailWxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/public-detail/index.wxml')
  const detailWxssPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/public-detail/index.wxss')

  const listWxml = fs.readFileSync(listWxmlPath, 'utf8')
  const listWxss = fs.readFileSync(listWxssPath, 'utf8')
  const detailWxml = fs.readFileSync(detailWxmlPath, 'utf8')
  const detailWxss = fs.readFileSync(detailWxssPath, 'utf8')

  // 1. 验证公共评价列表中星星不再写死 ri-star-fill，而是根据 rating 动态选择实心星与线框星
  assert.ok(
    listWxml.includes("item.review.rating >= star ? 'ri-star-fill star-active' : 'ri-star-line star-inactive'"),
    'public-list index.wxml should dynamically evaluate rating for each star'
  )
  assert.ok(!listWxml.includes('<text class="remix-icon ri-star-fill" wx:for="{{[1,2,3,4,5]}}"'), 'public-list should not hardcode ri-star-fill for all 5 stars')

  // 2. 验证 public-list wxss 中定义了 star-active 和 star-inactive
  assert.ok(listWxss.includes('.star-active'), 'public-list wxss should style active stars')
  assert.ok(listWxss.includes('.star-inactive'), 'public-list wxss should style inactive stars')

  // 3. 验证公共订单详情中同样动态渲染
  assert.ok(
    detailWxml.includes("detail.review.rating >= star ? 'ri-star-fill star-active' : 'ri-star-line star-inactive'"),
    'public-detail index.wxml should dynamically evaluate rating for each star'
  )
  assert.ok(!detailWxml.includes('<text class="remix-icon ri-star-fill" wx:for="{{[1,2,3,4,5]}}"'), 'public-detail should not hardcode ri-star-fill')

  // 4. 验证 public-detail wxss 中定义了 star-active 和 star-inactive
  assert.ok(detailWxss.includes('.star-active'), 'public-detail wxss should style active stars')
  assert.ok(detailWxss.includes('.star-inactive'), 'public-detail wxss should style inactive stars')
})

test('client order detail and sitter detail pages dynamically render 5 stars according to rating', () => {
  const orderDetailWxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/detail/index.wxml')
  const orderDetailWxssPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/detail/index.wxss')
  const sitterDetailWxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/sitters/detail/index.wxml')
  const sitterDetailWxssPath = path.resolve(__dirname, '../../miniprogram/pages/client/sitters/detail/index.wxss')

  const orderDetailWxml = fs.readFileSync(orderDetailWxmlPath, 'utf8')
  const orderDetailWxss = fs.readFileSync(orderDetailWxssPath, 'utf8')
  const sitterDetailWxml = fs.readFileSync(sitterDetailWxmlPath, 'utf8')
  const sitterDetailWxss = fs.readFileSync(sitterDetailWxssPath, 'utf8')

  // 1. 验证客户订单详情页包含 5 星动态展示
  assert.ok(
    orderDetailWxml.includes("review.rating >= star ? 'ri-star-fill star-active' : 'ri-star-line star-inactive'"),
    'order detail wxml should dynamically render 5 stars for review'
  )
  assert.ok(orderDetailWxss.includes('.star-active') && orderDetailWxss.includes('.star-inactive'), 'order detail wxss should style star states')

  // 2. 验证宠托师详情页近期评价展示 5 星动态高亮/置灰
  assert.ok(
    sitterDetailWxml.includes("item.rating >= star ? 'ri-star-fill star-icon-active' : 'ri-star-line star-icon-inactive'"),
    'sitter detail wxml should dynamically render 5 stars for review item'
  )
  assert.ok(sitterDetailWxss.includes('.star-icon-active') && sitterDetailWxss.includes('.star-icon-inactive'), 'sitter detail wxss should style star states')
})

test('review page has clear mapping between stars and rating text description', () => {
  const reviewJsPath = path.resolve(__dirname, '../../miniprogram/pages/client/orders/review/index.js')
  const reviewJs = fs.readFileSync(reviewJsPath, 'utf8')

  assert.ok(reviewJs.includes('1分 · 很差'), 'ratingTexts should include 1 point description')
  assert.ok(reviewJs.includes('5分 · 超出预期'), 'ratingTexts should include 5 points description')
})

test('context toHomeOrderActivity correctly formats review rating and text', () => {
  const db = createCollectionStore({})
  const context = createContext({ cloud: {}, db })

  const order = { _id: 'order_r1', orderNo: 'OR12345', serviceType: 'feed', status: 'completed' }
  const review = { rating: 4, content: '宠托师很准时，猫咪照顾得很好！', tags: ['准时到达', '服务细心'] }

  const activity = context.toHomeOrderActivity(order, { review, checkins: [], staffProfile: {} })
  assert.equal(activity.review.rating, 4)
  assert.equal(activity.review.ratingText, '4.0')
  assert.equal(activity.review.content, '宠托师很准时，猫咪照顾得很好！')
})

test('admin order detail wxml does not contain invalid expression like (evidenceImages || []).length', () => {
  const adminOrderDetailWxmlPath = path.resolve(__dirname, '../../miniprogram/pages/admin/orders/detail/index.wxml')
  const content = fs.readFileSync(adminOrderDetailWxmlPath, 'utf8')

  assert.ok(!content.includes(').'), 'WXML must not contain bracket property access like ).')
  assert.ok(content.includes('evidenceImages.length < 4'), 'evidenceImages length condition should be direct')
})

test('admin notifications, member-levels and coupons navigate via navigateTo so left-top displays back arrow instead of home icon', () => {
  const adminDir = path.resolve(__dirname, '../../miniprogram/pages/admin')
  const entries = fs.readdirSync(adminDir, { recursive: true })
  const adminJsFiles = entries
    .filter((file) => typeof file === 'string' && file.endsWith('.js'))
    .map((file) => path.join(adminDir, file))

  assert.ok(adminJsFiles.length > 0, 'should find admin js files')

  for (const file of adminJsFiles) {
    const code = fs.readFileSync(file, 'utf8')
    const match = code.match(/const mainNavUrls = \[(.*?)\]/s)
    if (match) {
      const navStr = match[1]
      assert.ok(
        !navStr.includes("'/pages/admin/notifications/index'"),
        `${file} should not include notifications/index in mainNavUrls`
      )
      assert.ok(
        !navStr.includes("'/pages/admin/member-levels/index'"),
        `${file} should not include member-levels/index in mainNavUrls`
      )
      assert.ok(
        !navStr.includes("'/pages/admin/coupons/index'"),
        `${file} should not include coupons/index in mainNavUrls`
      )
    }
  }
})
