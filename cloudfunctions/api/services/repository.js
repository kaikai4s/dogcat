module.exports = function createService({
  db
}) {
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
    const res = await db.collection(collectionName).where(where).get()
    const list = res.data || []
    await Promise.all(list.map((item) => db.collection(collectionName).doc(item._id).remove()))
    return list.length
  }

  async function removeAllByQuery(collectionName, where, filter) {
    let total = 0
    while (true) {
      const res = await db.collection(collectionName).where(where).limit(100).get()
      const list = filter ? (res.data || []).filter(filter) : (res.data || [])
      if (!list.length) break
      await Promise.all(list.map((item) => db.collection(collectionName).doc(item._id).remove()))
      total += list.length
      if ((res.data || []).length < 100) break
    }
    return total
  }

  async function countByQuery(collectionName, where) {
    const res = await db.collection(collectionName).where(where).count()
    return Number(res.total || 0)
  }

  async function updateByQuery(collectionName, where, buildUpdate) {
    const res = await db.collection(collectionName).where(where).get()
    const list = res.data || []
    await Promise.all(list.map((item) => db.collection(collectionName).doc(item._id).update({ data: typeof buildUpdate === 'function' ? buildUpdate(item) : buildUpdate })))
    return list.length
  }

  return {
    incUpdateValue,
    safeCollectionData,
    safeCollectionCount,
    removeByQuery,
    removeAllByQuery,
    countByQuery,
    updateByQuery
  }
}
