module.exports = function createHandler(context) {
  const {
    appendIncidentComment,
    appendOrderTimeline,
    attachOrderDisplayData,
    createRefundForOrder,
    db,
    closeIncidentFinancially,
    findByClientRequestId,
    freezeIncidentEarnings,
    getClientRequestId,
    getIncidentForAccess,
    getUser,
    issueCouponToTargetUser,
    makeIdempotencyKey,
    normalizeIncidentStatus,
    normalizeIncidentType,
    now,
    paginateList,
    recordIncidentAction,
    readScopedDocuments,
    requireAdmin,
    requireClientOrder,
    requireStaffOrder,
    safeText
  } = context
  return async function incident(openid, action, data) {
    if (action === 'createSosIncident') {
      const clientRequestId = getClientRequestId(data)
      const existingByRequest = await findByClientRequestId('order_incidents', { orderId: data.orderId, staffOpenid: openid, clientRequestId })
      if (existingByRequest) return existingByRequest
      const { user, order } = await requireStaffOrder(openid, data.orderId, '不是该订单员工')
      const time = now()
      const incident = { orderId: data.orderId, clientOpenid: order.clientOpenid || '', staffUserId: user._id, staffOpenid: openid, clientRequestId, idempotencyKey: clientRequestId || makeIdempotencyKey('incident_sos', data.orderId, openid, time.getTime()), incidentType: normalizeIncidentType(data.incidentType, 'sos'), title: data.title || '宠托师 SOS', description: data.description || '', latitude: Number(data.latitude || 0), longitude: Number(data.longitude || 0), mediaFileIds: data.mediaFileIds || [], status: 'open', resolution: null, refundId: '', refundNo: '', frozenEarningIds: [], createdByRole: 'staff', createdAt: time, updatedAt: time }
      const created = await db.collection('order_incidents').add({ data: incident })
      await recordIncidentAction(created._id, 'created_sos', 'staff', openid, { orderId: data.orderId })
      await appendOrderTimeline(data.orderId, 'incident_open', '宠托师发起 SOS', incident.description, 'staff')
      return { _id: created._id, ...incident }
    }
    if (action === 'createComplaint') {
      const clientRequestId = getClientRequestId(data)
      const existingByRequest = await findByClientRequestId('order_incidents', { orderId: data.orderId, openid, clientRequestId })
      if (existingByRequest) return existingByRequest
      const { user, order } = await requireClientOrder(openid, data.orderId, '仅宠物主可发起投诉')
      const description = safeText(data.description).trim()
      if (!description) throw new Error('请填写投诉说明')
      const time = now()
      const incident = { orderId: data.orderId, clientUserId: user._id, clientOpenid: openid, openid, clientRequestId, idempotencyKey: clientRequestId || makeIdempotencyKey('incident', data.orderId, openid, time.getTime()), staffOpenid: order.staffOpenid || '', staffProfileId: order.staffProfileId || '', incidentType: normalizeIncidentType(data.incidentType, 'complaint'), title: safeText(data.title).trim() || '订单投诉', description, latitude: Number(data.latitude || 0), longitude: Number(data.longitude || 0), mediaFileIds: Array.isArray(data.mediaFileIds) ? data.mediaFileIds.slice(0, 9) : [], status: 'open', resolution: null, refundId: '', refundNo: '', frozenEarningIds: [], createdByRole: 'client', createdAt: time, updatedAt: time }
      const created = await db.collection('order_incidents').add({ data: incident })
      await recordIncidentAction(created._id, 'created_complaint', 'client', openid, { orderId: data.orderId })
      await appendOrderTimeline(data.orderId, 'incident_open', '宠物主发起投诉', incident.title, 'client')
      return { _id: created._id, ...incident }
    }
    if (action === 'getIncidentDetail') {
      const { user, incident } = await getIncidentForAccess(openid, data.id || data.incidentId)
      const [comments, actions] = await Promise.all([
        readScopedDocuments('incident_comments', { incidentId: incident._id }, 'createdAt', 'asc'),
        user.roles.includes('admin') ? readScopedDocuments('incident_actions', { incidentId: incident._id }, 'createdAt', 'asc') : Promise.resolve([])
      ])
      const orderRes = incident.orderId ? await db.collection('orders').doc(incident.orderId).get().catch(() => ({ data: null })) : null
      const order = orderRes && orderRes.data
      return { incident, comments, actions, order: order ? await attachOrderDisplayData(order) : null }
    }
    if (action === 'appendIncidentComment') {
      const { user, incident } = await getIncidentForAccess(openid, data.incidentId)
      const actorRole = user.roles.includes('admin') ? 'admin' : (incident.staffOpenid === openid ? 'staff' : 'client')
      const comment = await appendIncidentComment(data.incidentId, actorRole, openid, data.content, data.mediaFileIds)
      await db.collection('order_incidents').doc(data.incidentId).update({ data: { updatedAt: now() } })
      await recordIncidentAction(data.incidentId, 'commented', actorRole, openid, { commentId: comment._id })
      return comment
    }
    if (action === 'uploadIncidentEvidence') {
      const { user, incident } = await getIncidentForAccess(openid, data.incidentId)
      const actorRole = user.roles.includes('admin') ? 'admin' : (incident.staffOpenid === openid ? 'staff' : 'client')
      const comment = await appendIncidentComment(data.incidentId, actorRole, openid, data.remark || '补充证据', data.mediaFileIds)
      await recordIncidentAction(data.incidentId, 'evidence_uploaded', actorRole, openid, { commentId: comment._id })
      return comment
    }
    if (action === 'listMyIncidents') {
      const user = await getUser(openid)
      const role = data.role === 'staff' ? 'staff' : 'client'
      const where = role === 'staff' && user.roles.includes('staff') ? { staffOpenid: openid } : { clientOpenid: openid }
      const status = safeText(data.status).trim()
      if (status) where.status = status

      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      if (wantsPage) {
        const page = Math.max(Number(data.page || 1), 1)
        const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 100)
        const offset = (page - 1) * pageSize
        const [countRes, listRes] = await Promise.all([
          db.collection('order_incidents').where(where).count(),
          db.collection('order_incidents').where(where).orderBy('createdAt', 'desc').skip(offset).limit(pageSize).get()
        ])
        const total = (countRes && typeof countRes.total === 'number') ? countRes.total : 0
        const list = listRes.data || []
        return {
          list,
          total,
          page,
          pageSize,
          hasMore: offset + list.length < total
        }
      }

      const res = await db.collection('order_incidents').where(where).orderBy('createdAt', 'desc').limit(100).get()
      return res.data || []
    }
    if (action === 'listIncidents') {
      await requireAdmin(openid)
      const status = safeText(data.status).trim()
      const orderId = safeText(data.orderId).trim()
      const where = {}
      if (status) where.status = status
      if (orderId) where.orderId = orderId

      const page = Math.max(Number(data.page || 1), 1)
      const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 100)
      const offset = (page - 1) * pageSize

      const [countRes, listRes] = await Promise.all([
        db.collection('order_incidents').where(where).count(),
        db.collection('order_incidents').where(where).orderBy('createdAt', 'desc').skip(offset).limit(pageSize).get()
      ])
      const total = (countRes && typeof countRes.total === 'number') ? countRes.total : 0
      const list = listRes.data || []
      return {
        list,
        total,
        page,
        pageSize,
        hasMore: offset + list.length < total
      }
    }
    if (action === 'updateIncidentStatus' || action === 'resolveIncident') {
      await requireAdmin(openid)
      const id = data.id || data.incidentId
      if (!id) throw new Error('缺少纠纷 ID')
      const incidentRes = await db.collection('order_incidents').doc(id).get().catch(() => ({ data: null }))
      const incident = incidentRes && incidentRes.data
      if (!incident) throw new Error('纠纷不存在')

      const status = action === 'resolveIncident' ? normalizeIncidentStatus(data.status, 'resolved') : normalizeIncidentStatus(data.status, 'processing')

      if (['closed', 'resolved', 'rejected'].includes(incident.status)) {
        if (incident.status === status) return { id, status }
        throw new Error('已结案纠纷不可变更状态')
      }

      const hasFrozenEarnings = Array.isArray(incident.frozenEarningIds) && incident.frozenEarningIds.length > 0
      const hasEarningSettled = incident.earningResolution && ['release', 'deduct'].includes(incident.earningResolution.decision)
      if (hasFrozenEarnings && !hasEarningSettled && ['resolved', 'closed', 'rejected'].includes(status)) {
        throw new Error('纠纷存在未处理的冻结收益，请通过结案流程结算收益')
      }

      const time = now()
      const update = { status, updatedAt: time }
      const res = await db.collection('order_incidents').where({ _id: id, status: incident.status }).update({ data: update })
      if (!res.stats || !res.stats.updated) throw new Error('纠纷状态已变化，请刷新后重试')

      await recordIncidentAction(id, 'status_updated', 'admin', openid, { status })
      return { id, status }
    }
    if (action === 'proposeResolution') {
      const admin = await requireAdmin(openid)
      const id = data.id || data.incidentId
      const incidentRes = await db.collection('order_incidents').doc(id).get().catch(() => ({ data: null }))
      const incident = incidentRes && incidentRes.data
      if (!incident) throw new Error('纠纷不存在')
      if (['closed', 'resolved', 'rejected'].includes(incident.status)) {
        throw new Error('已结案纠纷不可变更处理方案')
      }
      const type = safeText(data.resolutionType || data.type).trim() || 'explain'
      const resolution = { type, content: safeText(data.content).trim(), refundAmount: Number(data.refundAmount || 0), couponTemplateId: '', couponId: '', couponSnapshot: null, createdByOpenid: openid, createdAt: now() }
      if (type === 'coupon') {
        const couponTemplateId = safeText(data.couponTemplateId).trim()
        if (!couponTemplateId) throw new Error('请选择补偿优惠券')
        const orderRes = await db.collection('orders').doc(incident.orderId).get().catch(() => ({ data: null }))
        const order = orderRes && orderRes.data
        if (!order) throw new Error('订单不存在')
        const targetUser = (await db.collection('users').where({ openid: order.clientOpenid || incident.clientOpenid }).limit(1).get()).data[0]
        const templateRes = await db.collection('coupon_templates').doc(couponTemplateId).get().catch(() => ({ data: null }))
        const template = templateRes && templateRes.data
        if (!template) throw new Error('补偿优惠券不存在')
        const issued = await issueCouponToTargetUser(template, targetUser, {
          adminUserId: admin._id,
          adminOpenid: openid,
          idempotencyKey: `incident_coupon_${id}`,
          sourceType: 'incident_resolution',
          sourceId: id
        })
        resolution.couponTemplateId = couponTemplateId
        resolution.couponId = issued._id
        resolution.couponSnapshot = issued.templateSnapshot
        await recordIncidentAction(id, 'coupon_issued', 'admin', openid, { couponId: issued._id, couponTemplateId })
      }
      const status = data.status ? normalizeIncidentStatus(data.status) : 'processing'
      await db.collection('order_incidents').doc(id).update({ data: { resolution, status, updatedAt: now() } })
      await recordIncidentAction(id, 'resolution_proposed', 'admin', openid, resolution)
      await appendOrderTimeline(incident.orderId, 'incident_resolution', '平台提出处理方案', resolution.content || type, 'admin')
      return { id, resolution, status }
    }
    if (action === 'freezeStaffEarning') {
      await requireAdmin(openid)
      const id = data.id || data.incidentId
      return freezeIncidentEarnings(id, openid)
    }
    if (action === 'linkRefund') {
      await requireAdmin(openid)
      const id = data.id || data.incidentId
      const incidentRes = await db.collection('order_incidents').doc(id).get().catch(() => ({ data: null }))
      const incident = incidentRes && incidentRes.data
      if (!incident) throw new Error('纠纷不存在')
      if (['closed', 'resolved', 'rejected'].includes(incident.status)) {
        throw new Error('已结案纠纷不可再关联或发起退款')
      }
      const clientRequestId = getClientRequestId(data)
      if (incident.refundId) {
        if ((data.refundId && data.refundId === incident.refundId) || (clientRequestId && incident.clientRequestId === clientRequestId)) {
          return { id, refundId: incident.refundId, refundNo: incident.refundNo || '', status: incident.status }
        }
        throw new Error('该纠纷已关联退款单，请勿重复发起退款')
      }
      const orderRes = await db.collection('orders').doc(incident.orderId).get().catch(() => ({ data: null }))
      const order = orderRes && orderRes.data
      if (!order) throw new Error('订单不存在')
      let refund = null
      let actionName = 'refund_linked'
      const refundAmount = Number(data.refundAmount || 0)
      if (refundAmount > 0) {
        if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'refunding') throw new Error('订单未支付，不能退款')
        const payAmount = Number(order.payAmount || 0)
        const currentRefunded = Number(order.refundAmount || 0)
        const maxRefundable = Math.max(0, Math.round((payAmount - currentRefunded) * 100) / 100)
        if (refundAmount > payAmount) throw new Error('退款金额不正确')
        if (refundAmount > maxRefundable) throw new Error(`退款金额超出订单剩余可退上限（当前最大可退 ¥${maxRefundable}）`)
        refund = await createRefundForOrder({ ...order, _id: incident.orderId }, refundAmount, safeText(data.reason).trim() || '纠纷处理退款', 'incident', openid, clientRequestId)
        actionName = 'refund_created'
      } else if (data.refundId) {
        const refundRes = await db.collection('refunds').doc(data.refundId).get().catch(() => ({ data: null }))
        refund = refundRes && refundRes.data
        if (!refund || refund.orderId !== incident.orderId) throw new Error('退款单不存在或不属于本订单')
      } else {
        throw new Error('请输入有效的退款金额或选择已有退款单')
      }
      const update = { refundId: (refund && refund._id) || data.refundId || '', refundNo: (refund && refund.refundNo) || data.refundNo || '', status: 'refund_pending', clientRequestId: clientRequestId || '', updatedAt: now() }
      await db.collection('order_incidents').doc(id).update({ data: update })
      if (refund) {
        await appendOrderTimeline(incident.orderId, 'refund_processing', '纠纷处理退款中', `退款金额 ¥${Number(refund.refundAmount || refundAmount || 0)}`, 'admin')
      }
      await recordIncidentAction(id, actionName, 'admin', openid, { ...update, refundAmount: refund ? Number(refund.refundAmount || 0) : 0 })
      return { id, ...update }
    }
    if (action === 'closeIncident') {
      await requireAdmin(openid)
      const id = data.id || data.incidentId
      const status = normalizeIncidentStatus(data.status, 'closed')
      return closeIncidentFinancially(id, { ...data, status }, openid)
    }
    throw new Error('未知 incident 操作')
  }
}
