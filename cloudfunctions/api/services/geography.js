module.exports = function createService({
  
}) {
  function hasCoordinate(latitude, longitude) {
    const lat = Number(latitude)
    const lng = Number(longitude)
    return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && lat !== 0 && lng !== 0
  }

  function calcDistanceKm(lat1, lng1, lat2, lng2) {
    if (!hasCoordinate(lat1, lng1) || !hasCoordinate(lat2, lng2)) return null
    const R = 6371 // 地球平均半径 (公里)
    const toRad = (value) => (Number(value) * Math.PI) / 180
    const radLat1 = toRad(lat1)
    const radLat2 = toRad(lat2)
    const dLat = toRad(lat2 - lat1)
    const dLng = toRad(lng2 - lng1)

    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(radLat1) * Math.cos(radLat2) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2)
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
    return R * c
  }

  function formatDistance(distanceKm) {
    if (distanceKm === null) return '未定位'
    return distanceKm < 1 ? `${Math.round(distanceKm * 1000)}m` : `${distanceKm.toFixed(2)}km`
  }

  function normalizeCityName(city) {
    return String(city || '').trim().replace(/^(.*省|.*自治区)/, '').replace(/(市|特别行政区|地区|盟|自治州)$/, '')
  }

  function extractCityFromText(text) {
    const value = String(text || '')
    const directCity = value.match(/(北京市|上海市|天津市|重庆市|香港特别行政区|澳门特别行政区)/)
    if (directCity) return directCity[1]
    const city = value.match(/(?:.*省|.*自治区)?([^省自治区特别行政区]{2,20}市|[^省自治区特别行政区]{2,20}自治州|[^省自治区特别行政区]{2,20}地区|[^省自治区特别行政区]{2,20}盟)/)
    return city ? city[1] : ''
  }

  function orderMatchesCity(order, selectedCity) {
    const filterCity = normalizeCityName(selectedCity)
    if (!filterCity) return true
    const orderCity = normalizeCityName(order.city || extractCityFromText(`${order.serviceAddress || ''}${order.addressDetail || ''}`))
    if (!orderCity) return true
    return orderCity.includes(filterCity) || filterCity.includes(orderCity)
  }

  function maskServiceAddress(value) {
    const text = String(value || '').trim()
    if (!text) return ''
    const pattern = /(\d+[-—_号栋幢弄室单元层楼A-Za-z0-9]+.*$)/
    if (pattern.test(text)) return text.replace(pattern, '***')
    if (text.length > 10) return `${text.slice(0, 6)}***`
    return text
  }

  function validateDirectStaffServiceRange(staffProfile, data = {}, options = {}) {
    if (!staffProfile) throw new Error('指定宠托师不存在')
    const sitterLat = Number(staffProfile.serviceLatitude || 0)
    const sitterLng = Number(staffProfile.serviceLongitude || 0)
    const sitterAddress = String(staffProfile.serviceAddress || '').trim()
    const radiusKm = Math.max(Number(staffProfile.serviceRadiusKm || 5), 1)

    const hasSitterCoord = hasCoordinate(sitterLat, sitterLng)
    const orderLat = Number(data.addressLatitude !== undefined ? data.addressLatitude : (data.latitude || 0))
    const orderLng = Number(data.addressLongitude !== undefined ? data.addressLongitude : (data.longitude || 0))
    const hasOrderCoord = hasCoordinate(orderLat, orderLng)
    const orderAddress = String(data.serviceAddress || '').trim()

    // 1. 城市一致性校验（若双方城市均可识别出）
    const sitterCity = normalizeCityName(staffProfile.serviceCity || extractCityFromText(sitterAddress))
    const orderAddressFull = `${data.city || ''}${orderAddress}${data.addressDetail || ''}`
    const orderCity = normalizeCityName(data.city || extractCityFromText(orderAddressFull))
    if (sitterCity && orderCity && !sitterCity.includes(orderCity) && !orderCity.includes(sitterCity)) {
      throw new Error(`订单服务地址所在城市（${orderCity}）与宠托师服务城市（${sitterCity}）不一致，超出服务范围`)
    }

    // 2. 宠托师配置了服务定位时：
    if (hasSitterCoord) {
      if (!hasOrderCoord) {
        if (!options.isQuote) {
          throw new Error('指定宠托师预约需选择包含精确定位的服务地址')
        }
      } else {
        const dist = calcDistanceKm(orderLat, orderLng, sitterLat, sitterLng)
        if (dist !== null && dist > radiusKm) {
          const distText = `约 ${formatDistance(dist)}`
          const displayAddr = staffProfile.publicServiceAddress || maskServiceAddress(sitterAddress)
          throw new Error(`订单服务地址距离宠托师常驻服务地址${displayAddr ? `（${displayAddr}）` : ''}${distText}，超出宠托师设定的接单范围（${radiusKm}公里内），无法预约`)
        }
        return { dist, radiusKm, sitterAddress, sitterLat, sitterLng }
      }
    }

    let dist = null
    if (hasSitterCoord && hasOrderCoord) {
      dist = calcDistanceKm(orderLat, orderLng, sitterLat, sitterLng)
    }
    return { dist, radiusKm, sitterAddress, sitterLat, sitterLng }
  }

  return {
    hasCoordinate,
    calcDistanceKm,
    formatDistance,
    normalizeCityName,
    extractCityFromText,
    orderMatchesCity,
    validateDirectStaffServiceRange
  }
}
