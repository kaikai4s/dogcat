const { callFunction, showError } = require('../../../../utils/cloud')
const { ensureLogin } = require('../../../../utils/cloud')
const { loadMessageUnread } = require('../../../../utils/client-nav')
const formatUtils = require('../../../../utils/format') || {}
const withOrderText = formatUtils.withOrderText || ((x) => x)
const pageList = formatUtils.pageList || ((r) => Array.isArray(r) ? { list: r, hasMore: false, page: 1, total: r.length } : (r || { list: [], hasMore: false, page: 1, total: 0 }))
const navUtils = require('../../../../utils/nav') || {}
const safeNavigateTo = navUtils.safeNavigateTo || ((opts) => wx.navigateTo(opts))
const getNavBarInfo = navUtils.getNavBarInfo || (() => ({ statusBarHeight: 44, titleBarHeight: 44, navBarHeight: 88 }))
const navigateRoleRoute = navUtils.navigateRoleRoute || ((url) => wx.navigateTo({ url }))
const { applyTheme, getThemeState } = require('../../../../utils/theme')
const cloudAssets = require('../../../../utils/cloud-assets')
const getDovlinLogoUrl = (cloudAssets && (cloudAssets.getDovlinLogoSrc || cloudAssets.getDovlinLogoUrl)) || (() => '')
const applyDovlinLogo = (cloudAssets && cloudAssets.applyDovlinLogo) || (() => {})

const tabs = [
  { label: '全部', value: 'all' },
  { label: '待支付', value: 'pending_pay' },
  { label: '待派单', value: 'paid' },
  { label: '待服务', value: 'waiting_service' },
  { label: '已完成', value: 'completed' },
  { label: '退款中', value: 'refunding' },
  { label: '已退款', value: 'refunded' },
  { label: '已过期', value: 'expired' }
]

