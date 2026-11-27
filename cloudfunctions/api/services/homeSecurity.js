const crypto = require('crypto')
const { readOptionalDocument } = require('../utils/documentPages')
const { currentKeyReturn } = require('../utils/keyReturnEvidence')

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

  function getEarlyStartScope(order, session = null) {
    const target = session || getActiveServiceSession(order) || getNextPendingServiceSession(order)
    return {
      staffOpenid: order.staffOpenid || '',
      sessionIndex: Number(target?.index || 1),
      sessionStartTime: target?.startTime || order.startTime || '',
      assignmentTime: toTimeValue(order.assignedAt)
    }
  }
  async function readEarlyStart(orderId, status, order = null, session = null) {
    const current = order || await readOptionalDocument(db, 'orders', orderId)
    if (!current || !current.staffOpenid) return null
    const scope = getEarlyStartScope(current, session)
    const res = await db.collection('order_early_start_requests').where({ orderId, ...scope, ...(status ? { status } : {}) }).orderBy('createdAt', 'desc').limit(1).get()
    return res.data[0] || null
  }
  async function getApprovedEarlyStart(orderId, order = null, session = null) { return readEarlyStart(orderId, 'approved', order, session) }
  async function getPendingEarlyStart(orderId) { return readEarlyStart(orderId, 'pending') }
  async function getLatestEarlyStart(orderId) { return readEarlyStart(orderId, '') }

  function isBeforeServiceStart(order, current = now()) {
    const nextSession = getNextPendingServiceSession(order) || getActiveServiceSession(order)
    const start = toTimeValue((nextSession && nextSession.startTime) || order.startTime)
    return start > 0 && current.getTime() < start
  }

  async function canStartOrderService(order, current = now()) {
    if (!isBeforeServiceStart(order, current)) return true
    return Boolean(await getApprovedEarlyStart(order._id, order))
  }

  async function canStartOrderSession(order, session, current = now()) {
    const sessionStart = session && session.startTime ? session.startTime : order.startTime
    const start = toTimeValue(sessionStart)
    if (!start) return false
    if (current.getTime() >= start) return true
    return Boolean(await getApprovedEarlyStart(order._id, order, session))
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
        returnedSessionIndex: Number(security.key.returnedSessionIndex || 0),
        returnedSessionStartedAt: security.key.returnedSessionStartedAt || '',
        returnedStaffOpenid: security.key.returnedStaffOpenid || '',
        returnRecords: (Array.isArray(security.key.returnRecords) ? security.key.returnRecords : []).map(record => ({
          sessionIndex: Number(record.sessionIndex || 0), sessionStartedAt: record.sessionStartedAt || '',
          staffOpenid: record.staffOpenid || '', returnedAt: record.returnedAt || '',
          returnImageFileIds: Array.isArray(record.returnImageFileIds) ? record.returnImageFileIds : [],
          returnNote: record.returnNote || ''
        })),
        returnedAt: security.key.returnedAt || '',
        returnImageFileIds: Array.isArray(security.key.returnImageFileIds) ? security.key.returnImageFileIds : [],
        returnNote: security.key.returnNote || ''
      }
      safe.keyLocation = safe.key.location
    }
    return safe
  }

  function toPublicOrderHomeSecurity(security, order = null) {
    if (!security) return null
    const type = security.type || security.lockMethod || 'someone_home'
    const snapshot = toPublicHomeSecuritySnapshot({ ...security, type, lockMethod: type, lockMethodText: security.lockMethodText || lockMethodText(type) })
    if (order?.status === 'in_service' && type === 'key' && snapshot.key) {
      const receipt = currentKeyReturn(security.key, order)
      snapshot.key = { ...snapshot.key, returnedAt: receipt?.returnedAt || '',
        returnImageFileIds: receipt?.returnImageFileIds || [], returnNote: receipt?.returnNote || '' }
    }
    return snapshot
  }

  async function destroyOrderHomeSecuritySecrets(orderId, options = {}) {
    if (!orderId) return null
    const time = options.time || now()
    const sessionIndex = options.sessionIndex ? Number(options.sessionIndex) : null
    const reason = options.reason || 'service_completed_auto_destroyed'
    const actor = options.actor || 'staff'

    return db.runTransaction(async tx => {
      const secRes = await tx.collection('order_home_security').where({ orderId }).limit(2).get()
      if (secRes.data.length > 1) throw new Error('订单安防记录重复，请联系平台核对')
      const secDoc = secRes.data[0]
      const order = await readOptionalDocument(tx, 'orders', orderId)
      if (!order) return null
      const terminal = ['cancelled', 'expired', 'completed', 'refunded', 'closed'].includes(order.status)
      const groupFinished = order.groupCompletionPending && (order.serviceSessions || []).length > 0 &&
        order.serviceSessions.every(session => session.status === 'completed')
      if (options.onlyIfTerminated && !terminal && !groupFinished) return null
      if (options.onlyIfSessionCompleted && !(order.serviceSessions || []).some(session =>
        Number(session.index) === sessionIndex && ['completed', 'cancelled'].includes(session.status))) return null
      const pendingSessionIndexes = (order.homeSecurityPendingSessionIndexes || []).filter(index => Number(index) !== sessionIndex)
      const existingSecurity = secDoc || order.orderHomeSecurity || order.homeSecuritySnapshot ||
        (order.doorLockCodeCipher || order.doorLockCode ? { type: 'one_time_code' } : null)
      if (!existingSecurity) {
        await tx.collection('orders').doc(orderId).update({ data: {
          ...(terminal || groupFinished ? { homeSecurityCleanupPending: false, homeSecurityPendingSessionIndexes: [] }
            : { homeSecurityPendingSessionIndexes: pendingSessionIndexes })
        } })
        return null
      }

      const updatedSec = { ...order.orderHomeSecurity, ...existingSecurity }
      delete updatedSec._id
      const destroyCode = item => ({
        ...item, code: '', doorLockCode: '', cipher: '', iv: '', tag: '',
        destroyed: true, destroyedAt: item.destroyedAt || time,
        destroyReason: item.destroyReason || reason, masked: item.masked || '******'
      })
      const hasSessionCodes = Array.isArray(updatedSec.sessionCodes) && updatedSec.sessionCodes.length > 0
      if (sessionIndex && hasSessionCodes) {
        updatedSec.sessionCodes = updatedSec.sessionCodes.map(item =>
          Number(item.sessionIndex || item.index) === sessionIndex ? destroyCode(item) : item)
      }
      const totalSessions = (order.serviceSessions || []).length || 1
      const isMultiDay = order.orderType === 'multi_day' || totalSessions > 1
      // 中间场次只销毁当天密码；整单终止或明确最终完单才销毁统一码和未来场次。
      const isFullyDestroyed = terminal || options.isFinal === true || (isMultiDay
        ? Boolean(sessionIndex) && sessionIndex >= totalSessions
        : !sessionIndex || (hasSessionCodes && updatedSec.sessionCodes.every(item => item.destroyed === true)))
      if (isFullyDestroyed) {
        if (updatedSec.oneTimeCode) updatedSec.oneTimeCode = destroyCode(updatedSec.oneTimeCode)
        if (Array.isArray(updatedSec.sessionCodes)) updatedSec.sessionCodes = updatedSec.sessionCodes.map(destroyCode)
        Object.assign(updatedSec, {
          doorLockCodeCipher: '', doorLockCodeIv: '', doorLockCodeTag: '', doorLockCode: '', code: '',
          destroyed: true, destroyedAt: updatedSec.destroyedAt || time,
          destroyReason: updatedSec.destroyReason || reason, destroyedBy: updatedSec.destroyedBy || actor,
          isPasswordDestroyed: true
        })
      }
      updatedSec.updatedAt = time
      const hasActiveOneTimeCode = Boolean(updatedSec.oneTimeCode && !updatedSec.oneTimeCode.destroyed &&
        (updatedSec.oneTimeCode.cipher || updatedSec.oneTimeCode.code))
      const hasActiveSessionCodes = hasSessionCodes && updatedSec.sessionCodes.some(item => !item.destroyed)
      const hasRemainingCodes = !isFullyDestroyed && (hasActiveOneTimeCode || hasActiveSessionCodes)
      updatedSec.hasDoorLockCode = hasRemainingCodes
      const orderUpdateData = {
        orderHomeSecurity: db.command.set(updatedSec),
        homeSecuritySnapshot: db.command.set(toPublicHomeSecuritySnapshot(updatedSec)),
        hasDoorLockCode: hasRemainingCodes, updatedAt: time,
        homeSecurityPendingSessionIndexes: isFullyDestroyed ? [] : pendingSessionIndexes
      }
      if (isFullyDestroyed) {
        Object.assign(orderUpdateData, {
          isDoorLockCodeDestroyed: true, doorLockCodeDestroyedAt: updatedSec.destroyedAt,
          homeSecurityCleanupPending: false,
          doorLockCode: '', doorLockCodeCipher: '', doorLockCodeIv: '', doorLockCodeTag: ''
        })
      }
      const logId = `destroy_${crypto.createHash('sha256').update(JSON.stringify([orderId, isFullyDestroyed ? 'final' : sessionIndex])).digest('hex').slice(0, 32)}`
      const logged = await readOptionalDocument(tx, 'unlock_code_logs', logId)
      if (secDoc) {
        await tx.collection('order_home_security').doc(secDoc._id).update({ data: {
          ...updatedSec,
          ...(updatedSec.oneTimeCode ? { oneTimeCode: db.command.set(updatedSec.oneTimeCode) } : {})
        } })
      }
      await tx.collection('orders').doc(orderId).update({ data: orderUpdateData })
      if (!logged) await tx.collection('unlock_code_logs').doc(logId).set({ data: {
        orderId, staffOpenid: order.staffOpenid || '', result: 'destroyed', reason, actor,
        sessionIndex: sessionIndex || 0, createdAt: time
      } })
      return updatedSec
    })
  }

  async function retryPendingHomeSecurityCleanup() {
    const rows = (await db.collection('orders').where(db.command.or([
      { homeSecurityCleanupPending: true },
      { 'homeSecurityPendingSessionIndexes.0': db.command.exists(true) }
    ])).orderBy('updatedAt', 'asc').limit(30).get()).data || []
    for (const order of rows) {
      try {
        const terminal = ['cancelled', 'expired', 'completed', 'refunded', 'closed'].includes(order.status) ||
          (order.groupCompletionPending && (order.serviceSessions || []).length > 0 && order.serviceSessions.every(session => session.status === 'completed'))
        if (terminal) {
          await destroyOrderHomeSecuritySecrets(order._id, { isFinal: true, onlyIfTerminated: true, reason: 'terminal_cleanup_retry', actor: 'system' })
        } else {
          for (const sessionIndex of order.homeSecurityPendingSessionIndexes || []) {
            await destroyOrderHomeSecuritySecrets(order._id, { sessionIndex, onlyIfSessionCompleted: true, reason: 'session_cleanup_retry', actor: 'system' })
          }
        }
      } catch (error) {
        console.error('[home-security-cleanup]', { orderId: order._id, message: error.message })
      }
      await db.collection('orders').doc(order._id).update({ data: { updatedAt: now() } })
    }
    return rows.length
  }

  return {
    normalizeLockMethod,
    lockMethodText,
    isTimeRangeCovered,
    normalizeHomeSecurityInput,
    getApprovedEarlyStart,
    getEarlyStartScope,
    getPendingEarlyStart,
    getLatestEarlyStart,
    isBeforeServiceStart,
    canStartOrderService,
    canStartOrderSession,
    toEarlyStartView,
    toPublicHomeSecuritySnapshot,
    toPublicOrderHomeSecurity,
    destroyOrderHomeSecuritySecrets,
    retryPendingHomeSecurityCleanup
  }
}
