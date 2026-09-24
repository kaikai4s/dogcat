module.exports = function createHandler(context) {
  const {
    cancelUnpaidOrder,
    createRefundForOrder,
    db,
    getClientRequestId,
    getDocOrNull,
    getSkuById,
    logAdmin,
    mallOrderStatusText,
    normalizeMallCategory,
    normalizeMallProduct,
    now,
    paginateList,
    publicMallProduct,
    requireAdmin,
    restoreOrderCoupon,
    safeText,
    validateMallProductInput
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

  return async function adminMall(openid, action, data) {
    const admin = await requireAdmin(openid)
    if (action === 'listCategories') {
      const res = await db.collection('mall_categories').get()
      return (res.data || []).map(normalizeMallCategory).sort((a, b) => a.sortOrder - b.sortOrder)
    }
    if (action === 'saveCategory') {
      const id = safeText(data.id || data._id).trim()
      const time = now()
      const payload = { name: safeText(data.name).trim(), icon: safeText(data.icon).trim(), enabled: data.enabled !== false, sortOrder: Number(data.sortOrder || 0), updatedAt: time }
      if (!payload.name) throw new Error('分类名称不能为空')
      if (id) {
        await db.collection('mall_categories').doc(id).update({ data: payload })
        await logAdmin(admin, 'mall_category', id, 'saveCategory', payload)
        return { _id: id, ...payload }
      }
      const created = await db.collection('mall_categories').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'mall_category', created._id, 'saveCategory', payload)
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'deleteCategory') {
      const id = safeText(data.id).trim()
      if (!id) throw new Error('请选择分类')
      const products = await db.collection('mall_products').where({ categoryId: id }).get()
      if ((products.data || []).length) throw new Error('分类下已有商品，不能删除')
      await db.collection('mall_categories').doc(id).remove()
      await logAdmin(admin, 'mall_category', id, 'deleteCategory')
      return { id, deleted: true }
    }
    if (action === 'listProducts') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const status = safeText(data.status).trim()
      const where = {}
      if (status) where.status = status
      const products = await readAll('mall_products', where)
      let list = (products || []).map(publicMallProduct)
      if (keyword) list = list.filter((item) => [item.name, item.subtitle, item.specText].some((value) => safeText(value).toLowerCase().includes(keyword)))
      list.sort((a, b) => a.sortOrder - b.sortOrder || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      return paginateList(list, data)
    }
    if (action === 'saveProduct') {
      const id = safeText(data.id || data._id).trim()
      const time = now()
      validateMallProductInput(data)
      const payload = normalizeMallProduct({ ...data, ...(data.specMode !== 'multi' ? { specGroups: [], skus: [] } : {}), updatedAt: time })
      delete payload._id
      if (!payload.name) throw new Error('商品名称不能为空')
      if (!payload.coverFileId && !payload.imageFileIds.length) throw new Error('请上传商品图片')
      if (payload.categoryId) {
        const category = await getDocOrNull('mall_categories', payload.categoryId)
        if (!category) throw new Error('商品分类不存在')
      }
      if (id) {
        await db.collection('mall_products').doc(id).update({ data: payload })
        await logAdmin(admin, 'mall_product', id, 'saveProduct', { name: payload.name })
        return { _id: id, ...payload }
      }
      const created = await db.collection('mall_products').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'mall_product', created._id, 'saveProduct', { name: payload.name })
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'toggleProductStatus') {
      const id = safeText(data.id || data.productId).trim()
      const status = data.status === 'off_sale' ? 'off_sale' : 'on_sale'
      if (!id) throw new Error('请选择商品')
      await db.collection('mall_products').doc(id).update({ data: { status, updatedAt: now() } })
      await logAdmin(admin, 'mall_product', id, 'toggleProductStatus', { status })
      return { id, status }
    }
    if (action === 'listOrders') {
      const status = safeText(data.status).trim()
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const where = {}
      if (status) where.status = status

      const enrichOrder = (item) => {
        const payAmount = Number(item.payAmount || 0)
        const alreadyRefunded = Number(item.refundAmount || 0)
        const maxRefundable = Math.max(0, Math.round((payAmount - alreadyRefunded) * 100) / 100)
        return {
          ...item,
          statusText: mallOrderStatusText(item.status),
          alreadyRefunded,
          maxRefundable
        }
      }

      if (!keyword) {
        const page = Math.max(Number(data.page || 1), 1)
        const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 100)
        const offset = (page - 1) * pageSize
        const countRes = await db.collection('mall_orders').where(where).count()
        const total = (countRes && countRes.total) || 0
        const res = await db.collection('mall_orders')
          .where(where)
          .orderBy('createdAt', 'desc')
          .skip(offset)
          .limit(pageSize)
          .get()
        const list = (res.data || []).map(enrichOrder)
        return {
          list,
          total,
          page,
          pageSize,
          hasMore: offset + pageSize < total
        }
      }

      const allOrders = (await readAll('mall_orders', where, 2000)).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      const filtered = allOrders.filter((item) => [item.orderNo, item.contactPhone, item.trackingNo, item.expressCompany].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const enriched = filtered.map(enrichOrder)
      return paginateList(enriched, data)
    }
    if (action === 'getOrderDetail') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order) throw new Error('订单不存在')
      const payAmount = Number(order.payAmount || 0)
      const existingRefundsRes = await db.collection('refunds').where({ orderId: order._id }).get()
      const successfulRefundsAmount = (existingRefundsRes.data || [])
        .filter((r) => ['success', 'processing'].includes(r.status))
        .reduce((sum, r) => sum + Number(r.refundAmount || 0), 0)
      const alreadyRefunded = Math.max(Number(order.refundAmount || 0), successfulRefundsAmount)
      const maxRefundable = Math.max(0, Math.round((payAmount - alreadyRefunded) * 100) / 100)
      return { ...order, statusText: mallOrderStatusText(order.status), alreadyRefunded, maxRefundable }
    }
    if (action === 'shipOrder') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order) throw new Error('订单不存在')
      if (order.status !== 'pending_ship') throw new Error('当前订单不可发货')
      const expressCompany = safeText(data.expressCompany).trim()
      const trackingNo = safeText(data.trackingNo).trim()
      if (!expressCompany || !trackingNo) throw new Error('请填写快递公司和单号')
      const time = now()
      await db.collection('mall_orders').doc(order._id).update({ data: { status: 'shipped', expressCompany, trackingNo, shippedAt: time, updatedAt: time } })
      await logAdmin(admin, 'mall_order', order._id, 'shipOrder', { expressCompany, trackingNo })
      return { orderId: order._id, status: 'shipped', expressCompany, trackingNo }
    }
    if (action === 'updateOrderStatus') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const targetStatus = safeText(data.status).trim()
      const remark = safeText(data.remark || data.reason).trim()
      if (!remark) throw new Error('请填写操作说明')
      const allowedStatuses = ['pending_pay', 'pending_ship', 'shipped', 'completed', 'cancelled', 'refunded']
      if (!allowedStatuses.includes(targetStatus)) throw new Error('目标状态无效')

      const order = await getDocOrNull('mall_orders', orderId)
      if (!order) throw new Error('订单不存在')
      const prevStatus = order.status
      if (prevStatus === targetStatus) throw new Error(`订单当前已处于该状态(${targetStatus})`)

      if (targetStatus === 'cancelled') {
        if (order.status !== 'pending_pay') throw new Error('已支付订单请通过退款流程处理，不能直接取消')
        if (!await cancelUnpaidOrder(order, { collectionName: 'mall_orders', reason: remark, actorRole: 'admin' })) throw new Error('订单状态已变化，请刷新后重试')
        await logAdmin(admin, 'mall_order', orderId, 'updateOrderStatus', { prevStatus, targetStatus, remark })
        return { orderId, status: targetStatus, prevStatus, remark }
      }
      if (targetStatus === 'refunded' && order.paymentStatus !== 'refunded') throw new Error('退款尚未到账，不能标记已退款')
      if (targetStatus === 'pending_pay' && order.paymentStatus !== 'unpaid') throw new Error('已创建支付或已付款订单不能恢复待支付')
      if (['paid', 'pending_ship', 'shipped', 'assigned', 'in_service', 'completed'].includes(targetStatus) && !['paid', 'refunding'].includes(order.paymentStatus)) throw new Error('订单未支付，不能手动推进状态')

      const time = now()
      const updateData = {
        status: targetStatus,
        adminManualStatusUpdatedAt: time,
        adminManualStatusRemark: remark,
        adminManualStatusByOpenid: openid,
        updatedAt: time
      }
      await db.runTransaction(async tx => {
        const current = (await tx.collection('mall_orders').doc(orderId).get().catch(() => ({ data: null }))).data
        if (!current || current.status !== order.status || current.paymentStatus !== order.paymentStatus) throw new Error('订单状态已变化，请刷新后重试')
        await tx.collection('mall_orders').doc(orderId).update({ data: updateData })
      })
      await logAdmin(admin, 'mall_order', orderId, 'updateOrderStatus', { prevStatus, targetStatus, remark })
      return { orderId, status: targetStatus, prevStatus, remark }
    }
    if (action === 'refundOrder') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const order = await getDocOrNull('mall_orders', orderId)
      if (!order) throw new Error('订单不存在')
      const payAmount = Number(order.payAmount || 0)
      if (payAmount <= 0) throw new Error('该订单无需退款（实付金额为0）')
      if (order.status === 'pending_pay' && order.paymentStatus !== 'paid') {
        throw new Error('未付款订单不可退款')
      }

      const refundAmount = Number(data.refundAmount)
      if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error('请输入有效的退款金额（需大于0）')

      const reason = safeText(data.reason || data.remark).trim()
      if (!reason) throw new Error('请填写退款说明')

      const refund = await createRefundForOrder(order, refundAmount, reason, 'admin_mall_manual', openid, getClientRequestId(data))
      const currentOrder = ((await db.collection('mall_orders').doc(orderId).get().catch(() => ({ data: null }))).data) || order
      const totalRefundAmount = Number(currentOrder.refundAmount || 0)
      const isFullRefund = Number(currentOrder.refundedAmount || 0) >= payAmount
      await logAdmin(admin, 'mall_order', orderId, 'refundOrder', { refundAmount, reason, refundNo: refund.refundNo, isFullRefund })
      return {
        orderId,
        refundNo: refund.refundNo,
        refundAmount,
        totalRefundAmount,
        isFullRefund,
        status: currentOrder.status
      }
    }
    if (action === 'auditRefund') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order) throw new Error('订单不存在')
      if (order.refundStatus !== 'applied') throw new Error('当前订单没有待审核售后')
      const approved = data.approved === true
      const time = now()
      if (!approved) {
        let restoredStatus = order.preRefundStatus
        if (!restoredStatus || !['pending_ship', 'shipped', 'completed'].includes(restoredStatus)) {
          if (order.receivedAt) {
            restoredStatus = 'completed'
          } else if (order.trackingNo || order.shippedAt) {
            restoredStatus = 'shipped'
          } else {
            restoredStatus = 'pending_ship'
          }
        }
        const updated = await db.collection('mall_orders').where({ _id: order._id, refundStatus: 'applied' }).update({
          data: {
            status: restoredStatus,
            refundStatus: 'rejected',
            refundRejectReason: safeText(data.remark).trim(),
            refundAuditedAt: time,
            updatedAt: time
          }
        })
        if (!updated.stats || !updated.stats.updated) throw new Error('售后状态已变化，请刷新后重试')
        await logAdmin(admin, 'mall_order', order._id, 'auditRefund', { approved: false, remark: safeText(data.remark).trim(), restoredStatus })
        return { orderId: order._id, refundStatus: 'rejected', status: restoredStatus }
      }
      const payAmount = Number(order.payAmount || 0)
      const refundAmount = data.refundAmount !== undefined && data.refundAmount !== null && String(data.refundAmount).trim() !== ''
        ? Number(data.refundAmount)
        : payAmount
      if (payAmount > 0) {
        if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error('请输入有效的退款金额（需大于0）')
        if (refundAmount > payAmount) throw new Error('退款金额不能超过订单实付金额')
        const refund = await createRefundForOrder(order, refundAmount, data.remark || order.refundReason || '商城售后退款', 'mall_after_sale', openid, getClientRequestId(data))
        await logAdmin(admin, 'mall_order', order._id, 'auditRefund', { approved: true, refundNo: refund.refundNo, refundAmount })
        return { orderId: order._id, refundStatus: 'approved', refundNo: refund.refundNo, refundAmount }
      }
      // 0 元券单售后通过：无需调用微信支付退款，直接在事务中流转为全额退款完成并恢复优惠券与库存
      await db.runTransaction(async (tx) => {
        const current = (await tx.collection('mall_orders').doc(order._id).get().catch(() => ({ data: null }))).data
        if (!current || current.refundStatus !== 'applied') throw new Error('售后状态已变化，请刷新后重试')

        const shouldRestoreStock = current.status !== 'completed' && current.oversoldRefundRequired !== true && current.stockRestored !== true && Array.isArray(current.items) && current.items.length > 0
        if (shouldRestoreStock) {
          const productRestores = new Map()
          for (const item of current.items) {
            const quantity = Number(item.quantity)
            if (!Number.isSafeInteger(quantity) || quantity <= 0) continue
            let product = productRestores.get(item.productId)
            if (!product) {
              const rawProduct = (await tx.collection('mall_products').doc(item.productId).get().catch(() => ({ data: null }))).data
              if (rawProduct) product = typeof normalizeMallProduct === 'function' ? normalizeMallProduct(rawProduct) : rawProduct
            }
            if (product) {
              let sku = typeof getSkuById === 'function' ? getSkuById(product, item.skuId) : null
              if (!sku && Array.isArray(product.skus)) {
                sku = product.skus.find(s => s.skuId === item.skuId)
              }
              if (sku) {
                const skus = product.skus.map(row => row.skuId === sku.skuId
                  ? {
                    ...row,
                    stock: Number(row.stock || 0) + quantity,
                    salesCount: Math.max(0, Number(row.salesCount || 0) - quantity)
                  }
                  : row)
                const changed = skus.find(row => row.skuId === sku.skuId)
                if (typeof normalizeMallProduct === 'function') {
                  product = normalizeMallProduct({
                    ...product,
                    ...(product.specMode === 'single' ? { stock: changed.stock, salesCount: changed.salesCount } : {}),
                    skus
                  })
                } else {
                  product.skus = skus
                  if (product.specMode === 'single') {
                    product.stock = changed.stock
                    product.salesCount = changed.salesCount
                  }
                }
                productRestores.set(item.productId, product)
              }
            }
          }
          for (const [id, product] of productRestores) {
            const { skus, price, originalPrice, stock, totalStock, minPrice, maxPrice, salesCount, specText } = product
            await tx.collection('mall_products').doc(id).update({
              data: { skus, price, originalPrice, stock, totalStock, minPrice, maxPrice, salesCount, specText, updatedAt: time }
            })
          }
        }

        await tx.collection('mall_orders').doc(order._id).update({
          data: {
            status: 'refunded',
            refundStatus: 'full_refunded',
            refundAmount: 0,
            refundedAmount: 0,
            refundAuditedAt: time,
            ...(shouldRestoreStock ? { stockRestored: true, stockRestoredAt: time } : {}),
            updatedAt: time
          }
        })
        if (current.couponId && typeof restoreOrderCoupon === 'function') {
          await restoreOrderCoupon(current.couponId, order._id, tx)
        }
      })
      await logAdmin(admin, 'mall_order', order._id, 'auditRefund', { approved: true, refundAmount: 0, zeroPayAmount: true })
      return { orderId: order._id, refundStatus: 'approved', zeroPayAmount: true }
    }
    throw new Error('未知 adminMall 操作')
  }
}