Page({
  data: {
    statusBarHeight: 44,
    titleBarHeight: 44,
    navBarHeight: 88,
    isNavScrolled: false,
    dovlinLogoDogUrl: getDovlinLogoUrl(),
    ...getNavBarInfo(typeof wx !== 'undefined' ? wx : null),
    themeClass: 'theme-day',
    tabs,
    activeStatus: 'all',
    orders: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
    contentLoaded: false,
    loadError: false,
    total: 0,
    orderKeyword: '',
    startDate: '',
    endDate: '',
    messageUnreadCount: 0,
    messageHasUnread: false
  },
  initNavBar() {
    const navInfo = getNavBarInfo(typeof wx !== 'undefined' ? wx : null)
    if (
      this.data.statusBarHeight !== navInfo.statusBarHeight ||
      this.data.titleBarHeight !== navInfo.titleBarHeight ||
      this.data.navBarHeight !== navInfo.navBarHeight
    ) {
      this.setData({
        statusBarHeight: navInfo.statusBarHeight,
        titleBarHeight: navInfo.titleBarHeight,
        navBarHeight: navInfo.navBarHeight
      })
    }
  },
  onLoad(options = {}) {
    applyDovlinLogo(this)
    this.initNavBar()
    const requestedStatus = options && (options.status || options.activeStatus)
    if (requestedStatus && tabs.some(item => item.value === requestedStatus)) {
      this.setData({ activeStatus: requestedStatus })
    }
  },
  onShow() {
    this.initNavBar()
    this.applyCurrentTheme()
    ensureLogin({ content: '登录后可查看订单。' })
      .then(() => {
        const app = typeof getApp === 'function' ? getApp() : null
        const dirty = Boolean(app && app.globalData && app.globalData.ordersDirty)
        if (dirty && app && app.globalData) app.globalData.ordersDirty = false
        if (!this._hasLoadedOnce || dirty || !this.data.orders.length) {
          this._hasLoadedOnce = true
          this.load({ reset: true })
        }
        loadMessageUnread(this)
      })
      .catch(() => wx.redirectTo({ url: '/pages/client/home/index' }))
  },
  onReachBottom() {
    this.loadMore()
  },
  onCustomRefresh() {
    return Promise.resolve(this.onPullDownRefresh()).finally(() => {
      const refreshComp = this.selectComponent('#dovlinRefresh')
      if (refreshComp) {
        refreshComp.finishRefresh('更新完毕 ✨')
      }
    })
  },
  onOrderScroll(e) {
    const scrollTop = e && e.detail && typeof e.detail.scrollTop === 'number' ? e.detail.scrollTop : 0
    const isNavScrolled = scrollTop > 15
    if (this.data.isNavScrolled !== isNavScrolled) {
      this.setData({ isNavScrolled })
    }
  },
  onPullDownRefresh() {
    return this.load({ reset: true }).finally(() => wx.stopPullDownRefresh())
  },
  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },
  load(options = {}) {
    const reset = options.reset === true
    if (!reset && this.data.loading) return
    const page = reset ? 1 : this.data.page
    const activeStatus = this.data.activeStatus
    const params = {
      role: 'client',
      page,
      pageSize: this.data.pageSize,
      orderKeyword: (this.data.orderKeyword || '').trim(),
      startDate: (this.data.startDate || '').trim(),
      endDate: (this.data.endDate || '').trim()
    }
    if (activeStatus === 'waiting_service') params.statusGroup = 'waiting_service'
    else if (activeStatus !== 'all') params.status = activeStatus

    const requestSeq = (this._requestSeq || 0) + 1
    this._requestSeq = requestSeq
    this.setData({ loading: true, loadError: false })
    return callFunction('order', 'listOrders', params)
      .then((result) => {
        if (requestSeq !== this._requestSeq) return
        const pageData = pageList(result)
        const orders = (pageData.list || []).map(withOrderText)
        this.setData({
          orders: reset ? orders : this.data.orders.concat(orders),
          page: pageData.page,
          hasMore: pageData.hasMore,
          total: pageData.total,
          loading: false,
          contentLoaded: true,
          loadError: false
        })
      })
      .catch((error) => {
        if (requestSeq !== this._requestSeq) return
        this.setData({ loading: false, loadError: reset })
        showError(error)
      })
  },
  loadMore() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 }, () => this.load())
  },
  retryLoad() {
    return this.load({ reset: true })
  },
  chooseStatus(e) {
    const status = e.currentTarget.dataset.status
    if (status === this.data.activeStatus) return
    this.setData({ activeStatus: status, page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  inputKeyword(e) {
    this.setData({ orderKeyword: e.detail.value })
  },
  confirmSearch() {
    this.setData({ page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  clearKeyword() {
    this.setData({ orderKeyword: '', page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  changeStartDate(e) {
    this.setData({ startDate: e.detail.value, page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  changeEndDate(e) {
    this.setData({ endDate: e.detail.value, page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  resetFilters() {
    this.setData({ orderKeyword: '', startDate: '', endDate: '', page: 1, hasMore: true }, () => this.load({ reset: true }))
  },
  detail(e) { wx.navigateTo({ url: '/pages/client/orders/detail/index?id=' + e.currentTarget.dataset.id }) },
  openSubscriptions() {
    ensureLogin({ content: '登录后可管理服务提醒订阅。' })
      .then(() => safeNavigateTo({ url: '/pages/common/subscriptions/index?role=client' }))
      .catch(() => {})
  },
  openGroupBuyDetail(e) {
    const groupId = e.currentTarget.dataset.groupId
    if (groupId) {
      wx.navigateTo({ url: `/pages/client/orders/group-buy/index?groupId=${encodeURIComponent(groupId)}` })
    } else {
      wx.navigateTo({ url: '/pages/client/orders/group-buy/index' })
    }
  },
  onBottomNavTap(e) {
    const detail = (e && e.detail) || {}
    if (!detail.url) return
    return this.go({ currentTarget: { dataset: { url: detail.url } } })
  },
  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    navigateRoleRoute(url, 'client')
  }
})
