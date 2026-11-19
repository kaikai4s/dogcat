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
    if (!this.active || this.generation !== generation) return
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
    this.snapshotVerified = true
    this.retryCount = 0
    this.onState('connected')
    this.applyRecords([...this.records.values()])
  }

  watch(generation) {
    if (!this.active || this.generation !== generation || this.watchers.length || !wx.cloud?.database) return
    let watcher
    try {
      const env = getCloudEnv()
      const database = wx.cloud.database(env ? { env } : {})
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
            if (changed && this.snapshotVerified) this.applyRecords([...this.records.values()])
          },
          onError: error => {
            if (!this.active || this.generation !== generation) return
            this.closeWatcher(watcher)
            this.scheduleRetry(generation, error)
          }
        })
      this.watchers.push(watcher)
    } catch (error) {
      this.scheduleRetry(generation, error)
    }
  }

  scheduleRetry(generation, error) {
    if (!this.active || this.generation !== generation) return
    // A snapshot or move rejected with an expired session cannot be recovered
    // by watching again. The page must enter and obtain new credentials.
    if (error?.message?.includes('场景已切换')) {
      this.stop({ offline: false })
      this.onError(error)
      return
    }
    this.onState('reconnecting')
    if (error) this.onError(error)
    if (!this.active || this.generation !== generation) return
    clearTimeout(this.retryTimer)
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retryCount++, 5))
    this.retryTimer = setTimeout(() => {
      if (!this.active || this.generation !== generation) return
      this.watch(generation)
      this.snapshot(generation).catch(snapshotError => this.scheduleRetry(generation, snapshotError))
    }, delay)
  }

  async start() {
    if (this.active) return
    this.active = true
    this.snapshotVerified = false
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
    if (!this.active || this.generation !== generation) return
    clearTimeout(this.snapshotTimer)
    this.snapshotTimer = setTimeout(async () => {
      if (!this.active || this.generation !== generation) return
      try {
        await this.snapshot(generation)
      } catch (error) {
        this.scheduleRetry(generation, error)
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

  stop({ offline = true } = {}) {
    const wasActive = this.active
    this.active = false
    this.generation += 1
    this.pendingPositionState = null
    clearTimeout(this.retryTimer)
    clearTimeout(this.snapshotTimer)
    for (const watcher of this.watchers) this.closeWatcher(watcher)
    this.watchers = []
    if (wasActive && offline && this.scene.hasAvatar === true && this.sequence > 0) this.markOffline()
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
    const generation = this.generation
    while (this.active && this.pendingPositionState) {
      const state = this.pendingPositionState
      this.pendingPositionState = null
      const seq = ++this.sequence
      try {
        await callFunction('playground', 'syncManor3d', {
          ...this.credentials(), ...state, seq, online: true
        })
        if (!this.active || this.generation !== generation) return
        this.lastSignature = JSON.stringify([state.position3d, state.moving, state.running, state.facing])
        this.lastSentAt = Date.now()
      } catch (error) {
        if (this.active && this.generation === generation) {
          this.pendingPositionState = null
          this.scheduleRetry(generation, error)
        }
        return
      }
    }
  }

  markOffline() {
    this.pendingPositionState = null
    const seq = ++this.sequence
    callFunction('playground', 'syncManor3d', {
      ...this.credentials(), seq, online: false
    }).catch(() => {})
  }
}

module.exports = { ManorCommunitySync }
