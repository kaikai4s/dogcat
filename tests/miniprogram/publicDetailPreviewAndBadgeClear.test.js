const test = require('node:test')
const assert = require('node:assert/strict')

test('public-detail previewPhoto extracts section or full order photo urls for swipeable preview', () => {
  let previewCurrent = null
  let previewUrls = null

  global.wx = {
    previewImage: ({ current, urls }) => {
      previewCurrent = current
      previewUrls = urls
    }
  }

  const page = {
    data: {
      detail: {
        checkinSections: [
          {
            eventType: 'arrive',
            eventText: '到达拍照',
            photos: [
              { _id: 'p1', mediaFileId: 'https://cloud.com/photo_arrive_1.jpg', timeText: '14:02' },
              { _id: 'p2', mediaFileId: 'https://cloud.com/photo_arrive_2.jpg', timeText: '14:03' }
            ]
          },
          {
            eventType: 'feed',
            eventText: '喂养打卡',
            photos: [
              { _id: 'p3', mediaFileId: 'https://cloud.com/photo_feed_1.jpg', timeText: '14:15' },
              { _id: 'p4', mediaFileId: 'https://cloud.com/photo_feed_2.jpg', timeText: '14:18' }
            ]
          }
        ]
      }
    },
    previewPhoto(e) {
      const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
      const url = ds.url
      if (!url) return
      const detail = this.data.detail || {}
      let urls = []

      // 优先：若指定了环节索引，优先取该服务环节的所有打卡照片列表
      if (ds.sectionIndex !== undefined && Array.isArray(detail.checkinSections) && detail.checkinSections[ds.sectionIndex]) {
        urls = (detail.checkinSections[ds.sectionIndex].photos || []).map((p) => p.mediaFileId).filter(Boolean)
      }

      // 若当前环节未取到或单张，则取整个订单的所有打卡照片列表作为全局滑动序列
      if (!urls.length) {
        if (Array.isArray(detail.checkinSections) && detail.checkinSections.length) {
          urls = detail.checkinSections.reduce((acc, sec) => {
            const pList = (sec.photos || []).map((p) => p.mediaFileId).filter(Boolean)
            return acc.concat(pList)
          }, [])
        } else if (Array.isArray(detail.allCheckinPhotos) && detail.allCheckinPhotos.length) {
          urls = detail.allCheckinPhotos.map((item) => item.mediaFileId).filter(Boolean)
        } else if (Array.isArray(detail.checkinPhotos) && detail.checkinPhotos.length) {
          urls = detail.checkinPhotos.map((item) => item.mediaFileId).filter(Boolean)
        }
      }

      if (!urls.includes(url)) {
        urls.unshift(url)
      }

      global.wx.previewImage({ current: url, urls: urls.length ? urls : [url] })
    }
  }

  // Case 1: 点击第二环节（喂养打卡）的第二张照片
  page.previewPhoto({
    currentTarget: {
      dataset: {
        url: 'https://cloud.com/photo_feed_2.jpg',
        sectionIndex: 1
      }
    }
  })

  assert.equal(previewCurrent, 'https://cloud.com/photo_feed_2.jpg')
  assert.equal(previewUrls.length, 2)
  assert.deepEqual(previewUrls, [
    'https://cloud.com/photo_feed_1.jpg',
    'https://cloud.com/photo_feed_2.jpg'
  ])

  // Case 2: 点击未指定 sectionIndex 的图片时，自动聚合全部打卡大图滑动列表
  page.previewPhoto({
    currentTarget: {
      dataset: {
        url: 'https://cloud.com/photo_arrive_1.jpg'
      }
    }
  })
  assert.equal(previewCurrent, 'https://cloud.com/photo_arrive_1.jpg')
  assert.equal(previewUrls.length, 4)
  assert.deepEqual(previewUrls, [
    'https://cloud.com/photo_arrive_1.jpg',
    'https://cloud.com/photo_arrive_2.jpg',
    'https://cloud.com/photo_feed_1.jpg',
    'https://cloud.com/photo_feed_2.jpg'
  ])
})

test('admin notifications markAllRead synchronizes and clears admin home unread badge', async () => {
  let toastTitle = ''
  global.wx = {
    showLoading: () => {},
    hideLoading: () => {},
    showToast: ({ title }) => { toastTitle = title }
  }

  const adminHomePage = {
    route: 'pages/admin/home/index',
    data: {
      unreadNotificationCount: 5,
      urgentNotice: { title: '急单提醒' }
    },
    setData(patch) {
      Object.assign(this.data, patch)
    }
  }

  const notificationsPage = {
    route: 'pages/admin/notifications/index',
    data: {
      unreadCount: 5,
      list: [
        { _id: 'n1', isRead: false },
        { _id: 'n2', isRead: false }
      ]
    },
    setData(patch) {
      Object.assign(this.data, patch)
    },
    load() {},
    markAllReadMock(callCloud) {
      if (this.data.unreadCount === 0) return
      callCloud('admin', 'markAdminNotificationRead', { all: true })
        .then(() => {
          this.setData({ unreadCount: 0 })
          // 同步清除管理首页右上角小红点角标
          const pages = global.getCurrentPages()
          const adminHome = pages.find((p) => p && p.route && p.route.includes('pages/admin/home/index'))
          if (adminHome && typeof adminHome.setData === 'function') {
            adminHome.setData({ unreadNotificationCount: 0, urgentNotice: null })
          }
        })
    },
    tapItemMock(item, callCloud) {
      if (!item.isRead) {
        callCloud('admin', 'markAdminNotificationRead', { id: item._id })
        const list = this.data.list.map((n) => (n._id === item._id ? { ...n, isRead: true } : n))
        const nextUnread = Math.max(0, this.data.unreadCount - 1)
        this.setData({ list, unreadCount: nextUnread })

        const pages = global.getCurrentPages()
        const adminHome = pages.find((p) => p && p.route && p.route.includes('pages/admin/home/index'))
        if (adminHome && typeof adminHome.setData === 'function') {
          const currentCount = adminHome.data && adminHome.data.unreadNotificationCount
          adminHome.setData({ unreadNotificationCount: Math.max(0, (currentCount || 1) - 1) })
        }
      }
    }
  }

  global.getCurrentPages = () => [adminHomePage, notificationsPage]

  // 1. 测试单条已读时，管理首页角标同步减 1
  notificationsPage.tapItemMock({ _id: 'n1', isRead: false }, async () => {})
  assert.equal(notificationsPage.data.unreadCount, 4)
  assert.equal(adminHomePage.data.unreadNotificationCount, 4)

  // 2. 测试一键全部已读时，管理首页角标与加急提醒立即归零清除
  await notificationsPage.markAllReadMock(async () => {})
  assert.equal(notificationsPage.data.unreadCount, 0)
  assert.equal(adminHomePage.data.unreadNotificationCount, 0)
  assert.equal(adminHomePage.data.urgentNotice, null)
})
