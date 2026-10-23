const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function pageAt(relativePath, bindings = {}) {
  const file = path.resolve(__dirname, '../../miniprogram', relativePath)
  const localRequire = createRequire(file)
  let pageOptions = null
  const storage = bindings.storage || new Map()
  const toasts = []

  const wx = {
    getStorageSync: (k) => storage.get(k),
    setStorageSync: (k, v) => storage.set(k, v),
    showToast: (o) => toasts.push(o),
    navigateTo: () => {},
    createIntersectionObserver: () => ({ relativeToViewport: () => ({ observe: () => {} }) }),
    ...bindings.wx
  }

  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    Page(options) {
      pageOptions = options
    },
    require(name) {
      if (name.endsWith('/cloud')) {
        return {
          getCurrentUser: bindings.getCurrentUser || (async () => null),
          callFunction: bindings.callFunction || (async () => ({})),
          getCachedSystemSettings: () => ({}),
          loadSystemSettings: () => Promise.resolve({}),
          getSelectedLocation: () => null,
          chooseSelectedLocation: async () => ({}),
          showError: () => {},
          ensureLogin: async () => ({})
        }
      }
      if (name.endsWith('/theme')) {
        return {
          applyTheme: () => ({ value: 'day' }),
          getThemeState: () => ({ themeClass: 'theme-day' })
        }
      }
      if (name.endsWith('/hero-media') || name.endsWith('/client-nav') || name.endsWith('/nav')) {
        return {
          loadMessageUnread: () => {}, startStaffEntryUnread() {}, stopStaffEntryUnread() {},
          getCachedHeroMedia: () => null,
          resolveHeroMedia: () => {},
          safeNavigateTo: () => {}
        }
      }
      return localRequire(name)
    },
    wx,
    getApp: () => ({ globalData: {} }),
    clearTimeout,
    setTimeout
  })

  const page = {
    ...pageOptions,
    data: JSON.parse(JSON.stringify(pageOptions.data))
  }

  page.setData = function (patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      let target = this.data
      for (const part of parts.slice(0, -1)) {
        if (!target[part]) target[part] = {}
        target = target[part]
      }
      target[parts[parts.length - 1]] = value
    }
  }

  return { page, storage, toasts }
}

test('同小区拼单浮窗: 界面元素与不挤占正文样式校验', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/home/index.wxml'), 'utf8')
  assert.match(wxml, /home-group-notice-wrapper/)
  assert.match(wxml, /notice-close-btn/)
  assert.match(wxml, /dismissGroupNotice/)
  assert.match(wxml, /notice-today-btn/)
  assert.match(wxml, /dismissGroupNoticeToday/)
  assert.match(wxml, /今日不再显示/)

  const wxss = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/home/index.wxss'), 'utf8')
  // 必须使用 fixed 悬浮定位，绝不能普通流挤压页面原本元素
  assert.match(wxss, /position:\s*fixed/)
  // 必须具备半透明毛玻璃质感
  assert.match(wxss, /backdrop-filter:\s*blur/)
})

test('home hides formed groups and unpaid intents even when stale counts remain', async () => {
  const notice = { availableCount: 8, groups: [{ id: 'formed', status: 'formed', householdCount: 2 }], myGroups: [
    { id: 'formed', status: 'formed', householdCount: 2 },
    { id: 'unpaid', status: 'recruiting', householdCount: 1, orderStatus: 'pending_pay' }
  ] }
  const { page } = pageAt('pages/client/home/index.js', { getCurrentUser: async () => ({ openid: 'u1' }), callFunction: async () => notice })
  page._isPageActive = true
  await page.loadCommunityGroups()
  assert.equal(page.data.showCommunityGroupNotice, false)
  assert.equal(page.data.groupNoticeCards.length, 0)
  assert.equal(page.data.communityGroupNotice.myGroups.length, 0)
})

