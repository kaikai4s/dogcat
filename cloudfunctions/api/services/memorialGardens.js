const crypto = require('crypto')
const { readOptionalDocument, readDocuments } = require('../utils/documentPages')
const { version: DEFAULT } = require('../config/memorial-world.json')
const DEFAULT_NAME = '时光纪念园'
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32)
const gardenId = row => row && row.gardenId || DEFAULT
module.exports = context => {
  const { db, now, checkTextSecurity } = context
  const read = (store, id) => readOptionalDocument(store, 'platform_configs', id)
  const put = (store, id, data) => store.collection('platform_configs').doc(id).set({ data })
  const fallback = () => ({ _id: DEFAULT, key: 'memorial_garden', name: DEFAULT_NAME, template: DEFAULT, accepting: true, revision: 0 })
  const publicRow = row => ({ id: row._id, name: row.name, template: row.template, accepting: row.accepting !== false, revision: row.revision || 0, createdAt: row.createdAt || '' })
  async function get(id = DEFAULT, store = db) {
    if (typeof id !== 'string' || !(id === DEFAULT || /^garden_[a-f0-9]{32}$/.test(id))) throw new Error('纪念园不存在或版本不支持，请重新选择')
    const row = await read(store, id) || (id === DEFAULT ? fallback() : null)
    if (!row || row.key !== 'memorial_garden' || row.template !== DEFAULT) throw new Error('纪念园不存在或版本不支持，请重新选择')
    return row
  }
  async function labelRows(rows) {
    const names = new Map()
    for (const id of new Set(rows.map(gardenId))) names.set(id, (await get(id)).name)
    return rows.map(row => ({ ...row, gardenId: gardenId(row), gardenName: names.get(gardenId(row)) }))
  }
  async function plots(id) {
    const rows = await readDocuments(db, db.command, 'platform_configs', { key: 'memorial_plot', gardenId: id }, 600)
    // Legacy documents belong only to the original garden, without a destructive migration.
    if (id === DEFAULT) rows.push(...await readDocuments(db, db.command, 'platform_configs', { key: 'memorial_plot', gardenId: db.command.exists(false) }, 600))
    return rows
  }
  async function handle(openid, action, data) {
    if (action === 'listGardens' || action === 'listGardensAdmin') {
      const cursor = typeof data.cursor === 'string' ? data.cursor : ''
      const result = await db.collection('platform_configs').where({ key: 'memorial_garden', _id: db.command.gt(cursor || DEFAULT) }).orderBy('_id', 'asc').limit(31).get()
      const rows = (result.data || []).slice(0, 30)
      return { list: (cursor ? [] : [publicRow(await get(DEFAULT))]).concat(rows.map(publicRow)), hasMore: (result.data || []).length > 30, cursor: rows.length ? rows[rows.length - 1]._id : DEFAULT }
    }
    const name = String(data.name || '').normalize('NFKC').trim()
    if (!name || Array.from(name).length > 30 || typeof data.accepting !== 'boolean') throw new Error('请填写 1–30 字的园区名称并设置是否接收新申请')
    await checkTextSecurity(openid, name, { label: '纪念园名称' })
    const creating = action === 'createGarden'
    if (creating && !/^[a-zA-Z0-9_-]{8,80}$/.test(data.requestId || '')) throw new Error('创建编号无效，请重试')
    if (!creating && (!Number.isSafeInteger(data.revision) || data.revision < 0)) throw new Error('园区版本无效，请刷新')
    const id = creating ? 'garden_' + hash(openid + '|' + data.requestId) : data.id
    const fingerprint = hash(JSON.stringify([name, data.accepting, creating ? data.requestId : data.revision]))
    const nameKey = 'memorial_garden_name_' + hash(name.toLowerCase())
    return db.runTransaction(async tx => {
      const existing = creating ? await read(tx, id) : await get(id, tx)
      if (existing && existing.fingerprint === fingerprint) return publicRow(existing)
      if (creating && existing) throw new Error('创建内容已改变，请重新打开新建表单')
      if (!creating && existing.revision !== data.revision) throw new Error('园区已被其他管理员更新，请刷新')
      const reserved = await read(tx, nameKey), original = await get(DEFAULT, tx)
      if (reserved && reserved.gardenId !== id || id !== DEFAULT && original.name.toLowerCase() === name.toLowerCase()) throw new Error('已有同名纪念园，请换一个名称')
      if (existing && existing.name.toLowerCase() !== name.toLowerCase()) {
        const oldKey = 'memorial_garden_name_' + hash(existing.name.toLowerCase()), old = await read(tx, oldKey)
        if (old && old.gardenId === id) await tx.collection('platform_configs').doc(oldKey).remove()
      }
      const row = { key: 'memorial_garden', name, template: DEFAULT, accepting: data.accepting,
        revision: (existing && existing.revision || 0) + 1, fingerprint, createdAt: existing && existing.createdAt || now(), updatedAt: now(), updatedBy: openid }
      await put(tx, nameKey, { key: 'memorial_garden_name', gardenId: id })
      await put(tx, id, row)
      // Tell online clients about renames and application availability changes.
      const worldId = 'world_' + id, version = await readOptionalDocument(tx, 'pet_memorial_live', worldId)
      await tx.collection('pet_memorial_live').doc(worldId).set({ data: { kind: 'scene', sceneId: id, revision: (version && version.revision || 0) + 1 } })
      return publicRow({ ...row, _id: id })
    })
  }
  return { get, plots, handle, labelRows, publicRow }
}
module.exports.DEFAULT = DEFAULT
module.exports.gardenId = gardenId
