const { callFunction, getCloudEnv } = require('../../utils/cloud')

const COLLECTION = 'pet_playground_live'
const SNAPSHOT_INTERVAL_MS = 30000
const POLL_INTERVAL_MS = 1500
const POSITION_INTERVAL_MS = 160
const HEARTBEAT_INTERVAL_MS = 5000
const PEER_TTL_MS = 15000
const WATCH_BATCH_MS = 32
const REQUEST_TIMEOUT_MS = 8000

function samePosition(a, b) {
  return !!a && !!b && a.position3d.x === b.position3d.x && a.position3d.y === b.position3d.y &&
    a.position3d.z === b.position3d.z && a.facing === b.facing && a.moving === b.moving &&
    a.running === b.running && a.interior?.kind === b.interior?.kind &&
    a.interior?.plotId === b.interior?.plotId && a.characterType === b.characterType && a.pose === b.pose
}

function relevant(record) {
  return record && typeof record.id === 'string' &&
    ['presence', 'manor3dPresence', 'plot', 'resident', 'manor3dBuilding', 'manor3dVehicle'].includes(record.kind)
}

function stalePeer(record, now) {
  return (record.kind === 'presence' || record.kind === 'manor3dPresence') && record.manor3d === true && Number.isFinite(record.manor3dLastSeen) &&
    now - record.manor3dLastSeen >= PEER_TTL_MS
}

function newer(next, previous) {
  if (!previous) return true
  const a = next.version || {}
  const b = previous.version || {}
  return a.epoch > b.epoch || a.epoch === b.epoch && a.seq > b.seq
}

