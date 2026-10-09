module.exports = function createService({ db, crypto, now }) {
  async function read(tx, id) {
    try { return (await tx.collection('subscription_logs').doc(id).get()).data || null } catch (error) {
      if (String(error.message || error.errMsg).includes(`document with _id ${id} does not exist`)) return null
      throw error
    }
  }
  const deliveryId = message => {
    const identity = message.deliveryKey ? [message.openid, message.templateKey, message.orderId, message.deliveryKey] : message
    return `delivery_${crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`
  }
  async function enqueueSubscription(tx, message) {
    const id = deliveryId(message)
    if (await read(tx, id)) return id
    const time = now()
    await tx.collection('subscription_logs').doc(id).set({ data: {
      ...message, data: message.messageData, templateId: '', delivery: true, status: 'queued', attempts: 0,
      nextAttemptAt: time, createdAt: time, updatedAt: time
    } })
    return id
  }
  async function deliverSubscription(message, send) {
    const id = deliveryId(message)
    const token = crypto.randomBytes(16).toString('hex')
    const claim = await db.runTransaction(async tx => {
      const row = await read(tx, id)
      const time = now()
      if (row && ['sent', 'skipped', 'failed'].includes(row.status)) return { result: row }
      if (row && new Date(row.nextAttemptAt).getTime() > time.getTime()) return { result: { ...row, status: 'queued' } }
      const { _id, ...existing } = row || {}
      const value = { ...message, data: message.messageData, ...existing, templateId: row?.templateId || '', delivery: true, status: 'queued', leaseToken: token,
        attempts: Number(row?.attempts || 0) + 1, nextAttemptAt: new Date(time.getTime() + 120000),
        createdAt: row?.createdAt || time, updatedAt: time }
      await tx.collection('subscription_logs').doc(id).set({ data: value })
      return { value }
    })
    if (claim.result) return { status: claim.result.status, error: claim.result.error || '', templateKey: message.templateKey, templateId: claim.result.templateId || '' }
    let result
    try { result = await send(claim.value) } catch (error) { result = { status: 'failed', error: String(error.message || error) } }
    await db.runTransaction(async tx => {
      const row = await read(tx, id)
      if (!row || row.leaseToken !== token) return
      const retry = result.status === 'failed' && row.attempts < 6
      await tx.collection('subscription_logs').doc(id).update({ data: {
        status: retry ? 'queued' : result.status, error: result.error || '', templateId: result.templateId || '', leaseToken: '',
        nextAttemptAt: new Date(now().getTime() + Math.min(3600000, 60000 * Math.pow(2, row.attempts))), updatedAt: now(),
        ...(!retry ? { expiresAt: new Date(now().getTime() + 30 * 24 * 3600000) } : {})
      } })
    })
    return result
  }
  async function retrySubscriptionDeliveries(send) {
    const rows = (await db.collection('subscription_logs').where({ delivery: true, status: 'queued' }).orderBy('nextAttemptAt', 'asc').limit(30).get()).data || []
    for (const row of rows) {
      if (new Date(row.nextAttemptAt).getTime() > now().getTime()) continue
      const { openid, templateKey, page, messageData, orderId } = row
      try { await deliverSubscription({ openid, templateKey, page, messageData, orderId, ...(row.deliveryKey ? { deliveryKey: row.deliveryKey } : {}) }, send) }
      catch (error) { console.error('[subscription-retry]', { id: row._id, message: error.message }) }
    }
    return rows.length
  }
  async function listSubscriptionDeliveries(data = {}) {
    const status = ['queued', 'failed', 'sent', 'skipped'].includes(data.status) ? data.status : 'failed'
    const where = { delivery: true, status }
    if (data.cursor) where._id = db.command.gt(String(data.cursor))
    const rows = (await db.collection('subscription_logs').where(where).orderBy('_id', 'asc').limit(31).get()).data || []
    return { list: rows.slice(0, 30).map(row => ({ id: row._id, orderId: row.orderId || '', templateKey: row.templateKey,
      status: row.status, attempts: row.attempts, nextAttemptAt: row.nextAttemptAt, updatedAt: row.updatedAt })),
      hasMore: rows.length > 30, cursor: rows.length > 30 ? rows[29]._id : '' }
  }
  async function requeueSubscriptionDelivery(id, actorOpenid) {
    return db.runTransaction(async tx => {
      const row = await read(tx, id)
      if (!row || !row.delivery || !['failed', 'skipped'].includes(row.status)) throw new Error('仅失败或跳过的通知可重新发送')
      const time = now()
      await tx.collection('subscription_logs').doc(id).update({ data: {
        status: 'queued', attempts: 0, previousAttempts: Number(row.previousAttempts || 0) + Number(row.attempts || 0),
        manualRetries: Number(row.manualRetries || 0) + 1, nextAttemptAt: time, leaseToken: '', updatedAt: time,
        expiresAt: db.command.remove(), retriedBy: actorOpenid
      } })
      return { id, status: 'queued' }
    })
  }
  return { enqueueSubscription, deliverSubscription, retrySubscriptionDeliveries, listSubscriptionDeliveries, requeueSubscriptionDelivery }
}
