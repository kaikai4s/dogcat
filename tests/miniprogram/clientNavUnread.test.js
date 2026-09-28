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

test('applyUnreadState supports category unread objects (orderUnread and systemUnread)', () => {
  const page = {
    data: {},
    setData(data) {
      Object.assign(this.data, data)
    }
  }

  // Both categories have unread
  clientNav.applyUnreadState(page, { totalUnread: 3, orderUnread: 1, systemUnread: 2 })
  assert.equal(page.data.messageUnreadCount, 3)
  assert.equal(page.data.messageHasUnread, true)
  assert.equal(page.data.messageUnreadCountText, '3')
  assert.equal(page.data.orderUnreadCount, 1)
  assert.equal(page.data.orderHasUnread, true)
  assert.equal(page.data.orderUnreadCountText, '1')
  assert.equal(page.data.systemUnreadCount, 2)
  assert.equal(page.data.systemHasUnread, true)
  assert.equal(page.data.systemUnreadCountText, '2')

  // Only system notifications have unread (order has 0)
  clientNav.applyUnreadState(page, { totalUnread: 5, orderUnread: 0, systemUnread: 5 })
  assert.equal(page.data.orderUnreadCount, 0)
  assert.equal(page.data.orderHasUnread, false)
  assert.equal(page.data.orderUnreadCountText, '0')
  assert.equal(page.data.systemUnreadCount, 5)
  assert.equal(page.data.systemHasUnread, true)
  assert.equal(page.data.systemUnreadCountText, '5')
  assert.equal(page.data.messageUnreadCount, 5)
  assert.equal(page.data.messageHasUnread, true)

  // Large count 99+
  clientNav.applyUnreadState(page, { totalUnread: 150, orderUnread: 120, systemUnread: 30 })
  assert.equal(page.data.orderUnreadCountText, '99+')
  assert.equal(page.data.systemUnreadCountText, '30')
  assert.equal(page.data.messageUnreadCountText, '99+')
})

test('setCachedUnread and getCachedUnread persist and retrieve unread state', () => {
  clientNav.setCachedUnread('client', { totalUnread: 7, orderUnread: 4, systemUnread: 3, hasUnread: true })
  const cached = clientNav.getCachedUnread('client')
  assert.deepEqual(cached, { totalUnread: 7, orderUnread: 4, systemUnread: 3, hasUnread: true })

  // Check persistent storage
  assert.deepEqual(storage['vip_pet_client_unread_summary'], { totalUnread: 7, orderUnread: 4, systemUnread: 3, hasUnread: true })

  // Staff role
  clientNav.setCachedUnread('staff', { totalUnread: 12, orderUnread: 10, systemUnread: 2, hasUnread: true })
  const cachedStaff = clientNav.getCachedUnread('staff')
  assert.deepEqual(cachedStaff, { totalUnread: 12, orderUnread: 10, systemUnread: 2, hasUnread: true })
  assert.deepEqual(storage['vip_pet_staff_unread_summary'], { totalUnread: 12, orderUnread: 10, systemUnread: 2, hasUnread: true })

  // loadMessageUnread applies cached category counts synchronously to page
  const page = {
    data: {},
    setData(data) {
      Object.assign(this.data, data)
    }
  }
  clientNav.loadMessageUnread(page, 'client')
  assert.equal(page.data.orderHasUnread, true)
  assert.equal(page.data.orderUnreadCount, 4)
  assert.equal(page.data.orderUnreadCountText, '4')
  assert.equal(page.data.systemHasUnread, true)
  assert.equal(page.data.systemUnreadCount, 3)
  assert.equal(page.data.systemUnreadCountText, '3')
})