function residentNeedsAdvanced(next, previous) {
  if (next.kind !== 'resident' || previous?.kind !== 'resident') return false
  const nextVersion = next.version || {}
  const previousVersion = previous.version || {}
  if (nextVersion.epoch !== previousVersion.epoch || nextVersion.seq !== previousVersion.seq) return false
  const previousPets = new Map((previous.pets || []).map(pet => [pet.id, Number(pet.needs?.at) || 0]))
  return (next.pets || []).some(pet => (Number(pet.needs?.at) || 0) > (previousPets.get(pet.id) || 0))
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
    this.changedRecords = new Map()
    this.requests = new Set()
    this.serverClockOffset = Number.isFinite(scene.serverTime) ? scene.serverTime - Date.now() : 0
  }

  credentials() {
    return { sceneId: this.scene.sceneId, session: this.scene.session }
  }

  current(generation) {
    return this.active && this.generation === generation
  }

  request(action, data) {
    return new Promise((resolve, reject) => {
      const finish = (settle, value) => {
        if (!this.requests.delete(cancel)) return
        clearTimeout(timer)
        settle(value)
      }
      const cancel = () => finish(reject, new Error('庄园同步已停止'))
      const timer = setTimeout(() => finish(reject, new Error('庄园同步超时')), REQUEST_TIMEOUT_MS)
      this.requests.add(cancel)
      try {
        Promise.resolve(callFunction('playground', action, data)).then(
          value => finish(resolve, value), error => finish(reject, error))
      } catch (error) { finish(reject, error) }
    })
  }

  merge(record) {
    const previous = this.records.get(record?.id)
    if (!relevant(record) || stalePeer(record, Date.now() + this.serverClockOffset) ||
        !newer(record, previous) && !residentNeedsAdvanced(record, previous)) return
    this.eventSequence += 1
    const next = {
      ...record,
      kind: record.kind === 'manor3dPresence' ? 'presence' : record.kind,
      receivedSequence: this.eventSequence,
      mine: record.mine === true || record.ownerId === this.scene.playerId
    }
    this.records.set(record.id, next)
    this.changedRecords.set(record.id, next)
  }

  remove(record) {
    this.records.delete(record.id)
    this.changedRecords.set(record.id, { id: record.id, kind: record.kind, deleted: true })
  }

  publishChanges(replace = false) {
    if (!this.snapshotVerified) return
    const records = [...(replace ? this.records : this.changedRecords).values()]
    this.changedRecords.clear()
    if (replace || records.length) this.applyRecords(records, { replace })
  }

  schedulePublish(generation) {
    if (!this.snapshotVerified || !this.changedRecords.size || this.publishTimer) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = null
      if (this.current(generation)) this.publishChanges()
    }, WATCH_BATCH_MS)
  }

  snapshot(generation = this.generation) {
    if (!this.current(generation)) return Promise.resolve()
    if (this.snapshotFlight) return this.snapshotFlight
    const flight = this.readSnapshot(generation).finally(() => {
      if (this.snapshotFlight === flight) this.snapshotFlight = null
    })
    this.snapshotFlight = flight
    return flight
  }

  async readSnapshot(generation) {
    const startedAt = this.eventSequence
    const fetched = []
    let cursor = ''
    do {
      const result = await this.request('getScene', { ...this.credentials(), cursor, manor3d: true })
      if (!this.current(generation)) return
      if (Number.isFinite(result.serverTime)) this.serverClockOffset = result.serverTime - Date.now()
      fetched.push(...(Array.isArray(result.records) ? result.records : []))
      cursor = result.nextCursor || ''
    } while (cursor)

    const fetchedIds = new Set()
    const now = Date.now() + this.serverClockOffset
    for (const record of fetched) {
      if (!relevant(record) || stalePeer(record, now)) continue
      fetchedIds.add(record.id)
      this.merge(record)
    }
    for (const [id, old] of this.records) {
      if (!fetchedIds.has(id) && old.receivedSequence <= startedAt) this.remove(old)
    }
    const first = !this.snapshotVerified
    this.snapshotVerified = true
    this.setState('connected')
    this.publishChanges(first)
    this.scheduleExpiry(generation)
  }

  watch(generation) {
    if (!this.current(generation) || this.watchers.length || !wx.cloud?.database) return
    let watcher
    let failed = false
    try {
      const env = getCloudEnv()
      const database = wx.cloud.database(env ? { env } : {})
      watcher = database.collection(COLLECTION)
        .where({ kind: 'scene', communityId: this.scene.sceneId })
        .limit(16)
        .watch({
          onChange: event => {
            if (!this.current(generation) || failed) return
            this.retryCount = 0
            const shards = event.docChanges?.length
              ? event.docChanges.map(change => change.doc).filter(Boolean)
              : event.docs || []
            for (const shard of shards) {
              for (const record of Object.values(shard.records || {})) this.merge(record)
            }
            this.schedulePublish(generation)
          },
          onError: error => {
            if (!this.current(generation) || failed) return
            failed = true
            this.closeWatcher(watcher)
            this.scheduleRetry(generation, error)
            if (this.snapshotVerified) this.scheduleSnapshot(generation)
          }
        })
      if (failed) this.closeWatcher(watcher)
      else this.watchers.push(watcher)
    } catch (error) {
      this.scheduleRetry(generation, error)
    }
  }

  setState(state) {
    if (this.state === state) return
    this.state = state
    this.onState(state)
  }

  checkCredentials(generation, error) {
    if (!this.current(generation)) return false
    if (!error?.message?.includes('场景已切换')) return true
    this.stop({ offline: false })
    this.onError(error)
    return false
  }

  scheduleRetry(generation, error) {
    if (!this.checkCredentials(generation, error) || this.retryTimer) return
    if (!this.snapshotVerified) this.setState('reconnecting')
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.retryCount++, 5))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.current(generation)) return
      this.watch(generation)
      this.snapshot(generation)
        .then(() => this.scheduleSnapshot(generation), snapshotError => this.scheduleRetry(generation, snapshotError))
    }, delay)
  }

  async start() {
    if (this.active) return
    this.active = true
    this.snapshotVerified = false
    const generation = this.generation += 1
    this.setState('connecting')
    this.watch(generation)
    try {
      await this.snapshot(generation)
      this.scheduleSnapshot(generation)
    } catch (error) {
      this.scheduleRetry(generation, error)
    }
  }

  scheduleSnapshot(generation) {
    if (!this.current(generation)) return
    clearTimeout(this.snapshotTimer)
    this.snapshotTimer = setTimeout(async () => {
      if (!this.current(generation)) return
      try {
        await this.snapshot(generation)
        this.scheduleSnapshot(generation)
      } catch (error) {
        this.scheduleRetry(generation, error)
      }
    }, this.watchers.length || !this.snapshotVerified ? SNAPSHOT_INTERVAL_MS : POLL_INTERVAL_MS)
  }

  scheduleExpiry(generation) {
    if (this.expiryTimer) return
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null
      if (!this.current(generation)) return
      const now = Date.now() + this.serverClockOffset
      for (const record of this.records.values()) {
        if (stalePeer(record, now)) this.remove(record)
      }
      this.schedulePublish(generation)
      this.scheduleExpiry(generation)
    }, 2000)
  }

  closeWatcher(watcher) {
    if (!watcher) return
    this.watchers = this.watchers.filter(item => item !== watcher)
    try { Promise.resolve(watcher.close()).catch(() => {}) } catch (_) {}
  }

  stop({ offline = true, position } = {}) {
    const wasActive = this.active
    const lastState = position?.position3d ? position : this.lastPositionState
    this.active = false
    this.generation += 1
    this.pendingPositionState = null
    this.positionFlight = null
    this.snapshotFlight = null
    this.changedRecords.clear()
    for (const cancel of this.requests) cancel()
    clearTimeout(this.retryTimer)
    clearTimeout(this.snapshotTimer)
    clearTimeout(this.positionTimer)
    clearTimeout(this.publishTimer)
    clearTimeout(this.expiryTimer)
    this.retryTimer = this.positionTimer = this.publishTimer = this.expiryTimer = null
    for (const watcher of this.watchers) this.closeWatcher(watcher)
    this.watchers = []
    const canPublish = this.scene.manor3dCanPublish === true || this.scene.hasAvatar === true
    if (wasActive && offline && canPublish && (this.sequence > 0 || lastState)) {
      this.markOffline(lastState)
    }
  }

  syncPosition(state) {
    if (!this.active || !state?.position3d) return Promise.resolve()
    this.lastPositionState = state
    const queued = this.pendingPositionState || this.positionFlight?.state
    if (!samePosition(state, queued) && (queued || !samePosition(state, this.acknowledgedPosition) ||
        Date.now() - this.lastSentAt >= HEARTBEAT_INTERVAL_MS)) this.pendingPositionState = state
    this.schedulePosition(this.generation)
    return this.positionFlight?.promise || Promise.resolve()
  }

  schedulePosition(generation) {
    if (!this.current(generation) || this.positionFlight || this.positionTimer || !this.pendingPositionState) return
    const now = Date.now()
    const due = Math.max((this.lastPositionStartedAt ?? -Infinity) + POSITION_INTERVAL_MS, this.positionRetryAt || 0)
    if (due > now) {
      this.positionTimer = setTimeout(() => {
        this.positionTimer = null
        this.schedulePosition(generation)
      }, due - now)
      return
    }
    const state = this.pendingPositionState
    this.pendingPositionState = null
    this.lastPositionStartedAt = now
    const seq = ++this.sequence
    const flight = this.positionFlight = { state }
    flight.promise = this.request('syncManor3d', { ...this.credentials(), ...state, seq, online: true })
      .then(result => {
        if (!this.current(generation)) return
        if (Number.isSafeInteger(result?.ackSeq)) this.sequence = Math.max(this.sequence, result.ackSeq)
        this.acknowledgedPosition = state
        this.lastSentAt = Date.now()
        this.positionRetryAt = this.positionFailures = 0
      }, error => {
        if (!this.checkCredentials(generation, error)) return
        this.pendingPositionState ||= state
        this.positionFailures = (this.positionFailures || 0) + 1
        this.positionRetryAt = Date.now() + Math.min(5000, 350 * 2 ** Math.min(this.positionFailures - 1, 5))
      }).finally(() => {
        if (this.positionFlight !== flight) return
        this.positionFlight = null
        this.schedulePosition(generation)
      })
  }

  markOffline(position) {
    const seq = ++this.sequence
    try {
      callFunction('playground', 'syncManor3d', { ...this.credentials(), ...position, seq, online: false }).catch(() => {})
    } catch (_) {}
  }
}

module.exports = { ManorCommunitySync }
