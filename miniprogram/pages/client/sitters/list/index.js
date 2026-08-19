const { callFunction, showError, getSelectedLocation } = require('../../../../utils/cloud')
const { ensureLogin } = require('../../../../utils/cloud')
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
    allSitters: [],
    sitters: [],
    total: 0,
    loading: false
  },

  onShow() {
    this.applyCurrentTheme()
    this.loadFacets()
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  loadFacets() {
    this.setData({ loading: true })
    const loc = getSelectedLocation()
    const locParams = loc ? { latitude: loc.latitude, longitude: loc.longitude } : {}
    callFunction('staff', 'listApprovedSitters', { pageSize: 50, ...locParams })
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
    const loc = getSelectedLocation()
    const locParams = loc ? { latitude: loc.latitude, longitude: loc.longitude } : {}
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
        this.setData({ sitters: res.list || [], total: res.total || 0, loading: false })
      })
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

  inputKeyword(e) {
    this.setData({ keyword: e.detail.value })
  },

  search() {
    this.loadSitters()
  },

  chooseCity(e) {
    this.setData({ activeCity: e.currentTarget.dataset.city, activeArea: ALL }, () => {
      this.refreshOptions()
      this.loadSitters()
    })
  },

  chooseArea(e) {
    this.setData({ activeArea: e.currentTarget.dataset.area }, this.loadSitters)
  },

  chooseSort(e) {
    this.setData({ sortBy: e.currentTarget.dataset.sort }, this.loadSitters)
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
    wx.redirectTo({ url })
  },

  goProtected(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    ensureLogin({ content: '登录后可查看订单。' })
      .then(() => wx.redirectTo({ url }))
      .catch(() => {})
  }
})
