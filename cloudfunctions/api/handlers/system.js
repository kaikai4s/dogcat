module.exports = function createHandler(context) {
  const {
    checkImageSecurity,
    checkTextSecurity,
    db,
    getHomePageData,
    getSystemSettings,
    getUser,
    now,
    safeFileId,
    safeText
  } = context
  return async function system(openid, action, data) {
    if (action === 'getSettings') return getSystemSettings()
    if (action === 'getHomePageData') return getHomePageData(openid, data)
    if (action === 'recordSubscriptionConsent') {
      await getUser(openid)
      const templateKeys = Array.isArray(data.templateKeys) ? data.templateKeys : []
      const results = data.results || {}
      const time = now()
      const records = templateKeys.map((templateKey) => ({
        openid,
        templateKey,
        templateId: safeText(data.templateIds && data.templateIds[templateKey]).trim(),
        status: safeText(results[templateKey] || results[data.templateIds && data.templateIds[templateKey]] || 'unknown'),
        scene: safeText(data.scene).trim(),
        createdAt: time,
        updatedAt: time
      }))
      for (const record of records) {
        await db.collection('subscription_consents').add({ data: record })
      }
      return { count: records.length }
    }
    if (action === 'getCustomerServiceInfo') {
      const settings = await getSystemSettings()
      return settings.customerService || {}
    }
    if (action === 'checkTextSecurity') {
      return checkTextSecurity(openid, data.content, data.options || {})
    }
    if (action === 'checkImageSecurity') {
      return checkImageSecurity(openid, data.fileId || data.mediaUrl, data.options || {})
    }
    if (action === 'submitFeedback') {
      const user = await getUser(openid)
      const content = safeText(data.content).trim()
      const category = safeText(data.category).trim() || 'general'
      const contactInfo = safeText(data.contactInfo).trim()
      if (!content) throw new Error('请输入反馈内容')
      if (content.length > 2000) throw new Error('反馈内容不超过 2000 字')
      await checkTextSecurity(openid, content, { scene: 2, label: '反馈内容' })
      const time = now()
      const feedback = {
        openid,
        userId: user._id,
        nickname: user.nickname || '',
        phone: user.phone || '',
        category,
        content,
        contactInfo,
        mediaFileIds: Array.isArray(data.mediaFileIds) ? data.mediaFileIds.slice(0, 9).map(safeFileId).filter(Boolean) : [],
        status: 'pending',
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('user_feedback').add({ data: feedback })
      return { _id: created._id }
    }
    throw new Error('未知 system 操作')
  }
}
