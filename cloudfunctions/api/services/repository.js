module.exports = function createService({
  db,
  toTimeValue
}) {
  async function* scanDocumentPages(collectionName, where = {}) {
    if (Object.prototype.hasOwnProperty.call(where, '_id')) throw new Error('分页查询不可覆盖记录 ID 条件')
    let cursor = ''
    while (true) {
      const condition = { ...where }
      if (cursor) condition._id = db.command.gt(cursor)
      const rows = (await db.collection(collectionName).where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
      if (!rows.length) return
      const nextCursor = rows[rows.length - 1]._id
      yield rows
      if (rows.length < 100) return
      cursor = nextCursor
    }
  }

  // Use an ID cursor while reading; timestamp ties cannot skip records.
  async function readScopedDocuments(collectionName, where, timeField = '', direction = 'asc') {
    const rows = []
    for await (const page of scanDocumentPages(collectionName, where)) rows.push(...page)
    if (timeField) {
      const sign = direction === 'desc' ? -1 : 1
      rows.sort((a, b) => sign * (toTimeValue(a[timeField]) - toTimeValue(b[timeField])) || String(a._id).localeCompare(String(b._id)))
    }
    return rows
  }
  async function readAllByQuery(collectionName, where = {}, timeField = '', direction = 'asc') {
    const rows = []
    let cursor = ''
    while (true) {
      const condition = { ...where }
      if (cursor) condition._id = db.command.gt(cursor)
      const page = (await db.collection(collectionName).where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
      if (!page.length) break
      rows.push(...page)
      cursor = page[page.length - 1]._id
      if (page.length < 100) break
    }
    if (timeField) {
      const sign = direction === 'desc' ? -1 : 1
      rows.sort((a, b) => sign * (toTimeValue(a[timeField]) - toTimeValue(b[timeField])) || String(a._id).localeCompare(String(b._id)))
    }
    return rows
  }

  function incUpdateValue(currentValue, delta) {
    if (db.command && typeof db.command.inc === 'function') return db.command.inc(delta)
    return Number(currentValue || 0) + Number(delta || 0)
  }

  async function safeCollectionData(name, builder) {
    try {
      const query = builder ? builder(db.collection(name)) : db.collection(name)
      const res = await query.get()
      return res.data || []
    } catch (error) {
      return []
    }
  }

  async function safeCollectionCount(name, where = {}) {
    try {
      const res = await db.collection(name).where(where).count()
      return Number(res.total || 0)
    } catch (error) {
      return 0
    }
  }

  async function removeByQuery(collectionName, where) {
    return removeAllByQuery(collectionName, where)
  }

  async function removeAllByQuery(collectionName, where, filter) {
    let total = 0
    for await (const page of scanDocumentPages(collectionName, where)) {
      const list = filter ? page.filter(filter) : page
      await Promise.all(list.map((item) => db.collection(collectionName).doc(item._id).remove()))
      total += list.length
    }
    return total
  }

  async function countByQuery(collectionName, where) {
    const res = await db.collection(collectionName).where(where).count()
    return Number(res.total || 0)
  }

  async function updateByQuery(collectionName, where, buildUpdate) {
    let total = 0
    for await (const page of scanDocumentPages(collectionName, where)) {
      await Promise.all(page.map((item) => db.collection(collectionName).doc(item._id).update({ data: typeof buildUpdate === 'function' ? buildUpdate(item) : buildUpdate })))
      total += page.length
    }
    return total
  }

  return {
    scanDocumentPages,
    readScopedDocuments,
    readAllByQuery,
    incUpdateValue,
    safeCollectionData,
    safeCollectionCount,
    removeByQuery,
    removeAllByQuery,
    countByQuery,
    updateByQuery
  }
}
