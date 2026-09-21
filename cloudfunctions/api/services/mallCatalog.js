module.exports = function createService({
  applyCouponToPricing,
  db,
  getDocOrNull,
  now,
  safeFileId,
  safeText
}) {
  function createMallOrderNo() {
    return `M${Date.now()}${Math.floor(Math.random() * 1000)}`
  }

  function normalizeMallCategory(category = {}) {
    return {
      _id: category._id || '',
      name: safeText(category.name).trim(),
      icon: safeText(category.icon).trim(),
      enabled: category.enabled !== false,
      sortOrder: Number(category.sortOrder || 0),
      createdAt: category.createdAt || null,
      updatedAt: category.updatedAt || null
    }
  }

  function createMallSkuId(index = 0) {
    return `sku_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`
  }

  function normalizeMallSpecGroups(groups = []) {
    const merged = new Map()
    ;(Array.isArray(groups) ? groups : []).forEach((group) => {
      const name = safeText(group && group.name).trim()
      const values = group && Array.isArray(group.values) ? group.values.map((item) => safeText(item).trim()).filter(Boolean) : []
      if (!name || !values.length) return
      merged.set(name, Array.from(new Set((merged.get(name) || []).concat(values))))
    })
    return Array.from(merged, ([name, values]) => ({ name, values }))
  }

  function validateMallProductInput(data) {
    const validateNumbers = (item) => {
      for (const field of ['price', 'originalPrice', 'stock']) {
        const raw = item[field] == null && field === 'originalPrice' ? 0 : item[field]
        const value = Number(raw)
        if (!['number', 'string'].includes(typeof raw) || String(raw).trim() === '' || !Number.isFinite(value) || value < 0 || (field === 'price' && value <= 0) || (field === 'stock' && !Number.isSafeInteger(value)) || (field !== 'stock' && Math.abs(value * 100 - Math.round(value * 100)) > 1e-7)) {
          throw new Error(field === 'stock' ? '库存必须为非负整数' : (field === 'price' ? '售价必须大于0' : '金额必须为非负数且最多两位小数'))
        }
      }
    }
    if (data.specMode !== 'multi') { validateNumbers(data); return }
    const groups = data.specGroups
    if (!Array.isArray(groups) || !groups.length || groups.length > 3) throw new Error('请填写1至3个属性')
    const names = new Set()
    groups.forEach((group) => {
      const name = safeText(group && group.name).trim()
      if (!name || names.has(name)) throw new Error('属性名称不能为空或重复')
      names.add(name)
      if (!Array.isArray(group.values) || !group.values.length || group.values.length > 20) throw new Error('每个属性须有1至20个值')
      const values = group.values.map((value) => safeText(value).trim())
      if (values.some((value) => !value) || new Set(values).size !== values.length) throw new Error('属性值不能为空或重复')
    })
    if (!Array.isArray(data.skus) || !data.skus.length || data.skus.length > 80) throw new Error('请同步1至80个SKU')
    const ids = new Set()
    const combinations = new Set()
    data.skus.forEach((sku) => {
      const id = safeText(sku.skuId).trim()
      if (!id || ids.has(id)) throw new Error('SKU ID不能为空或重复')
      ids.add(id)
      const specs = sku.specs
      if (!specs || Array.isArray(specs) || Object.keys(specs).length !== groups.length || groups.some((group) => {
        const name = safeText(group.name).trim()
        return !Object.prototype.hasOwnProperty.call(specs, name) || !group.values.map((value) => safeText(value).trim()).includes(safeText(specs[name]).trim())
      })) throw new Error('属性与SKU不一致，请重新同步SKU')
      const key = JSON.stringify(Array.from(names).sort().map((name) => [name, safeText(specs[name]).trim()]))
      if (combinations.has(key)) throw new Error('SKU组合不能重复')
      combinations.add(key)
      validateNumbers(sku)
    })
  }

  function normalizeMallSku(raw = {}, index = 0, specGroups = []) {
    const specs = raw.specs && typeof raw.specs === 'object' ? raw.specs : {}
    const normalizedSpecs = {}
    specGroups.forEach((group) => {
      const value = safeText(specs[group.name]).trim()
      if (value) normalizedSpecs[group.name] = value
    })
    const specText = safeText(raw.specText).trim() || Object.values(normalizedSpecs).join(' / ') || '默认规格'
    return {
      skuId: safeText(raw.skuId || raw.id).trim() || (index === 0 ? 'default' : createMallSkuId(index)),
      specs: normalizedSpecs,
      specText,
      price: Math.max(Number(raw.price || 0), 0),
      originalPrice: Math.max(Number(raw.originalPrice || 0), 0),
      stock: Math.max(Math.floor(Number(raw.stock || 0)), 0),
      salesCount: Math.max(Math.floor(Number(raw.salesCount || 0)), 0),
      imageFileId: safeFileId(raw.imageFileId) || safeText(raw.imageFileId).trim(),
      status: raw.status === 'off_sale' ? 'off_sale' : 'on_sale'
    }
  }

  function normalizeMallSkus(product = {}, specGroups = []) {
    const rawSkus = Array.isArray(product.skus) ? product.skus : []
    const sourceSkus = product.specMode === 'multi' ? rawSkus : [{ skuId: rawSkus.length === 1 ? rawSkus[0].skuId || 'default' : 'default', specs: {}, specText: product.specText || '默认规格', price: product.price, originalPrice: product.originalPrice, stock: product.stock, salesCount: product.salesCount, status: rawSkus.length === 1 ? rawSkus[0].status : 'on_sale' }]
    return sourceSkus.map((sku, index) => normalizeMallSku(sku, index, specGroups))
  }

  function deriveMallProductFields(product = {}) {
    const skus = normalizeMallSkus(product, product.specGroups || [])
    const activeSkus = skus.filter((sku) => sku.status !== 'off_sale')
    const priceSkus = activeSkus.length ? activeSkus : skus
    const prices = priceSkus.map((sku) => Number(sku.price || 0)).filter((price) => Number.isFinite(price) && price >= 0)
    const minPrice = prices.length ? Math.min(...prices) : Math.max(Number(product.price || 0), 0)
    const maxPrice = prices.length ? Math.max(...prices) : minPrice
    const totalStock = activeSkus.reduce((sum, sku) => sum + Number(sku.stock || 0), 0)
    const salesCount = skus.reduce((sum, sku) => sum + Number(sku.salesCount || 0), 0) || Math.max(Math.floor(Number(product.salesCount || 0)), 0)
    const firstSku = priceSkus[0] || skus[0] || {}
    return { skus, minPrice, maxPrice, totalStock, price: minPrice, originalPrice: Number(firstSku.originalPrice == null ? product.originalPrice || 0 : firstSku.originalPrice), stock: totalStock, salesCount, specText: firstSku.specText || product.specText || '默认规格' }
  }

  function normalizeMallProduct(product = {}) {
    const specGroups = normalizeMallSpecGroups(product.specGroups)
    const specMode = product.specMode === 'multi' && specGroups.length ? 'multi' : 'single'
    const imageFileIds = Array.isArray(product.imageFileIds) ? product.imageFileIds.map((item) => safeFileId(item) || safeText(item).trim()).filter(Boolean).slice(0, 9) : []
    const base = {
      _id: product._id || '',
      categoryId: safeText(product.categoryId).trim(),
      name: safeText(product.name).trim(),
      subtitle: safeText(product.subtitle).trim(),
      coverFileId: safeFileId(product.coverFileId) || safeText(product.coverFileId).trim(),
      imageFileIds,
      specMode,
      specGroups: specMode === 'multi' ? specGroups : [],
      status: product.status === 'off_sale' ? 'off_sale' : 'on_sale',
      description: safeText(product.description).trim(),
      sortOrder: Number(product.sortOrder || 0),
      createdAt: product.createdAt || null,
      updatedAt: product.updatedAt || null
    }
    const derived = deriveMallProductFields({ ...product, specGroups: base.specGroups })
    return { ...base, ...derived }
  }

  function getProductSkus(product = {}) {
    return normalizeMallProduct(product).skus
  }

  function getSkuById(product = {}, skuId = '') {
    const skus = getProductSkus(product)
    const targetSkuId = safeText(skuId).trim()
    const sku = targetSkuId ? skus.find((item) => item.skuId === targetSkuId) : (product.specMode !== 'multi' ? skus[0] : null)
    if (!sku) return null
    if (product.specMode === 'multi') {
      const groups = normalizeMallSpecGroups(product.specGroups)
      if (!groups.length || groups.some((group) => !group.values.includes(sku.specs[group.name]))) return null
      if (skus.filter((item) => item.skuId === sku.skuId).length !== 1) return null
    }
    return sku
  }

  function formatMallPrice(product = {}) {
    const minPrice = Number(product.minPrice || product.price || 0)
    const maxPrice = Number(product.maxPrice || minPrice)
    return minPrice === maxPrice ? `¥${minPrice}` : `¥${minPrice}-${maxPrice}`
  }

  function publicMallProduct(product = {}) {
    const p = normalizeMallProduct(product)
    const selectedSku = p.skus.find((sku) => sku.status !== 'off_sale' && sku.stock > 0) || p.skus[0] || null
    return {
      ...p,
      skuCount: p.skus.length,
      hasSku: p.skus.length > 1 || p.specMode === 'multi',
      selectedSkuId: selectedSku ? selectedSku.skuId : '',
      soldOut: p.stock <= 0,
      displayPrice: formatMallPrice(p),
      priceText: formatMallPrice(p),
      imageFileIds: p.imageFileIds.length ? p.imageFileIds : (p.coverFileId ? [p.coverFileId] : [])
    }
  }

  function mallOrderStatusText(status) {
    const labels = { pending_pay: '待付款', pending_ship: '待发货', shipped: '已发货', completed: '已完成', cancelled: '已取消', refund_applied: '售后中', refunded: '已退款' }
    return labels[status] || '未知'
  }

  function normalizeShippingAddress(data = {}) {
    const contactName = safeText(data.contactName || data.name || data.receiverName).trim()
    const contactPhone = safeText(data.contactPhone || data.phone || data.receiverPhone).trim()
    const serviceAddress = safeText(data.serviceAddress || data.address || data.addressName).trim()
    const addressDetail = safeText(data.addressDetail || data.detail).trim()
    const doorplate = safeText(data.doorplate).trim()
    if (!contactName) throw new Error('请填写收货人')
    if (!contactPhone) throw new Error('请填写收货手机号')
    if (!serviceAddress) throw new Error('请选择收货地址')
    if (!addressDetail) throw new Error('请填写详细地址')
    return { contactName, contactPhone, serviceAddress, addressDetail, doorplate, fullAddress: [serviceAddress, addressDetail, doorplate].filter(Boolean).join(' ') }
  }

  function buildMallCartItem(product, sku, quantity, data = {}) {
    const time = now()
    return {
      productId: product._id,
      skuId: sku.skuId,
      quantity: Math.min(Math.max(Math.floor(Number(quantity || 1)), 1), 99),
      selected: data.selected !== false,
      snapshot: { name: product.name, coverFileId: sku.imageFileId || product.coverFileId || '', specText: sku.specText || '', price: Number(sku.price || 0), originalPrice: Number(sku.originalPrice || 0), specs: sku.specs || {}, imageFileId: sku.imageFileId || '' },
      updatedAt: data.updatedAt || time
    }
  }

  function isSameMallCartItem(a = {}, b = {}) {
    return a.productId === b.productId && safeText(a.skuId || 'default').trim() === safeText(b.skuId || 'default').trim()
  }

  async function loadMallCart(openid) {
    const res = await db.collection('mall_carts').where({ openid }).limit(1).get()
    return res.data[0] || null
  }

  async function saveMallCart(openid, items = []) {
    const time = now()
    const normalizedItems = items.filter((item) => item && item.productId && Number(item.quantity || 0) > 0).map((item) => ({ productId: item.productId, skuId: safeText(item.skuId || 'default').trim() || 'default', quantity: Math.min(Math.max(Math.floor(Number(item.quantity || 1)), 1), 99), selected: item.selected !== false, snapshot: item.snapshot || null, updatedAt: item.updatedAt || time }))
    const existing = await loadMallCart(openid)
    if (existing) {
      await db.collection('mall_carts').doc(existing._id).update({ data: { items: normalizedItems, updatedAt: time } })
      return { ...existing, items: normalizedItems, updatedAt: time }
    }
    const created = await db.collection('mall_carts').add({ data: { openid, items: normalizedItems, updatedAt: time } })
    return { _id: created._id, openid, items: normalizedItems, updatedAt: time }
  }

  async function formatMallCart(openid) {
    const cart = await loadMallCart(openid)
    const items = cart && Array.isArray(cart.items) ? cart.items : []
    const products = []
    for (const item of items) {
      const product = await getDocOrNull('mall_products', item.productId)
      const p = product ? publicMallProduct(product) : null
      const sku = product ? getSkuById(product, item.skuId) : null
      if (!sku) {
        products.push({ ...item, product: p || item.snapshot || {}, snapshot: item.snapshot || {}, invalid: true, soldOut: true, subtotal: 0 })
        continue
      }
      const invalid = p.status !== 'on_sale' || sku.status === 'off_sale'
      const soldOut = Number(sku.stock || 0) <= 0
      const quantity = Number(item.quantity || 0)
      const snapshot = item.snapshot || { name: p.name, coverFileId: sku.imageFileId || p.coverFileId || '', specText: sku.specText || '', price: Number(sku.price || 0), originalPrice: Number(sku.originalPrice || 0), specs: sku.specs || {}, imageFileId: sku.imageFileId || '' }
      products.push({ ...item, skuId: sku.skuId, sku, specText: sku.specText, specs: sku.specs || {}, price: Number(sku.price || 0), snapshot, product: p, invalid, soldOut, subtotal: Math.round(Number(sku.price || 0) * quantity * 100) / 100 })
    }
    const selectedItems = products.filter((item) => item.selected !== false && !item.invalid && !item.soldOut)
    const totalAmount = Math.round(selectedItems.reduce((sum, item) => sum + item.subtotal, 0) * 100) / 100
    return { items: products, selectedCount: selectedItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0), totalAmount }
  }

  function calcMallPricing(items, couponResult) {
    const totalProductAmount = Math.round(items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0) * 100) / 100
    const shippingFee = totalProductAmount >= 99 || totalProductAmount <= 0 ? 0 : 8
    const amount = Math.round((totalProductAmount + shippingFee) * 100) / 100
    const basePricing = { businessType: 'mall', amount, payAmount: amount, totalProductAmount, shippingFee, discountAmount: 0, currency: 'CNY', serviceTypes: ['mall'], priceItems: [{ key: 'mall_goods', label: '商品金额', price: totalProductAmount }, { key: 'shipping_fee', label: '运费', price: shippingFee }], priceSnapshot: { originalAmount: amount, totalProductAmount, shippingFee, discountAmount: 0, payAmount: amount } }
    return couponResult ? applyCouponToPricing(basePricing, couponResult) : basePricing
  }

  return {
    createMallOrderNo,
    normalizeMallCategory,
    createMallSkuId,
    normalizeMallSpecGroups,
    validateMallProductInput,
    normalizeMallSku,
    normalizeMallSkus,
    deriveMallProductFields,
    normalizeMallProduct,
    getProductSkus,
    getSkuById,
    formatMallPrice,
    publicMallProduct,
    mallOrderStatusText,
    normalizeShippingAddress,
    buildMallCartItem,
    isSameMallCartItem,
    loadMallCart,
    saveMallCart,
    formatMallCart,
    calcMallPricing
  }
}
