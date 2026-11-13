const crypto = require('crypto')
const { readOptionalDocument } = require('../utils/documentPages')
const { gardenId } = require('./memorialGardens')
const DAY = 86400000, OFFSET = 8 * 3600000, MINUTE = 60000
const SETTINGS_ID = 'memorial_offering_settings', MAX_MINUTES = 10080
const defaults = { flowerMinutes: 1440, snackMinutes: 1440 }
function displaySettings(row) {
  return { revision: row && row.revision || 0, ...Object.fromEntries(Object.entries(defaults).map(([key, value]) =>
    [key, Number.isInteger(row && row[key]) && row[key] >= 1 && row[key] <= MAX_MINUTES ? row[key] : value])) }
}
function scene(value, stamp) {
  return Object.fromEntries(['flower', 'snack'].map(kind => {
    const buckets = new Map()
    for (const row of value && Array.isArray(value[kind]) ? value[kind] : []) {
      if (Array.isArray(row) && Number.isSafeInteger(row[0]) && row[0] * MINUTE > stamp &&
        Number.isSafeInteger(row[1]) && row[1] > 0) buckets.set(row[0], (buckets.get(row[0]) || 0) + row[1])
    }
    return [kind, [...buckets].sort((a, b) => a[0] - b[0])]
  }))
}
const counts = value => Object.fromEntries(['flower', 'snack'].map(kind => [kind,
  Number.isSafeInteger(value && value[kind]) && value[kind] >= 0 ? value[kind] : 0]))
const receiptId = (openid, id, day) => 'memorial_offering_' + crypto.createHash('sha256').update(JSON.stringify([openid, id, day])).digest('hex').slice(0, 32)
module.exports = context => {
  const { db } = context
  const presence = require('./memorialPresence')(context)
  const read = (store, id) => readOptionalDocument(store, 'platform_configs', id)
  return async (openid, action, data = {}) => {
    if (action === 'getOfferingSettings') return displaySettings(await read(db, SETTINGS_ID))
    if (action === 'saveOfferingSettings') {
      if (!Number.isSafeInteger(data.revision) || data.revision < 0) throw new Error('设置版本无效，请重新读取')
      if (Object.keys(defaults).some(key => !Number.isInteger(data[key]) || data[key] < 1 || data[key] > MAX_MINUTES))
        throw new Error('鲜花和零食显示时长须为 1～10080 分钟的整数')
      return db.runTransaction(async tx => {
        const previous = displaySettings(await read(tx, SETTINGS_ID))
        if (previous.revision !== data.revision) {
          if (previous.flowerMinutes === data.flowerMinutes && previous.snackMinutes === data.snackMinutes) return previous
          throw new Error('设置已被其他管理员修改，请重新读取')
        }
        const settings = { flowerMinutes: data.flowerMinutes, snackMinutes: data.snackMinutes, revision: previous.revision + 1 }
        await tx.collection('platform_configs').doc(SETTINGS_ID).set({ data: { key: SETTINGS_ID, ...settings,
          updatedAt: context.now(), updatedBy: openid } })
        return settings
      })
    }
    if (typeof data.id !== 'string' || !data.id.trim()) throw new Error('请选择时光小筑')
    const id = data.id.trim(), placing = action === 'placeOffering'
    if (placing && !['flower', 'snack'].includes(data.kind)) throw new Error('请选择鲜花或零食')
    return db.runTransaction(async tx => {
      const stamp = (context.nowMs || Date.now)(), day = new Date(stamp + OFFSET).toISOString().slice(0, 10)
      const app = await read(tx, id)
      if (!app || app.key !== 'memorial_application' || app.status !== 'approved') throw new Error('这处时光小筑暂不可探望，请刷新')
      if (data.gardenId && data.gardenId !== gardenId(app)) throw new Error('园区已变化，请重新进入小筑')
      const plot = await read(tx, app.plotKey)
      if (!plot || plot.key !== 'memorial_plot' || plot.status !== 'approved' || plot.applicationId !== id) throw new Error('小筑位置已变化，请刷新')
      const key = receiptId(openid, id, day), old = await read(tx, key)
      const settings = displaySettings(await read(tx, SETTINGS_ID))
      const display = scene(plot.offeringScene, stamp)
      const result = { day, serverTime: stamp, resetAt: (Math.floor((stamp + OFFSET) / DAY) + 1) * DAY - OFFSET,
        counts: counts(plot.offerings), display, settings, given: { flower: !!(old && old.flower), snack: !!(old && old.snack) } }
      if (!placing) return result
      // The displayed server date binds retries to one day, including a lost response at midnight.
      if (data.day !== day) throw new Error('日期已更新，请刷新后再献上心意')
      if (result.given[data.kind]) return { ...result, duplicate: true }
      if (result.counts[data.kind] === Number.MAX_SAFE_INTEGER) throw new Error('心意数量暂时无法更新，请稍后重试')
      result.counts[data.kind]++
      result.given[data.kind] = true
      // Minute buckets keep a full seven-day window below the document size limit.
      // Gifts disappear on a minute boundary, at most 59s after the configured duration.
      const expires = Math.ceil(stamp / MINUTE) + settings[data.kind + 'Minutes']
      const bucket = display[data.kind].find(row => row[0] === expires)
      if (bucket) bucket[1]++
      else display[data.kind].push([expires, 1])
      display[data.kind].sort((a, b) => a[0] - b[0])
      await tx.collection('platform_configs').doc(app.plotKey).update({ data: { offerings: result.counts, offeringScene: display } })
      await tx.collection('platform_configs').doc(key).set({ data: {
        key: 'memorial_offering', applicationId: id, gardenId: gardenId(app), day,
        ...result.given, updatedAt: new Date(stamp).toISOString()
      } })
      await presence.changed(tx, gardenId(app))
      return { ...result, duplicate: false }
    })
  }
}
module.exports.counts = counts
module.exports.scene = scene
