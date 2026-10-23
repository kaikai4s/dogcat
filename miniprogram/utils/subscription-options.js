// These checks only reject obviously unusable values. Ownership and existence
// must still be confirmed by WeChat; a non-empty string is not proof of validity.
function subscriptionTemplateIssue(value) {
  const id = String(value || '').trim()
  if (!id) return '尚未配置模板 ID'
  if (/^\d+$/.test(id)) return '请填写完整模板 ID，不能填写模板编号'
  if (/^(?:your|replace|placeholder|example|demo)[_-]|^(?:template|tmpl)[_-]?id(?:$|[_-])|^请|^填写/i.test(id)) return '请用真实模板 ID 替换占位值'
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return '模板 ID 格式有误，请重新复制完整 ID'
  return ''
}

function subscriptionSections(role) {
  if (role === 'admin') return [['common', '商城管理通知', ['adminMallOrderPaid']]]
  return role === 'staff'
    ? [['common', '常用消息', ['staffDirectOrder', 'upcomingServiceReminder', 'serviceProgress', 'serviceFinish']], ['other', '其他消息', ['withdrawResult', 'disputeUpdate']]]
    : [['common', '常用消息', ['orderAccepted', 'staffDeparture', 'serviceStart', 'serviceFinish']], ['other', '其他消息', ['serviceProgress', 'orderPaid', 'orderAssigned', 'remoteUnlock', 'refundResult', 'disputeUpdate']]]
}

function availableSubscriptionIds(settings, role) {
  const subscription = settings && settings.subscription || {}
  if (!subscription.enabled) return []
  const templates = subscription.templates || {}
  return Array.from(new Set(subscriptionSections(role).flatMap(([, , keys]) => keys)
    .filter(key => key !== 'disputeUpdate')
    .map(key => String(templates[key] || '').trim()).filter(id => !subscriptionTemplateIssue(id))))
}

module.exports = { subscriptionSections, availableSubscriptionIds, subscriptionTemplateIssue }
