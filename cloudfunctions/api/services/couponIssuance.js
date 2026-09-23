module.exports = function createService({
  db,
  incUpdateValue,
  normalizeCouponSnapshot,
  now
}) {
  function getCouponValidRange(template, time = now()) {
    const snapshot = normalizeCouponSnapshot(template)
    if (snapshot.validType === 'fixed_range' && snapshot.validFromFixed && snapshot.validToFixed) {
      return {
        validFrom: new Date(`${snapshot.validFromFixed} 00:00:00`),
        validTo: new Date(`${snapshot.validToFixed} 23:59:59`)
      }
    }
    return {
      validFrom: time,
      validTo: new Date(time.getTime() + Number(snapshot.validDays || 30) * 86400000)
    }
  }

  function formatHomeCoupon(coupon) {
    return {
      _id: coupon._id,
      name: coupon.name || '新人优惠券',
      discountAmount: Number(coupon.discountAmount || 0),
      minOrderAmount: Number(coupon.minOrderAmount || 0),
      displayTag: coupon.displayTag || '新人专享',
      claimNotice: coupon.claimNotice || '',
      ruleText: coupon.minOrderAmount > 0 ? `满${coupon.minOrderAmount}减${coupon.discountAmount}` : `立减${coupon.discountAmount}`
    }
  }

  async function issueCouponToTargetUser(template, targetUser, adminMeta = {}) {
    if (!template || template.enabled === false) throw new Error('优惠券模板不可用')
    const templateId = template._id || template.templateId
    if (adminMeta.idempotencyKey) {
      const existingKey = (await db.collection('user_coupons').where({ openid: targetUser.openid, idempotencyKey: adminMeta.idempotencyKey }).limit(1).get()).data[0]
      if (existingKey) {
        return { _id: existingKey._id, templateSnapshot: existingKey.templateSnapshot, validFrom: existingKey.validFrom, validTo: existingKey.validTo }
      }
    }
    const existing = (await db.collection('user_coupons').where({ openid: targetUser.openid, templateId }).get()).data || []
    const activeCount = existing.filter((coupon) => coupon.status !== 'void').length
    if (activeCount >= Number(template.perUserLimit || 1)) throw new Error('该用户已达到领取上限')
    if (Number(template.totalIssueLimit || 0) > 0 && Number(template.issuedCount || 0) >= Number(template.totalIssueLimit || 0)) throw new Error('优惠券已达到发放上限')
    const time = now()
    const validRange = getCouponValidRange(template, time)
    const snapshot = normalizeCouponSnapshot(template)
    const created = await db.collection('user_coupons').add({
      data: {
        templateId,
        templateSnapshot: snapshot,
        userId: targetUser._id,
        openid: targetUser.openid,
        status: 'available',
        validFrom: validRange.validFrom,
        validTo: validRange.validTo,
        lockedOrderId: '',
        lockedAt: null,
        usedOrderId: '',
        usedAt: null,
        sourceType: adminMeta.sourceType || '',
        sourceId: adminMeta.sourceId || '',
        idempotencyKey: adminMeta.idempotencyKey || '',
        issuedByAdminUserId: adminMeta.adminUserId || '',
        issuedByAdminOpenid: adminMeta.adminOpenid || '',
        issuedAt: time,
        createdAt: time,
        updatedAt: time
      }
    })
    const updatedCount = Number(template.issuedCount || 0) + 1
    await db.collection('coupon_templates').doc(templateId).update({ data: { issuedCount: incUpdateValue(template.issuedCount, 1), updatedAt: time } })
    template.issuedCount = updatedCount
    return { _id: created._id, templateSnapshot: snapshot, validFrom: validRange.validFrom, validTo: validRange.validTo }
  }

  return {
    getCouponValidRange,
    formatHomeCoupon,
    issueCouponToTargetUser
  }
}
