const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')

function firstAvailableSku(product = {}) {
  const skus = Array.isArray(product.skus) ? product.skus : []
  return skus.find((sku) => sku.status !== 'off_sale' && Number(sku.stock || 0) > 0) || skus[0] || null
}

function displayImages(product = {}, sku = {}) {
  const images = []
  if (sku.imageFileId) images.push(sku.imageFileId)
  ;(product.imageFileIds || []).forEach((item) => { if (item && !images.includes(item)) images.push(item) })
  if (product.coverFileId && !images.includes(product.coverFileId)) images.unshift(product.coverFileId)
  return images
}

Page({
  data: { id: '', product: null, quantity: 1, selectedSpecs: {}, selectedSkuId: '', selectedSku: null, displayImages: [], loading: false },

  onLoad(query) {
    this.setData({ id: query.id || query.productId || '' })
    this.load()
  },

  load() {
    if (!this.data.id) return
    this.setData({ loading: true })
    callFunction('mall', 'getProductDetail', { id: this.data.id })
      .then((product) => this.initSkuSelection(product))
      .catch((error) => {
        this.setData({ loading: false })
        showError(error)
      })
  },

  initSkuSelection(product) {
    const sku = firstAvailableSku(product)
    this.setData({ product, selectedSkuId: sku ? sku.skuId : '', selectedSku: sku, selectedSpecs: sku && sku.specs || {}, displayImages: displayImages(product, sku || {}), quantity: 1, loading: false })
  },

  selectSpec(e) {
    const group = e.currentTarget.dataset.group
    const value = e.currentTarget.dataset.value
    const selectedSpecs = { ...this.data.selectedSpecs, [group]: value }
    const sku = (this.data.product.skus || []).find((item) => {
      const specs = item.specs || {}
      return Object.keys(selectedSpecs).every((key) => specs[key] === selectedSpecs[key])
    })
    if (!sku) return
    const stock = Number(sku.stock || 0)
    this.setData({ selectedSpecs, selectedSkuId: sku.skuId, selectedSku: sku, displayImages: displayImages(this.data.product, sku), quantity: Math.min(this.data.quantity, Math.max(stock, 1)) })
  },

  changeQty(e) {
    const delta = Number(e.currentTarget.dataset.delta || 0)
    const stock = Number(this.data.selectedSku && this.data.selectedSku.stock || 1)
    this.setData({ quantity: Math.min(Math.max(this.data.quantity + delta, 1), Math.max(stock, 1)) })
  },

  inputQty(e) {
    const stock = Number(this.data.selectedSku && this.data.selectedSku.stock || 1)
    const quantity = Math.min(Math.max(Math.floor(Number(e.detail.value || 1)), 1), Math.max(stock, 1))
    this.setData({ quantity })
  },

  addCart() {
    const product = this.data.product
    const sku = this.data.selectedSku
    if (!product || product.soldOut || !sku || Number(sku.stock || 0) <= 0) return wx.showToast({ title: '请选择有库存的规格', icon: 'none' })
    ensureLogin({ content: '登录后可加入购物车。' })
      .then(() => callFunction('mall', 'updateCart', { productId: product._id, skuId: sku.skuId, quantity: this.data.quantity, operation: 'add' }))
      .then(() => wx.showToast({ title: '已加入购物车' }))
      .catch(showError)
  },

  buyNow() {
    const product = this.data.product
    const sku = this.data.selectedSku
    if (!product || product.soldOut || !sku || Number(sku.stock || 0) <= 0) return wx.showToast({ title: '请选择有库存的规格', icon: 'none' })
    ensureLogin({ content: '登录后可购买商品。' })
      .then(() => wx.navigateTo({ url: `/pages/client/mall/checkout/index?productId=${product._id}&skuId=${sku.skuId}&quantity=${this.data.quantity}` }))
      .catch(() => {})
  },

  cart() { wx.navigateTo({ url: '/pages/client/mall/cart/index' }) }
})
