module.exports = function createHandler(context) {
  const {
    cancelUnpaidOrder,
    buildMallCartItem,
    buildMallOrderItemSnapshot,
    calcMallPricing,
    createClientSnapshot,
    createMallOrderNo,
    createOrderWithCouponLock,
    db,
    evaluateCoupon,
    formatMallCart,
    getClientRequestId,
    getDocOrNull,
    getSkuById,
    getUser,
    isSameMallCartItem,
    loadMallCart,
    mallOrderStatusText,
    normalizeMallCategory,
    normalizeMallProduct,
    normalizeShippingAddress,
    now,
    paginateList,
    publicMallProduct,
    safeFileId,
    safeText,
    saveMallCart
  } = context

  async function readAll(collectionName, where = {}, maxLimit = 2000) {
    const rows = []
    let cursor = ''
    while (rows.length < maxLimit) {
      const condition = { ...where }
      if (cursor && db.command && typeof db.command.gt === 'function') {
        condition._id = db.command.gt(cursor)
      }
      const page = (await db.collection(collectionName).where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
      rows.push(...page)
      if (page.length < 100) return rows
      const nextCursor = page[page.length - 1] && page[page.length - 1]._id
      if (!nextCursor || nextCursor === cursor) return rows
      cursor = nextCursor
    }
    return rows
  }

  return async function mall(openid, action, data) {
    if (action === 'listCategories') {
      const res = await db.collection('mall_categories').where({ enabled: true }).get()
      return (res.data || []).map(normalizeMallCategory).sort((a, b) => a.sortOrder - b.sortOrder)
    }
    if (action === 'listProducts') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const categoryId = safeText(data.categoryId).trim()
      const where = { status: 'on_sale' }
      if (categoryId) where.categoryId = categoryId
      const products = await readAll('mall_products', where)
      let list = (products || []).map(publicMallProduct).filter((item) => item.name)
      if (keyword) list = list.filter((item) => [item.name, item.subtitle, item.specText].some((value) => safeText(value).toLowerCase().includes(keyword)))
      if (data.sort === 'price_asc') list.sort((a, b) => a.minPrice - b.minPrice)
      else if (data.sort === 'price_desc') list.sort((a, b) => b.maxPrice - a.maxPrice)
      else if (data.sort === 'sales_desc') list.sort((a, b) => b.salesCount - a.salesCount)
      else list.sort((a, b) => a.sortOrder - b.sortOrder || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      return paginateList(list, data)
    }
    if (action === 'getProductDetail') {
      const product = await getDocOrNull('mall_products', data.id || data.productId)
      if (!product || product.status !== 'on_sale') throw new Error('商品不存在或已下架')
      return publicMallProduct(product)
    }
    if (action === 'getCart') {
      await getUser(openid)
      return formatMallCart(openid)
    }
    if (action === 'updateCart') {
      await getUser(openid)
      const productId = safeText(data.productId).trim()
      if (!productId) throw new Error('请选择商品')
      if (data.operation === 'remove') {
        const cart = await loadMallCart(openid)
        await saveMallCart(openid, (cart && cart.items || []).filter((item) => !isSameMallCartItem(item, { productId, skuId: data.skuId })))
        return formatMallCart(openid)
      }
      const product = await getDocOrNull('mall_products', productId)
      if (!product || product.status !== 'on_sale') throw new Error('商品不存在或已下架')
      const normalizedProduct = normalizeMallProduct(product)
      const sku = getSkuById(normalizedProduct, data.skuId)
      if (!sku || sku.status === 'off_sale') throw new Error('商品规格不存在或已下架')
      const cart = await loadMallCart(openid)
      let items = cart && Array.isArray(cart.items) ? cart.items.slice() : []
      const target = { productId, skuId: sku.skuId }
      const index = items.findIndex((item) => isSameMallCartItem(item, target))
      const operation = safeText(data.operation).trim() || 'set'
      if (operation === 'remove') {
        items = items.filter((item) => !isSameMallCartItem(item, target))
      } else {
        const quantity = Math.min(Math.max(Math.floor(Number(data.quantity || 1)), 1), 99)
        if (quantity > Number(sku.stock || 0)) throw new Error('商品库存不足')
        const nextQuantity = operation === 'add' && index >= 0 ? Number(items[index].quantity || 0) + quantity : quantity
        if (nextQuantity > Number(sku.stock || 0)) throw new Error('商品库存不足')
        const nextItem = buildMallCartItem(normalizedProduct, sku, nextQuantity, data)
        if (index >= 0) items[index] = { ...items[index], ...nextItem }
        else items.push(nextItem)
      }
      await saveMallCart(openid, items)
      return formatMallCart(openid)
    }
    if (action === 'createOrder') {
      const user = await getUser(openid)
      if (!safeText(user.phone).trim()) throw new Error('请先绑定手机号')
      const clientRequestId = getClientRequestId(data)
      if (clientRequestId) {
        const existing = (await db.collection('mall_orders').where({ clientOpenid: openid, clientRequestId }).limit(1).get()).data[0]
        if (existing) return existing
      }
      let orderItems = []
      if (data.productId) {
        orderItems = [{ productId: safeText(data.productId).trim(), skuId: safeText(data.skuId).trim(), quantity: Math.max(Math.floor(Number(data.quantity || 1)), 1) }]
      } else {
        const cart = await formatMallCart(openid)
        orderItems = cart.items.filter((item) => item.selected !== false && !item.invalid && !item.soldOut).map((item) => ({ productId: item.productId, skuId: item.skuId || 'default', quantity: Number(item.quantity || 1) }))
      }
      if (!orderItems.length) throw new Error('请选择要购买的商品')
      const snapshotItems = []
      for (const item of orderItems) {
        const product = await getDocOrNull('mall_products', item.productId)
        if (!product || product.status !== 'on_sale') throw new Error('商品不存在或已下架')
        const normalizedProduct = normalizeMallProduct(product)
        const sku = getSkuById(normalizedProduct, item.skuId)
        if (!sku || sku.status === 'off_sale') throw new Error('商品规格不存在或已下架')
        const quantity = Math.min(Math.max(Math.floor(Number(item.quantity || 1)), 1), 99)
        if (quantity > Number(sku.stock || 0)) throw new Error(`商品库存不足：${product.name}`)
        snapshotItems.push(buildMallOrderItemSnapshot(normalizedProduct, sku, quantity))
      }
      const address = normalizeShippingAddress(data.shippingAddress || data)
      let couponResult = null
      const basePricing = calcMallPricing(snapshotItems)
      if (data.couponId) {
        const couponRes = await db.collection('user_coupons').doc(data.couponId).get().catch(() => ({ data: null }))
        const coupon = couponRes && couponRes.data
        const result = evaluateCoupon(coupon, { ...basePricing, serviceTypes: ['mall'] }, openid)
        if (!result.applicable) throw new Error(result.reason)
        couponResult = result
      }
      const pricing = calcMallPricing(snapshotItems, couponResult)
      const time = now()
      const order = { orderType: 'mall', orderNo: createMallOrderNo(), clientRequestId, idempotencyKey: clientRequestId || '', clientUserId: user._id, clientOpenid: openid, clientSnapshot: createClientSnapshot(user), contactPhone: safeText(user.phone).trim(), items: snapshotItems, totalProductAmount: pricing.totalProductAmount, shippingFee: pricing.shippingFee, discountAmount: pricing.discountAmount || 0, amount: pricing.amount, payAmount: pricing.payAmount, couponId: pricing.coupon ? pricing.coupon.couponId : '', couponTemplateId: pricing.coupon ? pricing.coupon.templateId : '', couponName: pricing.coupon ? pricing.coupon.name : '', couponSnapshot: pricing.coupon ? pricing.coupon.snapshot : null, priceSnapshot: pricing.priceSnapshot, shippingAddress: address, status: 'pending_pay', paymentStatus: 'unpaid', paymentNo: '', wxTransactionId: '', refundStatus: 'none', refundReason: '', refundImages: [], refundAmount: 0, refundNo: '', expressCompany: '', trackingNo: '', shippedAt: null, receivedAt: null, createdAt: time, updatedAt: time }
      const created = await createOrderWithCouponLock({
        collectionName: 'mall_orders',
        order,
        couponId: order.couponId,
        openid
      })
      if (!data.productId) {
        const cart = await loadMallCart(openid)
        if (cart) await saveMallCart(openid, (cart.items || []).filter((item) => !snapshotItems.some((orderItem) => isSameMallCartItem(item, orderItem))))
      }
      return { ...order, ...created }
    }
    if (action === 'listMyOrders') {
      await getUser(openid)
      const status = safeText(data.status).trim()
      const where = { clientOpenid: openid }
      if (status && status !== 'all') {
        if (status === 'after_sale') {
          where.status = db.command && typeof db.command.in === 'function' ? db.command.in(['refund_applied', 'refunded']) : 'refund_applied'
        } else {
          where.status = status
        }
      }
      const page = Math.max(Number(data.page || 1), 1)
      const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 100)
      const offset = (page - 1) * pageSize
      const countRes = await db.collection('mall_orders').where(where).count()
      const total = (countRes && countRes.total) || 0
      const res = await db.collection('mall_orders').where(where).orderBy('createdAt', 'desc').skip(offset).limit(pageSize).get()
      const list = (res.data || []).map((item) => ({ ...item, statusText: mallOrderStatusText(item.status) }))
      return {
        list,
        total,
        page,
        pageSize,
        hasMore: offset + pageSize < total
      }
    }
    if (action === 'getOrderDetail') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order || order.clientOpenid !== openid) throw new Error('订单不存在')
      return { ...order, statusText: mallOrderStatusText(order.status) }
    }
    if (action === 'cancelOrder') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order || order.clientOpenid !== openid) throw new Error('订单不存在')
      if (order.status === 'cancelled') return { orderId: order._id, status: 'cancelled' }
      if (order.status !== 'pending_pay') throw new Error('当前订单不可取消')
      if (!await cancelUnpaidOrder(order, { collectionName: 'mall_orders', reason: '宠物主取消商城订单', actorRole: 'client' })) throw new Error('支付或订单状态已更新，请刷新后重试')
      return { orderId: order._id, status: 'cancelled' }
    }
    if (action === 'confirmReceipt') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order || order.clientOpenid !== openid) throw new Error('订单不存在')
      if (order.status !== 'shipped') throw new Error('当前订单不可确认收货')
      const time = now()
      const res = await db.collection('mall_orders').where({ _id: order._id, clientOpenid: openid, status: 'shipped' }).update({ data: { status: 'completed', receivedAt: time, updatedAt: time } })
      if (!res.stats || !res.stats.updated) throw new Error('订单状态已更新，请刷新后重试')
      return { orderId: order._id, status: 'completed' }
    }
    if (action === 'applyRefund') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order || order.clientOpenid !== openid) throw new Error('订单不存在')
      if (!['pending_ship', 'shipped', 'completed'].includes(order.status) || order.paymentStatus !== 'paid') throw new Error('当前订单不可申请售后')
      const reason = safeText(data.reason).trim()
      if (!reason) throw new Error('请填写售后原因')
      const time = now()
      const refundImages = Array.isArray(data.images || data.refundImages) ? (data.images || data.refundImages).map(safeFileId).filter(Boolean).slice(0, 6) : []
      const res = await db.collection('mall_orders').where({ _id: order._id, clientOpenid: openid, status: order.status }).update({
        data: {
          status: 'refund_applied',
          refundStatus: 'applied',
          preRefundStatus: order.status,
          refundReason: reason,
          refundImages,
          refundRequestedAmount: Number(order.payAmount || 0),
          updatedAt: time
        }
      })
      if (!res.stats || !res.stats.updated) throw new Error('订单状态已更新，请刷新后重试')
      return { orderId: order._id, refundStatus: 'applied', preRefundStatus: order.status }
    }
    throw new Error('未知 mall 操作')
  }
}
