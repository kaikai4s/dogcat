module.exports = function createHandler(context) {
  const {
    calcMallPricing,
    calcOrderPricing,
    couponDisplayStatus,
    db,
    evaluateCoupon,
    formatUserCoupon,
    getClientPetsByIds,
    getUser,
    issueCouponToTargetUser,
    normalizeCouponSnapshot,
    normalizePetIds,
    safeText
  } = context
  async function readUserCoupons(openid) {
    const rows = []
    let cursor = ''
    while (true) {
      const where = { openid }
      if (cursor) where._id = db.command.gt(cursor)
      const page = (await db.collection('user_coupons').where(where).orderBy('_id', 'asc').limit(100).get()).data || []
      rows.push(...page)
      if (page.length < 100) return rows
      cursor = page[page.length - 1]._id
    }
  }
  function isEffectiveOrder(order) {
    if (!order) return false
    if (order.paymentStatus === 'paid') return true
    if (['cancelled', 'closed', 'expired'].includes(order.status) && order.paymentStatus !== 'paid') {
      return false
    }
    return true
  }

  return async function coupon(openid, action, data) {
    if (action === 'listMyCoupons') {
      await getUser(openid)
      const statusFilter = data.status || 'available'
      return (await readUserCoupons(openid))
        .map((coupon) => formatUserCoupon(coupon))
        .filter((coupon) => statusFilter === 'all' || coupon.status === statusFilter)
        .sort((a, b) => String(a.validTo || '').localeCompare(String(b.validTo || '')))
    }

    if (action === 'listMallCoupons') {
      await getUser(openid)
      const coupons = await readUserCoupons(openid)
      const pricing = calcMallPricing(Array.isArray(data.items) ? data.items : [])
      return coupons
        .filter((coupon) => ['mall', 'all'].includes(normalizeCouponSnapshot(coupon).usageScope))
        .map((coupon) => {
          const result = evaluateCoupon(coupon, pricing, openid)
          return formatUserCoupon(coupon, {
            status: couponDisplayStatus(coupon),
            applicable: result.applicable,
            reason: result.reason || '',
            payAmountAfterDiscount: result.applicable ? Math.max(pricing.amount - result.discountAmount, 0) : pricing.amount
          })
        })
        .sort((a, b) => Number(b.applicable) - Number(a.applicable) || String(a.validTo || '').localeCompare(String(b.validTo || '')))
    }

    if (action === 'claimNewbieCoupon') {
      const user = await getUser(openid)
      const templateId = safeText(data.templateId).trim()
      if (!templateId) throw new Error('请选择新人优惠券')
      let template = null
      try {
        template = (await db.collection('coupon_templates').doc(templateId).get()).data
      } catch (err) {
        throw new Error('新人优惠券不可领取')
      }
      if (!template || template.enabled === false || template.newbieOnly !== true) throw new Error('新人优惠券不可领取')

      const [serviceOrdersRes, mallOrdersRes] = await Promise.all([
        db.collection('orders').where({ clientOpenid: openid }).limit(50).get().catch(() => ({ data: [] })),
        db.collection('mall_orders').where({ clientOpenid: openid }).limit(50).get().catch(() => ({ data: [] }))
      ])
      const serviceOrders = (serviceOrdersRes && serviceOrdersRes.data) || []
      const mallOrders = (mallOrdersRes && mallOrdersRes.data) || []
      if ([...serviceOrders, ...mallOrders].some(isEffectiveOrder)) {
        throw new Error('新人专享券仅限未下单的新用户领取')
      }

      const idempotencyKey = `newbie_${openid}_${templateId}`
      const issued = await issueCouponToTargetUser(template, user, {
        idempotencyKey,
        sourceType: 'newbie_claim',
        sourceId: templateId
      })
      return { _id: issued._id, templateId, status: 'available', templateSnapshot: issued.templateSnapshot, validFrom: issued.validFrom, validTo: issued.validTo }
    }

    if (action === 'listApplicableCoupons') {
      await getUser(openid)
      let pets = []
      const petIds = normalizePetIds(data)
      if (petIds.length) pets = await getClientPetsByIds(openid, petIds)
      const pricing = await calcOrderPricing({ ...data, couponId: '', autoApplyCoupon: false }, pets, { openid })
      const coupons = await readUserCoupons(openid)
      return coupons
        .filter((coupon) => ['service', 'all'].includes(normalizeCouponSnapshot(coupon).usageScope))
        .map((coupon) => {
          const result = evaluateCoupon(coupon, pricing, openid)
          return formatUserCoupon(coupon, {
            status: couponDisplayStatus(coupon),
            applicable: result.applicable,
            reason: result.reason || '',
            payAmountAfterDiscount: result.applicable ? Math.max(pricing.amount - result.discountAmount, 0) : pricing.amount
          })
        })
        .sort((a, b) => Number(b.applicable) - Number(a.applicable) || String(a.validTo || '').localeCompare(String(b.validTo || '')))
    }

    throw new Error('未知 coupon 操作')
  }
}
