const crypto = require('crypto')
const SIZE = 48
const STEP = 56
const CHUNK = STEP * 2
const CONFIG_ID = 'world_config_v2'
const hash = (value) =>
  crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)
async function read(db, id) {
  try {
    return (
      (await db.collection('pet_playground_plots').doc(id).get()).data || null
    )
  } catch (error) {
    if (
      /not exist|not found|does not exist|不存在/i.test(
        String(error.message || error.errMsg)
      )
    )
      return null
    throw error
  }
}
function dimensions(value = {}) {
  const result = {}
  for (const key of ['width', 'height']) {
    const n = value[key] === undefined ? 2240 : Number(value[key])
    if (!Number.isInteger(n) || n < 224 || n > 11200)
      throw new Error('乐园宽高须为 224～11200 之间的整数')
    result[key] = n
  }
  return result
}
function communityId(user) {
  const c = user.residentialCommunity
  if (!c || !String(c.name || '').trim()) return ''
  return hash(
    [c.city, c.district, c.name, c.address]
      .map((v) =>
        String(v || '')
          .trim()
          .replace(/\s+/g, '')
      )
      .join('|')
  )
}
const ownerId = (openid) => `plot_owner_${hash(openid)}`
const plotId = (id, x, z) => `plot_${id}_${x}_${z}`
function publicPlot(plot, openid) {
  if (!plot) return null
  return {
    id: plot._id,
    x: plot.x,
    z: plot.z,
    size: SIZE,
    cellX: plot.cellX,
    cellZ: plot.cellZ,
    mine: plot.ownerOpenid === openid,
    name: plot.name || '邻居庭院'
  }
}
async function updateCommunity(db, openid, userId, community, extra = {}) {
  return db.runTransaction(async (tx) => {
    const placed = await read(tx, ownerId(openid))
    if (
      placed &&
      communityId({ residentialCommunity: community }) !== placed.communityId
    ) {
      throw new Error('已有永久宅基地，不能更换所属小区')
    }
    await tx
      .collection('users')
      .doc(userId)
      .update({ data: { ...extra, residentialCommunity: community } })
  })
}
module.exports = {
  SIZE,
  STEP,
  CHUNK,
  CONFIG_ID,
  read,
  dimensions,
  communityId,
  ownerId,
  updateCommunity,
  create({ db, nowText }) {
    async function config() {
      return {
        ...dimensions(),
        ...((await read(db, CONFIG_ID)) || {}),
        plotSize: SIZE,
        step: STEP,
        chunkSize: CHUNK
      }
    }
    async function own(openid) {
      return read(db, ownerId(openid))
    }
    async function claim(openid, user, data) {
      const x = Number(data.cellX),
        z = Number(data.cellZ)
      if (!Number.isInteger(x) || !Number.isInteger(z) || x < 0 || z < 0)
        throw new Error('请选择有效的空草坪')
      return db.runTransaction(async (tx) => {
        const current = (await tx.collection('users').doc(user._id).get()).data
        const id = communityId(current)
        if (!id) throw new Error('请先设置常住小区，再选择宅基地')
        const existing = await read(tx, ownerId(openid))
        if (
          existing &&
          existing.communityId === id &&
          existing.cellX === x &&
          existing.cellZ === z
        ) {
          return publicPlot({ ...existing, _id: existing.plotId }, openid)
        }
        if (existing) throw new Error('你已经选择过房屋位置，不能更改')
        const { _id: configDocumentId, ...stored } =
          (await read(tx, CONFIG_ID)) || {}
        const settings = { ...dimensions(), ...stored }
        if ((x + 1) * STEP > settings.width || (z + 1) * STEP > settings.height)
          throw new Error('宅基地不能超过场景边界')
        const key = plotId(id, x, z)
        if (await read(tx, key)) throw new Error('这块草坪已被选择，请换一处')
        const plot = {
          kind: 'plot',
          communityId: id,
          ownerOpenid: openid,
          cellX: x,
          cellZ: z,
          x: x * STEP + STEP / 2,
          z: z * STEP + STEP / 2,
          size: SIZE,
          name: `${String(user.nickname || '我').slice(0, 20)}的庭院`,
          createdAt: nowText()
        }
        await tx.collection('pet_playground_plots').doc(key).set({ data: plot })
        await tx
          .collection('pet_playground_plots')
          .doc(ownerId(openid))
          .set({ data: { ...plot, plotId: key } })
        await tx
          .collection('pet_playground_plots')
          .doc(CONFIG_ID)
          .set({
            data: {
              ...settings,
              usedWidth: Math.max(settings.usedWidth || 0, (x + 1) * STEP),
              usedHeight: Math.max(settings.usedHeight || 0, (z + 1) * STEP)
            }
          })
        return publicPlot({ ...plot, _id: key }, openid)
      })
    }
    async function region(openid, user, data) {
      const saved = await own(openid)
      const id = saved ? saved.communityId : communityId(user)
      const cfg = await config()
      const x = Number(data.chunkX),
        z = Number(data.chunkZ)
      if (
        ![x, z].every(Number.isInteger) ||
        x < 0 ||
        z < 0 ||
        x * CHUNK >= cfg.width ||
        z * CHUNK >= cfg.height
      )
        throw new Error('场景区域超出边界')
      if (!id) return { plots: [], chunkX: x, chunkZ: z }
      const rows = await Promise.all(
        [0, 1, 2, 3].map((i) =>
          read(db, plotId(id, x * 2 + (i % 2), z * 2 + Math.floor(i / 2)))
        )
      )
      return {
        plots: rows.filter(Boolean).map((p) => publicPlot(p, openid)),
        chunkX: x,
        chunkZ: z
      }
    }
    return { config, own, claim, region, publicPlot }
  }
}
