const { readOptionalDocument, readDocuments } = require('../utils/documentPages')

// Only administrator-verified public points may cross the map API boundary.
module.exports = function createMapCommunities({ db, crypto, hasCoordinate, calcDistanceKm, normalizeCityName }) {
  const key = 'service_community'
  const clean = value => String(value || '').trim()
  const normalize = value => clean(value).replace(/\s+/g, '').toLowerCase()
  function publicCommunity(row) {
    if (!row || row.key !== key || row.enabled !== true || !hasCoordinate(row.latitude, row.longitude)) return null
    return { _id: row._id, name: row.name, city: row.city, district: row.district || '',
      latitude: Number(row.latitude), longitude: Number(row.longitude), revision: Number(row.revision || 1) }
  }
  async function readMapCommunities(city = '') {
    const where = { key, enabled: true }
    const normalizedCity = normalizeCityName(city)
    if (normalizedCity) where.cityKey = normalizedCity
    const rows = await readDocuments(db, db.command, 'platform_configs', where, 1001)
    if (rows.length > 1000) throw new Error('小区过多，请选择具体城市后重试')
    return rows.filter(publicCommunity)
  }
  async function getMapCommunity(id) {
    if (!/^map_community_[a-f0-9]{24}$/.test(String(id || ''))) return null
    const row = await readOptionalDocument(db, 'platform_configs', id)
    return publicCommunity(row) ? row : null
  }
  function matchMapCommunity(source, rows) {
    const id = source.serviceCommunityId || source.publicServiceCommunityId
    const name = normalize(source.serviceAddress)
    const city = normalizeCityName(source.city || source.serviceCity || '')
    const lat = source.addressLatitude !== undefined ? source.addressLatitude : source.latitude
    const lng = source.addressLongitude !== undefined ? source.addressLongitude : source.longitude
    const candidates = rows.filter(row => {
      if (!publicCommunity(row) || (city && normalizeCityName(row.city) !== city)) return false
      if (id && id !== row._id) return false
      if (!id && ![row.name, ...(row.aliases || [])].some(alias => normalize(alias) === name)) return false
      // A matching name alone cannot merge far-away estates with the same name.
      return hasCoordinate(lat, lng) && calcDistanceKm(lat, lng, row.latitude, row.longitude) <= Number(row.matchRadiusKm || 1)
    })
    return candidates.length === 1 ? candidates[0] : null
  }
  async function resolveOrderCommunity(source) {
    const rows = await readMapCommunities(source.city || '')
    const row = matchMapCommunity(source, rows)
    return row ? { serviceCommunityId: row._id, serviceCommunityName: row.name } : {}
  }
  function communityId() { return `map_community_${crypto.randomBytes(12).toString('hex')}` }
  return { readMapCommunities, getMapCommunity, publicCommunity, matchMapCommunity, resolveOrderCommunity, communityId }
}