test('同小区拼单浮窗: 点击取消图标能够关闭本次显示', async () => {
  const mockNotice = { communityName: '翠湖花园', availableCount: 2, myGroups: [] }
  const { page } = pageAt('pages/client/home/index.js', {
    getCurrentUser: async () => ({ openid: 'u1' }),
    callFunction: async () => mockNotice
  })

  page._isPageActive = true
  await page.loadCommunityGroups()
  assert.equal(page.data.showCommunityGroupNotice, true)
  assert.equal(page.data.communityGroupNotice.availableCount, 2)

  // 点击关闭
  page.dismissGroupNotice()
  assert.equal(page.data.showCommunityGroupNotice, false)
  assert.equal(page.data.groupNoticeDismissed, true)
})

test('同小区拼单浮窗: 点击今日不再显示则记录日期，当日刷新与进入均不弹窗', async () => {
  const mockNotice = { communityName: '翠湖花园', availableCount: 3, myGroups: [] }
  const storage = new Map()
  const { page, toasts } = pageAt('pages/client/home/index.js', {
    getCurrentUser: async () => ({ openid: 'u1' }),
    callFunction: async () => mockNotice,
    storage
  })

  page._isPageActive = true
  await page.loadCommunityGroups()
  assert.equal(page.data.showCommunityGroupNotice, true)

  // 点击“今日不再显示”
  page.dismissGroupNoticeToday()
  assert.equal(page.data.showCommunityGroupNotice, false)
  assert.equal(toasts.some((t) => t.title.includes('今日将不再提示')), true)

  // 验证 storage 写入了当天日期
  const todayStr = new Date().toISOString().slice(0, 10)
  assert.equal(storage.get('dismiss_community_group_notice_date'), todayStr)

  // 模拟重新进入页面或下一次轮询，验证依然保持不显示
  const newSession = pageAt('pages/client/home/index.js', {
    getCurrentUser: async () => ({ openid: 'u1' }),
    callFunction: async () => mockNotice,
    storage
  })
  newSession.page._isPageActive = true
  newSession.page.onShow()
  assert.equal(newSession.page.data.showCommunityGroupNotice, false)

  await newSession.page.loadCommunityGroups()
  assert.equal(newSession.page.data.showCommunityGroupNotice, false)
})

