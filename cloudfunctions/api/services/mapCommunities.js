const { readOptionalDocument, readDocuments } = require('../utils/documentPages')
const { communityName, nameKey, addressName, communityAddress, cityPrefixes } = require('../utils/communityNames')

// Only administrator-verified public points may cross the map API boundary.
module.exports = function createMapCommunities({ db, crypto, hasCoordinate, calcDistanceKm, normalizeCityName, extractCityFromText }) {
  const key = 'service_community'
  const selectionRadiusKm = 3
  function mapCityCondition(city) {
    const normalized = normalizeCityName(city)
    if (!normalized) throw new Error('请选择有效城市')
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return db.RegExp({ regexp: `^\\s*(?:[^省]{2,12}省|内蒙古自治区|广西壮族自治区|西藏自治区|宁夏回族自治区|新疆维吾尔自治区)?${escaped}(?:市|特别行政区|地区|盟|自治州)?\\s*$`, options: '' })
  }
  function publicCommunity(row) {
    if (!row || row.key !== key || row.enabled !== true || !hasCoordinate(row.latitude, row.longitude) || Math.abs(Number(row.latitude)) > 85) return null
    return { _id: row._id, name: row.name, city: row.city, district: row.district || '',
      latitude: Number(row.latitude), longitude: Number(row.longitude), revision: Number(row.revision || 1) }
  }
  async function readMapCommunities(city = '') {
    const where = { key, enabled: true }
    const normalizedCity = normalizeCityName(city)
    if (String(city).trim() && !normalizedCity) throw new Error('请选择有效城市')
    if (normalizedCity) where.cityKey = normalizedCity
    const rows = await readDocuments(db, db.command, 'platform_configs', where, 1001)
    if (rows.length > 1000) throw new Error('小区过多，请选择具体城市后重试')
    return rows.filter(publicCommunity)
  }
  async function getMapCommunity(id) {
    if (!/^map_community_[a-f0-9]{24}$/.test(String(id || ''))) return null
    const row = await readOptionalDocument(db, 'platform_configs', id)
    return publicCommunity(row) ? row : null
  }
  function createCommunityMatcher(rows) {
    const byId = new Map(), byName = new Map(), byApplication = new Map(), cityKeys = new Map()
    for (const row of rows) {
      byId.set(row._id, row); cityKeys.set(row._id, normalizeCityName(row.city))
      for (const applicationId of row.applicationIds || []) byApplication.set(applicationId, row)
      const prefixes = ['', row.district || '', ...cityPrefixes(row.city).flatMap(city => [city, `${city}${row.district || ''}`])]
      for (const alias of [row.name, ...(row.aliases || [])]) {
        for (const aliasKey of new Set([nameKey(alias), addressName(alias, row.city, row.district)])) {
          if (!aliasKey) continue
          for (const prefix of prefixes) {
            const key = nameKey(prefix + aliasKey)
            if (!byName.has(key)) byName.set(key, new Set())
            byName.get(key).add(row)
          }
        }
      }
    }
    function findByName(value, city = '') {
      const candidates = new Set()
      for (const key of [nameKey(value), addressName(value, '', '')]) {
        for (const row of byName.get(key) || []) candidates.add(row)
      }
      const cityKey = normalizeCityName(city)
      return [...candidates].filter(row => (!cityKey || cityKeys.get(row._id) === cityKey) && sameCommunityName(value, row))
    }
    function match(source) {
      const id = source.serviceCommunityId || source.publicServiceCommunityId
      const application = source.serviceCommunityApplicationId
      const city = normalizeCityName(source.city || source.serviceCity || '')
      const lat = source.addressLatitude ?? source.serviceLatitude ?? source.latitude
      const lng = source.addressLongitude ?? source.serviceLongitude ?? source.longitude
      if (!hasCoordinate(lat, lng)) return null
      const candidates = (id ? (byId.has(id) ? [byId.get(id)] : [])
        : application ? (byApplication.has(application) ? [byApplication.get(application)] : []) : findByName(source.serviceAddress, city)).filter(row =>
        publicCommunity(row) && (!city || cityKeys.get(row._id) === city) &&
        calcDistanceKm(lat, lng, row.latitude, row.longitude) <=
          (source.serviceCommunitySelection === 'client' || application ? selectionRadiusKm : Number(row.matchRadiusKm || 1)))
      // Ambiguous estates still require manual verification, even if one is closer.
      return candidates.length === 1 ? candidates[0] : null
    }
    return { match, findByName }
  }
  function matchMapCommunity(source, rows) {
    return createCommunityMatcher(rows).match(source)
  }
  function sameCommunityName(value, row) {
    const names = new Set([nameKey(value), addressName(value, row.city, row.district)])
    names.delete('')
    return [row.name, ...(row.aliases || [])].some(alias => names.has(nameKey(alias)) || names.has(addressName(alias, row.city, row.district)))
  }
  async function readCommunityCandidates(city = '') {
    const cityKey = normalizeCityName(city)
    const cityCondition = String(city).trim() ? mapCityCondition(city) : null
    const [orders, profiles, communities, applications] = await Promise.all([
      readDocuments(db, db.command, 'orders', { status: 'paid', publishMode: 'open', ...(cityCondition ? { city: cityCondition } : {}) }, 2001),
      readDocuments(db, db.command, 'staff_profiles', { auditStatus: 'approved', ...(cityCondition ? { serviceCity: cityCondition } : {}) }, 2001),
      readDocuments(db, db.command, 'platform_configs', { key, ...(cityKey ? { cityKey } : {}) }, 1001),
      readDocuments(db, db.command, 'platform_configs', { key: 'map_community_application', status: 'pending', ...(cityKey ? { cityKey } : {}) }, 1001)
    ])
    if (orders.length > 2000 || profiles.length > 2000 || communities.length > 1000 || applications.length > 1000) throw new Error('候选地址较多，请选择具体城市后重试')
    const groups = new Map()
    const matcher = createCommunityMatcher(communities)
    const activeCommunityIds = new Set(communities.filter(publicCommunity).map(row => row._id))
    const pendingApplications = new Map(applications.map(row => [row._id, row]))
    const pending = [], districts = new Map()
    let missingCityCount = 0
    const add = (source, kind) => {
      if (source.deletedAt || source.adminDeletedAt || source.groupBuyRefundRequired || matcher.match(source)) return
      const sourceCity = String(source.city || source.serviceCity || '').trim()
      const application = pendingApplications.get(source.serviceCommunityApplicationId)
      const associated = application && normalizeCityName(sourceCity) === application.cityKey ? application : null
      const address = associated?.name || source.serviceAddress
      if (!communityName(address)) return
      if (!sourceCity) { missingCityCount++; return }
      const existing = matcher.findByName(address, sourceCity)
      const parts = communityAddress(address, sourceCity, associated?.district || source.district || source.serviceDistrict || (existing.length === 1 ? existing[0].district : ''))
      const name = parts.name.slice(0, 60)
      if (!name) return
      const baseKey = `${normalizeCityName(sourceCity)}|${nameKey(name)}`
      if (!districts.has(baseKey)) districts.set(baseKey, new Set())
      if (parts.district) districts.get(baseKey).add(parts.district)
      const latitude = source.addressLatitude ?? source.serviceLatitude, longitude = source.addressLongitude ?? source.serviceLongitude
      const previousId = source.serviceCommunityId || source.publicServiceCommunityId
      const reason = associated ? '用户申请新增，待核验公共点'
        : !hasCoordinate(latitude, longitude) ? '服务地址缺少有效坐标，请重新选址'
        : previousId && !activeCommunityIds.has(previousId) ? '原关联小区已停用或不存在，请重新选择'
        : existing.length > 1 ? '同名小区，需核对位置'
        : existing.length === 1 ? (existing[0].enabled ? '服务地址超出自动匹配距离，请核对公共点或下单时直接选择' : '已维护但未启用') : '尚未维护公共小区'
      pending.push({ sourceCity, name, baseKey, district: parts.district, existing, kind, reason })
    }
    for (const order of orders) add(order, 'orderCount')
    for (const profile of profiles) add(profile, 'staffCount')
    for (const application of applications) {
      const existing = matcher.findByName(application.name, application.city)
      const parts = communityAddress(application.name, application.city, application.district)
      const baseKey = `${normalizeCityName(application.city)}|${nameKey(parts.name)}`
      if (!districts.has(baseKey)) districts.set(baseKey, new Set())
      if (parts.district) districts.get(baseKey).add(parts.district)
      pending.push({ sourceCity: application.city, name: parts.name, baseKey, district: parts.district,
        existing, kind: 'applicationCount', applicationId: application._id, reason: '用户申请新增，待核验公共点' })
    }
    for (const entry of pending) {
      const hints = districts.get(entry.baseKey)
      const district = entry.district || (hints.size === 1 ? [...hints][0] : '')
      const groupKey = `${entry.baseKey}|${district}`
      if (!groups.has(groupKey)) {
        const existing = entry.existing.filter(row => !district || !row.district || row.district === district)
        groups.set(groupKey, { _id: 'map_candidate_' + crypto.createHash('sha256').update(groupKey).digest('hex').slice(0, 24),
          name: entry.name, city: entry.sourceCity, district, orderCount: 0, staffCount: 0, applicationCount: 0, applicationIds: [],
          existingId: existing.length === 1 ? existing[0]._id : '',
          reason: entry.reason })
      }
      groups.get(groupKey)[entry.kind]++
      if (entry.applicationId) groups.get(groupKey).applicationIds.push(entry.applicationId)
    }
    return { list: [...groups.values()].sort((a, b) => b.orderCount - a.orderCount || b.staffCount - a.staffCount || a._id.localeCompare(b._id)), missingCityCount }
  }
  async function readOrderCommunityChoice(source) {
    const applicationId = String(source.serviceCommunityApplicationId || '')
    let id = String(source.serviceCommunityId || '')
    let application
    if (applicationId) {
      if (!/^map_application_[a-f0-9]{32}$/.test(applicationId)) return { error: '小区申请无效，请重新选择' }
      application = await readOptionalDocument(db, 'platform_configs', applicationId)
      if (!application || application.key !== 'map_community_application' || !['pending', 'resolved'].includes(application.status)) return { error: '小区申请不存在或已失效，请重新选择' }
      if (source.city && normalizeCityName(source.city) !== application.cityKey) return { error: '小区申请与服务城市不一致' }
      if (application.status === 'resolved') {
        if (!application.serviceCommunityId || (id && id !== application.serviceCommunityId)) return { error: '小区申请关联已变化，请重新选择' }
        id = application.serviceCommunityId
      }
    }
    if (id) {
      const row = await getMapCommunity(id)
      if (!row) return { error: '所选小区已停用或不存在，请重新选择' }
      if (source.city && normalizeCityName(source.city) !== normalizeCityName(row.city)) return { error: '所选小区与服务城市不一致' }
      if (!hasCoordinate(source.addressLatitude, source.addressLongitude) ||
          calcDistanceKm(source.addressLatitude, source.addressLongitude, row.latitude, row.longitude) > selectionRadiusKm) {
        return { error: '请选择服务地址附近3公里内的小区，或申请新增小区' }
      }
      return { community: publicCommunity(row), fields: { serviceCommunityId: row._id, serviceCommunityName: row.name, serviceCommunitySelection: 'client',
        ...(!source.city ? { city: row.city } : {}), ...(applicationId ? { serviceCommunityApplicationId: applicationId } : {}) } }
    }
    if (application) return { application: { name: application.name, city: application.city, district: application.district || '', status: application.status },
      fields: { serviceCommunityApplicationId: applicationId, serviceCommunitySelection: 'application',
        ...(!source.city ? { city: application.city } : {}) } }
    return null
  }
  async function resolveOrderCommunity(source) {
    const choice = await readOrderCommunityChoice(source)
    if (choice?.error) throw new Error(choice.error)
    if (choice) return choice.fields
    const rows = await readMapCommunities(source.city || '')
    const row = matchMapCommunity(source, rows)
    return row ? { serviceCommunityId: row._id, serviceCommunityName: row.name } : {}
  }
  async function prepareRebookCommunity(source) {
    // Automatic historical matches must not become explicit three-kilometre choices.
    if (source.serviceCommunitySelection !== 'client' && !source.serviceCommunityApplicationId) return {}
    const choice = await readOrderCommunityChoice(source)
    if (!choice || choice.error) return { communitySelectionNotice: '原地图小区或申请已失效，请重新选择附近小区或申请新增。' }
    return { ...choice.fields, orderCommunity: choice.community || null, orderCommunityApplication: choice.application || null }
  }
  async function nearbyOrderCommunities(data) {
    if (!hasCoordinate(data.latitude, data.longitude) || Math.abs(Number(data.latitude)) > 85) throw new Error('请先选择有效的服务地址')
    const city = String(data.city || extractCityFromText(data.address) || '').trim().slice(0, 40)
    if (!city) throw new Error('请选择服务地址所在城市')
    const rows = await readMapCommunities(city)
    const keyword = String(data.keyword || '').normalize('NFKC').trim().toLowerCase().slice(0, 60)
    const list = rows.filter(row => !keyword || [row.name, ...(row.aliases || [])].some(value => String(value).normalize('NFKC').toLowerCase().includes(keyword)))
      .map(row => ({ ...publicCommunity(row),
        distanceKm: calcDistanceKm(data.latitude, data.longitude, row.latitude, row.longitude) }))
      .filter(row => row.distanceKm <= selectionRadiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm || a._id.localeCompare(b._id))
    const offset = Math.max(0, Math.floor(Number(data.offset) || 0))
    return { list: list.slice(offset, offset + 20).map(row => ({ ...row,
      distanceText: row.distanceKm < 1 ? `${Math.round(row.distanceKm * 1000)}米` : `${row.distanceKm.toFixed(1)}公里` })),
      city, total: list.length, hasMore: offset + 20 < list.length, radiusKm: selectionRadiusKm }
  }
  function communityId() { return `map_community_${crypto.randomBytes(12).toString('hex')}` }
  return { readMapCommunities, getMapCommunity, publicCommunity, createCommunityMatcher, matchMapCommunity, sameCommunityName, readCommunityCandidates, resolveOrderCommunity, prepareRebookCommunity, nearbyOrderCommunities, communityId, mapCityCondition }
}
