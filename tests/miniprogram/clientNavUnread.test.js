const test = require('node:test')
const assert = require('node:assert/strict')

// Mock wx environment
const storage = {}
global.wx = {
  getStorageSync: (key) => storage[key],
  setStorageSync: (key, val) => {
    storage[key] = val
  }
}
global.getApp = () => ({ globalData: { env: 'test-env' } })

const clientNav = require('../../miniprogram/utils/client-nav')

test('applyUnreadState updates page data with accurate counts and 99+ formatting', () => {
  const page = {
    data: {},
    setData(data) {
      Object.assign(this.data, data)
    }
  }

  // 0 unread
  clientNav.applyUnreadState(page, 0)
  assert.equal(page.data.messageUnreadCount, 0)
  assert.equal(page.data.messageHasUnread, false)
  assert.equal(page.data.messageUnreadCountText, '0')

  // 1 unread
  clientNav.applyUnreadState(page, 1)
  assert.equal(page.data.messageUnreadCount, 1)
  assert.equal(page.data.messageHasUnread, true)
  assert.equal(page.data.messageUnreadCountText, '1')

  // 99 unread
  clientNav.applyUnreadState(page, 99)
  assert.equal(page.data.messageUnreadCount, 99)
  assert.equal(page.data.messageHasUnread, true)
  assert.equal(page.data.messageUnreadCountText, '99')

  // 100 unread -> 99+
  clientNav.applyUnreadState(page, 100)
  assert.equal(page.data.messageUnreadCount, 100)
  assert.equal(page.data.messageHasUnread, true)
  assert.equal(page.data.messageUnreadCountText, '99+')
})

test('setCachedUnread and getCachedUnread persist and retrieve unread state', () => {
  clientNav.setCachedUnread('client', { totalUnread: 7, hasUnread: true })
  const cached = clientNav.getCachedUnread('client')
  assert.deepEqual(cached, { totalUnread: 7, hasUnread: true })

  // Check persistent storage
  assert.deepEqual(storage['vip_pet_client_unread_summary'], { totalUnread: 7, hasUnread: true })

  // Staff role
  clientNav.setCachedUnread('staff', { totalUnread: 12, hasUnread: true })
  const cachedStaff = clientNav.getCachedUnread('staff')
  assert.deepEqual(cachedStaff, { totalUnread: 12, hasUnread: true })
  assert.deepEqual(storage['vip_pet_staff_unread_summary'], { totalUnread: 12, hasUnread: true })
})
