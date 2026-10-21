const assert = require('node:assert/strict')
const { isDeepStrictEqual } = require('node:util')
const { createCollectionStore } = require('./helpers')

// Overlapping snapshots, atomic commit and read-version retry, not a serialized queue.
function optimistic(db) {
  let retries = 0
  db.runTransaction = async callback => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const snapshot = createCollectionStore(structuredClone(db.state))
      const reads = new Map()
      const queryReads = new Map()
      const writes = []
      function trackQuery(query, name) {
        return new Proxy(query, { get(target, key) {
          if (key === 'get') return async () => {
            queryReads.set(name, structuredClone(snapshot.state[name] || []))
            return target.get()
          }
          if (['where', 'orderBy', 'limit', 'skip', 'field'].includes(key)) return (...args) => trackQuery(target[key](...args), name)
          return target[key]
        } })
      }
      const result = await callback({ collection(name) { return { where: (...args) => trackQuery(snapshot.collection(name).where(...args), name), doc(id) {
        const remember = () => reads.set(`${name}/${id}`, { name, id, value: structuredClone(snapshot.state[name]?.find(row => row._id === id)) })
        return {
          async get() { remember(); return snapshot.collection(name).doc(id).get() },
          async update({ data }) { remember(); writes.push({ name, id, data, replace: false }) },
          async set({ data }) {
            if (data && Object.prototype.hasOwnProperty.call(data, '_id')) {
              throw new Error('document.set:fail -501007 invalid parameters. 不能更新_id的值')
            }
            remember(); writes.push({ name, id, data, replace: true })
          }
        }
      } } } })
      if ([...reads.values()].some(({ name, id, value }) => !isDeepStrictEqual(db.state[name]?.find(row => row._id === id), value)) ||
        [...queryReads].some(([name, value]) => !isDeepStrictEqual(db.state[name] || [], value))) {
        retries++; continue
      }
      for (const { name, id, data, replace } of writes) {
        const rows = db.state[name] || (db.state[name] = [])
        const index = rows.findIndex(row => row._id === id)
        if (replace) {
          const row = { ...data, _id: id }
          if (index < 0) rows.push(row)
          else rows[index] = row
        } else {
          assert.ok(index >= 0)
          Object.assign(rows[index], data)
        }
      }
      return result
    }
    throw new Error('transaction retries exhausted')
  }
  return () => retries
}

module.exports = optimistic
