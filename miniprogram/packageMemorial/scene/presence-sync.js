// Network work never runs in the canvas loop. One request in flight, no movement queue.
const INTERVAL = 250, HEARTBEAT = 4000, TTL = 20000
const CLIENT_ID = 'client_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2)
let joinSequence = 0
function connectionIssue(error, phase) {
  const raw = String(error && (error.errMsg || error.message) || error || '')
  const code = String(error && (error.errCode || error.code) || '')
  const value = code + ' ' + raw
  const message = /index|索引/i.test(value) ? '同园同步缺少数据库索引' :
    /permission|denied|unauthorized|权限|-502003/i.test(value) ? '同园同步读取权限未配置' :
    /collection.*(not exist|not found)|集合.*不存在|-502005/i.test(value) ? '同园同步集合未创建' :
    /未知纪念园操作|not.*function|不支持实时监听/.test(value) ? '同园同步服务需要更新' :
    /登录/.test(value) ? '请登录后使用同园同步' : ''
  return { message: message || '同园连接中断，正在重连', permanent: !!message,
    detail: (phase || '连接') + '：' + (code ? code + ' · ' : '') + raw.slice(0, 300) }
}
class PresenceSync {
  constructor(options) {
    Object.assign(this, options)
    this.now = options.now || Date.now
    this.delay = options.delay || ((fn, ms) => setTimeout(fn, ms))
    this.cancel = options.cancel || (id => clearTimeout(id))
    this.generation = 0
    this.records = new Map()
    this.shards = new Map()
    this.seq = 0
    this.offset = 0
  }
  status(message) {
    const count = this.records.size + (this.session ? 1 : 0)
    const detail = this.issue && this.issue.detail || ''
    const signature = message + ':' + count + ':' + detail
    if (signature !== this.statusSignature) {
      this.statusSignature = signature
      this.onStatus({ message, count, detail })
    }
    this.message = message
  }
  current(g) { return this.active && this.generation === g }
  start() {
    if (this.active) return
    this.active = true
    const g = ++this.generation
    this.joinSeq = ++joinSequence
    this.requestId = 'visit_' + this.now().toString(36) + '_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    this.issue = null; this.sendFailed = false; this.awaitingEcho = null
    this.status('正在连接同园访客…')
    this.join(g)
  }
  async join(g) {
    try {
      const sent = this.now()
      const reply = await this.api('joinPresence', { sceneId: this.sceneId, requestId: this.requestId, clientId: CLIENT_ID, joinSeq: this.joinSeq,
        state: { ...this.state(), sampledAt: sent } })
      if (!this.current(g)) {
        if (reply.session) this.api('leavePresence', { ...reply, seq: 1 }).catch(() => {})
        return
      }
      if (reply.replaced) { this.stop(false); this.status('此账号已在另一处进入园区'); return }
      if (reply.rejoin) { this.stop(false); this.start(); return }
      if (!reply.session) throw new Error('未能进入实时园区')
      this.session = reply; this.seq = 0; this.echoSeq = 0
      this.syncClock(reply.serverTime, sent)
      this.failures = 0; this.lastSent = 0; this.signature = ''
      this.openWatch(g)
      this.maintain(g)
      this.tick(g)
    } catch (error) {
      if (!this.current(g)) return
      this.issue = connectionIssue(error, '加入园区')
      this.status(this.issue.message)
      if (!this.issue.permanent) this.joinTimer = this.delay(() => this.join(g), this.backoff())
    }
  }
  syncClock(serverTime, sent) {
    const received = this.now()
    if (![serverTime, sent, received].every(Number.isFinite) || received < sent || received - sent > 10000) return
    this.offset = serverTime - (sent + received) / 2
    if (this.onClock) this.onClock(serverTime, sent, received)
  }
  backoff() { return Math.min(15000, 1000 * 2 ** Math.min(this.failures = (this.failures || 0) + 1, 4)) }
  openWatch(g) {
    this.lastWatchAt = this.now()
    const revision = this.watchRevision = (this.watchRevision || 0) + 1
    const current = () => this.current(g) && this.watchRevision === revision
    const fail = error => {
      if (!current()) return
      this.watchRevision++; this.live = false; this.closeWatch()
      this.issue = connectionIssue(error, '实时监听')
      if (this.issue.permanent) this.stop()
      this.status(this.issue.message)
      if (!this.issue.permanent) this.watchTimer = this.delay(() => { if (this.current(g)) this.openWatch(g) }, this.backoff())
    }
    this.watchFailure = fail
    try {
      const watcher = this.watch(this.session, event => {
        if (!current()) return
        this.lastWatchAt = this.now()
        this.live = true; this.failures = 0; this.issue = null
        // A reconnect's initial snapshot is authoritative, including absent shards.
        const full = event.type === 'init' || !this.watchInitialized
        if (full) {
          const ids = new Set((event.docs || []).map(doc => doc._id))
          for (const [id, shard] of this.shards) if (!ids.has(id)) this.removeShard(id, shard)
          this.watchInitialized = true
        }
        const docs = full || !event.docChanges || !event.docChanges.length ? event.docs || [] : event.docChanges.map(change => change.doc).filter(Boolean)
        for (const doc of docs) this.merge(doc)
        for (const change of event.docChanges || []) if (change.dataType === 'remove' || change.queueType === 'dequeue') {
          const id = change.docId || change.doc && change.doc._id
          if (this.shards.has(id)) this.removeShard(id, this.shards.get(id))
        }
        this.expire(); this.status(this.sendFailed ? '动作发送中断，正在重试' : '')
      }, fail)
      if (!current()) { Promise.resolve(watcher.close()).catch(() => {}); return }
      this.watcher = watcher
    } catch (error) { fail(error) }
  }
  removeShard(id, shard) {
    const removed = Object.keys(shard.records || {}).filter(key => this.records.delete(key))
    this.shards.delete(id)
    if (removed.length) this.onRecords([], removed)
  }
  merge(doc) {
    if (!doc || doc.sceneId !== this.sceneId || doc.kind !== 'scene') return
    const old = this.shards.get(doc._id)
    if (old && doc.revision <= old.revision) return
    this.shards.set(doc._id, doc)
    if (!doc.records) {
      if (!old || doc.revision > old.revision) this.onWorldChange()
      return
    }
    const removed = Object.keys(old && old.records || {}).filter(id => !doc.records[id] && this.records.delete(id))
    const updates = []
    for (const row of Object.values(doc.records)) {
      if (row.id === this.session.playerId && (!this.session.epoch || row.epoch === this.session.epoch)) {
        this.echoSeq = Math.max(this.echoSeq || 0, row.seq)
        if (this.awaitingEcho && row.seq >= this.awaitingEcho.seq) this.awaitingEcho = null
      }
      if (row.id === this.session.playerId || !Number.isFinite(row.x) || !Number.isFinite(row.y) || !Number.isFinite(row.updatedAt) ||
        row.updatedAt <= this.now() + this.offset - TTL || !['boy', 'girl'].includes(row.gender) || !['sw', 'se', 'nw', 'ne'].includes(row.direction)) continue
      const previous = this.records.get(row.id)
      if (previous && (previous.epoch > row.epoch || previous.epoch === row.epoch && previous.seq >= row.seq)) continue
      this.records.set(row.id, row); updates.push(row)
    }
    if (updates.length || removed.length) this.onRecords(updates, removed)
  }
  expire() {
    const removed = []
    for (const [id, row] of this.records) if (row.updatedAt <= this.now() + this.offset - TTL) { this.records.delete(id); removed.push(id) }
    if (removed.length) this.onRecords([], removed)
    this.status(this.message || '')
  }
  maintain(g) {
    if (!this.current(g)) return
    this.expire()
    // Silence alone is not a disconnect. Only a confirmed write missing from
    // our subscription for 30 seconds warrants rebuilding the watcher.
    if (this.watcher && this.awaitingEcho && this.now() - this.awaitingEcho.at > 30000) {
      this.awaitingEcho = null; this.watchFailure(new Error('已提交的人物状态长时间未收到推送'))
    }
    this.expiryTimer = this.delay(() => this.maintain(g), 1000)
  }
  async tick(g) {
    if (!this.current(g)) return
    const started = this.now()
    this.expire()
    const watchdog = this.watchdog = this.delay(() => { if (this.current(g)) { this.sendFailed = true; this.status('动作发送较慢，正在等待连接') } }, 8000)
    try {
      const state = this.state(), signature = JSON.stringify(state)
      if (signature !== this.signature || started - this.lastSent >= HEARTBEAT) {
        // Timestamp the actual position capture, not the later cloud write.
        // Keep it out of the signature so idle visitors still use heartbeats.
        const reply = await this.api('syncPresence', { sceneId: this.sceneId, session: this.session.session, seq: ++this.seq,
          state: { ...state, sampledAt: started } })
        if (!this.current(g)) { this.cancel(watchdog); return }
        if (reply.replaced) { this.cancel(watchdog); this.stop(false); this.status('此账号已在另一处进入园区'); return }
        if (reply.rejoin) { this.cancel(watchdog); this.stop(false); this.start(); return }
        this.syncClock(reply.serverTime, started)
        if (reply.accepted) { this.signature = signature; this.lastSent = started
          if (!this.awaitingEcho && this.seq > (this.echoSeq || 0)) this.awaitingEcho = { seq: this.seq, at: this.now() }
        }
        this.sendFailed = false
        this.status(this.live ? '' : this.issue ? this.issue.message : '正在连接同园访客…')
      }
      this.sendFailures = 0
    } catch (error) {
      if (!this.current(g)) { this.cancel(watchdog); return }
      const issue = connectionIssue(error, '发送动作')
      if (issue.permanent) { this.issue = issue; this.stop(); this.status(issue.message); return }
      this.sendFailures = (this.sendFailures || 0) + 1; this.sendFailed = true
      this.status('动作发送中断，正在重试')
    }
    this.cancel(watchdog)
    if (this.current(g)) this.sendTimer = this.delay(() => this.tick(g), this.sendFailures ? Math.min(8000, 1000 * 2 ** Math.min(this.sendFailures - 1, 3)) : Math.max(0, INTERVAL - (this.now() - started)))
  }
  closeWatch() {
    this.watchInitialized = false
    const watcher = this.watcher; this.watcher = null
    if (watcher) { try { Promise.resolve(watcher.close()).catch(() => {}) } catch (_) {} }
  }
  stop(leave = true) {
    this.active = false; this.generation++; this.watchRevision = (this.watchRevision || 0) + 1
    for (const timer of [this.joinTimer, this.watchTimer, this.sendTimer, this.expiryTimer, this.watchdog]) this.cancel(timer)
    this.closeWatch(); this.live = false
    const session = this.session; this.session = null
    const removed = [...this.records.keys()]; this.records.clear(); this.shards.clear()
    if (removed.length) this.onRecords([], removed)
    if (leave && session) this.api('leavePresence', { sceneId: this.sceneId, session: session.session, seq: ++this.seq }).catch(() => {})
  }
}
module.exports = { PresenceSync, INTERVAL, HEARTBEAT, TTL, connectionIssue }
