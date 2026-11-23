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
  // Kept as a compatibility alias for callers using the older name.
  const readAllByQuery = readScopedDocuments

  async function runWithConcurrency(items, worker, concurrency = 10) {
    let nextIndex = 0
    async function consume() {
      while (nextIndex < items.length) {
        const index = nextIndex++
        await worker(items[index])
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, consume)
    await Promise.all(workers)
  }

  function incUpdateValue(currentValue, delta) {
    if (db.command && typeof db.command.inc === 'function') return db.command.inc(delta)
    return Number(currentValue || 0) + Number(delta || 0)
  }

  async function safeCollectionData(name, builder, { pageSize = 100, maxRows = 2000 } = {}) {
    try {
      let hasExplicitLimit = false
      let targetQuery = db.collection(name)
      const wrapQuery = (raw) => {
        const wrapper = {
          where: (...args) => wrapQuery(raw.where(...args)),
          orderBy: (...args) => wrapQuery(raw.orderBy(...args)),
          field: (...args) => wrapQuery(raw.field(...args)),
          skip: (...args) => wrapQuery(raw.skip(...args)),
          limit: (...args) => {
            hasExplicitLimit = true
            return wrapQuery(raw.limit(...args))
          },
          get: () => raw.get()
        }
        targetQuery = raw
        return wrapper
      }
      if (builder) {
        const built = builder(wrapQuery(targetQuery))
        if (built && typeof built.get === 'function' && built !== targetQuery && hasExplicitLimit) {
          const res = await built.get()
          return res.data || []
        }
      }
      if (hasExplicitLimit) {
        const res = await targetQuery.get()
        return res.data || []
      }
      const rows = []
      const batchSize = Math.min(Math.max(Number(pageSize || 100), 1), 100)
      while (rows.length < maxRows) {
        const remaining = maxRows - rows.length
        const limit = Math.min(batchSize, remaining)
        if (rows.length > 0 && typeof targetQuery.skip !== 'function') break
        const pageQuery = typeof targetQuery.skip === 'function' && rows.length > 0
          ? targetQuery.skip(rows.length).limit(limit)
          : targetQuery.limit(limit)
        const page = (await pageQuery.get()).data || []
        rows.push(...page)
        if (page.length < limit) break
      }
      return rows
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
      await runWithConcurrency(list, (item) => db.collection(collectionName).doc(item._id).remove())
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
      await runWithConcurrency(page, (item) => db.collection(collectionName).doc(item._id).update({ data: typeof buildUpdate === 'function' ? buildUpdate(item) : buildUpdate }))
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