test('同小区拼单浮窗: 多拼单卡片堆叠、上滑模糊淡出与动态顶起下一张校验', async () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/home/index.wxml'), 'utf8')
  assert.match(wxml, /home-group-notice-stack/)
  assert.match(wxml, /card-stack-layer-1/)
  assert.match(wxml, /card-stack-top/)
  assert.match(wxml, /notice-stack-counter/)

  const wxss = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/home/index.wxss'), 'utf8')
  assert.match(wxss, /card-dismissing/)
  assert.match(wxss, /promoting-to-top/)
  assert.match(wxss, /filter:\s*blur/)

  const mockNotice = {
    communityName: '蔚蓝海岸',
    availableCount: 3,
    groups: [
      { id: 'g1', serviceSummary: '遛狗服务', householdCount: 1, minHouseholds: 3, status: 'recruiting', mine: false },
      { id: 'g2', serviceSummary: '猫咪上门喂养', householdCount: 1, minHouseholds: 2, status: 'recruiting', mine: false },
      { id: 'g3', serviceSummary: '洗澡服务', householdCount: 2, minHouseholds: 3, status: 'recruiting', mine: false }
    ],
    myGroups: []
  }

  const { page } = pageAt('pages/client/home/index.js', {
    getCurrentUser: async () => ({ openid: 'u1' }),
    callFunction: async () => mockNotice
  })

  page._isPageActive = true
  await page.loadCommunityGroups()

  // 1. 验证生成 3 张堆叠卡片
  assert.equal(page.data.showCommunityGroupNotice, true)
  assert.equal(page.data.groupNoticeCards.length, 3)
  assert.equal(page.data.groupNoticeCards[0].id, 'g1')
  assert.equal(page.data.groupNoticeCards[1].id, 'g2')
  assert.equal(page.data.groupNoticeCards[2].id, 'g3')

  // 2. 模拟手势向上滑动：卡片随手指上移并实时呈现高斯模糊与淡出
  page.onNoticeTouchStart({ touches: [{ clientY: 200 }] })
  page.onNoticeTouchMove({ touches: [{ clientY: 140 }] }) // 向上滑动 60px
  assert.match(page.data.topCardTransformStyle, /translateY\(-60px\)/)
  assert.match(page.data.topCardTransformStyle, /filter:\s*blur/)
  assert.match(page.data.topCardTransformStyle, /opacity:/)

  // 3. 模拟松手达到阈值，触发飞出动画
  page.onNoticeTouchEnd()
  assert.equal(page.data.noticeCardDismissing, true)

  // 快进 280ms 等待动画完成
  await new Promise((resolve) => setTimeout(resolve, 300))

  // 4. 第一张卡片飞出，第二张动态顶上来成为新的第一张
  assert.equal(page.data.groupNoticeCards.length, 2)
  assert.equal(page.data.groupNoticeCards[0].id, 'g2')
  assert.equal(page.data.groupNoticeCards[1].id, 'g3')
  assert.equal(page.data.noticeCardDismissing, false)

  // 5. 点击右上角关闭（传入 tap 事件对象），验证亦触发飞出动效
  page.dismissGroupNotice({ type: 'tap' })
  assert.equal(page.data.noticeCardDismissing, true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(page.data.groupNoticeCards.length, 1)
  assert.equal(page.data.groupNoticeCards[0].id, 'g3')

  // 6. 仅剩一张卡片时，向上滑飞出后整体关闭浮窗
  page.onNoticeTouchStart({ touches: [{ clientY: 100 }] })
  page.onNoticeTouchMove({ touches: [{ clientY: 40 }] })
  page.onNoticeTouchEnd()
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(page.data.groupNoticeCards.length, 0)
  assert.equal(page.data.showCommunityGroupNotice, false)
  assert.equal(page.data.groupNoticeDismissed, true)
})

test('同小区拼单浮窗: 防滑动误触跳转、防轮询死而复生与定时器清理安全', async () => {
  let navigated = false
  const mockNotice = {
    communityName: '蔚蓝海岸',
    availableCount: 2,
    groups: [
      { id: 'g1', serviceSummary: '遛狗', householdCount: 1, minHouseholds: 2, status: 'recruiting', mine: false },
      { id: 'g2', serviceSummary: '喂猫', householdCount: 1, minHouseholds: 2, status: 'recruiting', mine: false }
    ],
    myGroups: []
  }

  const { page } = pageAt('pages/client/home/index.js', {
    getCurrentUser: async () => ({ openid: 'u1' }),
    callFunction: async () => mockNotice,
    wx: {
      navigateTo: (opts) => {
        if (opts.url.includes('group-buy')) navigated = true
      }
    }
  })

  page._isPageActive = true
  await page.loadCommunityGroups()
  assert.equal(page.data.groupNoticeCards.length, 2)

  // 1. 测试上滑过程中/动画中点击卡片，必须拦截跳转，杜绝误触
  page.onNoticeTouchStart({ touches: [{ clientY: 200 }] })
  page.onNoticeTouchMove({ touches: [{ clientY: 160 }] }) // 上移 40px
  page.openCommunityGroups()
  assert.equal(navigated, false, '滑动卡片时不应误触 openCommunityGroups 跳转')

  // 2. 完成上滑动效，g1 飞出
  page.onNoticeTouchEnd()
  page.openCommunityGroups()
  assert.equal(navigated, false, '松手瞬间仍处于动画/保护期，不应跳转')

  await new Promise((resolve) => setTimeout(resolve, 350))
  assert.equal(page.data.groupNoticeCards.length, 1)
  assert.equal(page.data.groupNoticeCards[0].id, 'g2')

  // 3. 模拟 30 秒后台轮询或下拉刷新触发 loadCommunityGroups
  // 必须保证已取消的 g1 不会重新复活！
  await page.loadCommunityGroups()
  assert.equal(page.data.groupNoticeCards.length, 1)
  assert.equal(page.data.groupNoticeCards[0].id, 'g2', '已取消的 g1 绝不可在轮询或刷新后复活')

  // 4. 正常轻触未滑动的卡片，允许正常跳转
  page._touchMoved = false
  page._preventCardTap = false
  page._isDismissing = false
  page.openCommunityGroups()
  assert.equal(navigated, true, '正常纯点击应顺利打开拼单列表')

  // 5. 测试 onHide 和 onUnload 定时器安全清理
  page.animateDismissTopCard()
  page.onHide()
  assert.equal(page._isDismissing, false, '切后台时应重置动画锁')
  page.onUnload()
  assert.equal(page._isDismissing, false)
})

