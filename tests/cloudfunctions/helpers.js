const Module = require('module')
const path = require('path')

function createCollectionStore(initial = {}) {
  const state = {}
  Object.keys(initial).forEach((name) => {
    state[name] = initial[name].map((item, index) => ({ _id: item._id || `${name}_${index + 1}`, ...item }))
  })

  function ensure(name) {
    if (!state[name]) state[name] = []
    return state[name]
  }

  function matchWhere(item, where) {
    return Object.keys(where || {}).every((key) => item[key] === where[key])
  }

  function collection(name) {
    const chain = {
      _where: null,
      _limit: null,
      _order: null,
      where(where) {
        this._where = where
        return this
      },
      limit(limit) {
        this._limit = limit
        return this
      },
      orderBy(field, direction) {
        this._order = { field, direction }
        return this
      },
      async get() {
        let data = ensure(name).filter((item) => matchWhere(item, this._where))
        if (this._order) {
          const { field, direction } = this._order
          data = data.slice().sort((a, b) => {
            const av = a[field] || ''
            const bv = b[field] || ''
            return direction === 'desc' ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv))
          })
        }
        if (this._limit !== null) data = data.slice(0, this._limit)
        return { data }
      },
      async count() {
        return { total: ensure(name).filter((item) => matchWhere(item, this._where)).length }
      },
      async add({ data }) {
        const _id = `${name}_${ensure(name).length + 1}`
        ensure(name).push({ _id, ...data })
        return { _id }
      },
      doc(id) {
        return {
          async get() {
            const item = ensure(name).find((record) => record._id === id)
            if (!item) throw new Error(`${name}/${id} not found`)
            return { data: item }
          },
          async update({ data }) {
            const item = ensure(name).find((record) => record._id === id)
            if (!item) throw new Error(`${name}/${id} not found`)
            Object.assign(item, data)
            return { stats: { updated: 1 } }
          },
          async remove() {
            const index = ensure(name).findIndex((record) => record._id === id)
            if (index >= 0) ensure(name).splice(index, 1)
            return { stats: { removed: index >= 0 ? 1 : 0 } }
          }
        }
      }
    }
    return chain
  }

  return { collection, state, command: {} }
}

function clearRequireCache(filePath) {
  const resolved = require.resolve(filePath)
  delete require.cache[resolved]
}

function loadCloudFunction(functionName, db, openid = 'openid_test') {
  const functionPath = path.resolve(__dirname, '../../cloudfunctions', functionName, 'index.js')
  const originalLoad = Module._load

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test-env',
        init() {},
        database() { return db },
        getWXContext() { return { OPENID: openid } },
        openapi: {
          phonenumber: {
            async getPhoneNumber() {
              return { phoneInfo: { phoneNumber: '19900006302', purePhoneNumber: '19900006302' } }
            }
          }
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    clearRequireCache(functionPath)
    return require(functionPath)
  } finally {
    Module._load = originalLoad
  }
}

module.exports = {
  createCollectionStore,
  loadCloudFunction
}
