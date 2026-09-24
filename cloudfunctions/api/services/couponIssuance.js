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
        validFrom: new Date(`${snapshot.validFromFixed}T00:00:00+08:00`),
        validTo: new Date(`${snapshot.validToFixed}T23:59:59+08:00`)
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
    if (!templateId) throw new Error('优惠券模板不可用')

    const idempotencyKey = String(adminMeta.idempotencyKey || '').trim()

    if (idempotencyKey) {
      const existingKey = (await db.collection('user_coupons').where({ openid: targetUser.openid, idempotencyKey }).limit(1).get()).data[0]
      if (existingKey) {
        return { _id: existingKey._id, templateSnapshot: existingKey.templateSnapshot, validFrom: existingKey.validFrom, validTo: existingKey.validTo }
      }
    }

    const existing = (await db.collection('user_coupons').where({ openid: targetUser.openid, templateId }).get()).data || []
    const activeCount = existing.filter((coupon) => coupon.status !== 'void').length
    if (activeCount >= Number(template.perUserLimit || 1)) throw new Error('该用户已达到领取上限')
    if (Number(template.totalIssueLimit || 0) > 0 && Number(template.issuedCount || 0) >= Number(template.totalIssueLimit || 0)) {
      throw new Error('优惠券已达到发放上限')
    }

    const time = typeof now === 'function' ? now() : new Date()
    const validRange = getCouponValidRange(template, time)
    const snapshot = normalizeCouponSnapshot(template)

    const couponDocId = idempotencyKey ? `uc_${idempotencyKey}` : ''

    const couponRecord = {
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
      idempotencyKey: idempotencyKey || '',
      issuedByAdminUserId: adminMeta.adminUserId || '',
      issuedByAdminOpenid: adminMeta.adminOpenid || '',
      issuedAt: time,
      createdAt: time,
      updatedAt: time
    }

    if (typeof db.runTransaction === 'function') {
      const txResult = await db.runTransaction(async (tx) => {
        let templateDoc = null
        try {
          templateDoc = (await tx.collection('coupon_templates').doc(templateId).get()).data
        } catch (err) {
          templateDoc = null
        }
        if (!templateDoc || templateDoc.enabled === false) throw new Error('优惠券模板不可用')
        const currentTotalLimit = Number(templateDoc.totalIssueLimit || 0)
        const currentIssuedCount = Number(templateDoc.issuedCount || 0)
        if (currentTotalLimit > 0 && currentIssuedCount >= currentTotalLimit) {
          throw new Error('优惠券已达到发放上限')
        }

        if (couponDocId) {
          let existingDoc = null
          try {
            const got = await tx.collection('user_coupons').doc(couponDocId).get()
            existingDoc = got && got.data
          } catch (err) {
            existingDoc = null
          }
          if (existingDoc) {
            return {
              _id: existingDoc._id,
              templateSnapshot: existingDoc.templateSnapshot,
              validFrom: existingDoc.validFrom,
              validTo: existingDoc.validTo,
              isExisting: true
            }
          }
        }

        let finalCouponId = couponDocId
        if (couponDocId) {
          await tx.collection('user_coupons').doc(couponDocId).set({ data: couponRecord })
        } else {
          finalCouponId = `uc_${templateId}_${targetUser._id || targetUser.openid}_${time.getTime()}_${Math.random().toString(36).slice(2, 8)}`
          await tx.collection('user_coupons').doc(finalCouponId).set({ data: couponRecord })
        }

        const nextIssuedCount = currentIssuedCount + 1
        await tx.collection('coupon_templates').doc(templateId).update({
          data: {
            issuedCount: incUpdateValue(templateDoc.issuedCount, 1),
            updatedAt: time
          }
        })

        return {
          _id: finalCouponId,
          templateSnapshot: snapshot,
          validFrom: validRange.validFrom,
          validTo: validRange.validTo,
          isExisting: false,
          issuedCount: nextIssuedCount
        }
      })

      if (!txResult.isExisting && txResult.issuedCount !== undefined) {
        template.issuedCount = txResult.issuedCount
      }

      return {
        _id: txResult._id,
        templateSnapshot: txResult.templateSnapshot,
        validFrom: txResult.validFrom,
        validTo: txResult.validTo
      }
    }

    let createdId = couponDocId
    try {
      if (couponDocId) {
        await db.collection('user_coupons').add({ data: { ...couponRecord, _id: couponDocId } })
      } else {
        const res = await db.collection('user_coupons').add({ data: couponRecord })
        createdId = res._id
      }
    } catch (err) {
      if (couponDocId && (err.message?.includes('already exists') || err.message?.includes('duplicate'))) {
        const conflictDoc = (await db.collection('user_coupons').where({ openid: targetUser.openid, idempotencyKey }).limit(1).get()).data[0]
        if (conflictDoc) {
          return {
            _id: conflictDoc._id,
            templateSnapshot: conflictDoc.templateSnapshot,
            validFrom: conflictDoc.validFrom,
            validTo: conflictDoc.validTo
          }
        }
      }
      throw err
    }

    const updatedCount = Number(template.issuedCount || 0) + 1
    await db.collection('coupon_templates').doc(templateId).update({
      data: { issuedCount: incUpdateValue(template.issuedCount, 1), updatedAt: time }
    })
    template.issuedCount = updatedCount

    return { _id: createdId, templateSnapshot: snapshot, validFrom: validRange.validFrom, validTo: validRange.validTo }
  }

  return {
    getCouponValidRange,
    formatHomeCoupon,
    issueCouponToTargetUser
  }
}
