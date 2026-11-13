function isManualRedemption(settings) {
  return settings?.settlement?.staffEarningsMode === 'manual_redemption'
}

async function readManualRedemption(reader, fallback = {}) {
  const rows = (await reader.collection('platform_configs').where({ key: 'system_settings' }).limit(1).get()).data || []
  return isManualRedemption(rows.length ? rows[0].value : fallback)
}

module.exports = { isManualRedemption, readManualRedemption }
