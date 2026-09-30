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
      const current = (await ref.get().catch(() => ({ data: null }))).data
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

  return { checkRateLimit }
}
