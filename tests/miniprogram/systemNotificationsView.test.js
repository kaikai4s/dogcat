const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.resolve(__dirname, '../../miniprogram')

test('system notifications: client and staff WXML templates contain tabs, notice cards and detail modal', () => {
  const clientWxml = fs.readFileSync(path.join(root, 'pages/client/messages/index.wxml'), 'utf8')
  assert.match(clientWxml, /messages-tabs-bar/)
  assert.match(clientWxml, /data-tab="order"/)
  assert.match(clientWxml, /data-tab="system"/)
  assert.match(clientWxml, /orderHasUnread/)
  assert.match(clientWxml, /systemHasUnread/)
  assert.match(clientWxml, /notice-card/)
  assert.match(clientWxml, /bindtap="tapNotice"/)
  assert.match(clientWxml, /bindtap="markAllSystemRead"/)
  assert.match(clientWxml, /modal-mask.*wx:if="\{\{showNoticeModal\}\}"/)

  const staffWxml = fs.readFileSync(path.join(root, 'pages/staff/messages/index.wxml'), 'utf8')
  assert.match(staffWxml, /messages-tabs-bar/)
  assert.match(staffWxml, /data-tab="order"/)
  assert.match(staffWxml, /data-tab="system"/)
  assert.match(staffWxml, /orderHasUnread/)
  assert.match(staffWxml, /systemHasUnread/)
  assert.match(staffWxml, /notice-card/)
  assert.match(staffWxml, /bindtap="tapNotice"/)
  assert.match(staffWxml, /bindtap="markAllSystemRead"/)
  assert.match(staffWxml, /modal-mask.*wx:if="\{\{showNoticeModal\}\}"/)

  const adminWxml = fs.readFileSync(path.join(root, 'pages/admin/notifications/index.wxml'), 'utf8')
  assert.match(adminWxml, /系统广播/)
  assert.match(adminWxml, /发送系统通知/)
  assert.match(adminWxml, /openSendModal/)
  assert.match(adminWxml, /revokeNotification/)
})