test('同小区拼单浮窗: 我的拼单专属呈现排他优先、同单严格全局只出现一次', async () => {
  const mockNotice = {
    communityName: '太阳城小区',
    availableCount: 2,
    // 模拟服务端下发数据：包含重复 id、包含属于我的拼单在 groups 与 myGroups 均有返回、包含已取消的拼单
    groups: [
      { id: 'g_mine', serviceSummary: '遛狗服务', householdCount: 1, minHouseholds: 2, status: 'recruiting', mine: true },
      { id: 'g_neighbor', serviceSummary: '猫咪上门喂养', householdCount: 1, minHouseholds: 2, status: 'recruiting', mine: false },
      { id: 'g_neighbor', serviceSummary: '猫咪上门喂养', householdCount: 1, minHouseholds: 2, status: 'recruiting', mine: false }, // 重复项
      { id: 'g_cancelled', serviceSummary: '猫咪洗护', householdCount: 0, minHouseholds: 2, status: 'cancelled', mine: false } // 已取消项
    ],
    myGroups: [
      { id: 'g_mine', serviceSummary: '遛狗服务', householdCount: 1, minHouseholds: 2, status: 'recruiting', mine: true }
    ]
  }

  const { page } = pageAt('pages/client/home/index.js', {
    getCurrentUser: async () => ({ openid: 'u1' }),
    callFunction: async () => mockNotice
  })

  page._isPageActive = true
  await page.loadCommunityGroups()

  // 1. 验证同单严格仅出现一次：总卡片数应为 2 (g_mine 和 g_neighbor)
  assert.equal(page.data.groupNoticeCards.length, 2, '相同 ID 的拼单与已取消拼单必须被去重/排除')

  // 2. 验证属于我的拼单排在第一位，且只显示为“🐾 我的拼单”，绝不显示为“🏡 同小区拼单”
  const cardMine = page.data.groupNoticeCards[0]
  assert.equal(cardMine.id, 'g_mine')
  assert.equal(cardMine.badge, '🐾 我的拼单')
  assert.equal(cardMine.type, 'my_group')
  assert.equal(cardMine.actionText, '查看拼单进度')

  // 3. 验证邻居拼单正常展示为“🏡 同小区拼单”
  const cardNeighbor = page.data.groupNoticeCards[1]
  assert.equal(cardNeighbor.id, 'g_neighbor')
  assert.equal(cardNeighbor.badge, '🏡 同小区拼单')
  assert.equal(cardNeighbor.type, 'community_group')
  assert.equal(cardNeighbor.actionText, '立即查看拼单')

  // 4. 再次验证：整个列表中不存在任何重复的 groupId
  const groupIds = page.data.groupNoticeCards.map((c) => c.groupId)
  assert.equal(new Set(groupIds).size, groupIds.length, '浮窗卡片中不能有重复拼单')
})
