const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')

Page({
  data: { cart: { items: [], selectedCount: 0, totalAmount: 0 }, loading: false, updatingId: '' },

  onShow() {
    ensureLogin({ content: '登录后可查看购物车。' })
      .then(() => this.load())
      .catch(() => wx.navigateBack())
  },

  load() {
    this.setData({ loading: true })
    callFunction('mall', 'getCart')
      .then((cart) => this.setData({ cart, loading: false }))
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

  updateItem(productId, skuId, quantity, selected) {
    if (this.data.updatingId) return
    this.setData({ updatingId: `${productId}_${skuId || 'default'}` })
    callFunction('mall', 'updateCart', { productId, skuId: skuId || 'default', quantity, selected })
      .then((cart) => this.setData({ cart, updatingId: '' }))
      .catch((error) => {
        this.setData({ updatingId: '' })
        showError(error)
      })
  },

  itemSkuId(item) { return item && item.skuId || 'default' },

  changeQty(e) {
    const item = this.data.cart.items[e.currentTarget.dataset.index]
    if (!item) return
    this.updateItem(item.productId, this.itemSkuId(item), Number(item.quantity || 1) + Number(e.currentTarget.dataset.delta || 0), item.selected !== false)
  },

  toggle(e) {
    const item = this.data.cart.items[e.currentTarget.dataset.index]
    if (!item) return
    this.updateItem(item.productId, this.itemSkuId(item), item.quantity, item.selected === false)
  },

  remove(e) {
    const item = this.data.cart.items[e.currentTarget.dataset.index]
    if (!item) return
    wx.showModal({
      title: '移除商品',
      content: '确认从购物车移除此商品吗？',
      success: (res) => {
        if (!res.confirm) return
        callFunction('mall', 'updateCart', { productId: item.productId, skuId: this.itemSkuId(item), operation: 'remove' })
          .then((cart) => this.setData({ cart }))
          .catch(showError)
      }
    })
  },

  checkout() {
    if (!this.data.cart.selectedCount) {
      wx.showToast({ title: '请选择商品', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/client/mall/checkout/index' })
  },

  detail(e) { wx.navigateTo({ url: '/pages/client/mall/detail/index?id=' + e.currentTarget.dataset.id }) }
})
