const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '../../miniprogram')

function createStaffProfilePage(options = {}) {
  const {
    cachedUser = null,
    storageData = {},
    callFunctionMock = async () => ({})
  } = options

  let pageConfig = null
  const storage = new Map(Object.entries(storageData))

  const cloudMock = {
    getCachedUser: () => cachedUser,
    callFunction: callFunctionMock,
    showError: () => {},
    showLoading: () => {},
    hideLoading: () => {},
    chooseSelectedLocation: async () => ({})
  }

  const code = fs.readFileSync(path.join(root, 'pages/staff/profile/index.js'), 'utf8')

  vm.runInNewContext(code, {
    Page: config => { pageConfig = config },
    require: modulePath => {
      if (modulePath.includes('cloud')) return cloudMock
      if (modulePath.includes('image-upload')) return { uploadImage: () => {} }
      if (modulePath.includes('format')) return { withStaffWorkflowText: (p) => p }
      if (modulePath.includes('theme')) return { applyTheme: () => ({ value: 'day' }), getThemeState: () => ({}) }
      if (modulePath.includes('client-nav')) return { loadMessageUnread: () => {} }
      if (modulePath.includes('profileCardStyle')) return {
        DEFAULT_CARD_STYLE: {},
        isHexColor: () => true,
        normalizeCardStyle: (p) => ({}),
        buildCardStyle: () => ''
      }
      return {}
    },
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, val) => storage.set(key, val),
      showToast: () => {},
      redirectTo: () => {},
      stopPullDownRefresh: () => {}
    },
    getApp: () => ({ globalData: {} }),
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id)
  })

  const page = { ...pageConfig, data: { ...pageConfig.data } }
  const setDataLog = []
  page.setData = function(patch, cb) {
    setDataLog.push(patch)
    for (const [key, val] of Object.entries(patch || {})) {
      if (key.includes('.')) {
        const parts = key.split('.')
        const last = parts.pop()
        let curr = this.data
        for (const p of parts) {
          if (!curr[p] || typeof curr[p] !== 'object') curr[p] = {}
          curr = curr[p]
        }
        curr[last] = val
      } else {
        this.data[key] = val
      }
    }
    if (cb) cb()
  }
  return { page, setDataLog, storage }
}

test('staff profile instant load: pre-populates certified status from cache with zero "未入驻" flash', () => {
  const cachedUser = {
    _id: 'user_s1',
    nickname: '王牌宠托师小李',
    avatarUrl: 'https://example.com/sitter.jpg'
  }
  const cachedProfile = {
    _id: 'p1',
    auditStatus: 'approved',
    staffLevel: 'certified',
    serviceAddress: '成都市武侯区某小区',
    serviceLatitude: 30.65,
    serviceLongitude: 104.06
  }
  const cachedBalance = {
    available: 128.5,
    pending: 45.0,
    withdrawn: 300.0
  }

  const { page } = createStaffProfilePage({
    cachedUser,
    storageData: {
      staff_profile_display_cache_v1: {
        profile: cachedProfile,
        balance: cachedBalance,
        cachedAt: Date.now()
      }
    }
  })

  // 1. 验证首屏实例化阶段已直接填充有效数据，处于已就绪状态
  assert.equal(page.data.loadingProfile, false)
  assert.equal(page.data.statusTitle, '认证宠托师')
  assert.notEqual(page.data.statusTitle, '未入驻')
  assert.equal(page.data.displayName, '王牌宠托师小李')
  assert.equal(page.data.avatarUrl, 'https://example.com/sitter.jpg')
  assert.equal(page.data.balance.availableText, '128.50')
  assert.equal(page.data.balance.pendingText, '45.00')
})

