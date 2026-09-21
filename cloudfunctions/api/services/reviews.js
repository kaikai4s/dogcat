module.exports = function createService({
  db,
  maskClientName,
  now,
  safeFileId,
  safeText,
  toPublicSitter,
  toTimeValue
}) {
  async function getReviewStats(staffProfileId) {
    const res = await db.collection('service_reviews').where({ staffProfileId, status: 'visible' }).get()
    const reviews = res.data || []
    const reviewCount = reviews.length
    const ratingAverage = reviewCount ? Number((reviews.reduce((sum, item) => sum + Number(item.rating || 0), 0) / reviewCount).toFixed(1)) : 0
    const recentReviews = reviews
      .slice()
      .sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt))
      .slice(0, 5)
      .map((item) => ({
        _id: item._id,
        rating: item.rating,
        tags: item.tags || [],
        content: item.content || '',
        clientName: maskClientName(item.clientName),
        clientAvatarUrl: safeFileId(item.clientAvatarUrl) || safeText(item.clientAvatarUrl),
        memberLevelName: safeText(item.memberLevelName).trim() || '普通会员',
        badgeTag: safeText(item.badgeTag).trim() || 'V1',
        badgeStyle: safeText(item.badgeStyle).trim() || 'gold',
        nameColor: safeText(item.nameColor).trim(),
        nameEffect: safeText(item.nameEffect).trim(),
        createdAt: item.createdAt
      }))
    return { ratingAverage, reviewCount, recentReviews }
  }

  async function updateStaffRatingStats(staffProfileId, time = now()) {
    if (!staffProfileId) return { ratingAverage: 0, reviewCount: 0 }
    const stats = await getReviewStats(staffProfileId)
    await db.collection('staff_profiles').doc(staffProfileId).update({
      data: {
        ratingAverage: stats.ratingAverage,
        reviewCount: stats.reviewCount,
        ratingUpdatedAt: time,
        updatedAt: time
      }
    })
    return stats
  }

  async function isFavoriteSitter(openid, staffProfileId) {
    const res = await db.collection('sitter_favorites').where({ openid, staffProfileId }).limit(1).get()
    return Boolean(res.data[0])
  }

  async function toPublicSitterDetail(openid, profile) {
    const base = toPublicSitter(profile)
    const reviewStats = await getReviewStats(profile._id)
    return {
      ...base,
      level: profile.level || (base.isIntern ? 'intern' : 'normal'),
      levelName: profile.levelName || base.staffLevelText,
      serviceRadiusKm: base.serviceRadiusKm,
      publicTags: Array.isArray(profile.publicTags) && profile.publicTags.length ? profile.publicTags : base.publicTags,
      favorite: openid ? await isFavoriteSitter(openid, profile._id) : false,
      ...reviewStats
    }
  }

  return {
    getReviewStats,
    updateStaffRatingStats,
    isFavoriteSitter,
    toPublicSitterDetail
  }
}
