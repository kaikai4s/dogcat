const { parseDateValue } = require('./time')

function userAssetExpiryDate(earning, validityDays = 0) {
  if (!earning) return null
  const created = parseDateValue(earning.createdAt)
  const days = Number(earning.validityDays || validityDays)
  const derived = created && days > 0 ? new Date(created.getTime() + days * 86400000) : null
  if (!earning.expiresAt) return earning.sourceType === 'invite_binding' ? derived : null
  // Older invite rewards stripped Z from UTC. Recognize only that exact value;
  // explicitly edited Beijing expirations keep their intended instant.
  if (earning.sourceType === 'invite_binding' && derived &&
      earning.expiresAt === derived.toISOString().replace('T', ' ').slice(0, 19)) return derived
  return parseDateValue(earning.expiresAt)
}

module.exports = { userAssetExpiryDate }