test('staff profile cold start: enters skeleton loading state and hides misleading "未入驻" text', async () => {
  const cachedUser = {
    _id: 'user_s2',
    nickname: '新宠托师'
  }

  let callCount = 0
  const { page, storage } = createStaffProfilePage({
    cachedUser,
    storageData: {}, // 无缓存
    callFunctionMock: async (name, action) => {
      callCount++
      if (name === 'auth' && action === 'me') {
        return { nickname: '新宠托师', roles: ['staff'] }
      }
      if (name === 'staff' && action === 'getStaffProfile') {
        return { auditStatus: 'approved', staffLevel: 'certified', serviceAddress: '地址' }
      }
      if (name === 'finance' && action === 'getStaffBalance') {
        return { available: 50.0, pending: 0, withdrawn: 0 }
      }
      return {}
    }
  })

  // 1. 冷启动无缓存时，处于骨架预加载状态
  assert.equal(page.data.loadingProfile, true)
  // 必须为空，不能暴露误导用户的“未入驻”
  assert.notEqual(page.data.statusTitle, '未入驻')
  assert.equal(page.data.profile, null)

  // 2. 接口调用完成
  await page.loadProfile()

  assert.equal(page.data.loadingProfile, false)
  assert.equal(page.data.statusTitle, '认证宠托师')
  assert.equal(page.data.balance.availableText, '50.00')

  // 3. 验证已成功写入缓存供下次秒开
  const saved = storage.get('staff_profile_display_cache_v1')
  assert.ok(saved)
  assert.equal(saved.profile.staffLevel, 'certified')
})

test('staff profile WXML contains skeleton loading structure for hero, wallet, and config cards', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/staff/profile/index.wxml'), 'utf8')
  // 验证骨架屏类名存在
  assert.match(wxml, /staff-hero-skeleton/)
  assert.match(wxml, /skeleton-wallet-card/)
  assert.match(wxml, /skeleton-config-card/)
  // 验证在没有 statusTitle 时不强行显示空粉色徽章
  assert.match(wxml, /wx:if="\{\{statusTitle\}\}"/)
})

test('staff profile deposit notice: never pre-populates stale deposit warning on initial render, preventing flash', async () => {
  const cachedUser = {
    _id: 'user_s3',
    nickname: '宠托师阿杰',
    avatarUrl: 'https://example.com/sitter3.jpg'
  }
  // 模拟缓存中残留了历史未缴保证金提示（如缴费前留存的快照）
  const cachedProfile = {
    _id: 'p3',
    auditStatus: 'approved',
    staffLevel: 'intern',
    depositStatus: 'paid', // 实际上已经交了押金
    depositNotice: {
      needDeposit: true,
      amount: 500,
      title: '未缴纳履约保证金'
    }
  }

  const { page, storage } = createStaffProfilePage({
    cachedUser,
    storageData: {
      staff_profile_display_cache_v1: {
        userId: 'user_s3',
        profile: cachedProfile,
        balance: { available: 100, pending: 0, withdrawn: 0 },
        cachedAt: Date.now()
      }
    },
    callFunctionMock: async (name, action) => {
      if (name === 'auth' && action === 'me') {
        return { _id: 'user_s3', nickname: '宠托师阿杰', roles: ['staff'] }
      }
      if (name === 'staff' && action === 'getStaffProfile') {
        return {
          _id: 'p3',
          auditStatus: 'approved',
          staffLevel: 'intern',
          depositStatus: 'paid',
          depositNotice: null
        }
      }
      return {}
    }
  })

  // 1. 首屏渲染时，绝不从离线缓存中预显欠缴保证金警告，防止闪现
  assert.equal(page.data.depositNotice, null)
  assert.equal(page.data.statusTitle, '实习宠托师')

  // 2. 接口返回后，真实保证金状态保持为 null
  await page.loadProfile()
  assert.equal(page.data.depositNotice, null)

  // 3. 验证新写入的缓存移除了任何残留的 depositNotice
  const saved = storage.get('staff_profile_display_cache_v1')
  assert.equal(saved.profile.depositNotice, undefined)
})

