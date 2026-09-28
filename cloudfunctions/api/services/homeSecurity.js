module.exports = function createService({
  db,
  encryptText,
  getActiveServiceSession,
  getNextPendingServiceSession,
  mask,
  now,
  safeText,
  toTimeValue
}) {
  function normalizeLockMethod(value) {
    const method = safeText(value).trim()
    const map = { handover: 'someone_home', password: 'one_time_code', other: 'someone_home' }
    const normalized = map[method] || method
    return ['someone_home', 'remote_unlock', 'one_time_code', 'key'].includes(normalized) ? normalized : 'someone_home'
  }

  function lockMethodText(method) {
    const textMap = { someone_home: '有人在家，敲门即可', remote_unlock: '上门后远程开门', one_time_code: '一次性密码', key: '钥匙/门禁卡', handover: '有人在家，敲门即可', password: '一次性密码' }
    return textMap[method] || textMap.someone_home
  }

  function isTimeRangeCovered(start, end, coverStart, coverEnd) {
    return toTimeValue(coverStart) <= toTimeValue(start) && toTimeValue(coverEnd) >= toTimeValue(end)
  }

  function normalizeHomeSecurityInput(data = {}) {
    const source = data.orderHomeSecurity || data.homeSecuritySnapshot || data.homeSecurity || {}
    const type = normalizeLockMethod(source.type || source.lockMethod || data.lockMethod)
    const entryNotes = safeText(source.entryNotes || data.entryNotes).trim()
    const base = { type, lockMethod: type, lockMethodText: lockMethodText(type), entryNotes, createdAt: now(), updatedAt: now() }

    if (type === 'someone_home') return base
    if (type === 'remote_unlock') {
      return { ...base, remoteUnlock: { lastRequestedAt: '', requestCount: 0, notifyChannels: ['wechat', 'admin_phone'], lastNotifyStatus: { wechat: '', admin_phone: '' } } }
    }
    if (type === 'one_time_code') {
      const sessionCodesInput = Array.isArray(source.sessionCodes) ? source.sessionCodes : (Array.isArray(data.sessionCodes) ? data.sessionCodes : [])
      let sessionCodes = []
      if (sessionCodesInput.length > 0) {
        sessionCodes = sessionCodesInput.map((item, idx) => {
          const itemCode = safeText(item.code || item.doorLockCode).trim()
          if (!itemCode) throw new Error(`请填写第${idx + 1}天的一次性开门密码`)
          const itemEffectiveStart = item.effectiveStart || item.doorLockCodeStartTime
          const itemEffectiveEnd = item.effectiveEnd || item.doorLockCodeEndTime
          if (!itemEffectiveStart || !itemEffectiveEnd) throw new Error(`请选择第${idx + 1}天一次性密码有效时间`)
          if (toTimeValue(itemEffectiveEnd) <= toTimeValue(itemEffectiveStart)) throw new Error(`第${idx + 1}天一次性密码结束时间必须晚于开始时间`)
          const enc = encryptText(itemCode)
          return {
            sessionIndex: Number(item.sessionIndex || item.index || (idx + 1)),
            date: safeText(item.date).trim(),
            cipher: enc.cipher,
            iv: enc.iv,
            tag: enc.tag,
            masked: mask(itemCode),
            effectiveStart: itemEffectiveStart,
            effectiveEnd: itemEffectiveEnd,
            coversServiceTime: true
          }
        })
      }

      const doorLockCode = safeText(source.code || source.doorLockCode || data.doorLockCode).trim()
      const effectiveStart = source.effectiveStart || data.doorLockCodeStartTime || (sessionCodes[0] && sessionCodes[0].effectiveStart)
      const effectiveEnd = source.effectiveEnd || data.doorLockCodeEndTime || (sessionCodes[sessionCodes.length - 1] && sessionCodes[sessionCodes.length - 1].effectiveEnd)

      if (!sessionCodes.length) {
        if (!doorLockCode) throw new Error('请填写一次性开门密码')
        if (!effectiveStart || !effectiveEnd) throw new Error('请选择一次性密码有效时间')
        if (toTimeValue(effectiveEnd) <= toTimeValue(effectiveStart)) throw new Error('一次性密码结束时间必须晚于开始时间')
        const coversServiceTime = isTimeRangeCovered(data.startTime, data.endTime, effectiveStart, effectiveEnd)
        if (!coversServiceTime) throw new Error('一次性密码有效期需要覆盖完整服务时间')
        const encrypted = encryptText(doorLockCode)
        return { ...base, hasDoorLockCode: true, oneTimeCode: { cipher: encrypted.cipher, iv: encrypted.iv, tag: encrypted.tag, masked: mask(doorLockCode), effectiveStart, effectiveEnd, coversServiceTime } }
      }

      const defaultCode = doorLockCode || (sessionCodesInput[0] && safeText(sessionCodesInput[0].code || sessionCodesInput[0].doorLockCode).trim()) || ''
      const defaultEnc = encryptText(defaultCode)
      return {
        ...base,
        hasDoorLockCode: true,
        sessionCodes,
        oneTimeCode: {
          cipher: defaultEnc.cipher,
          iv: defaultEnc.iv,
          tag: defaultEnc.tag,
          masked: sessionCodes[0] ? sessionCodes[0].masked : mask(defaultCode),
          effectiveStart: effectiveStart || '',
          effectiveEnd: effectiveEnd || '',
          coversServiceTime: true
        }
      }
    }
    if (type === 'key') {
      const location = safeText(source.location || data.keyLocation).trim()
      const imageFileIds = Array.isArray(source.imageFileIds) ? source.imageFileIds : (Array.isArray(data.keyImageFileIds) ? data.keyImageFileIds : [])
      if (!location) throw new Error('请填写钥匙放置位置')
      if (!imageFileIds.length) throw new Error('请上传钥匙放置位置图片')
      return { ...base, keyLocation: location, key: { location, imageFileIds, returnRequired: true, returnedAt: '', returnImageFileIds: [], returnNote: '' } }
    }
    throw new Error('请选择有效的入户方式')
  }

  async function getApprovedEarlyStart(orderId) {
    const res = await db.collection('order_early_start_requests').where({ orderId, status: 'approved' }).orderBy('approvedAt', 'desc').limit(1).get()
    return res.data[0] || null
  }

  async function getPendingEarlyStart(orderId) {
    const res = await db.collection('order_early_start_requests').where({ orderId, status: 'pending' }).orderBy('createdAt', 'desc').limit(1).get()
    return res.data[0] || null
  }

  async function getLatestEarlyStart(orderId) {
    const res = await db.collection('order_early_start_requests').where({ orderId }).orderBy('createdAt', 'desc').limit(1).get()
    return res.data[0] || null
  }

  function isBeforeServiceStart(order, current = now()) {
    const nextSession = getNextPendingServiceSession(order) || getActiveServiceSession(order)
    const start = toTimeValue((nextSession && nextSession.startTime) || order.startTime)
    return start > 0 && current.getTime() < start
  }

  async function canStartOrderService(order, current = now()) {
    if (!isBeforeServiceStart(order, current)) return true
    return Boolean(await getApprovedEarlyStart(order._id))
  }

  async function canStartOrderSession(order, session, current = now()) {
    const sessionStart = session && session.startTime ? session.startTime : order.startTime
    const start = toTimeValue(sessionStart)
    if (!start || current.getTime() >= start) return true
    return Boolean(await getApprovedEarlyStart(order._id))
  }

  function toEarlyStartView(request) {
    if (!request) return null
    return {
      _id: request._id,
      orderId: request.orderId,
      status: request.status,
      reason: request.reason || '',
      requestedAt: request.createdAt || '',
      approvedAt: request.approvedAt || '',
      rejectedAt: request.rejectedAt || '',
      clientRemark: request.clientRemark || ''
    }
  }

  function toPublicHomeSecuritySnapshot(security) {
    if (!security) return null
    const type = normalizeLockMethod(security.type || security.lockMethod)
    const isDestroyed = security.destroyed === true || security.isPasswordDestroyed === true
    const safe = {
      type,
      lockMethod: type,
      lockMethodText: security.lockMethodText || lockMethodText(type),
      entryNotes: security.entryNotes || '',
      destroyed: isDestroyed,
      isPasswordDestroyed: isDestroyed,
      passwordDestroyedAt: security.destroyedAt || security.passwordDestroyedAt || '',
      passwordDestroyReason: security.destroyReason || '',
      createdAt: security.createdAt || '',
      updatedAt: security.updatedAt || ''
    }
    if (security.oneTimeCode) {
      const codeDestroyed = isDestroyed || security.oneTimeCode.destroyed === true
      safe.oneTimeCode = {
        masked: security.oneTimeCode.masked || '******',
        effectiveStart: security.oneTimeCode.effectiveStart || '',
        effectiveEnd: security.oneTimeCode.effectiveEnd || '',
        coversServiceTime: security.oneTimeCode.coversServiceTime === true,
        destroyed: codeDestroyed,
        destroyedAt: security.oneTimeCode.destroyedAt || security.destroyedAt || ''
      }
      safe.hasDoorLockCode = !codeDestroyed
    }
    if (Array.isArray(security.sessionCodes) && security.sessionCodes.length) {
      safe.sessionCodes = security.sessionCodes.map((item) => {
        const itemDestroyed = isDestroyed || item.destroyed === true
        return {
          sessionIndex: item.sessionIndex || item.index,
          date: item.date || '',
          masked: item.masked || (item.cipher ? mask('******') : '******'),
          effectiveStart: item.effectiveStart || '',
          effectiveEnd: item.effectiveEnd || '',
          coversServiceTime: item.coversServiceTime === true,
          destroyed: itemDestroyed,
          destroyedAt: item.destroyedAt || security.destroyedAt || ''
        }
      })
      safe.hasDoorLockCode = !isDestroyed && safe.sessionCodes.some(s => !s.destroyed)
    }
    if (security.remoteUnlock) {
      safe.remoteUnlock = {
        lastRequestedAt: security.remoteUnlock.lastRequestedAt || '',
        requestCount: Number(security.remoteUnlock.requestCount || 0),
        notifyChannels: Array.isArray(security.remoteUnlock.notifyChannels) ? security.remoteUnlock.notifyChannels : [],
        lastNotifyStatus: security.remoteUnlock.lastNotifyStatus || {},
        lastNotifyError: security.remoteUnlock.lastNotifyError || ''
      }
    }
    if (security.key) {
      safe.key = {
        location: security.key.location || security.keyLocation || '',
        imageFileIds: Array.isArray(security.key.imageFileIds) ? security.key.imageFileIds : [],
        returnRequired: security.key.returnRequired !== false,
        returnedAt: security.key.returnedAt || '',
        returnImageFileIds: Array.isArray(security.key.returnImageFileIds) ? security.key.returnImageFileIds : [],
        returnNote: security.key.returnNote || ''
      }
      safe.keyLocation = safe.key.location
    }
    return safe
  }

  function toPublicOrderHomeSecurity(security) {
    if (!security) return null
    const type = security.type || security.lockMethod || 'someone_home'
    return toPublicHomeSecuritySnapshot({ ...security, type, lockMethod: type, lockMethodText: security.lockMethodText || lockMethodText(type) })
  }

  async function destroyOrderHomeSecuritySecrets(orderId, options = {}) {
    if (!orderId) return null
    const time = options.time || now()
    const sessionIndex = options.sessionIndex ? Number(options.sessionIndex) : null
    const reason = options.reason || 'service_completed_auto_destroyed'
    const actor = options.actor || 'staff'

    // 1. 查询 order_home_security 独立集合
    const secRes = await db.collection('order_home_security').where({ orderId }).limit(1).get().catch(() => ({ data: [] }))
    const secDoc = secRes.data && secRes.data[0]

    // 2. 查询 orders 集合
    const orderRes = await db.collection('orders').doc(orderId).get().catch(() => ({ data: null }))
    const order = orderRes && orderRes.data
    const existingSecurity = secDoc || (order && (order.orderHomeSecurity || order.homeSecuritySnapshot)) || null
    if (!existingSecurity) return null

    const updatedSec = { ...existingSecurity }

    const hasSessionCodes = Array.isArray(updatedSec.sessionCodes) && updatedSec.sessionCodes.length > 0
    // 销毁多日订单中特定场次
    let isAllDestroyed = false
    if (sessionIndex && hasSessionCodes) {
      updatedSec.sessionCodes = updatedSec.sessionCodes.map((item) => {
        if (Number(item.sessionIndex || item.index) === sessionIndex) {
          return {
            ...item,
            cipher: '',
            iv: '',
            tag: '',
            destroyed: true,
            destroyedAt: time,
            destroyReason: reason,
            masked: item.masked || '******'
          }
        }
        return item
      })
      isAllDestroyed = updatedSec.sessionCodes.every((item) => item.destroyed === true)
    }

    // 全单完结或单日完单或全部场次已销毁
    const isFullyDestroyed = !hasSessionCodes || !sessionIndex || isAllDestroyed || options.isFinal === true
    if (isFullyDestroyed) {
      if (updatedSec.oneTimeCode) {
        updatedSec.oneTimeCode = {
          ...updatedSec.oneTimeCode,
          cipher: '',
          iv: '',
          tag: '',
          destroyed: true,
          destroyedAt: time,
          destroyReason: reason,
          masked: updatedSec.oneTimeCode.masked || '******'
        }
      }
      if (Array.isArray(updatedSec.sessionCodes)) {
        updatedSec.sessionCodes = updatedSec.sessionCodes.map((item) => ({
          ...item,
          cipher: '',
          iv: '',
          tag: '',
          destroyed: true,
          destroyedAt: time,
          destroyReason: reason,
          masked: item.masked || '******'
        }))
      }
      updatedSec.doorLockCodeCipher = ''
      updatedSec.doorLockCodeIv = ''
      updatedSec.doorLockCodeTag = ''
      updatedSec.doorLockCode = ''
      updatedSec.code = ''
      updatedSec.destroyed = true
      updatedSec.destroyedAt = time
      updatedSec.destroyReason = reason
      updatedSec.destroyedBy = actor
      updatedSec.isPasswordDestroyed = true
    }

    updatedSec.updatedAt = time

    // 更新 order_home_security 集合
    if (secDoc) {
      await db.collection('order_home_security').doc(secDoc._id).update({
        data: updatedSec
      }).catch((err) => {
        console.error('[destroyOrderHomeSecuritySecrets] failed to update order_home_security:', err)
      })
    }

    // 更新 orders 集合中的快照与安防对象
    const hasRemainingCodes = !isFullyDestroyed && Array.isArray(updatedSec.sessionCodes) && updatedSec.sessionCodes.some(s => !s.destroyed)
    updatedSec.hasDoorLockCode = hasRemainingCodes
    const publicSnapshot = toPublicHomeSecuritySnapshot(updatedSec)

    const orderUpdateData = {
      orderHomeSecurity: updatedSec,
      homeSecuritySnapshot: publicSnapshot,
      hasDoorLockCode: hasRemainingCodes,
      updatedAt: time
    }
    if (isFullyDestroyed) {
      orderUpdateData.isDoorLockCodeDestroyed = true
      orderUpdateData.doorLockCodeDestroyedAt = time
    }

    await db.collection('orders').doc(orderId).update({
      data: orderUpdateData
    }).catch((err) => {
      console.error('[destroyOrderHomeSecuritySecrets] failed to update orders:', err)
    })

    // 写入安全审计流水
    await db.collection('unlock_code_logs').add({
      data: {
        orderId,
        staffOpenid: (order && order.staffOpenid) || '',
        result: 'destroyed',
        reason,
        actor,
        sessionIndex: sessionIndex || undefined,
        createdAt: time
      }
    }).catch(() => {})

    return updatedSec
  }

  return {
    normalizeLockMethod,
    lockMethodText,
    isTimeRangeCovered,
    normalizeHomeSecurityInput,
    getApprovedEarlyStart,
    getPendingEarlyStart,
    getLatestEarlyStart,
    isBeforeServiceStart,
    canStartOrderService,
    canStartOrderSession,
    toEarlyStartView,
    toPublicHomeSecuritySnapshot,
    toPublicOrderHomeSecurity,
    destroyOrderHomeSecuritySecrets
  }
}
