const crypto = require('crypto')

const COLLECTION = 'ai_chat_records'
const PAGE_SIZE = 20

module.exports = function createAiHistory({ db }) {
  function publicRecord(row) {
    return { id: row._id, question: row.question, answer: row.answer,
      ...(row.clientRequestId ? { clientRequestId: row.clientRequestId } : {}),
      generatedAt: row.createdAt, createdAtMs: row.createdAtMs, source: row.source }
  }

  function recordId(openid, requestId) {
    return crypto.createHash('sha256').update(JSON.stringify([openid, requestId])).digest('hex')
  }

  async function find(openid, id) {
    const result = await db.collection(COLLECTION).where({ openid, _id: id }).limit(1).get()
    return result.data[0] || null
  }

  async function list(openid, cursor = '') {
    let where = { openid }
    if (cursor) {
      if (typeof cursor !== 'string' || !/^\d{13,16}:[a-f0-9]{64}$/.test(cursor)) throw new Error('历史记录分页参数无效')
      const [timestamp, id] = cursor.split(':')
      const createdAtMs = Number(timestamp)
      if (!Number.isSafeInteger(createdAtMs)) throw new Error('历史记录分页参数无效')
      where = db.command.and([where, db.command.or([
        { createdAtMs: db.command.lt(createdAtMs) },
        { createdAtMs, _id: db.command.lt(id) }
      ])])
    }
    const result = await db.collection(COLLECTION).where(where)
      .orderBy('createdAtMs', 'desc').orderBy('_id', 'desc').limit(PAGE_SIZE + 1).get()
    const rows = result.data.slice(0, PAGE_SIZE)
    const last = rows[rows.length - 1]
    return { records: rows.map(publicRecord).reverse(),
      nextCursor: result.data.length > PAGE_SIZE ? `${last.createdAtMs}:${last._id}` : '' }
  }

  async function recentMessages(openid, petId) {
    // Only server-saved, moderated turns belonging to this caller are trusted.
    const result = await db.collection(COLLECTION).where({ openid, petId })
      .orderBy('createdAtMs', 'desc').orderBy('_id', 'desc').limit(6).get()
    const turns = []
    let remaining = 12000
    for (const row of result.data) {
      if (typeof row.question !== 'string' || typeof row.answer !== 'string') continue
      const question = row.question.slice(0, 300)
      const answer = row.answer.slice(0, 4000)
      if (!question.trim() || !answer.trim() || question.length + answer.length > remaining) break
      remaining -= question.length + answer.length
      turns.unshift([{ role: 'user', content: question }, { role: 'assistant', content: answer }])
    }
    return turns.flat()
  }

  async function save(row) {
    try {
      await db.collection(COLLECTION).add({ data: row })
      return row
    } catch (error) {
      // Concurrent retries can finish together; keep the first complete answer.
      const existing = await find(row.openid, row._id)
      if (existing && existing.question === row.question && existing.petId === row.petId) return existing
      throw error
    }
  }

  return { publicRecord, recordId, find, list, recentMessages, save }
}
