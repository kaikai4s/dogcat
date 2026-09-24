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
    notifyAdmins,
    notifyOrder,
    now,
    readScopedDocuments,
    safeText,
    toPublicHomeSecuritySnapshot,
    toPublicOrderHomeSecurity,
    toTimeValue,
    getActiveServiceSession,
    getNextPendingServiceSession
  } = context
  const removeField = db.command && typeof db.command.remove === 'function' ? db.command.remove() : undefined
  function stripLegacyHomeSecuritySecrets(security = {}) {
    const { doorLockCode, code, doorLockCodeCipher, doorLockCodeIv, doorLockCodeTag, ...safe } = security || {}
    if (Array.isArray(safe.sessionCodes)) {
      safe.sessionCodes = safe.sessionCodes.map(({ cipher, iv, tag, ...sessionSafe }) => sessionSafe)
    }
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
      const existing = await db.collection('home_security').where({ openid }).limit(1).get().catch(() => ({ data: [] }))
      const existingDoc = existing && existing.data && existing.data[0]
      if (existingDoc) {
        await db.collection('home_security').doc(existingDoc._id).update({ data: payload })
        return { _id: existingDoc._id, ...payload, doorLockCodeMasked: mask(data.doorLockCode || '') }
      }
      const created = await db.collection('home_security').add({ data: payload })
      return { _id: created._id, ...payload, doorLockCodeMasked: mask(data.doorLockCode || '') }
    }

    if (action === 'getMaskedHomeSecurity') {
      await getUser(openid)
      const res = await db.collection('home_security').where({ openid }).limit(1).get().catch(() => ({ data: [] }))
      const record = res && res.data && res.data[0]
      if (!record) return null
      const plain = decryptText(record.doorLockCodeCipher, record.doorLockCodeIv, record.doorLockCodeTag)
      return { ...record, doorLockCodeCipher: undefined, doorLockCodeIv: undefined, doorLockCodeTag: undefined, doorLockCodeMasked: mask(plain) }
    }

    if (action === 'listHomeSecurityHistory') {
      await getUser(openid)
      const orders = await readScopedDocuments('orders', { clientOpenid: openid }, 'createdAt', 'desc')
      return orders
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
      let user = null
      let order = null
      let result = 'forbidden'
      let reason = ''
      const orderId = safeText(data && data.orderId).trim()
      try {
        user = await getUser(openid)
        if (!user || !user.roles || !user.roles.includes('staff')) throw new Error('仅员工可查看')
        if (!orderId) throw new Error('缺少订单ID')
        const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
        order = orderRes && orderRes.data
        if (!order || isAdminDeletedOrder(order)) throw new Error('订单不存在')
        if (order.staffOpenid !== openid) throw new Error('不是该订单绑定员工')
        if (!['assigned', 'in_service', 'day_completed'].includes(order.status)) throw new Error('订单状态不允许查看')
        const current = now().getTime()

        // 频次控制：单订单 1 分钟内最多查看 3 次，防止恶意自动化探测与算力滥用
        const oneMinuteAgo = current - 60 * 1000
        const recentLogsRes = await db.collection('unlock_code_logs')
          .where({ orderId })
          .orderBy('createdAt', 'desc')
          .limit(10)
          .get()
          .catch(() => ({ data: [] }))
        const recentLogs = recentLogsRes.data || []
        const attemptsInLastMinute = recentLogs.filter((log) => {
          if (!log || !log.createdAt) return false
          const logTime = log.createdAt instanceof Date ? log.createdAt.getTime() : new Date(log.createdAt).getTime()
          return Number.isFinite(logTime) && logTime >= oneMinuteAgo
        }).length

        const MAX_UNLOCK_ATTEMPTS_PER_MINUTE = 3
        if (attemptsInLastMinute >= MAX_UNLOCK_ATTEMPTS_PER_MINUTE) {
          result = 'rate_limited'
          throw new Error('密码查看过于频繁，请稍后再试（1分钟内限查看3次）')
        }

        const approvedEarlyStart = await getApprovedEarlyStart(orderId)
        const regularStart = toTimeValue(order.startTime)
        const start = approvedEarlyStart ? toTimeValue(approvedEarlyStart.approvedAt || approvedEarlyStart.createdAt) : regularStart
        const end = toTimeValue(order.endTime)

        const sessions = Array.isArray(order.serviceSessions) ? order.serviceSessions.filter(s => s.status !== 'cancelled') : []
        let targetSession = null
        if (sessions.length > 0) {
          const reqSessionIndex = data && data.sessionIndex !== undefined && data.sessionIndex !== null && String(data.sessionIndex).trim() !== ''
            ? Number(data.sessionIndex)
            : null
          if (reqSessionIndex) {
            targetSession = sessions.find(s => Number(s.index) === reqSessionIndex) || null
          }
          if (!targetSession) {
            const activeSession = typeof getActiveServiceSession === 'function' ? getActiveServiceSession(order) : null
            targetSession = activeSession || sessions.find(s => {
              const sStart = toTimeValue(s.startTime)
              const sEnd = toTimeValue(s.endTime)
              return current >= sStart && current <= sEnd
            }) || null
          }
          if (!targetSession && approvedEarlyStart) {
            const nextSession = typeof getNextPendingServiceSession === 'function' ? getNextPendingServiceSession(order) : null
            targetSession = nextSession || sessions[0]
          }
          if (!targetSession) {
            throw new Error('不在服务解锁时间窗口')
          }

          const sessionRegularStart = toTimeValue(targetSession.startTime)
          const sessionStart = (approvedEarlyStart && (!order.activeSessionIndex || Number(order.activeSessionIndex) === Number(targetSession.index)))
            ? toTimeValue(approvedEarlyStart.approvedAt || approvedEarlyStart.createdAt)
            : sessionRegularStart
          const sessionEnd = toTimeValue(targetSession.endTime)
          if ((sessionStart && current < sessionStart) || (sessionEnd && current > sessionEnd)) {
            throw new Error('不在服务解锁时间窗口')
          }
        } else {
          if ((start && current < start) || (end && current > end)) throw new Error('不在服务解锁时间窗口')
        }

        let security = (await db.collection('order_home_security').where({ orderId }).limit(1).get()).data[0]
        if (!security) security = order.orderHomeSecurity || order.homeSecuritySnapshot
        if (!security || security.type !== 'one_time_code') throw new Error('该订单未设置一次性密码')

        let targetCodeObj = null
        if (targetSession && Array.isArray(security.sessionCodes) && security.sessionCodes.length) {
          targetCodeObj = security.sessionCodes.find(item => Number(item.sessionIndex || item.index) === Number(targetSession.index) || (item.date && item.date === targetSession.date))
        }
        if (!targetCodeObj) {
          targetCodeObj = security.oneTimeCode
        }
        if (!targetCodeObj || !targetCodeObj.cipher) throw new Error('该订单未设置一次性密码')

        const effectiveStart = toTimeValue(targetCodeObj.effectiveStart)
        const effectiveEnd = toTimeValue(targetCodeObj.effectiveEnd)
        if (effectiveStart && current < effectiveStart) throw new Error('一次性密码尚未生效，请提醒用户重新设置或等待生效')
        if (effectiveEnd && current > effectiveEnd) throw new Error('一次性密码已过期，请提醒用户重新设置')
        result = 'success'
        reason = 'ok'
        return {
          lockMethod: security.type,
          lockMethodText: security.lockMethodText || lockMethodText(security.type),
          doorLockCode: decryptText(targetCodeObj.cipher, targetCodeObj.iv, targetCodeObj.tag),
          sessionIndex: targetSession ? targetSession.index : undefined,
          date: targetSession ? targetSession.date : undefined,
          effectiveStart: targetCodeObj.effectiveStart,
          effectiveEnd: targetCodeObj.effectiveEnd,
          entryNotes: security.entryNotes || ''
        }
      } catch (error) {
        reason = error.message
        if (error.message && error.message.includes('过于频繁')) {
          result = 'rate_limited'
        }
        throw error
      } finally {
        await db.collection('unlock_code_logs').add({
          data: {
            orderId: orderId || (data && data.orderId) || '',
            staffUserId: user ? user._id : '',
            staffOpenid: openid,
            result,
            reason,
            isRateLimited: result === 'rate_limited',
            createdAt: now()
          }
        }).catch((err) => {
          console.error('[homeSecurity] failed to write unlock_code_logs', err)
        })
        if (result === 'rate_limited') {
          console.warn(`[homeSecurity] rate limit exceeded for unlock code: orderId=${orderId}, staffOpenid=${openid}`)
          if (typeof notifyAdmins === 'function') {
            notifyAdmins({
              type: 'unlock_code_rate_limit_warning',
              title: '门锁一次性密码查看频次超限告警',
              content: `订单 ${order && order.orderNo ? order.orderNo : orderId} 门锁一次性密码在1分钟内查看超过3次，已触发防暴力频控拦截`,
              level: 'warning',
              orderId,
              orderNo: order && order.orderNo ? order.orderNo : '',
              extra: { orderId, staffOpenid: openid, staffUserId: user ? user._id : '', reason }
            }).catch(() => {})
          }
        }
      }
    }

    if (action === 'requestRemoteUnlock') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可请求开门')
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单不存在')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      const order = orderRes && orderRes.data
      if (!order) throw new Error('订单不存在')
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
      await db.collection('orders').doc(orderId).update({ data: { orderHomeSecurity: updatedSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(updatedSecurity), updatedAt: time } })
      const securityRes = await db.collection('order_home_security').where({ orderId }).limit(1).get().catch(() => ({ data: [] }))
      const secDoc = securityRes && securityRes.data && securityRes.data[0]
      if (secDoc) await db.collection('order_home_security').doc(secDoc._id).update({ data: removeLegacySecretFields({ ...updatedSecurity, updatedAt: time }) })
      const notification = await db.collection('home_security_notifications').add({ data: { orderId, type: 'remote_unlock', clientOpenid: order.clientOpenid, staffOpenid: openid, channels: ['wechat', 'admin_phone'], status: { wechat: 'pending', admin_phone: 'available' }, customerServiceSnapshot, createdAt: time } })
      const updatedOrder = { ...order, _id: orderId, orderHomeSecurity: updatedSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(updatedSecurity), updatedAt: time }
      await appendOrderClientMessage(updatedOrder, { eventType: 'remote_unlock_requested', title: '宠托师请求远程开门', detail: '宠托师已到达服务地点，请及时远程开门。', actorRole: 'staff', idempotencyKey: makeIdempotencyKey('order_message', orderId, 'remote_unlock_requested', notification._id || time.toISOString()) })
      const notifyResult = await notifyOrder(order.clientOpenid, 'remoteUnlock', updatedOrder, { deviceName: '宠托师请求远程开门', requestTime: beijingClockText(time) })
      const finalSecurity = { ...updatedSecurity, remoteUnlock: { ...updatedSecurity.remoteUnlock, lastNotifyStatus: { wechat: notifyResult && notifyResult.status || 'skipped', admin_phone: 'available' }, lastNotifyError: notifyResult && notifyResult.error || '' } }
      await db.collection('orders').doc(orderId).update({ data: { orderHomeSecurity: finalSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(finalSecurity), updatedAt: time } })
      if (secDoc) await db.collection('order_home_security').doc(secDoc._id).update({ data: removeLegacySecretFields({ ...finalSecurity, updatedAt: time }) })
      await db.collection('home_security_notifications').doc(notification._id).update({ data: { status: finalSecurity.remoteUnlock.lastNotifyStatus, error: finalSecurity.remoteUnlock.lastNotifyError, updatedAt: time } })
      await appendOrderStaffMessage({ ...updatedOrder, orderHomeSecurity: finalSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(finalSecurity) }, { eventType: 'remote_unlock_reminder_sent', title: '已提醒宠物主远程开门', detail: '开门提醒已发送给宠物主，请等待对方处理。', actorRole: 'system', idempotencyKey: makeIdempotencyKey('order_staff_message', orderId, 'remote_unlock_reminder_sent', notification._id || time.toISOString()) })
      return toPublicOrderHomeSecurity(finalSecurity)
    }

    if (action === 'updateOrderOneTimeCode') {
      await getUser(openid)
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单不存在')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      const order = orderRes && orderRes.data
      if (!order) throw new Error('订单不存在')
      if (order.clientOpenid !== openid) throw new Error('无权修改该订单')
      if (!['pending_pay', 'paid', 'assigned', 'in_service'].includes(order.status)) throw new Error('当前订单状态不可修改密码')
      const time = now()
      const existingSecurity = stripLegacyHomeSecuritySecrets(order.orderHomeSecurity || {})
      let security = { ...existingSecurity, type: 'one_time_code', lockMethod: 'one_time_code', lockMethodText: lockMethodText('one_time_code'), entryNotes: data.entryNotes || existingSecurity.entryNotes || '', hasDoorLockCode: true, updatedAt: time }

      if (Array.isArray(data.sessionCodes) && data.sessionCodes.length) {
        const sessionCodes = data.sessionCodes.map((item, idx) => {
          const itemCode = safeText(item.code || item.doorLockCode).trim()
          if (!itemCode) throw new Error(`请填写第${idx + 1}天的一次性开门密码`)
          if (!item.effectiveStart || !item.effectiveEnd) throw new Error(`请选择第${idx + 1}天一次性密码有效时间`)
          if (toTimeValue(item.effectiveEnd) <= toTimeValue(item.effectiveStart)) throw new Error(`第${idx + 1}天一次性密码结束时间必须晚于开始时间`)
          const enc = encryptText(itemCode)
          return {
            sessionIndex: Number(item.sessionIndex || item.index || (idx + 1)),
            date: safeText(item.date).trim(),
            cipher: enc.cipher,
            iv: enc.iv,
            tag: enc.tag,
            masked: mask(itemCode),
            effectiveStart: item.effectiveStart,
            effectiveEnd: item.effectiveEnd,
            coversServiceTime: true
          }
        })
        security.sessionCodes = sessionCodes
        if (!security.oneTimeCode && sessionCodes[0]) {
          security.oneTimeCode = { ...sessionCodes[0] }
        }
      } else if (data.sessionIndex !== undefined && data.sessionIndex !== null && String(data.sessionIndex).trim() !== '') {
        const sessionIndex = Number(data.sessionIndex)
        const code = safeText(data.code).trim()
        if (!code) throw new Error('请填写一次性开门密码')
        if (!data.effectiveStart || !data.effectiveEnd) throw new Error('请选择一次性密码有效时间')
        if (toTimeValue(data.effectiveEnd) <= toTimeValue(data.effectiveStart)) throw new Error('一次性密码结束时间必须晚于开始时间')
        const enc = encryptText(code)
        const currentSessionCodes = Array.isArray(existingSecurity.sessionCodes) ? existingSecurity.sessionCodes.slice() : []
        const existIdx = currentSessionCodes.findIndex(item => Number(item.sessionIndex || item.index) === sessionIndex)
        const sessionItem = {
          sessionIndex,
          date: safeText(data.date).trim(),
          cipher: enc.cipher,
          iv: enc.iv,
          tag: enc.tag,
          masked: mask(code),
          effectiveStart: data.effectiveStart,
          effectiveEnd: data.effectiveEnd,
          coversServiceTime: true
        }
        if (existIdx >= 0) currentSessionCodes[existIdx] = sessionItem
        else currentSessionCodes.push(sessionItem)
        security.sessionCodes = currentSessionCodes
        if (!security.oneTimeCode) {
          security.oneTimeCode = { ...sessionItem }
        }
      } else {
        const code = safeText(data.code).trim()
        if (!code) throw new Error('请填写一次性开门密码')
        if (!data.effectiveStart || !data.effectiveEnd) throw new Error('请选择一次性密码有效时间')
        if (toTimeValue(data.effectiveEnd) <= toTimeValue(data.effectiveStart)) throw new Error('一次性密码结束时间必须晚于开始时间')
        const encrypted = encryptText(code)
        security.oneTimeCode = {
          cipher: encrypted.cipher,
          iv: encrypted.iv,
          tag: encrypted.tag,
          masked: mask(code),
          effectiveStart: data.effectiveStart,
          effectiveEnd: data.effectiveEnd,
          coversServiceTime: isTimeRangeCovered(order.startTime, order.endTime, data.effectiveStart, data.effectiveEnd)
        }
      }

      await db.collection('orders').doc(orderId).update({ data: { orderHomeSecurity: security, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(security), updatedAt: time } })
      const securityRes = await db.collection('order_home_security').where({ orderId }).limit(1).get().catch(() => ({ data: [] }))
      const secDoc = securityRes && securityRes.data && securityRes.data[0]
      if (secDoc) await db.collection('order_home_security').doc(secDoc._id).update({ data: removeLegacySecretFields({ ...security, updatedAt: time }) })
      await appendOrderStaffMessage({ ...order, _id: orderId, orderHomeSecurity: security, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(security), updatedAt: time }, { eventType: 'one_time_code_updated', title: '一次性密码已更新', detail: '宠物主已重新填写一次性门锁密码，请在服务时间内查看。', actorRole: 'client', idempotencyKey: makeIdempotencyKey('order_staff_message', orderId, 'one_time_code_updated', time.toISOString()) })
      return toPublicOrderHomeSecurity(security)
    }

    if (action === 'recordKeyReturned') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可操作')
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单不存在')
      const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
      const order = orderRes && orderRes.data
      if (!order) throw new Error('订单不存在')
      if (order.staffOpenid !== openid) throw new Error('不是该订单绑定员工')
      const security = stripLegacyHomeSecuritySecrets(order.orderHomeSecurity || order.homeSecuritySnapshot || {})
      if (security.type !== 'key' || !security.key) throw new Error('该订单不是钥匙入户方式')
      const imageFileIds = Array.isArray(data.imageFileIds) ? data.imageFileIds : []
      if (!imageFileIds.length) throw new Error('请上传放回钥匙位置图片')
      const time = now()
      const updatedSecurity = { ...security, key: { ...security.key, returnedAt: time.toISOString(), returnImageFileIds: imageFileIds, returnNote: data.note || '' }, updatedAt: time }
      await db.collection('orders').doc(data.orderId).update({ data: { orderHomeSecurity: updatedSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(updatedSecurity), updatedAt: time } })
      const returnSecRes = await db.collection('order_home_security').where({ orderId: data.orderId }).limit(1).get().catch(() => ({ data: [] }))
      const returnSecDoc = returnSecRes && returnSecRes.data && returnSecRes.data[0]
      if (returnSecDoc) await db.collection('order_home_security').doc(returnSecDoc._id).update({ data: removeLegacySecretFields({ ...updatedSecurity, updatedAt: time }) })
      return toPublicOrderHomeSecurity(updatedSecurity)
    }
    throw new Error('未知 homeSecurity 操作')
  }
}