test('staff profile cache: isolates cached profiles across different users', () => {
  const cachedUser = {
    _id: 'user_different',
    nickname: '不同用户'
  }
  const { page } = createStaffProfilePage({
    cachedUser,
    storageData: {
      staff_profile_display_cache_v1: {
        userId: 'user_original',
        profile: { _id: 'p_orig', staffLevel: 'certified' },
        cachedAt: Date.now()
      }
    }
  })

  // 不同用户登录时，旧用户缓存不生效，进入骨架预加载状态
  assert.equal(page.data.loadingProfile, true)
  assert.equal(page.data.profile, null)
})

test('staff profile addTimeSlot prevents duplicate and overlapping intervals', () => {
  const { page } = createStaffProfilePage({
    cachedUser: { _id: 'u1' }
  })

  page.openConfigModal()
  page.setData({ activeDay: 1, startHourIndex: 19, endHourIndex: 23 })
  page.addTimeSlot()
  const toPlain = (v) => JSON.parse(JSON.stringify(v))
  assert.deepEqual(toPlain(page.data.configForm.weeklySchedule['1']), [{ start: 19, end: 23 }])

  // 重复添加相同区间应被阻止
  page.addTimeSlot()
  assert.equal(page.data.configForm.weeklySchedule['1'].length, 1)

  // 重叠区间（如 20-24）应被阻止
  page.setData({ startHourIndex: 20, endHourIndex: 24 })
  page.addTimeSlot()
  assert.equal(page.data.configForm.weeklySchedule['1'].length, 1)

  // 无重叠区间（如 9-12）正常加入并排序
  page.setData({ startHourIndex: 9, endHourIndex: 12 })
  page.addTimeSlot()
  assert.deepEqual(toPlain(page.data.configForm.weeklySchedule['1']), [
    { start: 9, end: 12 },
    { start: 19, end: 23 }
  ])
})

test('staff profile schedule UI provides explicit guidance banners and direct save without modal block for off days', async () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/staff/profile/index.wxml'), 'utf8')
  assert.match(wxml, /class="schedule-hint-banner"/, 'WXML must contain schedule-hint-banner')
  assert.match(wxml, /若某天不接单，清空或不添加该天时间段即可/, 'WXML must provide clear notice about off days')
  assert.match(wxml, /class="add-slot-tip"/, 'WXML must show current slot tip')

  let toastShown = null
  const calls = []

  const { page } = createStaffProfilePage({
    cachedUser: { _id: 'u2' },
    callFunctionMock: async (name, action, data) => {
      calls.push({ name, action, data })
      return {}
    }
  })

  // 1. 测试选时间时给出 toast 引导（如 9:00 至 12:00）
  page.promptAddSlotNotice = function(start, end) {
    if (end > start) toastShown = `已选时间，请点【+ 添加】`
  }
  page.setData({ endHourIndex: 12 })
  page.bindStartHourChange({ detail: { value: '9' } })
  assert.equal(toastShown, '已选时间，请点【+ 添加】')

  // 2. 测试保存接单配置时：某天为空（休息不接单），直接保存成功，不弹窗强迫添加时间段
  const toPlain = (v) => JSON.parse(JSON.stringify(v))
  page.openConfigModal()
  page.setData({
    activeDay: 2, // 周二未设置任何时间段
    startHourIndex: 10,
    endHourIndex: 12,
    'configForm.serviceAddress': '测试地址',
    'configForm.serviceLatitude': 30.6,
    'configForm.serviceLongitude': 104.0,
    'configForm.profileCardColor': '#ffffff',
    'configForm.profileCardTextColor': '#2d211a'
  })

  page.saveConfig()
  await Promise.resolve()

  const saveCall = calls.find((c) => c.name === 'staff' && c.action === 'updateStaffProfileConfig')
  assert.ok(saveCall, 'saveConfig must trigger updateStaffProfileConfig')
  assert.deepEqual(toPlain(saveCall.data.weeklySchedule['2']), [])
})
