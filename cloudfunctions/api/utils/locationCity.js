// Keep in sync with miniprogram/utils/location-city.js.
// wx.chooseLocation returns addresses such as "四川省成都市郫都区…"; only a
// leading province/city prefix is trusted so street names never become cities.
const PROVINCE_PREFIX = /^(?:内蒙古自治区|广西壮族自治区|西藏自治区|宁夏回族自治区|新疆维吾尔自治区|[^省市区县]{2,7}省)/
const DIRECT_CITY = /^(北京市|上海市|天津市|重庆市|香港特别行政区|澳门特别行政区)/
const PREFECTURE_CITY = /^([^省市区县镇乡街道路号\d]{2,10}?(?:市|自治州|地区|盟))/

function normalizeCityName(city) {
  return String(city || '').trim().replace(/^(.*省|.*自治区)/, '').replace(/(市|特别行政区|地区|盟|自治州)$/, '')
}

function extractLocationCity(address) {
  const text = String(address || '').normalize('NFKC').replace(/\s+/g, '').replace(/^中国/, '')
  if (!text) return ''
  const direct = text.match(DIRECT_CITY)
  if (direct) return direct[1]
  const city = text.replace(PROVINCE_PREFIX, '').match(PREFECTURE_CITY)
  return city ? city[1] : ''
}

function sameCity(a, b) {
  const left = normalizeCityName(a)
  return Boolean(left) && left === normalizeCityName(b)
}

// Returns the city parsed from the map pick, or '' when it cannot be verified.
function assertServiceCityMatchesLocation(serviceCity, locationAddress) {
  const locationCity = extractLocationCity(locationAddress)
  if (!locationCity) return ''
  const city = String(serviceCity || '').trim()
  if (!city) throw new Error(`请填写常驻服务城市（地图选点位于${locationCity}）`)
  if (!sameCity(city, locationCity)) {
    throw new Error(`常驻服务城市「${city}」与地图选点所在的「${locationCity}」不一致，请重新确认服务城市或重新选点`)
  }
  return locationCity
}

module.exports = { extractLocationCity, sameCity, assertServiceCityMatchesLocation }
