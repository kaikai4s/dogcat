const { callFunction, getCloudEnv } = require('../../utils/cloud')

const COLLECTION = 'pet_playground_live'
const SNAPSHOT_INTERVAL_MS = 30000
function newer(next, previous) {
  if (!previous) return true
  const a = next.version || {}
  const b = previous.version || {}
  return a.epoch > b.epoch || a.epoch === b.epoch && a.seq > b.seq
}

class ManorCommunitySync {
  constructor(scene, applyRecords, onError = () => {}, onState = () => {}) {
    this.scene = scene
    this.applyRecords = applyRecords
    this.onError = onError
    this.onState = onState
    this.records = new Map()
    this.active = false
    this.generation = 0
    this.retryCount = 0
    this.watchers = []
    this.sequence = 0
    this.eventSequence = 0
    this.positionFlight = null
    this.pendingPositionState = null
  }

  credentials() {
    return { sceneId: this.scene.sceneId, session: this.scene.session }
  }

  merge(record) {
    if (!record || typeof record.id !== 'string' || !newer(record, this.records.get(record.id))) return false
    this.eventSequence += 1
    this.records.set(record.id, {
      ...record,
      receivedSequence: this.eventSequence,
      mine: record.ownerId === this.scene.playerId
    })
    return true
  }

  async snapshot(generation = this.generation) {
    const startedAt = this.eventSequence
    const fetched = []
    let cursor = ''
    do {
      const result = await callFunction('playground', 'getScene', { ...this.credentials(), cursor })
      if (!this.active || this.generation !== generation) return
      fetched.push(...(Array.isArray(result.records) ? result.records : []))
      cursor = result.nextCursor || ''
    } while (cursor)

    const nextRecords = new Map()
    for (const record of fetched) {
      const old = this.records.get(record.id)
      nextRecords.set(record.id, old && !newer(record, old) ? old : {
        ...record,
        mine: record.mine === true || record.ownerId === this.scene.playerId
      })
    }
    for (const [id, old] of this.records) {
      if (!nextRecords.has(id) && (old.receivedSequence || 0) > startedAt) nextRecords.set(id, old)
    }
    this.records = nextRecords
    this.retryCount = 0
    this.onState('connected')
    this.applyRecords([...this.records.values()])
  }

  watch(generation) {
    if (!wx.cloud?.database) return this.scheduleRetry(generation, new Error('当前微信环境不支持实时场景同步'))
    const env = getCloudEnv()
    const database = wx.cloud.database(env ? { env } : {})
    let watcher
    try {
      watcher = database.collection(COLLECTION)
        .where({ kind: 'scene', communityId: this.scene.sceneId })
        .limit(16)
        .watch({
          onChange: event => {
            if (!this.active || this.generation !== generation) return
            let changed = false
            const shards = event.docChanges?.length
              ? event.docChanges.map(change => change.doc).filter(Boolean)
              : event.docs || []
            for (const shard of shards) {
              for (const record of Object.values(shard.records || {})) changed = this.merge(record) || changed
            }
            this.retryCount = 0
            this.onState('connected')
            if (changed) this.applyRecords([...this.records.values()])
          },
          onError: error => {
            if (!this.active || this.generation !== generation) return
            this.closeWatcher(watcher)
            this.scheduleRetry(generation, error)
          }
        })
      this.watchers.push(watcher)
      this.onState('connected')
    } catch (error) {
      this.scheduleRetry(generation, error)
    }
  }

  scheduleRetry(generation, error) {
    this.onState('reconnecting')
    if (error) this.onError(error)
    clearTimeout(this.retryTimer)
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retryCount++, 5))
    this.retryTimer = setTimeout(() => {
      if (!this.active || this.generation !== generation) return
      this.watch(generation)
      this.snapshot(generation).catch(snapshotError => this.onError(snapshotError))
    }, delay)
  }

  async start() {
    if (this.active) return
    this.active = true
    const generation = this.generation += 1
    this.onState('connecting')
    this.watch(generation)
    try {
      await this.snapshot(generation)
    } catch (error) {
      this.scheduleRetry(generation, error)
    } finally {
      this.scheduleSnapshot(generation)
    }
  }

  scheduleSnapshot(generation) {
    clearTimeout(this.snapshotTimer)
    this.snapshotTimer = setTimeout(async () => {
      if (!this.active || this.generation !== generation) return
      try {
        await this.snapshot(generation)
      } catch (error) {
        this.onError(error)
      } finally {
        this.scheduleSnapshot(generation)
      }
    }, SNAPSHOT_INTERVAL_MS)
  }

  closeWatcher(watcher) {
    if (!watcher) return
    this.watchers = this.watchers.filter(item => item !== watcher)
    try { Promise.resolve(watcher.close()).catch(() => {}) } catch (_) {}
  }

  stop() {
    const wasActive = this.active
    this.active = false
    this.generation += 1
    clearTimeout(this.retryTimer)
    clearTimeout(this.snapshotTimer)
    for (const watcher of this.watchers) this.closeWatcher(watcher)
    this.watchers = []
    if (wasActive) this.markOffline()
  }

  syncPosition(state) {
    if (!this.active || !state?.position3d) return Promise.resolve()
    const signature = JSON.stringify([state.position3d, state.moving, state.running, state.facing])
    if (signature === this.lastSignature && Date.now() - (this.lastSentAt || 0) < 2000) return Promise.resolve()
    this.pendingPositionState = state
    if (!this.positionFlight) {
      this.positionFlight = this.flushPositions().finally(() => {
        this.positionFlight = null
        if (this.active && this.pendingPositionState) this.syncPosition(this.pendingPositionState)
      })
    }
    return this.positionFlight
  }

  async flushPositions() {
    while (this.active && this.pendingPositionState) {
      const state = this.pendingPositionState
      this.pendingPositionState = null
      const seq = ++this.sequence
      try {
        const result = await callFunction('playground', 'syncManor3d', {
          ...this.credentials(), ...state, seq, online: true
        })
        if (!this.active) return
        this.lastSignature = JSON.stringify([state.position3d, state.moving, state.running, state.facing])
        this.lastSentAt = Date.now()
      } catch (error) {
        this.onError(error)
      }
    }
  }

  markOffline() {
    this.pendingPositionState = null
    const seq = ++this.sequence
    callFunction('playground', 'syncManor3d', {
      ...this.credentials(), seq, online: false
    }).catch(error => this.onError(error))
  }
}

module.exports = { ManorCommunitySync }
