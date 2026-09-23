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
    if (!staffProfileId) return { ratingAverage: 0, reviewCount: 0, recentReviews: [] }
    const where = { staffProfileId, status: 'visible' }
    const countRes = await db.collection('service_reviews').where(where).count().catch(() => ({ total: 0 }))
    const reviewCount = Number(countRes?.total || 0)

    if (!reviewCount) {
      return { ratingAverage: 0, reviewCount: 0, recentReviews: [] }
    }

    const recentRes = await db.collection('service_reviews')
      .where(where)
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get()
      .catch(() => ({ data: [] }))
    const fetchedReviews = recentRes.data || []
    const sorted = fetchedReviews.slice().sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt))
    const recentReviews = sorted.slice(0, 5).map((item) => ({
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

    let ratingAverage = 0
    if (reviewCount <= 100 && fetchedReviews.length) {
      const totalRating = fetchedReviews.reduce((sum, item) => sum + Number(item.rating || 0), 0)
      ratingAverage = Number((totalRating / reviewCount).toFixed(1))
    } else {
      let avgComputed = false
      if (db && db.command && db.command.aggregate && typeof db.command.aggregate.sum === 'function') {
        try {
          const $ = db.command.aggregate
          const aggRes = await db.collection('service_reviews').aggregate()
            .match(where)
            .group({
              _id: null,
              totalRating: $.sum('$rating'),
              count: $.sum(1)
            })
            .end()
          if (aggRes && aggRes.list && aggRes.list[0] && Number(aggRes.list[0].count) > 0) {
            const total = Number(aggRes.list[0].totalRating || 0)
            const count = Number(aggRes.list[0].count || 0)
            ratingAverage = Number((total / count).toFixed(1))
            avgComputed = true
          }
        } catch (_) {
          avgComputed = false
        }
      }

      if (!avgComputed) {
        let totalRating = 0
        let cursor = ''
        while (true) {
          const condition = { ...where }
          if (cursor && db.command && typeof db.command.gt === 'function') {
            condition._id = db.command.gt(cursor)
          }
          const batch = (await db.collection('service_reviews').where(condition).orderBy('_id', 'asc').limit(100).get()).data || []
          for (const r of batch) totalRating += Number(r.rating || 0)
          if (batch.length < 100) break
          cursor = batch[batch.length - 1]._id
        }
        ratingAverage = reviewCount ? Number((totalRating / reviewCount).toFixed(1)) : 0
      }
    }

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
    }).catch(() => {})
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
