const { readOptionalDocument } = require('../utils/documentPages')

module.exports = function createService(context) {
  const { crypto, db, now, safeText } = context
  let collectionReady = false

  async function ensureRateLimitCollection() {
    if (collectionReady || typeof db.createCollection !== 'function') return
    await db.createCollection('rate_limits').catch(() => {})
    collectionReady = true
  }

  function rateLimitDocId(openid, action, windowStart) {
    return `rl_${crypto.createHash('sha256').update(`${safeText(openid).trim()}:${safeText(action).trim()}:${windowStart}`).digest('hex')}`
  }

  async function checkRateLimit(openid, action, options = {}) {
    const userOpenid = safeText(openid).trim()
    const limitAction = safeText(action).trim()
    const max = Math.max(1, Number(options.max || 60))
    const windowMs = Math.max(1000, Number(options.windowMs || 60 * 1000))
    if (!userOpenid || !limitAction) return { allowed: true }

    await ensureRateLimitCollection()
    const currentMs = Date.now()
    const windowStart = Math.floor(currentMs / windowMs) * windowMs
    const id = rateLimitDocId(userOpenid, limitAction, windowStart)
    const time = typeof now === 'function' ? now() : new Date()

    return db.runTransaction(async (tx) => {
      const ref = tx.collection('rate_limits').doc(id)
      const current = await readOptionalDocument(tx, 'rate_limits', id)
      const count = Number(current && current.count || 0)
      if (count >= max) throw new Error(options.message || '操作过于频繁，请稍后再试')
      const data = {
        openid: userOpenid,
        action: limitAction,
        windowStart,
        windowEnd: windowStart + windowMs,
        count: count + 1,
        updatedAt: time
      }
      if (current) {
        await ref.update({ data })
      } else {
        await ref.set({ data: { ...data, createdAt: time } })
      }
      return { allowed: true, count: count + 1, max, windowStart, windowMs }
    })
  }

  async function checkLogisticsQueryRateLimit(openid) {
    const userOpenid = safeText(openid).trim()
    if (!userOpenid) throw new Error('请先登录后再查询物流')
    await ensureRateLimitCollection()
    const max = 3, windowMs = 5 * 60 * 1000
    const time = typeof now === 'function' ? now() : new Date()
    const currentMs = new Date(time).getTime()
    const id = rateLimitDocId(userOpenid, 'logistics.query', 'sliding')
    return db.runTransaction(async tx => {
      const current = await readOptionalDocument(tx, 'rate_limits', id)
      const timestamps = (Array.isArray(current?.timestamps) ? current.timestamps : [])
        .filter(value => Number.isFinite(value) && value > currentMs - windowMs)
        .sort((a, b) => a - b)
      if (timestamps.length >= max) {
        const seconds = Math.max(1, Math.ceil((timestamps[0] + windowMs - currentMs) / 1000))
        throw Object.assign(new Error(`物流查询过于频繁，5分钟内最多查询3次，请在${seconds}秒后重试`), {
          code: 'LOGISTICS_RATE_LIMITED', retryAfterSeconds: seconds
        })
      }
      timestamps.push(currentMs)
      await tx.collection('rate_limits').doc(id).set({ data: {
        openid: userOpenid, action: 'logistics.query', timestamps, count: timestamps.length,
        windowMs, expiresAt: new Date(currentMs + windowMs),
        createdAt: current?.createdAt || time, updatedAt: time
      } })
      return { allowed: true, count: timestamps.length, max, windowMs }
    })
  }

  return { checkRateLimit, checkLogisticsQueryRateLimit }
}
