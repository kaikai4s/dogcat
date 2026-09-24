module.exports = function createHandler(context) {
  const {
    addPoints,
    cstTodayStart,
    db,
    getUser,
    getCouponValidRange,
    incUpdateValue,
    normalizeCouponSnapshot,
    now,
    safeText,
    titleSnapshot,
    toCstParts,
    getPetTitle,
    resolvePetBlessing
  } = context
  return async function lottery(openid, action, data) {
    if (action === 'getActiveActivity') {
      // 不要求登录，首页可公开展示活动信息；已登录时返回今日剩余抽奖次数
      const res = await db.collection('lottery_activities').where({ enabled: true }).limit(1).get()
      const activity = res.data[0] || null
      if (!activity) return null

      let remainingDrawCount = openid ? 1 : 0
      if (openid) {
        const time = now()
        const { dateKey } = toCstParts(time)
        const recordId = `lottery_${activity._id}_${openid}_${dateKey}`

        let hasRecord = false
        try {
          const rec = await db.collection('lottery_records').doc(recordId).get()
          if (rec && rec.data && rec.data.status !== 'failed') {
            hasRecord = true
          }
        } catch (e) {
          hasRecord = false
        }

        if (!hasRecord) {
          const todayStart = cstTodayStart()
          const todayRecord = await db.collection('lottery_records')
            .where({ openid, activityId: activity._id })
            .orderBy('createdAt', 'desc')
            .limit(1)
            .get()
          if (todayRecord.data[0] && new Date(todayRecord.data[0].createdAt).getTime() >= todayStart.getTime()) {
            hasRecord = true
          }
        }

        if (hasRecord) {
          remainingDrawCount = 0
        }
      }

      return {
        _id: activity._id,
        name: activity.name,
        description: activity.description || '',
        prizeCount: (activity.prizes || []).length,
        remainingDrawCount,
        canDraw: remainingDrawCount > 0
      }
    }
    if (action === 'listMyRecords') {
      const user = await getUser(openid)
      const pageSize = Math.min(Math.max(Math.round(Number(data.pageSize || 20)), 1), 50)
      const records = await db.collection('lottery_records')
        .where({ openid: user.openid || openid })
        .orderBy('createdAt', 'desc')
        .limit(pageSize)
        .get()
      return (records.data || [])
        .filter((item) => item.status !== 'failed')
        .map((item) => {
          const prizeType = item.prizeType || (item.couponId ? 'coupon' : (Number(item.points) > 0 ? 'points' : 'text'))
          let prizeName = item.prizeName || '谢谢参与'
          let prizeText = safeText(item.prizeText || (item.prizeSnapshot && item.prizeSnapshot.text) || '').trim()
          if (prizeType === 'text') {
            const resolved = resolvePetBlessing({
              name: prizeName,
              text: prizeText,
              snapshot: item.prizeSnapshot
            })
            prizeName = resolved.name
            prizeText = resolved.text
          } else {
            prizeText = ''
          }
          return {
            _id: item._id,
            activityId: item.activityId || '',
            prizeType,
            prizeName,
            prizeText,
            points: Number(item.points || 0),
            couponId: item.couponId || '',
            titleId: item.titleId || '',
            rewardMailId: item.rewardMailId || '',
            createdAt: item.createdAt || ''
          }
        })
    }
    if (action === 'draw') {
      const user = await getUser(openid)
      const activityRes = await db.collection('lottery_activities').where({ enabled: true }).limit(1).get()
      const activity = activityRes.data[0]
      if (!activity) throw new Error('当前没有进行中的抽奖活动')

      const time = now()
      const { dateKey } = toCstParts(time)
      const recordId = `lottery_${activity._id}_${openid}_${dateKey}`

      // 1. 检查今日是否已抽过
      let existingRecord = null
      try {
        const rec = await db.collection('lottery_records').doc(recordId).get()
        existingRecord = rec && rec.data ? rec.data : null
      } catch (e) {
        existingRecord = null
      }

      if (existingRecord) {
        if (existingRecord.status === 'completed') {
          throw new Error('今天已参与过本次抽奖')
        }
      } else {
        const todayStart = cstTodayStart()
        const todayRecord = await db.collection('lottery_records')
          .where({ openid, activityId: activity._id })
          .orderBy('createdAt', 'desc').limit(1).get()
        if (todayRecord.data[0] && new Date(todayRecord.data[0].createdAt).getTime() >= todayStart.getTime()) {
          throw new Error('今天已参与过本次抽奖')
        }
      }

      let drawContext = null

      if (!existingRecord) {
        // 2. 事务并发控制：原子占位抽奖记录并扣减奖品库存
        drawContext = await db.runTransaction(async (tx) => {
          let txRecord = null
          try {
            const rec = await tx.collection('lottery_records').doc(recordId).get()
            txRecord = rec && rec.data ? rec.data : null
          } catch (e) {
            txRecord = null
          }
          if (txRecord) {
            throw new Error('今天已参与过本次抽奖')
          }

          const freshActivity = (await tx.collection('lottery_activities').doc(activity._id).get()).data
          if (!freshActivity || freshActivity.enabled === false) {
            throw new Error('当前没有进行中的抽奖活动')
          }

          const prizes = freshActivity.prizes || []
          const availablePrizes = prizes
            .map((p, index) => ({ ...p, _originalIndex: index }))
            .filter((p) => Number(p.stockLeft || 0) > 0)

          if (!availablePrizes.length) {
            throw new Error('奖品已被领完')
          }

          // 按概率随机抽取
          const totalProb = availablePrizes.reduce((sum, p) => sum + Number(p.probability || 0), 0)
          const rand = Math.random() * (totalProb > 0 ? totalProb : availablePrizes.length)
          let cumulative = 0
          let selected = availablePrizes[availablePrizes.length - 1]
          for (let i = 0; i < availablePrizes.length; i++) {
            cumulative += Number(availablePrizes[i].probability || 0)
            if (rand <= cumulative) {
              selected = availablePrizes[i]
              break
            }
          }

          // 定位库存扣减位置（优先按稳定奖品 id 匹配，fallback 按原始数组索引）
          let targetIndex = -1
          const prizeStableId = selected.id || selected._id
          if (prizeStableId) {
            targetIndex = prizes.findIndex((p) => (p.id || p._id) === prizeStableId && Number(p.stockLeft || 0) > 0)
          }
          if (targetIndex === -1) {
            targetIndex = selected._originalIndex
          }

          const currentStock = Number(prizes[targetIndex]?.stockLeft || 0)
          if (currentStock <= 0) {
            throw new Error('奖品已被领完')
          }

          const updatedPrizes = prizes.map((p, i) =>
            i === targetIndex ? { ...p, stockLeft: Math.max(currentStock - 1, 0) } : p
          )
          await tx.collection('lottery_activities').doc(activity._id).update({
            data: { prizes: updatedPrizes, updatedAt: time }
          })

          const prizeType = selected.type || (selected.templateId ? 'coupon' : (selected.titleId ? 'pet_title' : (Number(selected.points) > 0 ? 'points' : 'text')))
          let tentativePrizeName = safeText(selected.name).trim()
          let prizeText = ''
          if (prizeType === 'text') {
            const resolved = resolvePetBlessing(selected)
            tentativePrizeName = tentativePrizeName || resolved.name
            prizeText = resolved.text
          } else {
            if (!tentativePrizeName) {
              if (prizeType === 'points') tentativePrizeName = `${Math.max(Math.round(Number(selected.points || 0)), 0)} 积分`
              else tentativePrizeName = '谢谢参与'
            }
          }

          const recordData = {
            userId: user._id,
            openid,
            activityId: activity._id,
            dateKey,
            status: 'pending',
            prizeType,
            prizeTemplateId: selected.templateId || '',
            prizeTitleId: selected.titleId || '',
            prizeName: tentativePrizeName,
            prizeText,
            points: 0,
            couponId: '',
            titleId: selected.titleId || '',
            rewardMailId: '',
            prizeSnapshot: {
              ...selected,
              _originalIndex: undefined
            },
            createdAt: time,
            updatedAt: time
          }

          // 微信云数据库 doc.set 的 data 中不可携带 _id 字段，否则会报错 -501007 不能更新_id的值
          const { _id, ...cleanRecordData } = recordData
          await tx.collection('lottery_records').doc(recordId).set({
            data: cleanRecordData
          })

          return {
            recordId,
            selectedPrize: selected,
            prizeType,
            tentativePrizeName,
            prizeText
          }
        })
      } else {
        // 从已占位的 pending 记录恢复
        const snapshot = existingRecord.prizeSnapshot || {}
        const prizeType = existingRecord.prizeType || snapshot.type || (snapshot.templateId ? 'coupon' : (snapshot.titleId ? 'pet_title' : (Number(snapshot.points) > 0 ? 'points' : 'text')))
        let tentativePrizeName = existingRecord.prizeName || snapshot.name || ''
        let prizeText = existingRecord.prizeText || snapshot.text || ''
        if (prizeType === 'text') {
          const resolved = resolvePetBlessing({ name: tentativePrizeName, text: prizeText, snapshot })
          tentativePrizeName = resolved.name
          prizeText = resolved.text
        }
        drawContext = {
          recordId,
          selectedPrize: snapshot,
          prizeType,
          tentativePrizeName,
          prizeText
        }
      }

      const { selectedPrize, prizeType, tentativePrizeName, prizeText } = drawContext
      let couponId = ''
      let templateSnapshot = null
      let pointsAwarded = 0
      let rewardMailId = ''
      let titleId = ''
      let petTitleSnapshot = null
      let finalPrizeName = tentativePrizeName

      // 3. 履约发奖（添加幂等 key）
      if (prizeType === 'coupon' && selectedPrize.templateId) {
        const existingCoupon = (await db.collection('user_coupons').where({
          openid,
          lotteryRecordId: recordId
        }).limit(1).get()).data[0]

        if (existingCoupon) {
          couponId = existingCoupon._id
          templateSnapshot = existingCoupon.templateSnapshot || null
        } else {
          const templateRes = await db.collection('coupon_templates').doc(selectedPrize.templateId).get().catch(() => ({ data: null }))
          const template = templateRes && templateRes.data
          if (template && template.enabled !== false) {
            templateSnapshot = normalizeCouponSnapshot(template)
            const { validFrom, validTo } = getCouponValidRange(template, time)
            const coupon = await db.collection('user_coupons').add({
              data: {
                templateId: selectedPrize.templateId,
                templateSnapshot,
                userId: user._id,
                openid,
                status: 'available',
                validFrom,
                validTo,
                lockedOrderId: '',
                lockedAt: null,
                usedOrderId: '',
                usedAt: null,
                sourceType: 'lottery',
                sourceId: recordId,
                lotteryRecordId: recordId,
                idempotencyKey: recordId,
                issuedAt: time,
                createdAt: time,
                updatedAt: time
              }
            })
            couponId = coupon._id
            await db.collection('coupon_templates').doc(selectedPrize.templateId).update({
              data: { issuedCount: incUpdateValue(template.issuedCount, 1), updatedAt: time }
            })
          }
        }
      } else if (prizeType === 'points') {
        pointsAwarded = Math.max(Math.round(Number(selectedPrize.points || 0)), 0)
        if (pointsAwarded > 0) {
          const existingPointLog = (await db.collection('point_logs').where({
            openid,
            idempotencyKey: recordId
          }).limit(1).get()).data[0]

          if (!existingPointLog) {
            await addPoints(
              openid,
              user._id,
              pointsAwarded,
              'lottery_reward',
              activity._id,
              `抽奖活动【${activity.name}】获得 ${pointsAwarded} 积分`,
              { idempotencyKey: recordId, lotteryRecordId: recordId }
            )
          }
        }
      } else if (prizeType === 'pet_title') {
        titleId = safeText(selectedPrize.titleId).trim()
        let petTitle = null
        try {
          petTitle = await getPetTitle(titleId, { includeDeleted: true })
        } catch (e) {
          petTitle = null
        }
        if (petTitle && !petTitle.deletedAt && petTitle.enabled !== false) {
          petTitleSnapshot = selectedPrize.titleSnapshot || titleSnapshot(petTitle)
          const existingMail = (await db.collection('reward_mails').where({
            openid,
            lotteryRecordId: recordId
          }).limit(1).get()).data[0]

          if (existingMail) {
            rewardMailId = existingMail._id
          } else {
            const mail = await db.collection('reward_mails').add({
              data: {
                userId: user._id,
                openid,
                title: `抽奖获得宠物头衔【${petTitle.name}】`,
                content: `你在抽奖活动【${activity.name}】中获得宠物头衔【${petTitle.name}】，请领取后为宠物佩戴。`,
                targetType: 'lottery',
                targetOpenids: [openid],
                targetRole: '',
                targetLevelIds: [],
                targetLevelNamesSnapshot: [],
                reward: { type: 'pet_title', titleId, titleSnapshot: petTitleSnapshot, duplicatePoints: petTitleSnapshot.duplicatePoints },
                sourceType: 'lottery',
                sourceId: recordId,
                lotteryRecordId: recordId,
                idempotencyKey: recordId,
                sentByAdminUserId: '',
                sentByAdminOpenid: '',
                readAt: null,
                claimedAt: null,
                rewardClaimResult: {},
                createdAt: time,
                updatedAt: time
              }
            })
            rewardMailId = mail._id
          }
        } else {
          pointsAwarded = 20
          finalPrizeName = `${finalPrizeName}（已折算20积分）`
          const compKey = `${recordId}_title_comp`
          const existingCompLog = (await db.collection('point_logs').where({
            openid,
            idempotencyKey: compKey
          }).limit(1).get()).data[0]

          if (!existingCompLog) {
            await addPoints(
              openid,
              user._id,
              pointsAwarded,
              'lottery_reward',
              activity._id,
              `抽奖活动【${activity.name}】头衔失效补偿 20 积分`,
              { idempotencyKey: compKey, lotteryRecordId: recordId }
            )
          }
        }
      }

      if (!finalPrizeName) {
        if (prizeType === 'text') {
          finalPrizeName = tentativePrizeName || '谢谢参与'
        } else {
          finalPrizeName = selectedPrize.name || (prizeType === 'points' ? `${pointsAwarded} 积分` : '谢谢参与')
        }
      }

      // 4. 履约完成，更新抽奖记录为 completed
      await db.collection('lottery_records').doc(recordId).update({
        data: {
          status: 'completed',
          prizeName: finalPrizeName,
          prizeText,
          points: pointsAwarded,
          couponId,
          titleId,
          rewardMailId,
          updatedAt: now()
        }
      })

      return {
        prizeName: finalPrizeName,
        prizeType,
        prizeText,
        points: pointsAwarded,
        couponId,
        titleId,
        rewardMailId,
        titleSnapshot: petTitleSnapshot,
        templateSnapshot
      }
    }
    throw new Error('未知 lottery 操作')
  }
}

