const { callFunction, showError, getSelectedLocation, chooseSelectedLocation } = require('../../../../utils/cloud')
const { ensureLogin } = require('../../../../utils/cloud')
const { loadMessageUnread } = require('../../../../utils/client-nav')
const { applyTheme, getThemeState } = require('../../../../utils/theme')

const ALL = '全部'
const sortOptions = [
  { label: '推荐', value: 'default' },
  { label: '距离最近', value: 'distance' },
  { label: '评分最高', value: 'rating' },
  { label: '最近更新', value: 'latest' },
  { label: '城市优先', value: 'city' }
]

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)))
}

function areaTags(sitter) {
  return Array.isArray(sitter.areaTags) ? sitter.areaTags : []
}

Page({
  data: {
    themeClass: 'theme-day',
    keyword: '',
    activeCity: ALL,
    activeArea: ALL,
    sortBy: 'default',
    sortOptions,
    cityOptions: [ALL],
    areaOptions: [ALL],
    locationName: '',
    locationAddress: '',
    allSitters: [],
    sitters: [],
    total: 0,
    loading: false,
    messageUnreadCount: 0,
    messageHasUnread: false
  },

  onShow() {
    this.applyCurrentTheme()
    this.syncCurrentLocation()
    this.loadFacets()
    loadMessageUnread(this)
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  syncCurrentLocation() {
    const loc = getSelectedLocation()
    this.setData({
      locationName: loc ? (loc.name || '已选择位置') : '未选择定位',
      locationAddress: loc ? (loc.address || '') : '点击选择具体位置以精准计算服务范围'
    })
  },

  loadFacets() {
    this.setData({ loading: true })
    this.syncCurrentLocation()
    // 首次拉取城市选项时，不加定位过滤，以便展示系统中全量服务城市
    callFunction('staff', 'listApprovedSitters', { pageSize: 50 })
      .then((res) => {
        const allSitters = res.list || []
        this.setData({ allSitters }, () => {
          this.refreshOptions()
          this.loadSitters()
        })
      })
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

  refreshOptions() {
    const { allSitters, activeCity } = this.data
    const cityOptions = [ALL, ...unique(allSitters.map((item) => item.serviceCity).filter((city) => city && city !== '服务城市待完善'))]
    const source = activeCity === ALL ? allSitters : allSitters.filter((item) => item.serviceCity === activeCity)
    const areaOptions = [ALL, ...unique(source.reduce((list, item) => list.concat(areaTags(item)), []))]
    this.setData({ cityOptions, areaOptions })
  },

  loadSitters() {
    const { keyword, activeCity, activeArea, sortBy } = this.data
    this.syncCurrentLocation()
    const loc = getSelectedLocation()
    const locParams = loc ? { latitude: loc.latitude, longitude: loc.longitude } : {}
    const requestSeq = (this._requestSeq || 0) + 1
    this._requestSeq = requestSeq
    this.setData({ loading: true })
    callFunction('staff', 'listApprovedSitters', {
      keyword,
      serviceCity: activeCity === ALL ? '' : activeCity,
      serviceArea: activeArea === ALL ? '' : activeArea,
      sortBy,
      pageSize: 50,
      ...locParams
    })
      .then((res) => {
        if (requestSeq !== this._requestSeq) return
        this.setData({ sitters: res.list || [], total: res.total || 0, loading: false })
      })
      .catch((error) => {
        if (requestSeq !== this._requestSeq) return
        this.setData({ loading: false })
        showError(error)
      })
  },

  updateLocation() {
    chooseSelectedLocation()
      .then((loc) => {
        this.setData({
          locationName: loc.name || '已选择位置',
          locationAddress: loc.address || '已选择服务附近位置'
        })
        this.loadSitters()
      })
      .catch((err) => {
        const errMsg = (err && err.errMsg) || ''
        if (errMsg.includes('cancel')) return
        wx.showToast({ title: '获取位置失败', icon: 'none' })
      })
  },

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  search() {
    this.loadSitters()
  },

  chooseCity(e) {
    const city = e.currentTarget.dataset.city
    if (city === this.data.activeCity) return
    this.setData({ activeCity: city, activeArea: ALL }, () => {
      this.refreshOptions()
      this.loadSitters()
    })
  },

  chooseArea(e) {
    const area = e.currentTarget.dataset.area
    if (area === this.data.activeArea) return
    this.setData({ activeArea: area }, () => this.loadSitters())
  },

  chooseSort(e) {
    const sort = e.currentTarget.dataset.sort
    if (sort === this.data.sortBy) return
    this.setData({ sortBy: sort }, () => this.loadSitters())
  },

  clearFilters() {
    this.setData({ keyword: '', activeCity: ALL, activeArea: ALL, sortBy: 'default' }, () => {
      this.refreshOptions()
      this.loadSitters()
    })
  },

  detail(e) {
    wx.navigateTo({ url: '/pages/client/sitters/detail/index?id=' + e.currentTarget.dataset.id })
  },

  book(e) {
    const staffProfileId = e.currentTarget.dataset.id
    const url = staffProfileId
      ? `/pages/client/orders/create/index?publishMode=direct&staffProfileId=${staffProfileId}`
      : '/pages/client/orders/create/index?publishMode=open'
    ensureLogin({ content: '登录后可预约宠托师。' })
      .then(() => wx.navigateTo({ url }))
      .catch(() => {})
  },

  openPublish() {
    ensureLogin({ content: '登录后可发布预约。' })
      .then(() => wx.navigateTo({ url: '/pages/client/orders/create/index?publishMode=open' }))
      .catch(() => {})
  },

  showAreas(e) {
    wx.showModal({
      title: '服务区域',
      content: e.currentTarget.dataset.area || '服务区域待完善',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/client/home/index', '/pages/client/sitters/list/index', '/pages/client/orders/list/index', '/pages/client/messages/index', '/pages/client/profile/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  },

  goProtected(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    ensureLogin({ content: '登录后可查看订单和消息。' })
      .then(() => {
        const pages = getCurrentPages()
        const current = pages[pages.length - 1]
        const currentRoute = current && current.route ? '/' + current.route : ''
        if (currentRoute === url) return
        const mainNavUrls = ['/pages/client/home/index', '/pages/client/sitters/list/index', '/pages/client/orders/list/index', '/pages/client/messages/index', '/pages/client/profile/index']
        const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
        wx[method]({ url })
      })
      .catch(() => {})
  }
})
