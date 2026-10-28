const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')

function pageList(result) {
  return Array.isArray(result) ? { list: result, hasMore: false, page: 1, total: result.length } : (result || { list: [], hasMore: false, page: 1, total: 0 })
}

Page({
  data: {
    categories: [],
    products: [],
    categoryId: '',
    keyword: '',
    sort: '',
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
    total: 0,
    localLoaded: false,
    configLoaded: false,
    shopConfigError: false,
    shopSupported: true,
    shopPreviewMode: false,
    shopConfig: { enabled: false, appid: '' },
    mallMode: 'local',
    preferredMallMode: 'shop'
  },

  onLoad() {
    this.loadShopConfig(true).then(() => {
      if (this.data.mallMode === 'local') return this.loadLocalMall()
    })
  },

  onShow() {
    if (this.data.configLoaded) this.loadShopConfig(false)
  },

  loadShopConfig(initial) {
    const requestId = (this._shopConfigRequestId || 0) + 1
    this._shopConfigRequestId = requestId
    const device = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() :
      (typeof wx.getSystemInfoSync === 'function' ? wx.getSystemInfoSync() : {})
    const shopPreviewMode = device.platform === 'devtools'
    const shopSupported = !/^(mac|windows)/i.test(device.platform || '') &&
      (typeof wx.canIUse !== 'function' || wx.canIUse('store-home'))
    return callFunction('mall', 'getShopConfig')
      .then((shopConfig) => {
        if (requestId !== this._shopConfigRequestId) return
        const enabled = shopConfig.enabled === true && !!shopConfig.appid
        const mode = enabled && shopSupported && this.data.preferredMallMode === 'shop' ? 'shop' : 'local'
        const fellBack = this.data.mallMode === 'shop' && mode === 'local'
        this.setData({ shopConfig: { enabled, appid: shopConfig.appid || '' }, shopSupported, shopPreviewMode, mallMode: mode, configLoaded: true, shopConfigError: false })
        if (fellBack && !this.data.localLoaded) return this.loadLocalMall()
      })
      .catch(() => {
        if (requestId !== this._shopConfigRequestId) return
        this.setData({ shopConfigError: true, configLoaded: true })
        if (!initial && this.data.mallMode === 'local' && !this.data.localLoaded) return this.loadLocalMall()
      })
  },

  retryShopConfig() { return this.loadShopConfig(false) },

  loadLocalMall() {
    return Promise.all([this.loadCategories(), this.loadProducts({ reset: true })])
  },

  switchMallMode(e) {
    const mode = e.currentTarget.dataset.mode
    if (!['local', 'shop'].includes(mode) || mode === this.data.mallMode || (mode === 'shop' && (!this.data.shopConfig.enabled || !this.data.shopSupported))) return
    this.setData({ mallMode: mode, preferredMallMode: mode })
    if (mode === 'local' && !this.data.localLoaded) return this.loadLocalMall()
  },

  onCustomRefresh() {
    return Promise.resolve(this.onPullDownRefresh()).finally(() => {
      const refreshComp = this.selectComponent('#dovlinRefresh')
      if (refreshComp) {
        refreshComp.finishRefresh('更新完毕 ✨')
      }
    })
  },

  onPullDownRefresh() {
    const request = this.data.mallMode === 'shop'
      ? this.loadShopConfig(false)
      : Promise.all([this.loadShopConfig(false), this.loadLocalMall()])
    return Promise.resolve(request).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.mallMode === 'local') this.loadMore()
  },

  loadCategories() {
    return callFunction('mall', 'listCategories')
      .then((categories) => this.setData({ categories }))
      .catch(showError)
  },

  loadProducts(options = {}) {
    if (this.data.loading) return Promise.resolve()
    const reset = options.reset === true
    const page = reset ? 1 : this.data.page
    this.setData({ loading: true })
    return callFunction('mall', 'listProducts', { keyword: this.data.keyword, categoryId: this.data.categoryId, sort: this.data.sort, page, pageSize: this.data.pageSize })
      .then((result) => {
        const pageData = pageList(result)
        this.setData({
          products: reset ? pageData.list : this.data.products.concat(pageData.list),
          page: pageData.page,
          hasMore: pageData.hasMore,
          total: pageData.total,
          loading: false,
          localLoaded: true
        })
      })
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

  loadMore() {
    if (!this.data.hasMore || this.data.loading) return
    this.setData({ page: this.data.page + 1 }, () => this.loadProducts())
  },

  inputKeyword(e) { this.setData({ keyword: e.detail.value }) },
  search() { this.setData({ page: 1, hasMore: true }, () => this.loadProducts({ reset: true })) },
  chooseCategory(e) { this.setData({ categoryId: e.currentTarget.dataset.id || '', page: 1, hasMore: true }, () => this.loadProducts({ reset: true })) },
  chooseSort(e) { this.setData({ sort: e.currentTarget.dataset.sort || '', page: 1, hasMore: true }, () => this.loadProducts({ reset: true })) },

  detail(e) { wx.navigateTo({ url: '/pages/client/mall/detail/index?id=' + e.currentTarget.dataset.id }) },
  cart() { ensureLogin({ content: '登录后可查看购物车。' }).then(() => wx.navigateTo({ url: '/pages/client/mall/cart/index' })).catch(() => {}) },
  orders() { ensureLogin({ content: '登录后可查看商城订单。' }).then(() => wx.navigateTo({ url: '/pages/client/mall/orders/list/index' })).catch(() => {}) },

  addCart(e) {
    const productId = e.currentTarget.dataset.id
    const product = this.data.products[e.currentTarget.dataset.index]
    if (product && product.hasSku) {
      wx.navigateTo({ url: '/pages/client/mall/detail/index?id=' + productId })
      return
    }
    ensureLogin({ content: '登录后可加入购物车。' })
      .then(() => callFunction('mall', 'updateCart', { productId, skuId: product && product.selectedSkuId || 'default', quantity: 1, operation: 'add' }))
      .then(() => wx.showToast({ title: '已加入购物车' }))
      .catch(showError)
  }
})
