const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('client profile entries converted to icon grid with badges and styling', async () => {
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/profile/index.wxml')
  const wxssPath = path.resolve(__dirname, '../../miniprogram/pages/client/profile/index.wxss')
  const appWxssPath = path.resolve(__dirname, '../../miniprogram/app.wxss')

  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  const wxss = fs.readFileSync(wxssPath, 'utf8')
  const appWxss = fs.readFileSync(appWxssPath, 'utf8')

  // 1. Check WXML sections have profile-grid-panel
  assert.ok(wxml.includes('class="profile-grid-panel cols-4"'), 'should have cols-4 grid panels')
  assert.ok(wxml.includes('class="profile-grid-panel cols-5"'), 'should have cols-5 grid panels')

  // 2. Check all entries are present with expected handlers and icons
  const entries = [
    { label: '编辑资料', handler: 'editProfile', icon: 'ri-user-settings-fill' },
    { label: '我的地址', handler: 'openAddresses', icon: 'ri-map-pin-2-fill' },
    { label: '我的关注', handler: 'openFavorites', icon: 'ri-star-fill' },
    { label: '投诉/售后', handler: 'openIncidents', icon: 'ri-shield-cross-fill' },
    { label: '我的优惠券', handler: 'openCoupons', icon: 'ri-coupon-3-fill' },
    { label: '签到中心', handler: 'openCheckin', icon: 'ri-calendar-check-fill' },
    { label: '奖励邮箱', handler: 'openRewardMails', icon: 'ri-mail-star-fill' },
    { label: '我的积分', handler: 'openPoints', icon: 'ri-coins-fill' },
    { label: '关注公众号', handler: 'openOfficialAccountModal', icon: 'ri-wechat-fill' },
    { label: '客服中心', handler: 'openCustomerService', icon: 'ri-customer-service-2-fill' },
    { label: '意见反馈', handler: 'openFeedbackModal', icon: 'ri-feedback-fill' },
    { label: '设置', handler: 'openSettings', icon: 'ri-settings-3-fill' },
    { label: '退出登录', handler: 'logout', icon: 'ri-logout-box-r-fill' }
  ]

  for (const entry of entries) {
    assert.ok(wxml.includes(entry.label), `WXML must include label "${entry.label}"`)
    assert.ok(wxml.includes(`bindtap="${entry.handler}"`), `WXML must include handler "${entry.handler}"`)
    assert.ok(wxml.includes(entry.icon), `WXML must include icon class "${entry.icon}"`)
  }

  // 3. Check badges support
  assert.ok(wxml.includes('retroCardCount'), 'Checkin center should support retroCardCount badge')
  assert.ok(wxml.includes('rewardMailUnclaimedCount'), 'Reward mail should support unclaimed count badge')
  assert.ok(wxml.includes('rewardMailUnreadCount'), 'Reward mail should support unread dot badge')
  assert.ok(wxml.includes('{{points}}'), 'Points entry should support points count badge')

  // 4. Check guest avatar rendering safety
  assert.ok(wxml.includes('wx:if="{{!isGuest && avatarUrl}}"'), 'avatar image should only show for authenticated users')

  // 5. Check text hierarchy (z-index) above icon
  assert.ok(wxss.includes('.profile-grid-label'), 'WXSS must define .profile-grid-label')
  assert.ok(wxss.includes('z-index: 10'), '.profile-grid-label must have higher z-index (z-index: 10) to sit on top of icons')
  assert.ok(wxss.includes('.profile-icon-wrap'), 'WXSS must define .profile-icon-wrap')

  // 6. Check pseudo element and hero overrides cleaned up
  assert.ok(wxss.includes('.profile-hero::before'), 'profile-hero::before should be explicitly disabled in profile wxss')
  assert.ok(!appWxss.includes('background: linear-gradient(180deg, #ffd7e2 0%, #fff3f7 100%)'), 'app.wxss must not contain legacy pink profile-hero gradient')
})
