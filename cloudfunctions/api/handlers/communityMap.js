const { readDocuments, readOptionalDocument } = require('../utils/documentPages')

module.exports = function createHandler(context) {
  const { db, requireAdmin, getUser, now, checkTextSecurity, checkRateLimit, hasCoordinate,
    readMapCommunities, publicCommunity, communityId, getMapCommunity, matchMapCommunity } = context
  return async function communityMap(openid, action, data = {}) {
    if (action === 'listAdmin' || action === 'saveAdmin') {
      await requireAdmin(openid)
      if (action === 'listAdmin') {
        const list = await readDocuments(db, db.command, 'platform_configs', { key: 'service_community' }, 1001)
        if (list.length > 1000) throw new Error('小区数量超过单次管理上限，请联系管理员分城市维护')
        return list.map(row => ({ _id: row._id, name: row.name, city: row.city, district: row.district || '',
          aliases: row.aliases || [], latitude: row.latitude, longitude: row.longitude, enabled: row.enabled,
          matchRadiusKm: row.matchRadiusKm, revision: row.revision }))
      }
      const name = String(data.name || '').trim(), city = String(data.city || '').trim(), district = String(data.district || '').trim()
      if (!name || name.length > 60 || !city || city.length > 40 || district.length > 40) throw new Error('请填写有效的小区名称、城市和行政区')
      const latitude = Number(data.latitude), longitude = Number(data.longitude)
      if (!hasCoordinate(latitude, longitude)) throw new Error('请选择小区公共入口或公共中心')
      if (data.confirmPublic !== true) throw new Error('请确认该坐标是小区公共参考点，不是家庭位置')
      const aliases = [...new Set((Array.isArray(data.aliases) ? data.aliases : []).map(v => String(v).trim()).filter(Boolean))]
      if (aliases.length > 20 || aliases.some(v => v.length > 80)) throw new Error('别名最多20项，每项不超过80字')
      const radius = Number(data.matchRadiusKm || 1)
      if (!Number.isFinite(radius) || radius < 0.1 || radius > 3) throw new Error('匹配半径应为0.1至3公里')
      const id = data.id || communityId()
      if (!/^map_community_[a-f0-9]{24}$/.test(id)) throw new Error('小区编号无效')
      const existing = await readOptionalDocument(db, 'platform_configs', id)
      if (data.id && (!existing || existing.key !== 'service_community')) throw new Error('小区不存在')
      if (existing && Number(data.revision) !== Number(existing.revision)) throw new Error('小区已更新，请刷新后重试')
      await checkTextSecurity(openid, [name, city, district, ...aliases].join(' '), { scene: 1, label: '公共小区资料' })
      const patch = { key: 'service_community', name, city, cityKey: context.normalizeCityName(city), district, aliases,
        latitude, longitude, matchRadiusKm: radius, enabled: data.enabled === true, updatedAt: now() }
      await db.runTransaction(async tx => {
        const current = await readOptionalDocument(tx, 'platform_configs', id)
        if (Number(current?.revision || 0) !== Number(existing?.revision || 0)) throw new Error('小区已更新，请刷新后重试')
        await tx.collection('platform_configs').doc(id).set({ data: { ...patch, revision: Number(current?.revision || 0) + 1, createdAt: current?.createdAt || now() } })
      })
      return { id }
    }
    if (action === 'catalog') {
      await checkRateLimit(openid, 'communityMap.catalog', { max: 60 })
      const keyword = String(data.keyword || '').trim().slice(0, 60)
      const rows = await readMapCommunities(String(data.city || '').trim().slice(0, 40))
      const items = rows.filter(row => !keyword || [row.name, ...(row.aliases || [])].some(v => v.includes(keyword)))
        .sort((a, b) => a.name.localeCompare(b.name) || a._id.localeCompare(b._id))
      const offset = Math.max(0, Math.floor(Number(data.offset) || 0))
      return { list: items.slice(offset, offset + 30).map(publicCommunity), hasMore: offset + 30 < items.length, total: items.length }
    }
    if (action === 'setVisibility') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅宠托师可设置')
      await checkRateLimit(openid, 'communityMap.visibility', { max: 10 })
      const profiles = (await db.collection('staff_profiles').where({ openid }).limit(1).get()).data || []
      const profile = profiles[0]
      if (!profile) throw new Error('宠托师档案不存在')
      if (data.enabled !== true) {
        await db.collection('staff_profiles').doc(profile._id).update({ data: { publicMapEnabled: false, updatedAt: now() } })
        return { enabled: false }
      }
      if (data.confirmPublic !== true) throw new Error('请确认同意公开服务小区及公开范围')
      const row = await getMapCommunity(data.communityId)
      if (!row) throw new Error('请选择已核验的小区')
      if (!context.canTakeOrders(profile, (await context.getSystemSettings()).staffDeposit)) throw new Error('当前资格不可公开接单')
      if (context.normalizeCityName(row.city) !== context.normalizeCityName(profile.serviceCity)) throw new Error('请选择服务城市内的小区')
      if (!hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) ||
          context.calcDistanceKm(profile.serviceLatitude, profile.serviceLongitude, row.latitude, row.longitude) > Number(row.matchRadiusKm || 1)) throw new Error('所选小区与固定服务地址不匹配，请核对资料或联系平台')
      // Freeze the public booking centre until the sitter explicitly confirms another revision.
      const radius = Number(profile.serviceRadiusKm || 5)
      if (Number(data.radiusKm) !== radius || Number(data.communityRevision) !== Number(row.revision)) throw new Error('服务范围或小区资料已更新，请刷新后重新确认')
      await db.runTransaction(async tx => {
        const current = await readOptionalDocument(tx, 'staff_profiles', profile._id)
        const currentCommunity = await readOptionalDocument(tx, 'platform_configs', row._id)
        if (!current || !currentCommunity?.enabled || currentCommunity.revision !== row.revision ||
          Number(current.serviceRadiusKm || 5) !== radius || current.serviceLatitude !== profile.serviceLatitude || current.serviceLongitude !== profile.serviceLongitude ||
          current.serviceCity !== profile.serviceCity || current.auditStatus !== profile.auditStatus) throw new Error('资料已变化，请刷新后重新确认')
        await tx.collection('staff_profiles').doc(profile._id).update({ data: { publicMapEnabled: true,
          publicServiceCommunityId: row._id, publicServiceCommunityName: row.name, publicCommunityRevision: row.revision,
          publicBookingLatitude: row.latitude, publicBookingLongitude: row.longitude, publicBookingRadiusKm: radius,
          publicBookingPolicyVersion: 1, publicBookingNeedsConfirmation: false, publicMapConsentAt: now(), updatedAt: now() } })
      })
      return { enabled: true }
    }
    if (action === 'listSitters') {
      await checkRateLimit(openid, 'communityMap.sitters', { max: 40 })
      const city = String(data.city || '').trim().slice(0, 40)
      if (!city) throw new Error('请先选择城市')
      const communities = await readMapCommunities(city)
      const where = { publicMapEnabled: true, serviceCity: db.command.in([city, context.normalizeCityName(city), `${context.normalizeCityName(city)}市`]) }
      const profiles = await readDocuments(db, db.command, 'staff_profiles', where, 2001)
      if (profiles.length > 2000) throw new Error('人员过多，请使用列表或缩小查询范围')
      const settings = await context.getSystemSettings()
      const activeStaff = new Set()
      const identities = [...new Set(profiles.map(profile => profile.openid).filter(Boolean))]
      for (let i = 0; i < identities.length; i += 50) {
        const users = (await db.collection('users').where({ openid: db.command.in(identities.slice(i, i + 50)), status: 'active' }).limit(100).get()).data || []
        for (const user of users) if (user.roles?.includes('staff')) activeStaff.add(user.openid)
      }
      const nodes = new Map(communities.map(row => [row._id, { ...publicCommunity(row), count: 0 }]))
      const accepted = []
      for (const profile of profiles) {
        const node = nodes.get(profile.publicServiceCommunityId)
        if (!node || !activeStaff.has(profile.openid) || Number(profile.publicCommunityRevision) !== node.revision || !context.canTakeOrders(profile, settings.staffDeposit)) continue
        if (data.staffGenderRequirement && data.staffGenderRequirement !== 'any' && profile.gender !== data.staffGenderRequirement) continue
        if (data.onlyDirect === true && (profile.acceptDirectOrders === false || profile.publicBookingNeedsConfirmation === true)) continue
        node.count++
        if (data.communityId === node._id) accepted.push(profile)
      }
      const page = Math.max(1, Math.floor(Number(data.page) || 1)), size = 10
      const compareSitter = (a, b) => Number(b.ratingAverage || 0) - Number(a.ratingAverage || 0) || a._id.localeCompare(b._id)
      accepted.sort(compareSitter)
      const cursor = String(data.cursor || '').slice(0, 256)
      let start = (page - 1) * size
      if (cursor) {
        const separator = cursor.indexOf('|')
        const rating = Number(cursor.slice(0, separator)), profileId = cursor.slice(separator + 1)
        if (separator < 1 || !Number.isFinite(rating) || !profileId) throw new Error('分页参数无效，请刷新后重试')
        start = accepted.findIndex(profile => compareSitter(profile, { ratingAverage: rating, _id: profileId }) > 0)
        if (start < 0) start = accepted.length
      }
      const pageRows = accepted.slice(start, start + size)
      const list = await context.batchWithSitterUserProfiles(pageRows)
      const hasMore = start + pageRows.length < accepted.length
      const last = pageRows[pageRows.length - 1]
      return { communities: [...nodes.values()].filter(row => row.count),
        list: list.map(profile => ({ ...context.toPublicSitter(profile), serviceAddress: nodes.get(profile.publicServiceCommunityId).name,
          publicServiceAddress: nodes.get(profile.publicServiceCommunityId).name,
          canDirectBook: profile.acceptDirectOrders !== false && profile.publicBookingNeedsConfirmation !== true, bookingNeedsContext: true })),
        page, total: accepted.length, hasMore,
        nextCursor: hasMore && last ? `${Number(last.ratingAverage || 0)}|${last._id}` : '', generatedAt: now() }
    }
    if (action === 'listOrders') {
      // Reuse the entire staff pool, including its eligibility and bundle checks, before pagination.
      const handler = require('./staff')(context)
      return handler(openid, 'listOrderMap', data)
    }
    throw new Error('未知小区地图操作')
  }
}
