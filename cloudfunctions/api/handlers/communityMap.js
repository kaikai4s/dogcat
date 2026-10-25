const { readDocuments, readOptionalDocument } = require('../utils/documentPages')
const { mapRefreshIds, visibleMapRows } = require('../utils/mapCards')
const { nameKey } = require('../utils/communityNames')

module.exports = function createHandler(context) {
  const { db, requireAdmin, getUser, now, checkTextSecurity, checkRateLimit, hasCoordinate,
    readMapCommunities, publicCommunity, getMapCommunity } = context
  return async function communityMap(openid, action, data = {}) {
    if (action === 'nearbyForOrder') {
      await getUser(openid)
      await checkRateLimit(openid, 'communityMap.nearbyForOrder', { max: 60 })
      return context.nearbyOrderCommunities(data)
    }
    if (action === 'applyCommunity') {
      await getUser(openid)
      await checkRateLimit(openid, 'communityMap.applyCommunity', { max: 5, windowMs: 60 * 60 * 1000 })
      const name = String(data.name || '').normalize('NFKC').trim()
      const city = String(data.city || '').trim(), district = String(data.district || '').trim()
      const cityKey = context.normalizeCityName(city)
      if (!name || name.length > 60 || !cityKey || city.length > 40 || district.length > 40) throw new Error('请填写小区公共名称及所在城市')
      if (/1[3-9]\d{9}|\d+\s*(?:号楼|栋|幢|单元|室|门牌)/.test(name)) throw new Error('请只填写小区公共名称，不要填写楼栋、门牌或电话')
      await checkTextSecurity(openid, [name, city, district].join(' '), { scene: 1, label: '新增公共小区申请' })
      const applicationId = 'map_application_' + context.crypto.createHash('sha256').update(`${cityKey}|${nameKey(name)}|${district}`).digest('hex').slice(0, 32)
      // Applications hold public place names only. Never copy the order's home point or doorplate.
      return db.runTransaction(async tx => {
        const current = await readOptionalDocument(tx, 'platform_configs', applicationId)
        if (current?.status === 'resolved') {
          const row = await readOptionalDocument(tx, 'platform_configs', current.serviceCommunityId)
          if (publicCommunity(row)) return { applicationId, status: 'resolved', community: publicCommunity(row) }
          throw new Error('该小区已维护但暂未启用，请联系平台核对')
        }
        if (!current || current.status !== 'pending') await tx.collection('platform_configs').doc(applicationId).set({ data: {
          key: 'map_community_application', name, city, cityKey, district, status: 'pending', createdAt: current?.createdAt || now(), updatedAt: now()
        } })
        return { applicationId, status: 'pending' }
      })
    }
    if (action === 'listAdmin' || action === 'saveAdmin') {
      await requireAdmin(openid)
      await checkRateLimit(openid, `communityMap.${action}`, { max: action === 'saveAdmin' ? 30 : 60 })
      if (action === 'listAdmin') {
        const city = String(data.city || '').trim().slice(0, 40), keyword = String(data.keyword || '').normalize('NFKC').trim().toLowerCase().slice(0, 60)
        const offset = Math.max(0, Math.floor(Number(data.offset) || 0))
        if (data.view === 'pending') {
          const result = await context.readCommunityCandidates(city)
          const list = result.list.filter(row => !keyword || `${row.name} ${row.city}`.normalize('NFKC').toLowerCase().includes(keyword))
          return { list: list.slice(offset, offset + 30), total: list.length, hasMore: offset + 30 < list.length, missingCityCount: result.missingCityCount }
        }
        const single = data.id ? await readOptionalDocument(db, 'platform_configs', String(data.id)) : null
        const list = data.id ? (single?.key === 'service_community' ? [single] : []) : await readDocuments(db, db.command, 'platform_configs', { key: 'service_community',
          ...(city ? { cityKey: context.normalizeCityName(city) } : {}) }, 1001)
        if (list.length > 1000) throw new Error('小区数量超过单次管理上限，请联系管理员分城市维护')
        const rows = list.filter(row => !keyword || [row.name, ...(row.aliases || [])].some(value => String(value).normalize('NFKC').toLowerCase().includes(keyword)))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)) || a._id.localeCompare(b._id)).map(row => ({ _id: row._id, name: row.name, city: row.city, district: row.district || '',
          aliases: row.aliases || [], latitude: row.latitude, longitude: row.longitude, enabled: row.enabled,
          matchRadiusKm: row.matchRadiusKm, revision: row.revision, editVersion: row.editVersion || row.revision || 1 }))
        return data.paginated === true ? { list: rows.slice(offset, offset + 30), total: rows.length, hasMore: offset + 30 < rows.length } : rows
      }
      const name = String(data.name || '').trim(), city = String(data.city || '').trim(), district = String(data.district || '').trim()
      if (!name || name.length > 60 || !city || city.length > 40 || district.length > 40) throw new Error('请填写有效的小区名称、城市和行政区')
      const latitude = Number(data.latitude), longitude = Number(data.longitude)
      if (!hasCoordinate(latitude, longitude) || Math.abs(latitude) > 85) throw new Error('请选择地图支持范围内的小区公共入口或公共中心')
      if (data.confirmPublic !== true) throw new Error('请确认该坐标是小区公共参考点，不是家庭位置')
      const aliases = [...new Set((Array.isArray(data.aliases) ? data.aliases : []).map(v => String(v).trim()).filter(Boolean))]
      if (aliases.length > 20 || aliases.some(v => v.length > 80)) throw new Error('别名最多20项，每项不超过80字')
      const radius = Number(data.matchRadiusKm ?? 1)
      if (!Number.isFinite(radius) || radius < 0.1 || radius > 3) throw new Error('匹配半径应为0.1至3公里')
      const cityKey = context.normalizeCityName(city)
      if (!cityKey) throw new Error('请填写有效的城市名称')
      const applicationIds = [...new Set(Array.isArray(data.applicationIds) ? data.applicationIds : [])].sort()
      if (applicationIds.length > 100 || applicationIds.some(id => !/^map_application_[a-f0-9]{32}$/.test(id))) throw new Error('小区申请编号无效，请刷新后重试')
      if (applicationIds.length && data.enabled !== true) throw new Error('处理新增申请时请启用公共小区')
      const id = data.id || 'map_community_' + context.crypto.createHash('sha256').update(`${cityKey}|${nameKey(name)}|${latitude.toFixed(5)}|${longitude.toFixed(5)}`).digest('hex').slice(0, 24)
      if (!/^map_community_[a-f0-9]{24}$/.test(id)) throw new Error('小区编号无效')
      const patch = { key: 'service_community', name, city, cityKey, district, aliases,
        latitude, longitude, matchRadiusKm: radius, enabled: data.enabled === true }
      const requestId = data.requestId == null ? '' : String(data.requestId)
      if (requestId && !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new Error('保存请求编号无效，请重新打开表单')
      const hash = value => context.crypto.createHash('sha256').update(value).digest('hex')
      const receiptId = requestId ? 'map_community_save_' + hash(`${openid}|${requestId}`).slice(0, 32) : ''
      const fingerprint = hash(JSON.stringify({ id, editVersion: Number(data.editVersion ?? data.revision) || 0, ...patch,
        ...(applicationIds.length ? { applicationIds } : {}) }))
      const completed = receipt => {
        if (!receipt) return false
        if (receipt.key !== 'map_community_save_request' || receipt.fingerprint !== fingerprint) throw new Error('保存内容已变化，请重新确认后提交')
        return true
      }
      if (receiptId && completed(await readOptionalDocument(db, 'platform_configs', receiptId))) return { id }
      const existing = await readOptionalDocument(db, 'platform_configs', id)
      const conflict = !data.id && existing ? '该公共小区已存在，请在已维护小区中编辑'
        : data.id && (!existing || existing.key !== 'service_community') ? '小区不存在'
        : existing && Number(data.editVersion ?? data.revision) !== Number(existing.editVersion || existing.revision || 1) ? '小区已更新，请刷新后重试' : ''
      if (conflict) {
        // The first receipt read may precede a concurrent retry's commit.
        if (receiptId && completed(await readOptionalDocument(db, 'platform_configs', receiptId))) return { id }
        throw new Error(conflict)
      }
      await checkTextSecurity(openid, [name, city, district, ...aliases].join(' '), { scene: 1, label: '公共小区资料' })
      // Validate the city snapshot with document locks; nearby duplicate checks
      // must stay valid until commit, including moves between two cities.
      const cityKeys = [...new Set([cityKey, existing && context.normalizeCityName(existing.city)].filter(Boolean))].sort()
      const locks = cityKeys.map(value => 'map_community_catalog_' + hash(value).slice(0, 24))
      for (let attempt = 0; attempt < 3; attempt++) {
        const versions = []
        for (const lockId of locks) versions.push(Number((await readOptionalDocument(db, 'platform_configs', lockId))?.version || 0))
        const neighbours = await readDocuments(db, db.command, 'platform_configs', { key: 'service_community', cityKey }, 1001)
        if (neighbours.length > 1000 || (neighbours.length >= 1000 && !neighbours.some(row => row._id === id))) throw new Error('当前城市小区数量已达管理上限')
        if (neighbours.some(row => row._id !== id && context.sameCommunityName(name, row) && hasCoordinate(row.latitude, row.longitude) &&
          context.calcDistanceKm(latitude, longitude, row.latitude, row.longitude) < .15)) throw new Error('附近已有同名公共小区，请编辑已有小区，避免重复展示')
        try {
          await db.runTransaction(async tx => {
            if (receiptId && completed(await readOptionalDocument(tx, 'platform_configs', receiptId))) return
            const current = await readOptionalDocument(tx, 'platform_configs', id)
            if (Number(current?.editVersion || current?.revision || 0) !== Number(existing?.editVersion || existing?.revision || 0)) throw new Error('小区已更新，请刷新后重试')
            const applications = []
            for (const applicationId of applicationIds) {
              const application = await readOptionalDocument(tx, 'platform_configs', applicationId)
              if (!application || application.key !== 'map_community_application' || application.cityKey !== cityKey ||
                  (application.status === 'resolved' && application.serviceCommunityId !== id)) throw new Error('小区申请已变化或城市不一致，请刷新核对')
              applications.push(applicationId)
            }
            const linkedApplications = [...new Set([...(current?.applicationIds || []), ...applications])]
            if (linkedApplications.length > 100) throw new Error('关联申请过多，请联系平台核对')
            for (let i = 0; i < locks.length; i++) {
              const lock = await readOptionalDocument(tx, 'platform_configs', locks[i])
              if (Number(lock?.version || 0) !== versions[i]) {
                const error = new Error('小区目录正在更新，请重试'); error.code = 'COMMUNITY_CATALOG_CHANGED'; throw error
              }
            }
            const previousPublic = current && { name: current.name, cityKey: context.normalizeCityName(current.city), district: current.district || '',
              latitude: Number(current.latitude), longitude: Number(current.longitude), enabled: current.enabled === true }
            const publicChanged = !previousPublic || Object.keys(previousPublic).some(field => previousPublic[field] !== patch[field])
            await tx.collection('platform_configs').doc(id).set({ data: { ...patch,
              ...(linkedApplications.length ? { applicationIds: linkedApplications } : {}), updatedAt: now(),
              revision: Number(current?.revision || 0) + (publicChanged ? 1 : 0),
              editVersion: Number(current?.editVersion || current?.revision || 0) + 1, createdAt: current?.createdAt || now() } })
            for (const applicationId of applications) await tx.collection('platform_configs').doc(applicationId).update({ data: {
              status: 'resolved', serviceCommunityId: id, updatedAt: now()
            } })
            for (let i = 0; i < locks.length; i++) await tx.collection('platform_configs').doc(locks[i]).set({ data: {
              key: 'map_community_catalog', cityKey: cityKeys[i], version: versions[i] + 1, updatedAt: now() } })
            if (receiptId) await tx.collection('platform_configs').doc(receiptId).set({ data: {
              key: 'map_community_save_request', fingerprint, communityId: id, createdAt: now() } })
          })
          return { id }
        } catch (error) { if (error.code !== 'COMMUNITY_CATALOG_CHANGED' || attempt === 2) throw error }
      }
    }
    if (action === 'catalog') {
      await checkRateLimit(openid, 'communityMap.catalog', { max: 60 })
      const keyword = String(data.keyword || '').normalize('NFKC').trim().toLowerCase().slice(0, 60)
      let profile = null
      if (data.recommended === true) {
        const user = await getUser(openid)
        if (!user.roles?.includes('staff')) throw new Error('仅宠托师可查看驻点推荐')
        profile = (await db.collection('staff_profiles').where({ openid }).limit(1).get()).data?.[0]
        if (!profile || !hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) || !profile.serviceCity || profile.serviceCity === '服务城市待完善') throw new Error('请先完善固定服务地址及服务城市')
      }
      const rows = await readMapCommunities(String(profile?.serviceCity || data.city || '').trim().slice(0, 40))
      const items = rows.filter(row => (!keyword || [row.name, ...(row.aliases || [])].some(v => String(v).normalize('NFKC').toLowerCase().includes(keyword))) &&
        (!profile || context.calcDistanceKm(profile.serviceLatitude, profile.serviceLongitude, row.latitude, row.longitude) <= Number(row.matchRadiusKm || 1)))
        .sort((a, b) => (profile ? context.calcDistanceKm(profile.serviceLatitude, profile.serviceLongitude, a.latitude, a.longitude) - context.calcDistanceKm(profile.serviceLatitude, profile.serviceLongitude, b.latitude, b.longitude) : 0) || a.name.localeCompare(b.name) || a._id.localeCompare(b._id))
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
      const refreshIds = mapRefreshIds(data.refreshIds)
      await checkRateLimit(openid, 'communityMap.sitters', { max: 40 })
      const city = String(data.city || '').trim().slice(0, 40)
      if (!city) throw new Error('请先选择城市')
      const communities = await readMapCommunities(city)
      const where = { publicMapEnabled: true, serviceCity: context.mapCityCondition(city) }
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
      const visibleRows = refreshIds ? visibleMapRows(accepted, refreshIds) : []
      const enriched = await context.batchWithSitterUserProfiles([...new Map([...pageRows, ...visibleRows].map(row => [row._id, row])).values()])
      const byId = new Map(enriched.map(profile => [profile._id, profile]))
      const toMapSitter = row => {
        const profile = byId.get(row._id)
        return { ...context.toPublicSitter(profile), serviceAddress: nodes.get(profile.publicServiceCommunityId).name,
          publicServiceAddress: nodes.get(profile.publicServiceCommunityId).name,
          canDirectBook: profile.acceptDirectOrders !== false && profile.publicBookingNeedsConfirmation !== true, bookingNeedsContext: true }
      }
      const hasMore = start + pageRows.length < accepted.length
      const last = pageRows[pageRows.length - 1]
      return { communities: [...nodes.values()].filter(row => row.count),
        list: pageRows.map(toMapSitter),
        page, total: accepted.length, hasMore,
        nextCursor: hasMore && last ? `${Number(last.ratingAverage || 0)}|${last._id}` : '', generatedAt: now(),
        ...(refreshIds ? { visibleList: visibleRows.map(toMapSitter) } : {}) }
    }
    if (action === 'listOrders') {
      // Reuse the entire staff pool, including its eligibility and bundle checks, before pagination.
      const handler = require('./staff')(context)
      return handler(openid, 'listOrderMap', data)
    }
    throw new Error('未知小区地图操作')
  }
}
