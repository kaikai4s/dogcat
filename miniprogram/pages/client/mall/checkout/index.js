const { callFunction, showError, ensureLogin, requestSubscribeTemplates } = require('../../../../utils/cloud')
const { createClientRequestId } = require('../../../../utils/offlineQueue')

function calcPreview(items = [], coupon = null) {
  const totalProductAmount = Math.round(items.reduce((sum, item) => sum + Number(item.price || (item.product && item.product.price) || 0) * Number(item.quantity || 0), 0) * 100) / 100
  const shippingFee = totalProductAmount >= 99 || totalProductAmount <= 0 ? 0 : 8
  const amount = Math.round((totalProductAmount + shippingFee) * 100) / 100
  const minOrderAmount = Number(coupon && coupon.minOrderAmount || 0)
  const canUseCoupon = coupon && coupon.applicable !== false && amount >= minOrderAmount
  const discountAmount = canUseCoupon ? Math.min(Number(coupon.discountAmount || 0), amount) : 0
  const payAmount = Math.round(Math.max(amount - discountAmount, 0) * 100) / 100
  return { totalProductAmount, shippingFee, discountAmount, payAmount }
}

function chooseSku(product = {}, skuId = '') {
  const skus = Array.isArray(product.skus) ? product.skus : []
  return skus.find((sku) => sku.skuId === skuId) || skus.find((sku) => sku.status !== 'off_sale' && Number(sku.stock || 0) > 0) || skus[0] || null
}

Page({
  data: { productId: '', skuId: '', quantity: 1, items: [], address: null, coupons: [], couponId: '', couponName: '', pricing: { totalProductAmount: 0, shippingFee: 0, discountAmount: 0, payAmount: 0 }, submitting: false, pendingOrderId: '' },

  onLoad(query) {
    this.setData({ productId: query.productId || '', skuId: query.skuId || '', quantity: Math.max(Math.floor(Number(query.quantity || 1)), 1) })
  },

  onShow() {
    ensureLogin({ content: '登录后可结算商品。' })
      .then(() => Promise.all([this.loadItems().then(() => this.loadCoupons()), this.loadAddress()]))
      .catch(() => wx.navigateBack())
  },

  loadItems() {
    if (this.data.productId) {
      return callFunction('mall', 'getProductDetail', { id: this.data.productId }).then((product) => {
        const sku = chooseSku(product, this.data.skuId)
        if (!sku || Number(sku.stock || 0) <= 0) throw new Error('请选择有库存的规格')
        const items = [{ productId: product._id, skuId: sku.skuId, name: product.name, coverFileId: sku.imageFileId || product.coverFileId || (product.imageFileIds || [])[0], price: sku.price, quantity: this.data.quantity, specText: sku.specText }]
        this.setData({ items, skuId: sku.skuId }, () => this.refreshPricing())
      }).catch(showError)
    }
    return callFunction('mall', 'getCart').then((cart) => {
      const items = (cart.items || []).filter((item) => item.selected !== false && !item.invalid && !item.soldOut).map((item) => ({ ...item, name: item.snapshot && item.snapshot.name || item.product.name, coverFileId: item.snapshot && item.snapshot.coverFileId || item.product.coverFileId, price: item.price || item.snapshot && item.snapshot.price || item.product.price, specText: item.specText || item.snapshot && item.snapshot.specText || item.product.specText }))
      this.setData({ items }, () => this.refreshPricing())
    }).catch(showError)
  },

  loadAddress() {
    return callFunction('client', 'listAddresses', { page: 1, pageSize: 20 })
      .then((result) => {
        const list = Array.isArray(result) ? result : (result.list || [])
        const address = list.find((item) => item.isDefault) || list[0] || null
        if (address && !this.data.address) this.applyAddress(address)
      })
      .catch(() => {})
  },

  loadCoupons() {
    const items = this.data.items.map((item) => ({ productId: item.productId, skuId: item.skuId, price: item.price, quantity: item.quantity }))
    return callFunction('coupon', 'listMallCoupons', { items })
      .then((coupons) => this.setData({ coupons: (coupons || []).filter((item) => item.status === 'available') }, () => this.refreshPricing()))
      .catch(() => {})
  },

  applyAddress(address) {
    this.setData({ address: { contactName: address.contactName || address.name, contactPhone: address.contactPhone || address.phone, serviceAddress: address.serviceAddress || address.address, addressDetail: address.addressDetail || address.detail, doorplate: address.doorplate || '' } })
  },

  chooseAddress() { wx.navigateTo({ url: '/pages/client/addresses/list/index?select=1' }) },

  refreshPricing() {
    const coupon = this.data.coupons.find((item) => item._id === this.data.couponId) || null
    this.setData({ pricing: calcPreview(this.data.items, coupon) })
  },

  chooseCoupon(e) {
    const coupon = this.data.coupons[e.detail.value]
    this.setData({ couponId: coupon ? coupon._id : '', couponName: coupon ? coupon.name : '' }, () => this.refreshPricing())
  },

  clearCoupon() {
    this.setData({ couponId: '', couponName: '' }, () => this.refreshPricing())
  },

  submit() {
    if (this.data.submitting) return
    if (!this.data.items.length) {
      wx.showToast({ title: '请选择商品', icon: 'none' })
      return
    }
    if (!this.data.address) {
      wx.showToast({ title: '请选择收货地址', icon: 'none' })
      return
    }
    const data = { shippingAddress: this.data.address, couponId: this.data.couponId, clientRequestId: createClientRequestId('mall_order') }
    if (this.data.productId) Object.assign(data, { productId: this.data.productId, skuId: this.data.skuId, quantity: this.data.quantity })
    this.setData({ submitting: true })
    callFunction('mall', 'createOrder', data)
      .then((order) => {
        this.setData({ pendingOrderId: order._id })
        return requestSubscribeTemplates(['refundResult'], 'mall_pay').catch(() => null).then(() => order)
      })
      .then((order) => callFunction('payment', 'createPayment', { orderId: order._id, clientRequestId: createClientRequestId('mall_pay') }).then((payment) => ({ order, payment })))
      .then(({ order, payment }) => {
        if (payment.paid) return order
        if (payment.mock) return callFunction('payment', 'mockPayOrder', { orderId: order._id, paymentNo: payment.paymentNo }).then(() => order)
        if (!payment.payParams) throw new Error(payment.message || '微信支付参数未配置')
        return new Promise((resolve, reject) => wx.requestPayment({ ...payment.payParams, success: resolve, fail: reject })).then(() => order)
      })
      .then((order) => {
        wx.showToast({ title: '下单成功' })
        wx.redirectTo({ url: '/pages/client/mall/orders/detail/index?id=' + order._id })
      })
      .catch((error) => {
        this.setData({ submitting: false })
        const msg = error && (error.errMsg || error.message) || ''
        if (msg.includes('cancel') && this.data.pendingOrderId) {
          wx.showModal({
            title: '已取消支付',
            content: '订单已创建，可前往订单详情继续支付。',
            confirmText: '查看订单',
            success: (res) => {
              if (res.confirm) wx.redirectTo({ url: '/pages/client/mall/orders/detail/index?id=' + this.data.pendingOrderId })
            }
          })
        } else if (msg.includes('cancel')) wx.showToast({ title: '已取消支付，可在订单中继续支付', icon: 'none' })
        else showError(error)
      })
  }
})
