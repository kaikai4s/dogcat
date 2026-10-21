// Read bounded pages by immutable ID, including inside a transaction. Query errors
// must reach the caller; an unavailable database is never an empty ledger.
async function* documentPages(store, command, collection, where = {}) {
  if (Object.prototype.hasOwnProperty.call(where, '_id')) throw new Error('分页查询不可覆盖记录 ID 条件')
  let cursor = ''
  while (true) {
    const rows = (await store.collection(collection).where({ ...where,
      ...(cursor ? { _id: command.gt(cursor) } : {})
    }).orderBy('_id', 'asc').limit(100).get()).data || []
    if (!rows.length) return
    const next = rows[rows.length - 1]._id
    if (!next || (cursor && next <= cursor)) throw new Error('分页记录 ID 异常')
    yield rows
    if (rows.length < 100) return
    cursor = next
  }
}

async function readDocuments(store, command, collection, where, maximum = Infinity) {
  const rows = []
  for await (const page of documentPages(store, command, collection, where)) {
    rows.push(...page.slice(0, maximum - rows.length))
    if (rows.length >= maximum) break
  }
  return rows
}

async function readOptionalDocument(store, collection, id) {
  try { return (await store.collection(collection).doc(id).get()).data || null } catch (error) {
    const message = String(error.message || error.errMsg || '')
    if (message.includes(`document with _id ${id} does not exist`) || error.code === 'DATABASE_DOCUMENT_NOT_EXIST') return null
    throw error
  }
}

module.exports = { documentPages, readDocuments, readOptionalDocument }
