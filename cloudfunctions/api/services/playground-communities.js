const world = require('./playground-world')
const normalize = value => {
  if (typeof value === 'string') value = { name: value }
  if (!value || !String(value.name || '').trim()) return null
  const latitude = Number(value.latitude || 0), longitude = Number(value.longitude || 0)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new Error('小区位置无效')
  return { name: String(value.name).trim().slice(0, 100), address: String(value.address || '').trim().slice(0, 300),
    city: String(value.city || '').trim().slice(0, 60), district: String(value.district || '').trim().slice(0, 60), latitude, longitude }
}
module.exports = function createCommunities({ db }) {
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
    const community = normalize(value)
    if (!community) throw new Error('请选择有效小区')
    const id = world.communityId({ residentialCommunity: community })
    const rows = await readPlots({ kind: 'plot', communityId: id })
    return { id, community, residentCount: new Set(rows.map(row => row.ownerOpenid)).size }
  }
  async function list(user, data = {}) {
    const keyword = String(data.keyword || '').trim().toLowerCase().slice(0, 100)
    const rows = await readPlots({ kind: 'plot' })
    const communities = new Map(), owners = new Set(rows.map(row => row.ownerOpenid)), meta = new Map()
    const keys = [...owners]
    // Only return public community information and aggregate counts, never resident identities.
    for (let i = 0; i < keys.length; i += 50) {
      const users = (await db.collection('users').where({ openid: db.command.in(keys.slice(i, i + 50)) })
        .field({ _id: true, residentialCommunity: true }).limit(100).get()).data || []
      for (const resident of users) {
        const community = normalize(resident.residentialCommunity)
        if (community) meta.set(world.communityId({ residentialCommunity: community }), community)
      }
    }
    const current = normalize(user.residentialCommunity)
    const currentId = current && world.communityId({ residentialCommunity: current })
    if (current) meta.set(currentId, current)
    for (const plot of rows) {
      if (!meta.has(plot.communityId)) continue
      if (!communities.has(plot.communityId)) communities.set(plot.communityId, new Set())
      communities.get(plot.communityId).add(plot.ownerOpenid)
    }
    if (current && !communities.has(currentId)) communities.set(currentId, new Set())
    const items = [...communities].map(([id, residents]) => ({ id, community: meta.get(id), residentCount: residents.size, mine: id === currentId }))
      .filter(item => !keyword || `${item.community.name} ${item.community.address}`.toLowerCase().includes(keyword))
      .sort((a, b) => Number(b.mine) - Number(a.mine) || b.residentCount - a.residentCount || a.id.localeCompare(b.id))
    const page = Math.max(1, Math.floor(Number(data.page) || 1)), pageSize = 20
    return { list: items.slice((page - 1) * pageSize, page * pageSize), hasMore: page * pageSize < items.length, page }
  }
  return { list, info }
}
