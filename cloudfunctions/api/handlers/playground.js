module.exports = function createHandler(context) {
  const { db, getUser, safeText } = context
  const worldService = require('../services/playground-world')
  const { placedBuildings, isPublicBuilding } = require('../services/playground-shared/plot-buildings')
  const world = worldService.create(context)
  const shared = require('../services/playground-shared')(context)
  const { publicAppearance } = require('../services/playground-appearance-record')
  const { toCstParts: defaultToCstParts, beijingClockText: defaultBeijingClockText } = require('../utils/time')
  const getToCstParts = context.toCstParts || defaultToCstParts
  const getBeijingClockText = context.beijingClockText || defaultBeijingClockText
  const {
    getOrCreateClientPlayground,
    getOrCreatePetHome,
    getOrCreatePlaygroundEntity
  } = require('../services/playground')(context)

  return async function playground(openid, action, data = {}) {
    const user = await getUser(openid)
    if (action === 'listCommunityGroupBuys') return require('../services/playground-group-buy')(context).list(openid)
    if (action === 'getPublicPetCare') return require('../services/playground-care')(context).publicCare(openid, data)
    if (action === 'syncScene') return shared.sync(openid, data)
    if (action === 'getScene') return shared.snapshot(openid, data)
    if (action === 'vehicleAction') return shared.vehicles.action(openid,user,data)
    if (action === 'setVehicleSpeed') return shared.vehicles.speed(openid,user,data)
    if (action === 'petAction') return shared.companions.action(openid,data)
    if (action === 'petRelief') return shared.companions.relief(openid,data)
    if (action === 'getFarm') return shared.farm.state(openid,data)
    if (action === 'getFarmCatalog') return require('../services/playground-farm-catalog').readCatalog(db)
    if (action === 'farmAction') return shared.farm.action(openid,data)
    if (action === 'rideRequest') return shared.rides.request(openid,data)
    if (action === 'rideRespond') return shared.rides.respond(openid,data)
    if (action === 'rideLeave') return shared.rides.leave(openid,data)
    if (action === 'movePet') return shared.commandPet(openid, data)
    if (action === 'interactPet') return shared.commandPet(openid, {...data,interact:true})
    if (action === 'getSocial') return shared.social.state(openid)
    if (action === 'requestFriend') return shared.social.request(openid,{...data,type:'friend'})
    if (action === 'requestVisit') return shared.social.request(openid,{...data,type:'visit'})
    if (action === 'respondRequest') return shared.social.respond(openid,data)
    if (action === 'removeFriend') return shared.social.removeFriend(openid,data)
    if (action === 'demolishPlot') {
      const old=await world.own(openid)
      const {released,removedPlotIds,...result}=await world.demolish(openid,data,shared.rides.beforeDemolish)
      await shared.publishRecords(released||[])
      const allRemoved = Array.isArray(removedPlotIds) && removedPlotIds.length ? removedPlotIds : [old.plotId]
      for (const pId of allRemoved) {
        await shared.plotChanged(openid, pId, true, old.communityId)
      }
      return result
    }
    const disputes = require('../services/playground-disputes')(context)
    const buildingsService = require('../services/playground-buildings')(context)
    if (action === 'getBuildingCatalog') {
      const catalog = await buildingsService.readCatalog(), access = await require('../services/playground-access').memberAccess(db, openid)
      const { decorate } = require('../services/playground-access')
      // Include the home and occupied gardens: ordinary buildings can be added
      // to either. Complete projections also work before distant chunks load.
      await world.own(openid)
      const buildablePlots = []
      let cursor = ''
      do {
        const query = { kind: 'plot', ownerOpenid: openid, ...(data.sceneId ? { communityId: data.sceneId } : {}), ...(cursor ? { _id: db.command.gt(cursor) } : {}) }
        const page = (await db.collection('pet_playground_plots').where(query).orderBy('_id', 'asc').limit(100).get()).data || []
        buildablePlots.push(...page.filter((p) => !p.demolished).map((p) => world.publicPlot(p, openid)))
        cursor = page.length === 100 ? page[page.length - 1]._id : ''
      } while (cursor)
      const emptyPlots = buildablePlots.filter((p) => p.isNewPlot && !placedBuildings(p).some(isPublicBuilding))
      return {
        ...catalog,
        buildings: catalog.buildings.map((b) => decorate(b, access)),
        plotSizes: catalog.plotSizes.map((p) => decorate(p, access)),
        memberLevelName: access.memberLevelName,
        emptyPlots,
        buildablePlots
      }
    }
    if (action === 'reportPoop') return disputes.reportPoop(openid, user, data)
    if (action === 'listDisputes') return disputes.listDisputes(openid, data)
    if (action === 'resolveDispute') {
      const {record,...result}=await disputes.resolveDispute(openid,user,data)
      if(record)await shared.publishRecords([record])
      return result
    }
    if (action === 'claimWeeklySalary') return disputes.claimWeeklySalary(openid, data)
    if (action === 'washVehicle') {
      const {record,...result}=await disputes.washVehicle(openid,user,data)
      if(record)await shared.publishRecords([record])
      return result
    }
    if (action === 'repairVehicle') {
      const {record,...result}=await disputes.repairVehicle(openid, user, data)
      if(record)await shared.publishRecords([record])
      return result
    }
    const justice = require('../services/playground-justice')(context)
    if (action === 'reportAccident') return justice.reportAccident(openid, user, data)
    if (action === 'listAccidents') return justice.listAccidents(openid, data)
    if (action === 'arrestDriver') return justice.arrestDriver(openid, user, data)
    if (action === 'releaseDriver') return justice.releaseDriver(openid, data)
    if (action === 'hospitalTreat') return justice.hospitalTreat(openid, user, data)

    if (action === 'hospitalCare') {
      const careType = data.careType === 'treat' ? 'treat' : 'wash'
      const petId = String(data.petId || '')
      // 更新爱宠的健康或洗护状态并持久化，同时同步实时场景
      await db.collection('pet_playground_plots').where({ kind: 'resident', ownerOpenid: openid }).get().then(async (res) => {
        const published = []
        for (const doc of (res.data || [])) {
          const stamp = Date.now()
          const pets = (doc.pets || []).map((p) => {
            if (!petId || p.id === petId || p._id === petId) {
              if (careType === 'treat') {
                return {
                  ...p,
                  sick: false,
                  injured: false,
                  sickReason: '',
                  needs: { ...(p.needs || {}), satiety: 100, hydration: 100, energy: 100 }
                }
              } else {
                return {
                  ...p,
                  needs: { ...(p.needs || {}), energy: 100, pee: 0, poop: 0 }
                }
              }
            }
            return p
          })
          const updated = { ...doc, pets, revision: Math.max(stamp, (doc.revision || 0) + 1) }
          const { _id, ...cleanDoc } = updated
          await db.collection('pet_playground_plots').doc(doc._id).set({ data: cleanDoc })
          published.push(updated)
        }
        if (published.length) await shared.publishRecords(published)
      }).catch(() => {})
      const sceneId = String(data.sceneId || '')
      let bonusMsg = ''
      if (sceneId) {
        try {
          const hospitalRes = await db.collection('pet_playground_plots').where({ kind: 'plot', communityId: sceneId, buildingType: 'pet_hospital' }).get()
          const hospital = (hospitalRes.data || []).find((p) => !p.demolished)
          if (hospital && hospital.ownerOpenid && hospital.ownerOpenid !== openid) {
            const userRes = await db.collection('users').where({ openid: hospital.ownerOpenid }).limit(1).get()
            const targetUser = (userRes.data || [])[0]
            if (targetUser) {
              await db.collection('users').doc(targetUser._id).update({
                data: {
                  playgroundCoins: (targetUser.playgroundCoins || 0) + 15
                }
              })
              bonusMsg = '，已向爱心医院主理人发放 15 爱心币调理津贴'
            }
          }
        } catch (_) {}
      }
      return {
        success: true,
        careType,
        message: careType === 'wash'
          ? `爱宠在宠物医院完成了精细洗护，毛发柔顺蓬松，洁净清爽${bonusMsg}！`
          : `爱宠在宠物医院完成了健康治疗与创伤恢复，生病状态已治愈，状态满格${bonusMsg}！`
      }
    }

    if (action === 'buildInYard') {
      if (data.buildingType === 'committee') {
        const existing = await disputes.getCommunityCommittee(data.sceneId)
        if (existing && existing.ownerOpenid !== openid) {
          throw new Error('当前社区已设立居委会，每个社区有且仅能有一个居委会')
        }
      }
      const plot = await world.buildInYard(openid, user, data)
      await shared.plotChanged(openid, plot.id)
      return { plot }
    }

    if (action === 'dismantleBuilding') {
      const result = await world.dismantleBuilding(openid, user, data)
      await shared.plotChanged(openid, result.plotId)
      return result
    }

    if (action === 'relocateBuilding') {
      const plot = await world.relocateBuilding(openid, user, data)
      await shared.plotChanged(openid, plot.id)
      return { plot }
    }

    if (action === 'claimPlot') {
      if (data.buildingType === 'committee') {
        const existing = await disputes.getCommunityCommittee(data.sceneId)
        if (existing && existing.ownerOpenid !== openid) {
          throw new Error('当前社区已设立居委会，每个社区有且仅能有一个居委会')
        }
      }
      const old=await world.own(openid),plot=await world.claim(openid,user,data)
      if(!data.isNewPlot && old && old.plotId !== plot.id) await shared.plotChanged(openid,old.plotId,true,old.communityId)
      await shared.plotChanged(openid,plot.id)
      return {plot}
    }
    if (action === 'getRegion') return world.region(openid, user, data)
    if (action === 'getMapOverview') return world.mapOverview(openid, user, data)
    if (action === 'fillBowl') {
      const result = await world.fillBowl(openid, data)
      await shared.plotChanged(openid, data.plotId)
      let pointsAwarded = 0
      let message = '猫狗碗的粮食已添满'
      if (typeof context.addPoints === 'function' && user && user._id) {
        const todayDateKey = getToCstParts(new Date(context.nowMs ? context.nowMs() : Date.now())).dateKey
        try {
          const pointRes = await context.addPoints(
            openid,
            user._id,
            5,
            'playground_care',
            `${openid}_${todayDateKey}`,
            '爱宠空间-每日关爱添粮照料打卡',
            { idempotencyKey: `playground_care_${openid}_${todayDateKey}` }
          )
          if (!pointRes.duplicate && pointRes.delta > 0) {
            pointsAwarded = pointRes.delta
            message = `食盆已添满！获得每日关爱打卡 +${pointsAwarded} 积分`
          }
        } catch (e) {}
      }
      if (pointsAwarded > 0) {
        return { ...result, pointsAwarded, message }
      }
      return result
    }

    if (action === 'getServiceTwinInfo') {
      const EVENT_NAME_MAP = {
        sanitization: '进门消毒',
        enter_door: '进入家门',
        leash_on: '佩戴牵引绳',
        pet_status: '毛孩子状态',
        return_home: '安全回到家',
        leave_door: '确认离家',
        feed: '添加粮食',
        food: '添加粮食',
        water: '更换饮水',
        litter: '清理猫砂',
        clean: '现场清洁',
        medicine: '喂药照护',
        play: '陪伴玩耍',
        pet_beauty_photo: '毛孩子美照'
      }

      const EVENT_EMOJI_MAP = {
        feed: '🥣',
        food: '🥣',
        water: '💧',
        litter: '🧹',
        clean: '🧹',
        play: '🎾',
        medicine: '💊',
        sanitization: '🧴',
        enter_door: '🚪',
        leave_door: '🚪',
        return_home: '🏠',
        leash_on: '🦮',
        pet_status: '🐾',
        pet_beauty_photo: '📷'
      }

      let activeOrder = null
      try {
        const orderRes = await db.collection('orders')
          .where({ clientOpenid: openid, status: 'in_service' })
          .limit(5)
          .get()
        const orderList = orderRes.data || []
        // 内存中按时间倒序排序，避免云开发因缺少复合索引而报错
        orderList.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime())
        const order = orderList[0]
        if (order) {
          activeOrder = {
            id: order._id,
            orderNo: order.orderNo,
            serviceType: order.serviceSummary || order.serviceType || '上门照料',
            staffName: (order.staffSnapshot && (order.staffSnapshot.name || order.staffSnapshot.nickname)) || '认证宠托师',
            staffAvatar: (order.staffSnapshot && order.staffSnapshot.avatarUrl) || '',
            staffPhone: (order.staffSnapshot && order.staffSnapshot.phone) || '',
            status: order.status,
            startedAt: order.serviceStartDate || order.updatedAt
          }
        }
      } catch (e) {}

      let latestCheckins = []
      try {
        let targetOrderId = activeOrder ? activeOrder.id : ''
        if (!targetOrderId) {
          const recentOrders = await db.collection('orders')
            .where({ clientOpenid: openid })
            .limit(6)
            .get()
          const rawOrders = recentOrders.data || []
          rawOrders.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
          const completedOrder = rawOrders.find((o) => ['completed', 'day_completed', 'in_service'].includes(o.status))
          if (completedOrder) targetOrderId = completedOrder._id
        }
        if (targetOrderId) {
          const checkinRes = await db.collection('checkin_logs')
            .where({ orderId: targetOrderId })
            .limit(20)
            .get()
          // 过滤掉已软删除的打卡日志，并在内存中排序，防止缺少复合索引抛错
          const validLogs = (checkinRes.data || []).filter((c) => !c.deletedAt)
          validLogs.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())

          latestCheckins = validLogs.slice(0, 8).map((c) => {
            const eventType = c.eventType || 'checkin'
            const emoji = EVENT_EMOJI_MAP[eventType] || '📷'
            const label = EVENT_NAME_MAP[eventType] || '上门照料'
            return {
              id: c._id,
              eventType,
              eventLabel: `${emoji} ${label}`,
              mediaFileId: c.mediaFileId || c.fileId || '',
              remark: c.checkinRemark || c.remark || '',
              time: c.createdAt ? getBeijingClockText(c.createdAt) : ''
            }
          })
        }
      } catch (e) {}

      let bowlAutoRefilled = false
      if (latestCheckins.some((c) => ['food', 'water', 'feed'].includes(c.eventType))) {
        bowlAutoRefilled = true
      }

      return {
        hasActiveService: Boolean(activeOrder),
        activeOrder,
        latestCheckins,
        bowlAutoRefilled
      }
    }

    if (action === 'getMallSupplies') {
      let products = []
      try {
        const res = await db.collection('mall_products')
          .where({ status: 'on_sale' })
          .limit(12)
          .get()
        const rawList = res.data || []
        // 在内存排序，避免在没有创建 salesCount 数据库索引时抛出错误
        rawList.sort((a, b) => Number(b.salesCount || 0) - Number(a.salesCount || 0))
        products = rawList.slice(0, 6).map((p) => ({
          id: p._id,
          name: p.name,
          price: p.price,
          originalPrice: p.originalPrice || p.price,
          coverUrl: p.coverUrl || (Array.isArray(p.images) ? p.images[0] : '') || '',
          summary: p.summary || p.desc || '精选优质宠粮',
          salesCount: p.salesCount || 0,
          pointsDeductible: true,
          pointsDeduction: Math.min(20, Math.max(5, Math.floor((p.price || 0) * 0.1))),
          maxPointsDiscount: Math.min(20, Math.floor((p.price || 0) * 0.2))
        }))
      } catch (e) {}
      return { products }
    }

    if (action === 'getCommunityGroupBuy') {
      const groups = await require('../services/playground-group-buy')(context).list(openid)
      const userCommunity = (user && user.residentialCommunity) || null
      const communityName = (typeof userCommunity === 'string' ? userCommunity : (userCommunity && userCommunity.name)) ||
        (data && data.community && (typeof data.community === 'string' ? data.community : data.community.name)) ||
        '当前社区'
      let sitters = []
      try {
        const rawStaff = []
        let cursor = ''
        do {
          // Scan by the built-in id index; local sitters may be beyond the first page.
          const page = (await db.collection('staff_profiles').where(cursor ? { _id: db.command.gt(cursor) } : {}).orderBy('_id','asc').limit(100).get()).data || []
          const approved = page.filter((s) => s.auditStatus === 'approved' && s.openid && !s.deletedAt && !s.revokedAt)
          const owners = [...new Set(approved.map((s) => s.openid))]
          const residents = []
          for (let i = 0; i < owners.length; i += 50) residents.push(...(await db.collection('users').where({openid:db.command.in(owners.slice(i,i+50))}).limit(100).get()).data || [])
          for (const staff of approved) {
            const resident = residents.find((r) => r.openid === staff.openid), community = resident && resident.residentialCommunity
            if (!community || worldService.communityId({residentialCommunity:typeof community==='string'?{name:community}:community}) !== groups.communityId) continue
            const publicStaff = typeof context.toPublicSitter === 'function' ? context.toPublicSitter({...staff,userProfile:resident}) : {}
            rawStaff.push({...staff,...publicStaff,nickname:publicStaff.displayName||publicStaff.name||resident.nickname||staff.nickname||'认证宠托师'})
          }
          cursor = page.length === 100 ? page[page.length - 1]._id : ''
        } while (cursor)
        // 在内存按评分排序，避免远程复合索引缺失
        rawStaff.sort((a, b) => Number(b.ratingAverage || b.rating || 0) - Number(a.ratingAverage || a.rating || 0))
        sitters = rawStaff.slice(0, 3).map((s) => ({
          id: s._id,
          name: s.nickname || s.name || '认证宠托师',
          avatarUrl: s.avatarUrl || '',
          rating: Number(s.ratingAverage || s.rating || 0).toFixed(1),
          orderCount: s.orderCount || s.completedOrders || 0,
          specialties: Array.isArray(s.specialties) ? s.specialties.slice(0, 3) : (s.publicTags || []).slice(0, 3)
        }))
      } catch (e) {}

      return {
        ...groups,
        communityName: groups.communityName || communityName,
        groupBuyDiscount: `${groups.rules.waiveVisitFee ? '同小区拼单免路费 · ' : ''}满${groups.rules.minHouseholds}户享${Number((groups.rules.discountRate * 10).toFixed(2))}折`,
        groupBuyRule: `仅限本人所属小区，特惠预付满${groups.rules.minHouseholds}户成团，优惠不与优惠券叠加。凑齐户数立即成团并安排抢单；未成团或服务前2小时无人接单全额原路退款。`,
        sitters
      }
    }

    if (action === 'getPlaygroundRewards') {
      const userDoc = user && user._id ? (await db.collection('users').doc(user._id).get().catch(() => ({ data: {} }))).data || user : (user || {})
      const memberLevelKey = userDoc.memberLevel || 'bronze'
      let memberLevelName = '普通会员'
      try {
        const levelDoc = (await db.collection('member_levels').doc(memberLevelKey).get().catch(() => ({ data: {} }))).data
        if (levelDoc && levelDoc.name) memberLevelName = levelDoc.name
      } catch (e) {}

      let exchangeableCoupons = []
      try {
        const couponRes = await db.collection('coupon_templates')
          .where({ status: 'active' })
          .limit(4)
          .get()
        exchangeableCoupons = (couponRes.data || []).map((c) => ({
          id: c._id,
          name: c.name,
          discountAmount: c.discountAmount,
          minSpend: c.minSpend || 0,
          requiredPoints: Math.max(50, (c.discountAmount || 5) * 10),
          type: c.type || 'service'
        }))
      } catch (e) {}

      return {
        points: Number(userDoc.points || 0),
        memberLevel: memberLevelKey,
        memberLevelName,
        exchangeableCoupons
      }
    }

    if (action === 'exchangeCoupon') {
      if (!user || !user._id) throw new Error('请先登录后操作')
      const templateId = String(data.templateId || '').trim()
      if (!templateId) throw new Error('请选择要兑换的优惠券')
      const templateDoc = await db.collection('coupon_templates').doc(templateId).get().catch(() => null)
      const templateRaw = templateDoc && templateDoc.data
      if (!templateRaw || templateRaw.status !== 'active' || templateRaw.enabled === false) {
        throw new Error('该优惠券暂不可兑换或已下架')
      }
      const template = { ...templateRaw, _id: templateRaw._id || templateId }

      const requiredPoints = Math.max(50, Number(template.discountAmount || 5) * 10)
      const userDoc = (await db.collection('users').doc(user._id).get().catch(() => ({ data: {} }))).data || user
      if (Number(userDoc.points || 0) < requiredPoints) {
        throw new Error(`积分不足，兑换该券需要 ${requiredPoints} 积分（当前可用 ${userDoc.points || 0} 积分）`)
      }

      // 必须先安全发券（内部会校验库存与每人上限），确保不会出现扣了积分但发券失败的情况
      if (typeof context.issueCouponToTargetUser === 'function') {
        await context.issueCouponToTargetUser(template, user, {
          sourceType: 'playground_exchange',
          sourceId: templateId
        })
      }

      // 发券成功后再扣减积分
      if (typeof context.addPoints === 'function') {
        try {
          await context.addPoints(
            openid,
            user._id,
            -requiredPoints,
            'coupon_exchange',
            `${templateId}_${Date.now()}`,
            `关爱积分兑换优惠券【${template.name}】`
          )
        } catch (pointErr) {
          console.error('[exchangeCoupon] deduct points error:', pointErr)
        }
      }

      return { success: true, message: `成功消耗 ${requiredPoints} 积分兑换【${template.name}】！` }
    }

    if (action === 'setPetScale') {
      const petId = typeof data.petId === 'string' ? data.petId.trim() : ''
      const scale = data.scale
      if (!petId || typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.5 || scale > 2)
        throw new Error('宠物大小须在 50%～200% 之间')
      const result = await db.collection('pets').where({ _id: petId, openid }).get()
      const pet = (result.data || [])[0]
      if (!pet || pet.deletedAt) throw new Error('宠物不存在或无权修改')
      const playgroundScale = Math.round(scale * 100) / 100
      await db.collection('pets').where({ _id: petId, openid }).update({
        data: { playgroundScale }
      })
      await shared.petScale(openid, petId, playgroundScale)
      return { petId, scale: playgroundScale }
    }

    if (action === 'saveCommunity') {
      const community = data.community || null
      let normalizedCommunity = null
      if (community && community.name) {
        normalizedCommunity = {
          name: safeText(community.name).trim(),
          address: safeText(community.address || '').trim(),
          latitude: Number(community.latitude || 0),
          longitude: Number(community.longitude || 0),
          city: safeText(community.city || '').trim(),
          district: safeText(community.district || '').trim(),
          updatedAt: context.nowText
            ? context.nowText()
            : new Date().toISOString()
        }
      }
      await worldService.updateCommunity(
        db,
        openid,
        user._id,
        normalizedCommunity,
        {
          updatedAt: context.nowText
            ? context.nowText()
            : new Date().toISOString()
        }
      )
      return { residentialCommunity: normalizedCommunity }
    }

    if (action !== 'getOverview' && action !== 'enterScene') throw new Error('未知 playground 操作')

    const playground = await getOrCreateClientPlayground(openid)
    const petRes = await db
      .collection('pets')
      .where({ openid })
      .orderBy('createdAt', 'desc')
      .get()
    const pets = (petRes.data || [])
      .filter(
        (pet) => !pet.deletedAt && ['cat', 'dog'].includes(pet.species || 'dog')
      )
      .slice(0, Number(playground.maxVisiblePets || 8))
    const homes = []
    const entities = []

    for (let index = 0; index < pets.length; index += 1) {
      const pet = pets[index]
      const home = await getOrCreatePetHome(openid, playground._id, pet, index)
      const entity = await getOrCreatePlaygroundEntity(
        openid,
        playground._id,
        pet,
        home,
        index
      )
      homes.push(home)
      entities.push(entity)
    }

    const scene = action === 'enterScene' ? await shared.enter(openid, user, data, pets) : null
    const userCommunity = scene ? scene.community : user.residentialCommunity || null
    const communityName =
      userCommunity && userCommunity.name
        ? String(userCommunity.name).trim()
        : ''
    const hasCommunity = Boolean(communityName)
    const neighbors = []
    const ownPlot = await world.own(openid)

    const member=await require('../services/playground-access').memberAccess(db,openid)
    let activeService = null
    try {
      const activeOrderRes = await db.collection('orders')
        .where({ clientOpenid: openid, status: 'in_service' })
        .orderBy('updatedAt', 'desc')
        .limit(1)
        .get()
      const aOrder = (activeOrderRes.data || [])[0]
      if (aOrder) {
        activeService = {
          orderId: aOrder._id,
          orderNo: aOrder.orderNo,
          serviceType: aOrder.serviceSummary || aOrder.serviceType || '上门照料',
          staffName: (aOrder.staffSnapshot && (aOrder.staffSnapshot.name || aOrder.staffSnapshot.nickname)) || '认证宠托师'
        }
      }
    } catch (e) {}

    return {
      activeService,
      world: {...await world.config(),plotSizes:(await buildingsService.readCatalog()).plotSizes.map((p)=>require('../services/playground-access').decorate(p,member))},
      farmCatalog: await require('../services/playground-farm-catalog').readCatalog(db),
      scene,
      plot: scene ? scene.plot : ownPlot ? world.publicPlot({ ...ownPlot, _id: ownPlot.plotId }, openid) : null,
      foodBowls: { dog: Number(ownPlot&&ownPlot.foodBowls&&ownPlot.foodBowls.dog)||0, cat:Number(ownPlot&&ownPlot.foodBowls&&ownPlot.foodBowls.cat)||0 },
      playground,
      userCommunity,
      hasCommunity,
      neighbors,
      pets: pets.map((pet) => ({
        _id: pet._id,
        name: safeText(pet.name),
        species: pet.species === 'cat' ? 'cat' : 'dog',
        appearance:publicAppearance(pet.playgroundAppearance,'pet',pet._id,openid),
        playgroundScale: Math.max(0.5, Math.min(2, Number(pet.playgroundScale) || 1)),
        breed: safeText(pet.breed),
        avatarFileId: safeText(pet.avatarFileId),
        personality: safeText(pet.personality),
        gender: safeText(pet.gender)
      })),
      homes,
      entities,
      defaults: {
        theme: playground.theme || 'sunny_garden',
        maxVisiblePets: Number(playground.maxVisiblePets || 8)
      }
    }
  }
}
