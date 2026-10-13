const aggregateDate = require('../utils/aggregateDate')

module.exports = function createService({ db, orderStatusText, readScopedDocuments }) {
  const collections = role => role === 'staff'
    ? { threads: 'order_staff_message_threads', messages: 'order_staff_messages', owner: 'staffOpenid', hidden: 'hiddenForStaff' }
    : { threads: 'order_message_threads', messages: 'order_messages', owner: 'clientOpenid', hidden: 'hiddenForClient' }
  const dateFallback = fields => fields.reduceRight((fallback, field) => ({ $ifNull: [aggregateDate(field), fallback] }), new Date(0))
  const integer = (value, fallback, max) => Math.max(1, Math.min(max, Math.floor(Number(value) || fallback)))

  async function hydrateThreadOrderStatus(thread) {
    if (!thread || !thread.orderId) return thread
    const orderDoc = await db.collection('orders').doc(thread.orderId).get().catch(() => ({ data: null }))
    const order = orderDoc && orderDoc.data
    if (!order || !order.status) return thread
    return {
      ...thread,
      orderStatus: order.status,
      orderNo: order.orderNo || thread.orderNo || '',
      petName: order.petName || thread.petName || '',
      serviceSummary: order.serviceSummary || thread.serviceSummary || '',
      orderTitle: thread.orderTitle || order.serviceSummary || thread.orderTitle || ''
    }
  }

  async function hydrateThreadsOrderStatus(rows) {
    return Promise.all(rows.map(hydrateThreadOrderStatus))
  }

  function withThreadStatusText(row, hasUnread) {
    return { ...row, hasUnread, orderStatusText: orderStatusText(row.orderStatus) }
  }

  async function queryMessageThreads(openid, role, data = {}) {
    const config = collections(role)
    const where = { [config.owner]: openid, [config.hidden]: db.command.neq(true) }
    const page = integer(data.page, 1, 10000)
    const pageSize = integer(data.pageSize, 20, 100)
    const [result, count] = await Promise.all([
      db.collection(config.threads).aggregate().match(where).addFields({
        _sortTime: dateFallback(['lastMessageAt', 'updatedAt', 'createdAt']),
        _unread: { $cond: [{ $gt: [{ $ifNull: ['$unreadCount', 0] }, 0] }, 1, 0] }
      }).sort({ _unread: -1, _sortTime: -1, _id: 1 }).skip((page - 1) * pageSize).limit(pageSize).end(),
      db.collection(config.threads).where(where).count()
    ])
    const rows = await hydrateThreadsOrderStatus(result.list.map(({ _sortTime, ...row }) => row))
    return { list: rows.map(({ _unread, ...row }) => withThreadStatusText(row, _unread === 1)),
      page, pageSize, total: count.total, hasMore: page * pageSize < count.total }
  }
  async function queryThreadMessages(threadId, role, data = {}) {
    const { messages } = collections(role)
    // Preserve old clients; updated detail pages opt in to the bounded cursor API.
    if (!data.pageSize && !data.before && !data.after) return {
      messages: await readScopedDocuments(messages, { threadId }, 'createdAt', 'asc')
    }
    if (data.before && data.after) throw new Error('消息游标不正确')
    const pageSize = integer(data.pageSize, 30, 99)
    const cursor = data.before || data.after
    let pipeline = db.collection(messages).aggregate().match({ threadId }).addFields({ _sortTime: dateFallback(['createdAt']) })
    if (cursor) {
      const time = new Date(cursor.time)
      if (!cursor || typeof cursor.id !== 'string' || !cursor.id || !Number.isFinite(time.getTime())) throw new Error('消息游标不正确')
      const operator = data.after ? '$gt' : '$lt'
      pipeline = pipeline.match(db.command.expr({ $or: [
        { [operator]: ['$_sortTime', time] },
        { $and: [{ $eq: ['$_sortTime', time] }, { [operator]: ['$_id', cursor.id] }] }
      ] }))
    }
    const direction = data.after ? 1 : -1
    const result = await pipeline.sort({ _sortTime: direction, _id: direction }).limit(pageSize + 1).end()
    const rows = result.list.slice(0, pageSize)
    if (direction === -1) rows.reverse()
    const key = row => row ? { id: row._id, time: row._sortTime.toISOString() } : null
    return { messages: rows.map(({ _sortTime, ...row }) => row), hasMore: result.list.length > pageSize,
      before: key(rows[0]), after: key(rows[rows.length - 1]) }
  }
  async function queryOrderMessageUnread(openid, role) {
    const config = collections(role)
    const result = await db.collection(config.threads).aggregate()
      .match({ [config.owner]: openid, [config.hidden]: db.command.neq(true) })
      .group({ _id: null, total: { $sum: { $max: [{ $ifNull: ['$unreadCount', 0] }, 0] } } }).end()
    return Number(result.list[0]?.total || 0)
  }
  return { queryMessageThreads, queryThreadMessages, queryOrderMessageUnread, hydrateThreadOrderStatus }
}
