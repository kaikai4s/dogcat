const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')

function validSkus(product = {}) {
  const groups = product.specGroups || []
  return (product.skus || []).filter((sku) => sku.skuId && (product.specMode !== 'multi' || groups.length) && Object.keys(sku.specs || {}).length === groups.length && groups.every((group) => group.values.includes((sku.specs || {})[group.name])) && product.skus.filter((item) => item.skuId === sku.skuId).length === 1)
}

function firstAvailableSku(product = {}) {
  const skus = validSkus(product)
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
    const merged = new Map()
    ;(product.specGroups || []).forEach((group) => {
      const name = String(group.name || '').trim()
      if (name) merged.set(name, Array.from(new Set((merged.get(name) || []).concat(group.values || []))))
    })
    product = { ...product, specGroups: Array.from(merged, ([name, values]) => ({ name, values })) }
    const sku = firstAvailableSku(product)
    this.setData({ product, quantity: 1, loading: false })
    this.applySelection(sku && sku.specs || {}, sku)
  },

  applySelection(selectedSpecs, sku) {
    const product = this.data.product
    const stock = Number(sku && sku.stock || 0)
    const selectionMessage = product.status === 'off_sale' ? '商品已下架' : !sku ? '请补选剩余属性；无匹配组合时请更换属性值' : sku.status === 'off_sale' ? '该规格已下架' : stock <= 0 ? '该规格已售罄' : ''
    this.setData({ selectedSpecs, selectedSkuId: sku ? sku.skuId : '', selectedSku: sku || null, displayImages: displayImages(product, sku || {}), quantity: Math.min(this.data.quantity, Math.max(Math.min(stock, 99), 1)), canBuy: !selectionMessage, selectionMessage })
  },

  selectSpec(e) {
    const group = e.currentTarget.dataset.group
    const value = e.currentTarget.dataset.value
    const product = this.data.product
    if (!(product.specGroups || []).some((item) => item.name === group && item.values.includes(value))) return
    const selectedSpecs = { [group]: value }
    let candidates = validSkus(product).filter((item) => item.specs[group] === value)
    // The clicked value wins; retain old selections only when a real combination supports them.
    Object.keys(this.data.selectedSpecs).filter((key) => key !== group).forEach((key) => {
      const matching = candidates.filter((item) => item.specs[key] === this.data.selectedSpecs[key])
      if (matching.length) { selectedSpecs[key] = this.data.selectedSpecs[key]; candidates = matching }
    })
    const complete = product.specGroups.every((item) => Object.prototype.hasOwnProperty.call(selectedSpecs, item.name))
    this.applySelection(selectedSpecs, complete && candidates.length === 1 ? candidates[0] : null)
  },

  changeQty(e) {
    const delta = Number(e.currentTarget.dataset.delta || 0)
    const stock = Number(this.data.selectedSku && this.data.selectedSku.stock || 1)
    this.setData({ quantity: Math.min(Math.max(this.data.quantity + delta, 1), Math.max(Math.min(stock, 99), 1)) })
  },

  inputQty(e) {
    const stock = Number(this.data.selectedSku && this.data.selectedSku.stock || 1)
    const quantity = Math.min(Math.max(Math.floor(Number(e.detail.value || 1)), 1), Math.max(Math.min(stock, 99), 1))
    this.setData({ quantity })
  },

  addCart() {
    const product = this.data.product
    const sku = this.data.selectedSku
    if (!this.data.canBuy || !product || product.status === 'off_sale' || !sku || sku.status === 'off_sale' || this.data.quantity > Number(sku.stock || 0)) return wx.showToast({ title: this.data.selectionMessage || '请选择有库存的规格', icon: 'none' })
    ensureLogin({ content: '登录后可加入购物车。' })
      .then(() => callFunction('mall', 'updateCart', { productId: product._id, skuId: sku.skuId, quantity: this.data.quantity, operation: 'add' }))
      .then(() => wx.showToast({ title: '已加入购物车' }))
      .catch(showError)
  },

  buyNow() {
    const product = this.data.product
    const sku = this.data.selectedSku
    if (!this.data.canBuy || !product || product.status === 'off_sale' || !sku || sku.status === 'off_sale' || this.data.quantity > Number(sku.stock || 0)) return wx.showToast({ title: this.data.selectionMessage || '请选择有库存的规格', icon: 'none' })
    ensureLogin({ content: '登录后可购买商品。' })
      .then(() => wx.navigateTo({ url: `/pages/client/mall/checkout/index?productId=${product._id}&skuId=${sku.skuId}&quantity=${this.data.quantity}` }))
      .catch(() => {})
  },

  cart() { wx.navigateTo({ url: '/pages/client/mall/cart/index' }) }
})
