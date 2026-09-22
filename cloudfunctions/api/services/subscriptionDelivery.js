module.exports = function createService({ db, crypto, now }) {
  async function read(tx, id) {
    try { return (await tx.collection('subscription_logs').doc(id).get()).data || null } catch (error) {
      if (String(error.message || error.errMsg).includes(`document with _id ${id} does not exist`)) return null
      throw error
    }
  }
  async function deliverSubscription(message, send) {
    const id = `delivery_${crypto.createHash('sha256').update(JSON.stringify(message)).digest('hex').slice(0, 32)}`
    const token = crypto.randomBytes(16).toString('hex')
    const claim = await db.runTransaction(async tx => {
      const row = await read(tx, id)
      const time = now()
      if (row && ['sent', 'skipped', 'failed'].includes(row.status)) return { result: row }
      if (row && new Date(row.nextAttemptAt).getTime() > time.getTime()) return { result: { ...row, status: 'queued' } }
      const value = { ...message, data: message.messageData, templateId: row?.templateId || '', delivery: true, status: 'queued', leaseToken: token,
        attempts: Number(row?.attempts || 0) + 1, nextAttemptAt: new Date(time.getTime() + 120000),
        createdAt: row?.createdAt || time, updatedAt: time }
      await tx.collection('subscription_logs').doc(id).set({ data: value })
      return { value }
    })
    if (claim.result) return { status: claim.result.status, error: claim.result.error || '', templateKey: message.templateKey, templateId: claim.result.templateId || '' }
    let result
    try { result = await send(message) } catch (error) { result = { status: 'failed', error: String(error.message || error) } }
    await db.runTransaction(async tx => {
      const row = await read(tx, id)
      if (row.leaseToken !== token) return
      const retry = result.status === 'failed' && row.attempts < 6
      await tx.collection('subscription_logs').doc(id).update({ data: {
        status: retry ? 'queued' : result.status, error: result.error || '', templateId: result.templateId || '', leaseToken: '',
        nextAttemptAt: new Date(now().getTime() + Math.min(3600000, 60000 * Math.pow(2, row.attempts))), updatedAt: now()
      } })
    })
    return result
  }
  async function retrySubscriptionDeliveries(send) {
    const rows = (await db.collection('subscription_logs').where({ delivery: true, status: 'queued' }).orderBy('nextAttemptAt', 'asc').limit(30).get()).data || []
    for (const row of rows) {
      if (new Date(row.nextAttemptAt).getTime() > now().getTime()) continue
      const { openid, templateKey, page, messageData, orderId } = row
      try { await deliverSubscription({ openid, templateKey, page, messageData, orderId }, send) }
      catch (error) { console.error('[subscription-retry]', { id: row._id, message: error.message }) }
    }
    return rows.length
  }
  return { deliverSubscription, retrySubscriptionDeliveries }
}
