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
  return async function rewardMail(openid, action, data) {
    if (action === 'getUnreadCount') {
      await getUser(openid)
      const mailsRes = await db.collection('reward_mails').where({ openid }).get()
      const mails = mailsRes.data || []
      return {
        unreadCount: mails.filter((mail) => !mail.readAt).length,
        unclaimedCount: mails.filter((mail) => !mail.claimedAt).length
      }
    }
    if (action === 'listMyMails') {
      await getUser(openid)
      const mailsRes = await db.collection('reward_mails').where({ openid }).orderBy('createdAt', 'desc').get()
      return (mailsRes.data || []).map(formatRewardMail)
    }
    if (action === 'markRead') {
      await getUser(openid)
      const id = safeText(data.id).trim()
      if (!id) throw new Error('缺少邮件 ID')
      const mail = (await db.collection('reward_mails').doc(id).get()).data
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
      const mail = (await db.collection('reward_mails').doc(id).get()).data
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
          const template = (await db.collection('coupon_templates').doc(templateId).get()).data
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
