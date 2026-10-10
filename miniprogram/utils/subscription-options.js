function subscriptionSections(role) {
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
    .map(key => String(templates[key] || '').trim()).filter(Boolean)))
}

module.exports = { subscriptionSections, availableSubscriptionIds }
