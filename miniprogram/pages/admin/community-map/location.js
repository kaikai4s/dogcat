// Keep public-point parsing inside the admin subpackage. WeChat subpackages
// cannot synchronously require JavaScript from another subpackage.
function validPoint(point) {
  return !!point && Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude)) &&
    Math.abs(Number(point.latitude)) <= 85 && Math.abs(Number(point.longitude)) <= 180 && Number(point.latitude) !== 0 && Number(point.longitude) !== 0
}
function locationCity(location) {
  if (location?.city) return String(location.city).trim()
  const text = `${location?.address || ''}${location?.name || ''}`
  const direct = text.match(/(北京市|上海市|天津市|重庆市|香港特别行政区|澳门特别行政区)/)
  if (direct) return direct[1]
  const city = text.match(/(?:.*省|.*自治区)?([^省自治区特别行政区]{2,20}市|[^省自治区特别行政区]{2,20}自治州|[^省自治区特别行政区]{2,20}地区|[^省自治区特别行政区]{2,20}盟)/)
  return city ? city[1] : ''
}
function communityLocationFields(point) {
  const city = locationCity(point)
  const address = String(point?.address || '')
  const cityAt = city ? address.indexOf(city) : -1
  const rest = cityAt >= 0 ? address.slice(cityAt + city.length) : address
  const district = point?.district || rest.match(/^([^省市]{1,12}?(?:区|县|旗))/)?.[1] || ''
  const name = String(point?.name || '').trim().replace(/[\s·\-—(（]*(?:(?:东南|西南|东北|西北|东|南|西|北|正|主|侧)(?:[一二三四\d]+)?门(?:口)?|[一二三四五六七八九十\d]+号门|出入口|入口)[)）]*$/, '').trim()
  return { name, city, district, latitude: Number(point?.latitude), longitude: Number(point?.longitude) }
}
module.exports = { validPoint, locationCity, communityLocationFields }
