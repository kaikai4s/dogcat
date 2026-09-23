module.exports = function createHandler(context) {
  const {
    addPoints,
    db,
    formatRewardMail,
    getRewardMailRetroCardGrant,
    getUser,
    grantPetTitleToUser,
    grantRetroCards,
    issueCouponToTargetUser,
    now,
    resetRewardClaimResultField,
    safeText
  } = context
  async function readUserMails(userOpenid, maxLimit = 1000) {
    const rows = []
    let cursor = ''
    while (rows.length < maxLimit) {
      const condition = { openid: userOpenid }
      if (cursor && db.command && typeof db.command.gt === 'function') {
        condition._id = db.command.gt(cursor)
      }
      const page = (await db.collection('reward_mails').where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
      rows.push(...page)
      if (page.length < 100) break
      cursor = page[page.length - 1]._id
    }
    return rows
  }

  return async function rewardMail(openid, action, data) {
    if (action === 'getUnreadCount') {
      await getUser(openid)
      const mails = await readUserMails(openid, 1000)
      return {
        unreadCount: mails.filter((mail) => !mail.readAt).length,
        unclaimedCount: mails.filter((mail) => !mail.claimedAt).length
      }
    }
    if (action === 'listMyMails') {
      await getUser(openid)
      const wantsPage = data && (data.page !== undefined || data.pageSize !== undefined)
      if (wantsPage) {
        const countRes = await db.collection('reward_mails').where({ openid }).count()
        const total = (countRes && countRes.total) || 0
        const page = Math.max(1, Number(data.page || 1))
        const pageSize = Math.min(100, Math.max(1, Number(data.pageSize || 20)))
        const offset = (page - 1) * pageSize
        if (offset >= total) {
          return { list: [], total, page, pageSize, hasMore: false }
        }
        const res = await db.collection('reward_mails')
          .where({ openid })
          .orderBy('createdAt', 'desc')
          .skip(offset)
          .limit(pageSize)
          .get()
        const list = (res.data || []).map(formatRewardMail)
        return {
          list,
          total,
          page,
          pageSize,
          hasMore: offset + list.length < total
        }
      }
      const mails = (await readUserMails(openid, 1000))
        .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
      return mails.map(formatRewardMail)
    }
    if (action === 'markRead') {
      await getUser(openid)
      const id = safeText(data.id).trim()
      if (!id) throw new Error('缺少邮件 ID')
      const mailRes = await db.collection('reward_mails').doc(id).get().catch(() => ({ data: null }))
      const mail = mailRes && mailRes.data
      if (!mail || mail.openid !== openid) throw new Error('奖励邮件不存在')
      if (mail.readAt) return formatRewardMail(mail)
      const updated = { readAt: now(), updatedAt: now() }
      await db.collection('reward_mails').doc(id).update({ data: updated })
      return formatRewardMail({ ...mail, ...updated })
    }
    if (action === 'claimReward') {
      const user = await getUser(openid)
      const id = safeText(data.id).trim()
      if (!id) throw new Error('缺少邮件 ID')
      const mailRes = await db.collection('reward_mails').doc(id).get().catch(() => ({ data: null }))
      const mail = mailRes && mailRes.data
      if (!mail || mail.openid !== openid) throw new Error('奖励邮件不存在')
      if (mail.claimedAt) return formatRewardMail(mail)
      const claimTime = now()
      const claimed = await db.collection('reward_mails').where({ _id: id, openid, claimedAt: null }).update({ data: { readAt: mail.readAt || claimTime, claimedAt: claimTime, updatedAt: claimTime } })
      if (!claimed.stats || !claimed.stats.updated) throw new Error('奖励已领取，请刷新后查看')
      const reward = mail.reward || {}
      let pointsResult = null
      let couponResult = null
      let retroCardResult = null
      let petTitleResult = null
      try {
        if (reward.type === 'coupon') {
          const templateId = safeText(reward.couponTemplateId).trim()
          if (!templateId) throw new Error('奖励优惠券不存在')
          const templateRes = await db.collection('coupon_templates').doc(templateId).get().catch(() => ({ data: null }))
          const template = templateRes && templateRes.data
          if (!template) throw new Error('奖励优惠券不存在')
          couponResult = await issueCouponToTargetUser(template, user, {
            adminUserId: safeText(mail.sentByAdminUserId).trim(),
            adminOpenid: safeText(mail.sentByAdminOpenid).trim()
          })
        } else if (reward.type === 'retro_card') {
          const count = Math.max(Math.round(Number(reward.count || 0)), 0)
          if (!count) throw new Error('补签卡奖励数量无效')
          retroCardResult = await getRewardMailRetroCardGrant(openid, id)
          if (!retroCardResult) {
            retroCardResult = await grantRetroCards(openid, user._id, count, 'reward_mail', id, safeText(mail.title).trim() || '奖励邮件补签卡')
          }
        } else if (reward.type === 'pet_title') {
          const titleId = safeText(reward.titleId).trim()
          if (!titleId) throw new Error('宠物头衔奖励不存在')
          petTitleResult = await grantPetTitleToUser(user, titleId, {
            sourceType: 'reward_mail',
            sourceId: id,
            sourceKey: `mail:${id}`,
            duplicatePoints: reward.duplicatePoints
          })
        } else {
          const delta = Math.max(Math.round(Number(reward.points || 0)), 0)
          if (delta > 0) {
            pointsResult = await addPoints(openid, user._id, delta, 'reward_mail', id, safeText(mail.title).trim() || '奖励邮件积分', { baseDelta: delta })
          }
        }
      } catch (error) {
        await db.collection('reward_mails').doc(id).update({ data: { claimedAt: null, updatedAt: now() } })
        throw error
      }
      const updated = {
        readAt: mail.readAt || claimTime,
        claimedAt: claimTime,
        rewardClaimResult: {
          pointsDelta: pointsResult ? pointsResult.delta : (petTitleResult ? petTitleResult.compensationPoints : 0),
          couponId: couponResult ? couponResult._id : '',
          retroCardCountDelta: retroCardResult ? Math.max(Math.round(Number(reward.count || 0)), 0) : 0,
          retroCardBalance: retroCardResult ? retroCardResult.balance : 0,
          petTitleInventoryId: petTitleResult ? petTitleResult.inventoryId : '',
          petTitleId: petTitleResult ? petTitleResult.titleId : '',
          petTitleOutcome: petTitleResult ? petTitleResult.outcome : '',
          petTitleSnapshot: petTitleResult ? petTitleResult.titleSnapshot : null
        },
        updatedAt: now()
      }
      await resetRewardClaimResultField(id)
      await db.collection('reward_mails').doc(id).update({ data: updated })
      return formatRewardMail({ ...mail, ...updated })
    }
    throw new Error('未知 rewardMail 操作')
  }
}
