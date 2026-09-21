module.exports = function createHandler(context) {
  const {
    createRefundForOrder,
    db,
    getClientRequestId,
    getDocOrNull,
    logAdmin,
    mallOrderStatusText,
    normalizeMallCategory,
    normalizeMallProduct,
    now,
    paginateList,
    publicMallProduct,
    requireAdmin,
    safeText,
    validateMallProductInput
  } = context
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
      const res = await db.collection('mall_products').get()
      let list = (res.data || []).map(publicMallProduct)
      if (status) list = list.filter((item) => item.status === status)
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
      const res = await db.collection('mall_orders').orderBy('createdAt', 'desc').get()
      let list = res.data || []
      if (status) list = list.filter((item) => item.status === status)
      if (keyword) list = list.filter((item) => [item.orderNo, item.contactPhone, item.trackingNo, item.expressCompany].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const enriched = list.map((item) => {
        const payAmount = Number(item.payAmount || 0)
        const alreadyRefunded = Number(item.refundAmount || 0)
        const maxRefundable = Math.max(0, Math.round((payAmount - alreadyRefunded) * 100) / 100)
        return {
          ...item,
          statusText: mallOrderStatusText(item.status),
          alreadyRefunded,
          maxRefundable
        }
      })
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

      const time = now()
      const updateData = {
        status: targetStatus,
        adminManualStatusUpdatedAt: time,
        adminManualStatusRemark: remark,
        adminManualStatusByOpenid: openid,
        updatedAt: time
      }
      await db.collection('mall_orders').doc(orderId).update({ data: updateData })
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

      const existingRefundsRes = await db.collection('refunds').where({ orderId }).get()
      const successfulRefundsAmount = (existingRefundsRes.data || [])
        .filter((r) => ['success', 'processing'].includes(r.status))
        .reduce((sum, r) => sum + Number(r.refundAmount || 0), 0)
      const alreadyRefunded = Math.max(Number(order.refundAmount || 0), successfulRefundsAmount)
      const maxRefundable = Math.max(0, Math.round((payAmount - alreadyRefunded) * 100) / 100)

      if (maxRefundable <= 0) throw new Error('该订单已全额退款，无剩余可退金额')

      const refundAmount = Number(data.refundAmount)
      if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error('请输入有效的退款金额（需大于0）')
      if (refundAmount > maxRefundable) throw new Error(`退款金额不能超过可退金额上限 ¥${maxRefundable.toFixed(2)}`)

      const reason = safeText(data.reason || data.remark).trim()
      if (!reason) throw new Error('请填写退款说明')

      const refund = await createRefundForOrder(order, refundAmount, reason, 'admin_mall_manual', openid, getClientRequestId(data))
      const totalRefundAmount = Math.round((alreadyRefunded + refundAmount) * 100) / 100
      const isFullRefund = totalRefundAmount >= payAmount

      const time = now()
      const orderUpdate = {
        refundAmount: totalRefundAmount,
        refundNo: refund.refundNo,
        refundStatus: isFullRefund ? 'approved' : 'partially_refunded',
        paymentStatus: isFullRefund ? 'refunded' : 'refunding',
        adminManualRefundRemark: reason,
        adminManualRefundByOpenid: openid,
        adminManualRefundAt: time,
        updatedAt: time
      }
      if (isFullRefund && !['completed'].includes(order.status)) {
        orderUpdate.status = 'refunded'
      }
      await db.collection('mall_orders').doc(orderId).update({ data: orderUpdate })
      await logAdmin(admin, 'mall_order', orderId, 'refundOrder', { refundAmount, reason, refundNo: refund.refundNo, isFullRefund })
      return {
        orderId,
        refundNo: refund.refundNo,
        refundAmount,
        totalRefundAmount,
        isFullRefund,
        status: orderUpdate.status || order.status
      }
    }
    if (action === 'auditRefund') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order) throw new Error('订单不存在')
      if (order.refundStatus !== 'applied') throw new Error('当前订单没有待审核售后')
      const approved = data.approved === true
      const time = now()
      if (!approved) {
        await db.collection('mall_orders').doc(order._id).update({ data: { status: order.trackingNo ? 'shipped' : 'pending_ship', refundStatus: 'rejected', refundRejectReason: safeText(data.remark).trim(), updatedAt: time } })
        await logAdmin(admin, 'mall_order', order._id, 'auditRefund', { approved: false })
        return { orderId: order._id, refundStatus: 'rejected' }
      }
      const refund = await createRefundForOrder(order, Number(data.refundAmount || order.payAmount || 0), data.remark || order.refundReason || '商城售后退款', 'mall_after_sale', openid, getClientRequestId(data))
      await db.collection('mall_orders').doc(order._id).update({ data: { status: 'refunded', paymentStatus: 'refunding', refundStatus: 'approved', refundAmount: refund.refundAmount, refundNo: refund.refundNo, updatedAt: time } })
      await logAdmin(admin, 'mall_order', order._id, 'auditRefund', { approved: true, refundNo: refund.refundNo })
      return { orderId: order._id, refundStatus: 'approved', refundNo: refund.refundNo }
    }
    throw new Error('未知 adminMall 操作')
  }
}
