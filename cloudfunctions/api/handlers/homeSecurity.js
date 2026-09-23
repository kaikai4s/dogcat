module.exports = function createHandler(context) {
  const {
    appendOrderClientMessage,
    appendOrderStaffMessage,
    beijingClockText,
    db,
    decryptText,
    encryptText,
    getApprovedEarlyStart,
    getSystemSettings,
    getUser,
    isAdminDeletedOrder,
    isTimeRangeCovered,
    lockMethodText,
    makeIdempotencyKey,
    mask,
    notifyOrder,
    now,
    safeText,
    toPublicHomeSecuritySnapshot,
    toPublicOrderHomeSecurity,
    toTimeValue
  } = context
  const removeField = db.command && typeof db.command.remove === 'function' ? db.command.remove() : undefined
  function stripLegacyHomeSecuritySecrets(security = {}) {
    const { doorLockCode, code, doorLockCodeCipher, doorLockCodeIv, doorLockCodeTag, ...safe } = security || {}
    return safe
  }
  function removeLegacySecretFields(data = {}) {
    if (removeField === undefined) return data
    return { ...data, doorLockCode: removeField, code: removeField }
  }
  return async function homeSecurity(openid, action, data) {
    if (action === 'saveHomeSecurity') {
      const user = await getUser(openid)
      const encrypted = encryptText(data.doorLockCode || '')
      const payload = { userId: user._id, openid, doorLockCodeCipher: encrypted.cipher, doorLockCodeIv: encrypted.iv, doorLockCodeTag: encrypted.tag, keyLocation: data.keyLocation || '', entryNotes: data.entryNotes || '', cameraLocations: data.cameraLocations || '', forbiddenAreas: data.forbiddenAreas || '', emergencyContactName: data.emergencyContactName || '', emergencyContactPhone: data.emergencyContactPhone || '', updatedAt: now() }
      const existing = await db.collection('home_security').where({ openid }).limit(1).get()
      if (existing.data[0]) {
        await db.collection('home_security').doc(existing.data[0]._id).update({ data: payload })
        return { _id: existing.data[0]._id, ...payload, doorLockCodeMasked: mask(data.doorLockCode || '') }
      }
      const created = await db.collection('home_security').add({ data: payload })
      return { _id: created._id, ...payload, doorLockCodeMasked: mask(data.doorLockCode || '') }
    }

    if (action === 'getMaskedHomeSecurity') {
      await getUser(openid)
      const res = await db.collection('home_security').where({ openid }).limit(1).get()
      const record = res.data[0]
      if (!record) return null
      const plain = decryptText(record.doorLockCodeCipher, record.doorLockCodeIv, record.doorLockCodeTag)
      return { ...record, doorLockCodeCipher: undefined, doorLockCodeIv: undefined, doorLockCodeTag: undefined, doorLockCodeMasked: mask(plain) }
    }

    if (action === 'listHomeSecurityHistory') {
      await getUser(openid)
      const res = await db.collection('orders').where({ clientOpenid: openid }).orderBy('createdAt', 'desc').get()
      return (res.data || [])
        .filter((order) => !isAdminDeletedOrder(order))
        .map((order) => {
          const security = toPublicOrderHomeSecurity(order.orderHomeSecurity || order.homeSecuritySnapshot)
          if (!security) return null
          return { orderId: order._id, orderNo: order.orderNo || '', serviceTime: `${order.startTime || ''} - ${order.endTime || ''}`, serviceAddress: order.serviceAddress || '', orderHomeSecurity: security, createdAt: order.createdAt || '' }
        })
        .filter(Boolean)
        .slice(0, Math.min(Number(data.limit || 30), 50))
    }

    if (action === 'getUnlockCode') {
      const user = await getUser(openid)
      const orderRes = await db.collection('orders').doc(data.orderId).get()
      const order = orderRes.data
      let result = 'forbidden'
      let reason = ''
      try {
        if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
        if (order.staffOpenid !== openid) throw new Error('不是该订单绑定员工')
        if (!['assigned', 'in_service', 'day_completed'].includes(order.status)) throw new Error('订单状态不允许查看')
        const current = now().getTime()
        const approvedEarlyStart = await getApprovedEarlyStart(data.orderId)
        const regularStart = toTimeValue(order.startTime)
        const start = approvedEarlyStart ? toTimeValue(approvedEarlyStart.approvedAt || approvedEarlyStart.createdAt) : regularStart
        const end = toTimeValue(order.endTime)
        if ((start && current < start) || (end && current > end)) throw new Error('不在服务解锁时间窗口')
        let security = (await db.collection('order_home_security').where({ orderId: data.orderId }).limit(1).get()).data[0]
        if (!security) security = order.orderHomeSecurity || order.homeSecuritySnapshot
        if (!security || security.type !== 'one_time_code' || !security.oneTimeCode) throw new Error('该订单未设置一次性密码')
        const effectiveStart = toTimeValue(security.oneTimeCode.effectiveStart)
        const effectiveEnd = toTimeValue(security.oneTimeCode.effectiveEnd)
        if (current < effectiveStart) throw new Error('一次性密码尚未生效，请提醒用户重新设置或等待生效')
        if (current > effectiveEnd) throw new Error('一次性密码已过期，请提醒用户重新设置')
        result = 'success'
        reason = 'ok'
        return { lockMethod: security.type, lockMethodText: security.lockMethodText || lockMethodText(security.type), doorLockCode: decryptText(security.oneTimeCode.cipher, security.oneTimeCode.iv, security.oneTimeCode.tag), effectiveStart: security.oneTimeCode.effectiveStart, effectiveEnd: security.oneTimeCode.effectiveEnd, entryNotes: security.entryNotes || '' }
      } catch (error) {
        reason = error.message
        throw error
      } finally {
        await db.collection('unlock_code_logs').add({ data: { orderId: data.orderId, staffUserId: user._id, staffOpenid: openid, result, reason, createdAt: now() } })
      }
    }

    if (action === 'requestRemoteUnlock') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可请求开门')
      const order = (await db.collection('orders').doc(data.orderId).get()).data
      if (order.staffOpenid !== openid) throw new Error('不是该订单绑定员工')
      if (!['assigned', 'in_service', 'day_completed'].includes(order.status)) throw new Error('订单状态不允许请求开门')
      const security = stripLegacyHomeSecuritySecrets(order.orderHomeSecurity || order.homeSecuritySnapshot || {})
      if (security.type !== 'remote_unlock') throw new Error('该订单不是远程开门方式')
      const remoteUnlock = security.remoteUnlock || { requestCount: 0, notifyChannels: ['wechat', 'admin_phone'], lastNotifyStatus: {} }
      const time = now()
      if (remoteUnlock.lastRequestedAt && time.getTime() - toTimeValue(remoteUnlock.lastRequestedAt) < 2 * 60 * 1000) throw new Error('开门请求发送过于频繁，请稍后再试')
      const settings = await getSystemSettings()
      const customerServiceSnapshot = settings.customerService || {}
      const updatedSecurity = { ...security, remoteUnlock: { ...remoteUnlock, lastRequestedAt: time.toISOString(), requestCount: Number(remoteUnlock.requestCount || 0) + 1, notifyChannels: ['wechat', 'admin_phone'], lastNotifyStatus: { wechat: 'pending', admin_phone: 'available' }, customerServiceSnapshot }, updatedAt: time }
      await db.collection('orders').doc(data.orderId).update({ data: { orderHomeSecurity: updatedSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(updatedSecurity), updatedAt: time } })
      const securityRes = await db.collection('order_home_security').where({ orderId: data.orderId }).limit(1).get()
      if (securityRes.data[0]) await db.collection('order_home_security').doc(securityRes.data[0]._id).update({ data: removeLegacySecretFields({ ...updatedSecurity, updatedAt: time }) })
      const notification = await db.collection('home_security_notifications').add({ data: { orderId: data.orderId, type: 'remote_unlock', clientOpenid: order.clientOpenid, staffOpenid: openid, channels: ['wechat', 'admin_phone'], status: { wechat: 'pending', admin_phone: 'available' }, customerServiceSnapshot, createdAt: time } })
      const updatedOrder = { ...order, _id: data.orderId, orderHomeSecurity: updatedSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(updatedSecurity), updatedAt: time }
      await appendOrderClientMessage(updatedOrder, { eventType: 'remote_unlock_requested', title: '宠托师请求远程开门', detail: '宠托师已到达服务地点，请及时远程开门。', actorRole: 'staff', idempotencyKey: makeIdempotencyKey('order_message', data.orderId, 'remote_unlock_requested', notification._id || time.toISOString()) })
      const notifyResult = await notifyOrder(order.clientOpenid, 'remoteUnlock', updatedOrder, { deviceName: '宠托师请求远程开门', requestTime: beijingClockText(time) })
      const finalSecurity = { ...updatedSecurity, remoteUnlock: { ...updatedSecurity.remoteUnlock, lastNotifyStatus: { wechat: notifyResult && notifyResult.status || 'skipped', admin_phone: 'available' }, lastNotifyError: notifyResult && notifyResult.error || '' } }
      await db.collection('orders').doc(data.orderId).update({ data: { orderHomeSecurity: finalSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(finalSecurity), updatedAt: time } })
      if (securityRes.data[0]) await db.collection('order_home_security').doc(securityRes.data[0]._id).update({ data: removeLegacySecretFields({ ...finalSecurity, updatedAt: time }) })
      await db.collection('home_security_notifications').doc(notification._id).update({ data: { status: finalSecurity.remoteUnlock.lastNotifyStatus, error: finalSecurity.remoteUnlock.lastNotifyError, updatedAt: time } })
      await appendOrderStaffMessage({ ...updatedOrder, orderHomeSecurity: finalSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(finalSecurity) }, { eventType: 'remote_unlock_reminder_sent', title: '已提醒宠物主远程开门', detail: '开门提醒已发送给宠物主，请等待对方处理。', actorRole: 'system', idempotencyKey: makeIdempotencyKey('order_staff_message', data.orderId, 'remote_unlock_reminder_sent', notification._id || time.toISOString()) })
      return toPublicOrderHomeSecurity(finalSecurity)
    }

    if (action === 'updateOrderOneTimeCode') {
      await getUser(openid)
      const order = (await db.collection('orders').doc(data.orderId).get()).data
      if (order.clientOpenid !== openid) throw new Error('无权修改该订单')
      if (!['pending_pay', 'paid', 'assigned', 'in_service'].includes(order.status)) throw new Error('当前订单状态不可修改密码')
      const code = safeText(data.code).trim()
      if (!code) throw new Error('请填写一次性开门密码')
      if (!data.effectiveStart || !data.effectiveEnd) throw new Error('请选择一次性密码有效时间')
      if (toTimeValue(data.effectiveEnd) <= toTimeValue(data.effectiveStart)) throw new Error('一次性密码结束时间必须晚于开始时间')
      const encrypted = encryptText(code)
      const time = now()
      const existingSecurity = stripLegacyHomeSecuritySecrets(order.orderHomeSecurity || {})
      const security = { ...existingSecurity, type: 'one_time_code', lockMethod: 'one_time_code', lockMethodText: lockMethodText('one_time_code'), entryNotes: data.entryNotes || existingSecurity.entryNotes || '', hasDoorLockCode: true, oneTimeCode: { cipher: encrypted.cipher, iv: encrypted.iv, tag: encrypted.tag, masked: mask(code), effectiveStart: data.effectiveStart, effectiveEnd: data.effectiveEnd, coversServiceTime: isTimeRangeCovered(order.startTime, order.endTime, data.effectiveStart, data.effectiveEnd) }, updatedAt: time }
      await db.collection('orders').doc(data.orderId).update({ data: { orderHomeSecurity: security, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(security), updatedAt: time } })
      const securityRes = await db.collection('order_home_security').where({ orderId: data.orderId }).limit(1).get()
      if (securityRes.data[0]) await db.collection('order_home_security').doc(securityRes.data[0]._id).update({ data: removeLegacySecretFields({ ...security, updatedAt: time }) })
      await appendOrderStaffMessage({ ...order, _id: data.orderId, orderHomeSecurity: security, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(security), updatedAt: time }, { eventType: 'one_time_code_updated', title: '一次性密码已更新', detail: '宠物主已重新填写一次性门锁密码，请在服务时间内查看。', actorRole: 'client', idempotencyKey: makeIdempotencyKey('order_staff_message', data.orderId, 'one_time_code_updated', time.toISOString()) })
      return toPublicOrderHomeSecurity(security)
    }

    if (action === 'recordKeyReturned') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可操作')
      const order = (await db.collection('orders').doc(data.orderId).get()).data
      if (order.staffOpenid !== openid) throw new Error('不是该订单绑定员工')
      const security = stripLegacyHomeSecuritySecrets(order.orderHomeSecurity || order.homeSecuritySnapshot || {})
      if (security.type !== 'key' || !security.key) throw new Error('该订单不是钥匙入户方式')
      const imageFileIds = Array.isArray(data.imageFileIds) ? data.imageFileIds : []
      if (!imageFileIds.length) throw new Error('请上传放回钥匙位置图片')
      const time = now()
      const updatedSecurity = { ...security, key: { ...security.key, returnedAt: time.toISOString(), returnImageFileIds: imageFileIds, returnNote: data.note || '' }, updatedAt: time }
      await db.collection('orders').doc(data.orderId).update({ data: { orderHomeSecurity: updatedSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(updatedSecurity), updatedAt: time } })
      const securityRes = await db.collection('order_home_security').where({ orderId: data.orderId }).limit(1).get()
      if (securityRes.data[0]) await db.collection('order_home_security').doc(securityRes.data[0]._id).update({ data: removeLegacySecretFields({ ...updatedSecurity, updatedAt: time }) })
      return toPublicOrderHomeSecurity(updatedSecurity)
    }
    throw new Error('未知 homeSecurity 操作')
  }
}
