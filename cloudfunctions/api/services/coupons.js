module.exports = function createService({
  db,
  now,
  safeText
}) {
  function normalizeCouponUsageScope(value) {
    return ['service', 'mall', 'all'].includes(value) ? value : 'service'
  }

  function couponUsageScopeText(scope) {
    return ({ service: '服务券', mall: '零售券', all: '通用券' })[scope] || '服务券'
  }

  function normalizeCouponSnapshot(coupon) {
    const snapshot = coupon.templateSnapshot || coupon
    const usageScope = normalizeCouponUsageScope(snapshot.usageScope || snapshot.businessType)
    return {
      templateId: coupon.templateId || coupon._id || '',
      name: safeText(snapshot.name).trim() || '优惠券',
      description: safeText(snapshot.description).trim(),
      type: snapshot.type === 'fixed' ? 'fixed' : 'fixed',
      usageScope,
      usageScopeText: couponUsageScopeText(usageScope),
      discountAmount: Math.max(Number(snapshot.discountAmount || 0), 0),
      minOrderAmount: Math.max(Number(snapshot.minOrderAmount || 0), 0),
      applicableServiceTypes: Array.isArray(snapshot.applicableServiceTypes) ? snapshot.applicableServiceTypes.map((item) => String(item || '').trim()).filter(Boolean) : [],
      validType: snapshot.validType === 'fixed_range' ? 'fixed_range' : 'relative_days',
      validDays: Math.max(Math.round(Number(snapshot.validDays || 30)), 1),
      validFromFixed: snapshot.validFromFixed || '',
      validToFixed: snapshot.validToFixed || '',
      displayTag: safeText(snapshot.displayTag).trim(),
      claimNotice: safeText(snapshot.claimNotice).trim(),
      useNotice: safeText(snapshot.useNotice).trim()
    }
  }

  function couponRuleText(snapshot) {
    const normalized = normalizeCouponSnapshot(snapshot)
    const minText = normalized.minOrderAmount > 0 ? `满${normalized.minOrderAmount}减${normalized.discountAmount}` : `立减${normalized.discountAmount}`
    const scopeText = couponUsageScopeText(normalized.usageScope)
    if (normalized.usageScope === 'service' && normalized.applicableServiceTypes.length) return `${scopeText}，${minText}，限指定服务`
    return `${scopeText}，${minText}`
  }

  function couponBusinessMatches(snapshot, pricing = {}) {
    const businessType = pricing.businessType === 'mall' || (Array.isArray(pricing.serviceTypes) && pricing.serviceTypes.includes('mall')) ? 'mall' : 'service'
    return snapshot.usageScope === 'all' || snapshot.usageScope === businessType
  }

  function couponDisplayStatus(coupon, time = now()) {
    if (coupon.status === 'used' || coupon.status === 'locked' || coupon.status === 'void') return coupon.status
    const validTo = new Date(coupon.validTo || 0).getTime()
    if (validTo && validTo < time.getTime()) return 'expired'
    return coupon.status || 'available'
  }

  function couponStatusText(status) {
    return ({ available: '可使用', locked: '已锁定', used: '已使用', expired: '已过期', void: '已作废' })[status] || '未知状态'
  }

  function formatUserCoupon(coupon, options = {}) {
    const snapshot = normalizeCouponSnapshot(coupon)
    const status = options.status || couponDisplayStatus(coupon)
    return {
      _id: coupon._id,
      templateId: coupon.templateId || snapshot.templateId,
      name: snapshot.name,
      description: snapshot.description,
      usageScope: snapshot.usageScope,
      usageScopeText: snapshot.usageScopeText,
      discountAmount: snapshot.discountAmount,
      minOrderAmount: snapshot.minOrderAmount,
      applicableServiceTypes: snapshot.applicableServiceTypes,
      validFrom: coupon.validFrom || '',
      validTo: coupon.validTo || '',
      status,
      statusText: couponStatusText(status),
      ruleText: couponRuleText(snapshot),
      applicable: options.applicable,
      reason: options.reason || '',
      payAmountAfterDiscount: options.payAmountAfterDiscount
    }
  }

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

  async function getAvailableUserCoupons(openid) {
    const time = now()
    return (await readUserCoupons(openid))
      .filter((coupon) => couponDisplayStatus(coupon, time) === 'available')
      .sort((a, b) => String(a.validTo || '').localeCompare(String(b.validTo || '')) || String(b.issuedAt || b.createdAt || '').localeCompare(String(a.issuedAt || a.createdAt || '')))
  }

  function evaluateCoupon(coupon, pricing, openid) {
    if (!coupon || coupon.openid !== openid) return { applicable: false, reason: '优惠券不存在' }
    const status = couponDisplayStatus(coupon)
    if (status !== 'available') return { applicable: false, reason: couponStatusText(status) }
    const snapshot = normalizeCouponSnapshot(coupon)
    if (!couponBusinessMatches(snapshot, pricing)) return { applicable: false, reason: snapshot.usageScope === 'mall' ? '仅限商城用品订单使用' : '仅限上门服务订单使用' }
    if (pricing.amount < snapshot.minOrderAmount) return { applicable: false, reason: `订单满 ¥${snapshot.minOrderAmount} 可用` }
    if (snapshot.usageScope === 'service' && snapshot.applicableServiceTypes.length && !pricing.serviceTypes.some((key) => snapshot.applicableServiceTypes.includes(key))) return { applicable: false, reason: '当前服务不可用' }
    const discountAmount = Math.min(snapshot.discountAmount, pricing.amount)
    if (discountAmount <= 0) return { applicable: false, reason: '优惠金额无效' }
    return {
      applicable: true,
      couponId: coupon._id,
      templateId: coupon.templateId || snapshot.templateId,
      name: snapshot.name,
      discountAmount,
      ruleText: couponRuleText(snapshot),
      snapshot
    }
  }

  function applyCouponToPricing(pricing, couponResult) {
    if (!couponResult || !couponResult.applicable) {
      return { ...pricing, discountAmount: 0, coupon: null, payAmount: pricing.amount, priceSnapshot: { ...pricing.priceSnapshot, originalAmount: pricing.amount, discountAmount: 0, payAmount: pricing.amount } }
    }
    const discountAmount = couponResult.discountAmount
    const payAmount = Math.max(pricing.amount - discountAmount, 0)
    const coupon = {
      couponId: couponResult.couponId,
      templateId: couponResult.templateId,
      name: couponResult.name,
      discountAmount,
      ruleText: couponResult.ruleText,
      snapshot: couponResult.snapshot
    }
    return {
      ...pricing,
      discountAmount,
      coupon,
      payAmount,
      priceItems: [...pricing.priceItems, { key: 'coupon', label: `优惠券：${coupon.name}`, price: -discountAmount }],
      priceSnapshot: { ...pricing.priceSnapshot, coupon, originalAmount: pricing.amount, discountAmount, payAmount }
    }
  }

  return {
    normalizeCouponUsageScope,
    couponUsageScopeText,
    normalizeCouponSnapshot,
    couponRuleText,
    couponBusinessMatches,
    couponDisplayStatus,
    couponStatusText,
    formatUserCoupon,
    getAvailableUserCoupons,
    evaluateCoupon,
    applyCouponToPricing
  }
}
