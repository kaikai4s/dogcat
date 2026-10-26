const world = require('./playground-world')
const { readDocuments, readOptionalDocument } = require('../utils/documentPages')
const normalize = value => {
  if (typeof value === 'string') value = { name: value }
  if (!value || !String(value.name || '').trim()) return null
  const latitude = Number(value.latitude || 0), longitude = Number(value.longitude || 0)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error('小区位置无效')
  return { ...(value.serviceCommunityId ? { serviceCommunityId: String(value.serviceCommunityId) } : {}),
    name: String(value.name).trim().slice(0, 100), address: String(value.address || '').trim().slice(0, 300),
    city: String(value.city || '').trim().slice(0, 60), district: String(value.district || '').trim().slice(0, 60), latitude, longitude }
}
module.exports = function createCommunities({ db, normalizeCityName = value => String(value || '').trim().replace(/市$/, '') }) {
  function selectable(row) {
    return row && /^map_community_[a-f0-9]{24}$/.test(row._id) && row.key === 'service_community' && row.enabled === true &&
      typeof row.name === 'string' && row.name.trim() && row.latitude != null && row.longitude != null &&
      Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)) &&
      Math.abs(Number(row.latitude)) <= 85 && Math.abs(Number(row.longitude)) <= 180 &&
      !(Number(row.latitude) === 0 && Number(row.longitude) === 0)
  }
  function fromManaged(row) {
    return { serviceCommunityId: row._id, name: row.name, address: [row.city, row.district, row.name].filter(Boolean).join(' '),
      city: row.city, district: row.district || '', latitude: Number(row.latitude), longitude: Number(row.longitude) }
  }
  async function resolve(value, store = db) {
    if (!value?.serviceCommunityId) return normalize(value)
    const id = String(value.serviceCommunityId)
    if (!/^map_community_[a-f0-9]{24}$/.test(id)) throw new Error('小区编号无效')
    const row = await readOptionalDocument(store, 'platform_configs', id)
    if (!selectable(row)) throw new Error('小区尚未启用或已停用，请重新选择')
    return fromManaged(row)
  }
  async function readPlots(where) {
    const rows = []
    let cursor = ''
    do {
      const page = (await db.collection('pet_playground_plots').where({ ...where, ...(cursor ? { _id: db.command.gt(cursor) } : {}) })
        .field({ _id: true, ownerOpenid: true, communityId: true, buildingType: true, isNewPlot: true, demolished: true })
        .orderBy('_id', 'asc').limit(100).get()).data || []
      rows.push(...page.filter(world.isResidence))
      cursor = page.length === 100 ? page[page.length - 1]._id : ''
    } while (cursor)
    return rows
  }
  async function info(value) {
    const community = await resolve(value)
    if (!community) throw new Error('请选择有效小区')
    const id = world.communityId({ residentialCommunity: community })
    const rows = await readPlots({ kind: 'plot', communityId: id })
    return { id, community, residentCount: new Set(rows.map(row => row.ownerOpenid)).size }
  }
  async function list(user, data = {}) {
    const keyword = String(data.keyword || '').trim().toLowerCase().slice(0, 100)
    const city = String(data.city || '').trim().slice(0, 40)
    // The maintained directory includes zero-resident communities immediately.
    const managed = await readDocuments(db, db.command, 'platform_configs', { key: 'service_community', enabled: true,
      ...(city ? { cityKey: normalizeCityName(city) } : {}) }, 1001)
    if (managed.length > 1000) throw new Error('小区较多，请联系平台分城市查询')
    const managedById = new Map(managed.filter(selectable).map(row => [row._id, row]))
    const savedCommunity = value => {
      // Old profile snapshots may have broken coordinates or an obsolete name.
      // Managed entries use the current directory; one invalid legacy profile
      // must not prevent everyone else from opening the community selector.
      if (value?.serviceCommunityId) {
        const row = managedById.get(String(value.serviceCommunityId))
        return row ? fromManaged(row) : null
      }
      try { return normalize(value) } catch (_) { return null }
    }
    const rows = await readPlots({ kind: 'plot' })
    const communities = new Map(), owners = new Set(rows.map(row => row.ownerOpenid)), meta = new Map()
    const keys = [...owners]
    // Only return public community information and aggregate counts, never resident identities.
    for (let i = 0; i < keys.length; i += 50) {
      const users = (await db.collection('users').where({ openid: db.command.in(keys.slice(i, i + 50)) })
        .field({ _id: true, residentialCommunity: true }).limit(100).get()).data || []
      for (const resident of users) {
        const community = savedCommunity(resident.residentialCommunity)
        if (community) meta.set(world.communityId({ residentialCommunity: community }), community)
      }
    }
    const current = savedCommunity(user.residentialCommunity)
    const currentId = current && world.communityId({ residentialCommunity: current })
    if (current) meta.set(currentId, current)
    const managedIds = new Set()
    for (const row of managed) {
      if (!selectable(row)) continue
      const community = fromManaged(row), id = world.communityId({ residentialCommunity: community })
      managedIds.add(id); meta.set(id, community); communities.set(id, new Set())
    }
    for (const plot of rows) {
      if (!meta.has(plot.communityId)) continue
      if (!communities.has(plot.communityId)) communities.set(plot.communityId, new Set())
      communities.get(plot.communityId).add(plot.ownerOpenid)
    }
    if (current && !communities.has(currentId)) communities.set(currentId, new Set())
    const items = [...communities].map(([id, residents]) => ({ id, community: meta.get(id), residentCount: residents.size, mine: id === currentId, maintained: managedIds.has(id) }))
      // Saved user metadata must not resurrect disabled or deleted directory entries.
      .filter(item => !item.community.serviceCommunityId || managedIds.has(item.id))
      .filter(item => !city || normalizeCityName(item.community.city) === normalizeCityName(city))
      .filter(item => !keyword || `${item.community.name} ${item.community.address}`.toLowerCase().includes(keyword))
      .sort((a, b) => Number(b.mine) - Number(a.mine) || b.residentCount - a.residentCount || a.id.localeCompare(b.id))
    const page = Math.max(1, Math.floor(Number(data.page) || 1)), pageSize = 20
    return { list: items.slice((page - 1) * pageSize, page * pageSize), hasMore: page * pageSize < items.length, page }
  }
  return { list, info, resolve }
}
