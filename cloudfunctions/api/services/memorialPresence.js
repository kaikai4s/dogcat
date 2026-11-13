const crypto = require('crypto')
const { readOptionalDocument } = require('../utils/documentPages')
const { version: SCENE } = require('../config/memorial-world.json')
const bounds = require('../config/memorial-presence.json')
const COLLECTION = 'pet_memorial_live'
const SHARDS = 64, TTL = 20000, SESSION_TTL = 3600000
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const playerId = openid => 'visitor_' + digest('memorial|' + openid).slice(0, 24)
const shardId = (id, scene = SCENE) => 'scene_' + scene + '_' + (parseInt(digest(id).slice(0, 4), 16) % SHARDS)
function state(data) {
  if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y) || data.x < bounds.minX || data.x > bounds.maxX || data.y < bounds.minY || data.y > bounds.maxY ||
    !['boy', 'girl'].includes(data.gender) || !['sw', 'se', 'nw', 'ne'].includes(data.direction) || typeof data.moving !== 'boolean' ||
    !['walk', 'map', 'remember', 'select'].includes(data.activity) ||
    data.sampledAt !== undefined && (!Number.isSafeInteger(data.sampledAt) || data.sampledAt < 0)) throw new Error('人物状态无效')
  // Public presence is deliberately a small allowlist; never include drafts, media or account IDs.
  return { x: Math.round(data.x * 10) / 10, y: Math.round(data.y * 10) / 10, gender: data.gender,
    direction: data.direction, moving: data.moving, activity: data.activity,
    // Optional for old clients. This untrusted sender clock is used only for
    // relative animation timing; TTL, rate limits and sessions use server time.
    ...(data.sampledAt === undefined ? {} : { sampledAt: data.sampledAt }) }
}
module.exports = function createPresence(context) {
  const { db, getUser, checkRateLimit, nowMs } = context
  const gardens = require('./memorialGardens')(context)
  const clock = nowMs || Date.now
  const read = (tx, id) => readOptionalDocument(tx, COLLECTION, id)
  const write = (tx, id, data) => tx.collection(COLLECTION).doc(id).set({ data })
  async function changed(tx, sceneId = SCENE) {
    const id = 'world_' + sceneId, old = await read(tx, id)
    await write(tx, id, { kind: 'scene', sceneId, revision: (old && old.revision || 0) + 1 })
  }
  async function handle(openid, action, data) {
    const sceneId = data.sceneId
    if (typeof sceneId !== 'string' || !(sceneId === SCENE || /^garden_[a-f0-9]{32}$/.test(sceneId))) throw new Error('园区版本已更新，请重新进入')
    const id = playerId(openid), key = 'session_' + id, shard = shardId(id, sceneId)
    const joining = action === 'joinPresence', leaving = action === 'leavePresence'
    if (joining) {
      await getUser(openid)
      await gardens.get(sceneId)
      await checkRateLimit(openid, 'memorial.joinPresence', { max: 30, windowMs: 60000 })
      if (!/^[a-zA-Z0-9_-]{16,80}$/.test(data.clientId || '') || !Number.isSafeInteger(data.joinSeq) || data.joinSeq < 1 || !/^[a-zA-Z0-9_-]{16,80}$/.test(data.requestId || '')) throw new Error('进入编号无效')
    } else if (!/^[a-f0-9]{48}$/.test(data.session || '') || !Number.isSafeInteger(data.seq) || data.seq < 1) throw new Error('同步凭据无效')
    const next = leaving ? null : state(data.state)
    const token = joining ? crypto.randomBytes(24).toString('hex') : data.session
    return db.runTransaction(async tx => {
      const stamp = clock(), previous = await read(tx, key)
      if (!joining && (!previous || previous.token !== token || (previous.sceneId || SCENE) !== sceneId)) return { replaced: true, serverTime: stamp }
      if (!joining && (previous.expiresAt <= stamp || previous.closed)) return { rejoin: !leaving, serverTime: stamp }
      if (joining && previous && previous.clientId === data.clientId && previous.joinSeq > data.joinSeq) return { replaced: true, serverTime: stamp }
      if (joining && previous && previous.requestId === data.requestId) {
        if ((previous.sceneId || SCENE) !== sceneId) throw new Error('进入编号对应的园区不一致')
        if (previous.closed || previous.expiresAt <= stamp) return { rejoin: true, serverTime: stamp }
        return { playerId: id, session: previous.token, epoch: previous.epoch, sceneId, collection: COLLECTION, shards: SHARDS + 1, serverTime: stamp }
      }
      if (!joining && data.seq <= previous.seq) return { accepted: true, serverTime: stamp }
      if (!joining && !leaving && stamp - previous.updatedAt < 180) return { accepted: false, serverTime: stamp }
      if (joining && previous && !previous.closed && (previous.sceneId || SCENE) !== sceneId) {
        const oldShard = shardId(id, previous.sceneId || SCENE), oldRoom = await read(tx, oldShard)
        if (oldRoom && oldRoom.records && oldRoom.records[id]) {
          const records = { ...oldRoom.records }; delete records[id]
          await write(tx, oldShard, { kind: 'scene', sceneId: previous.sceneId || SCENE, revision: oldRoom.revision + 1, records })
        }
      }
      const room = await read(tx, shard)
      // Remove abandoned records on each write. A shard never grows with historical visits.
      const records = Object.fromEntries(Object.entries(room && room.records || {}).filter(([who, row]) => who !== id && row.updatedAt > stamp - TTL))
      if (!leaving && Object.keys(records).length >= 64) throw new Error('园区当前较繁忙，请稍后重试')
      const epoch = joining ? Math.max(stamp, (previous && previous.epoch || 0) + 1) : previous.epoch
      const seq = joining ? 0 : data.seq
      if (!leaving) records[id] = { id, ...next, epoch, seq, updatedAt: stamp }
      // Both documents commit together: delayed writes/leaves cannot replace a new session.
      await write(tx, shard, { kind: 'scene', sceneId, revision: (room && room.revision || 0) + 1, records })
      await write(tx, key, { kind: 'session', sceneId, token, requestId: joining ? data.requestId : previous.requestId,
        epoch, seq, clientId: joining ? data.clientId : previous.clientId, joinSeq: joining ? data.joinSeq : previous.joinSeq, updatedAt: stamp, expiresAt: joining ? stamp + SESSION_TTL : previous.expiresAt, closed: leaving })
      return joining ? { playerId: id, session: token, epoch, sceneId, collection: COLLECTION, shards: SHARDS + 1, serverTime: stamp } : { accepted: true, serverTime: stamp }
    })
  }
  return { handle, changed }
}
module.exports.constants = { COLLECTION, SCENE, TTL, SHARDS, playerId, shardId }