test('client messages page: tab switching, system notice loading, tapping read and mark all read', async () => {
  const source = fs.readFileSync(path.join(root, 'pages/client/messages/index.js'), 'utf8')
  let pageInstance
  const calls = []
  let toastMsg = ''
  let modalConfig = null

  const mockCloud = {
    callFunction: async (module, action, data) => {
      calls.push({ module, action, data })
      if (module === 'message' && action === 'listSystemNotifications') {
        return {
          list: [
            {
              _id: 'notice-1',
              title: '系统维护升级公告',
              content: '今晚24点将进行系统服务升级维护。',
              type: 'system',
              typeText: '系统公告',
              level: 'urgent',
              isRead: false,
              targetUrl: '/pages/client/home/index',
              createdAtText: '2026-09-28 12:00'
            },
            {
              _id: 'notice-2',
              title: '国庆限时宠物大礼包',
              content: '国庆狂欢优惠券已发放到您的账户！',
              type: 'activity',
              typeText: '活动福利',
              level: 'normal',
              isRead: true,
              targetUrl: '',
              createdAtText: '2026-09-28 10:00'
            }
          ],
          total: 2,
          hasMore: false,
          page: 1,
          unreadCount: 1
        }
      }
      if (module === 'message' && action === 'markSystemNotificationRead') {
        return { success: true }
      }
      return { list: [], total: 0, hasMore: false, page: 1 }
    },
    ensureLogin: async () => {},
    showError: () => {}
  }

  vm.runInNewContext(source, {
    Page(options) {
      pageInstance = options
    },
    require(name) {
      if (name.includes('cloud')) return mockCloud
      if (name.includes('client-nav')) return { loadMessageUnread: () => Promise.resolve(), refreshUnread: () => Promise.resolve() }
      if (name.includes('theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      if (name.includes('format')) return { formatDateTime: () => '' }
      return {}
    },
    wx: {
      showToast(opts) { toastMsg = opts && opts.title },
      showLoading() {},
      hideLoading() {},
      showModal(opts) {
        modalConfig = opts
        if (opts && typeof opts.success === 'function') opts.success({ confirm: true })
      },
      navigateTo() {},
      redirectTo() {}
    },
    getCurrentPages() { return [{ route: 'pages/client/messages/index' }] }
  })

  pageInstance.data = { ...pageInstance.data }
  pageInstance.setData = function(update, cb) {
    Object.assign(this.data, update)
    if (cb) cb()
  }

  // 1. 默认 Tab 为 'order'
  assert.equal(pageInstance.data.activeTab, 'order')

  // 2. 切换到 'system' Tab，自动拉取系统通知
  pageInstance.switchTab({ currentTarget: { dataset: { tab: 'system' } } })
  assert.equal(pageInstance.data.activeTab, 'system')

  await new Promise((r) => setTimeout(r, 20))

  assert.equal(pageInstance.data.systemNotices.length, 2)
  assert.equal(pageInstance.data.systemUnreadCount, 1)
  assert.equal(pageInstance.data.systemHasUnread, true)
  assert.equal(pageInstance.data.systemNotices[0].isRead, false)

  // 3. 点击未读通知，触发弹窗及已读上报
  pageInstance.tapNotice({ currentTarget: { dataset: { id: 'notice-1' } } })
  assert.equal(pageInstance.data.showNoticeModal, true)
  assert.equal(pageInstance.data.selectedNotice._id, 'notice-1')

  await new Promise((r) => setTimeout(r, 20))

  const markCalls = calls.filter((c) => c.module === 'message' && c.action === 'markSystemNotificationRead')
  assert.ok(markCalls.length > 0)
  assert.equal(markCalls[0].data.id, 'notice-1')

  // 验证本地状态已即时更新为已读
  assert.equal(pageInstance.data.systemNotices[0].isRead, true)
  assert.equal(pageInstance.data.systemUnreadCount, 0)
  assert.equal(pageInstance.data.systemHasUnread, false)

  // 4. 一键全部已读
  pageInstance.setData({ systemUnreadCount: 1, systemHasUnread: true })
  pageInstance.markAllSystemRead()
  assert.ok(modalConfig)
  assert.equal(modalConfig.title, '全部已读')

  await new Promise((r) => setTimeout(r, 20))
  assert.equal(toastMsg, '已全部标为已读')
  assert.equal(pageInstance.data.systemUnreadCount, 0)
  assert.equal(pageInstance.data.systemHasUnread, false)
})

test('staff messages page: tab switching, system notice loading and tapping read', async () => {
  const source = fs.readFileSync(path.join(root, 'pages/staff/messages/index.js'), 'utf8')
  let pageInstance
  const calls = []

  const mockCloud = {
    callFunction: async (module, action, data) => {
      calls.push({ module, action, data })
      if (module === 'staffMessage' && action === 'listSystemNotifications') {
        return {
          list: [
            {
              _id: 'notice-staff-1',
              title: '国庆接单奖励公告',
              content: '国庆期间完成服务每单额外补贴30元！',
              type: 'notice',
              typeText: '服务通知',
              level: 'urgent',
              isRead: false,
              targetUrl: '/pages/staff/home/index',
              createdAtText: '2026-09-28 14:00'
            }
          ],
          total: 1,
          hasMore: false,
          page: 1,
          unreadCount: 1
        }
      }
      if (module === 'staffMessage' && action === 'markSystemNotificationRead') {
        return { success: true }
      }
      return { list: [], total: 0, hasMore: false, page: 1 }
    },
    showError: () => {}
  }

  vm.runInNewContext(source, {
    Page(options) {
      pageInstance = options
    },
    require(name) {
      if (name.includes('cloud')) return mockCloud
      if (name.includes('client-nav')) return { loadMessageUnread: () => Promise.resolve(), refreshUnread: () => Promise.resolve() }
      if (name.includes('theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      if (name.includes('format')) return { formatDateTime: () => '' }
      return {}
    },
    wx: {
      showToast() {},
      showLoading() {},
      hideLoading() {},
      showModal(opts) {
        if (opts && typeof opts.success === 'function') opts.success({ confirm: true })
      },
      navigateTo() {},
      redirectTo() {}
    },
    getCurrentPages() { return [{ route: 'pages/staff/messages/index' }] }
  })

  pageInstance.data = { ...pageInstance.data }
  pageInstance.setData = function(update, cb) {
    Object.assign(this.data, update)
    if (cb) cb()
  }

  // 1. 切换到 'system' Tab
  pageInstance.switchTab({ currentTarget: { dataset: { tab: 'system' } } })
  assert.equal(pageInstance.data.activeTab, 'system')

  await new Promise((r) => setTimeout(r, 20))

  assert.equal(pageInstance.data.systemNotices.length, 1)
  assert.equal(pageInstance.data.systemUnreadCount, 1)
  assert.equal(pageInstance.data.systemNotices[0].title, '国庆接单奖励公告')

  // 2. 点击查看通知详情
  pageInstance.tapNotice({ currentTarget: { dataset: { id: 'notice-staff-1' } } })
  assert.equal(pageInstance.data.showNoticeModal, true)

  await new Promise((r) => setTimeout(r, 20))

  const markStaffCalls = calls.filter((c) => c.module === 'staffMessage' && c.action === 'markSystemNotificationRead')
  assert.ok(markStaffCalls.length > 0)
  assert.equal(markStaffCalls[0].data.id, 'notice-staff-1')
  assert.equal(pageInstance.data.systemNotices[0].isRead, true)
  assert.equal(pageInstance.data.systemUnreadCount, 0)
})
