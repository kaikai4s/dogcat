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
    total: 0
  },

  onLoad() {
    this.loadCategories()
    this.loadProducts({ reset: true })
  },

  onPullDownRefresh() {
    Promise.all([this.loadCategories(), this.loadProducts({ reset: true })]).finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadMore()
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
          loading: false
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
