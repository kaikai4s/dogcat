const Module = require('module')
const path = require('path')
const { Aggregator } = require('mingo/aggregator')
const { Context, evalExpr } = require('mingo/core')

// Mingo's default date parser only accepts its fixed ISO format. Model the
// CloudBase dateFromString forms used by our fixtures; cloud integration is separate.
const aggregateContext = Context.init({
  accumulator: require('mingo/operators/accumulator'),
  pipeline: require('mingo/operators/pipeline'),
  query: require('mingo/operators/query'),
  expression: {
    ...require('mingo/operators/expression'),
    $dateFromString(row, expression, options) {
      const args = evalExpr(row, expression, options)
      if (args.dateString == null) return args.onNull
      let text = args.dateString.replace(' ', 'T')
      if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/i.test(text)) return args.onError
      const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(text)
      if (hasZone && args.timezone) throw new Error('Duplicate date timezone')
      if (text.length === 10) text += 'T00:00:00'
      if (!hasZone) text += args.timezone || 'Z'
      const date = new Date(text)
      return Number.isFinite(date.getTime()) ? date : args.onError
    }
  }
})

const aggregateCommand = Object.fromEntries([
  'eq', 'neq', 'in', 'gte', 'lt', 'or', 'and', 'indexOfBytes', 'cond', 'dateFromString',
  'ifNull', 'literal', 'floor', 'add', 'multiply', 'sum', 'push'
].map(name => [name, value => ({ [`$${name === 'neq' ? 'ne' : name}`]: value })]))

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
    return Object.keys(where || {}).every((key) => {
      const condition = where[key]
      if (condition && typeof condition === 'object' && '$gt' in condition) return item[key] > condition.$gt
      if (condition && typeof condition === 'object' && '$gte' in condition) return item[key] >= condition.$gte
      if (condition && typeof condition === 'object' && Array.isArray(condition.$in)) {
        if (Array.isArray(item[key])) return item[key].some(value => condition.$in.includes(value))
        return condition.$in.includes(item[key]) || (condition.$in.includes('') && item[key] === undefined) || (condition.$in.includes(null) && item[key] === null)
      }
      return item[key] === condition
    })
  }

  function collection(name) {
    const chain = {
      aggregate() {
        const stages = []
        const pipeline = {}
        for (const stage of ['addFields', 'match', 'group', 'sort', 'limit']) {
          pipeline[stage] = value => { stages.push({ [`$${stage}`]: value }); return pipeline }
        }
        pipeline.end = async () => ({ list: new Aggregator(stages, { context: aggregateContext }).run(ensure(name)).slice(0, 100) })
        return pipeline
      },
      _where: null,
      _limit: null,
      _order: null,
      _skip: 0,
      where(where) {
        this._where = where
        return this
      },
      limit(limit) {
        this._limit = limit
        return this
      },
      skip(offset) {
        this._skip = offset
        return this
      },
      orderBy(field, direction) {
        this._order = [...(this._order || []), { field, direction }]
        return this
      },
      async get() {
        let data = ensure(name).filter((item) => matchWhere(item, this._where))
        if (this._order) {
          data = data.slice().sort((a, b) => {
            for (const { field, direction } of this._order) {
              const av = a[field] || ''
              const bv = b[field] || ''
              const result = direction === 'desc' ? String(bv).localeCompare(String(av)) : String(av).localeCompare(String(bv))
              if (result) return result
            }
            return 0
          })
        }
        data = data.slice(this._skip)
        if (this._limit !== null) data = data.slice(0, this._limit)
        return { data }
      },
      async count() {
        return { total: ensure(name).filter((item) => matchWhere(item, this._where)).length }
      },
      async add({ data }) {
        if (data && data._id && ensure(name).some((item) => item._id === data._id)) {
          throw new Error(`document with _id ${data._id} already exists`)
        }
        const _id = (data && data._id) || `${name}_${ensure(name).length + 1}`
        ensure(name).push({ ...data, _id })
        return { _id }
      },
      async update({ data }) {
        const items = ensure(name).filter((item) => matchWhere(item, this._where))
        items.forEach((item) => Object.assign(item, data))
        return { stats: { updated: items.length } }
      },
      doc(id) {
        const _id = id || `${name}_${ensure(name).length + 1}`
        return {
          id: _id,
          _id,
          async get() {
            const item = ensure(name).find((record) => record._id === _id)
            if (!item) throw new Error(`document with _id ${_id} does not exist`)
            return { data: item }
          },
          async set({ data }) {
            const items = ensure(name)
            const index = items.findIndex(record => record._id === _id)
            const record = { ...data, _id }
            if (index >= 0) items[index] = record
            else items.push(record)
            return { _id, stats: { updated: index >= 0 ? 1 : 0, created: index < 0 ? 1 : 0 } }
          },
          async update({ data }) {
            const item = ensure(name).find((record) => record._id === _id)
            if (!item) throw new Error(`${name}/${_id} not found`)
            Object.assign(item, data)
            return { stats: { updated: 1 } }
          },
          async remove() {
            const index = ensure(name).findIndex((record) => record._id === _id)
            if (index >= 0) ensure(name).splice(index, 1)
            return { stats: { removed: index >= 0 ? 1 : 0 } }
          }
        }
      }
    }
    return chain
  }

  let transactionQueue = Promise.resolve()
  function runTransaction(callback) {
    const run = transactionQueue.then(async () => {
      // Isolated snapshots model atomic commit/rollback, not CloudBase conflict retries.
      const snapshot = createCollectionStore(structuredClone(state))
      const result = await callback({ collection: snapshot.collection })
      for (const name of Object.keys(state)) delete state[name]
      Object.assign(state, snapshot.state)
      return result
    })
    transactionQueue = run.catch(() => {})
    return run
  }
  return { collection, state, runTransaction, command: {
    in: (arr) => ({ $in: arr }), gt: value => ({ $gt: value }), gte: value => ({ $gte: value }),
    expr: value => ({ $expr: value }), aggregate: aggregateCommand
  } }
}

function clearRequireCache(filePath) {
  const resolved = require.resolve(filePath)
  const dir = path.dirname(resolved)
  Object.keys(require.cache).forEach(k => {
    if (k.startsWith(dir)) delete require.cache[k]
  })
}

function loadCloudFunction(functionName, db, openid = 'openid_test', cloudOverrides = {}) {
  const functionPath = path.resolve(__dirname, '../../cloudfunctions', functionName, 'index.js')
  const originalLoad = Module._load

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'wx-server-sdk') {
      return {
        DYNAMIC_CURRENT_ENV: 'test-env',
        init() {},
        database() { return db },
        getWXContext() { return { OPENID: openid } },
        getTempFileURL: cloudOverrides.getTempFileURL,
        ai: cloudOverrides.ai,
        extend: cloudOverrides.extend,
        downloadFile: cloudOverrides.downloadFile,
        openapi: {
          phonenumber: {
            async getPhoneNumber() {
              return { phoneInfo: { phoneNumber: '19900006302', purePhoneNumber: '19900006302' } }
            }
          },
          security: (cloudOverrides.openapi && cloudOverrides.openapi.security) || cloudOverrides.security,
          ...cloudOverrides.openapi
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
