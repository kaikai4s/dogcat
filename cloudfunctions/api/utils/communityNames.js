const text = value => String(value || '').normalize('NFKC').trim()

// Remove explicit entrance/building suffixes, never phases or north/south residential areas.
function communityName(value) {
  let name = text(value)
  let previous
  do {
    previous = name
    name = name.replace(/[\s,，·\-—(（]*[A-Za-z\d一二三四五六七八九十百]+(?:号楼|号栋|栋|幢|座|单元|楼|室|层)[)）]*$/, '')
    name = name.replace(/[\s·\-—(（]*(?:(?:东南|西南|东北|西北|东|南|西|北|正|主|侧)(?:[一二三四\d]+)?门(?:口)?|[一二三四五六七八九十\d]+号门|出入口|入口)[)）]*$/, '')
    name = name.trim()
  } while (name !== previous)
  return name.trim()
}
function nameKey(value) { return communityName(value).replace(/\s+/g, '').toLowerCase() }
function withoutProvince(value) {
  return value.replace(/^(?:[^省]{2,12}省|内蒙古自治区|广西壮族自治区|西藏自治区|宁夏回族自治区|新疆维吾尔自治区)/, '')
}
function cityPrefixes(city) {
  const name = withoutProvince(text(city).replace(/\s+/g, ''))
  if (!name) return []
  return [...new Set([name, name.replace(/市$/, ''), ...(/(?:市|特别行政区|地区|盟|自治州)$/.test(name) ? [] : [`${name}市`])])].sort((a, b) => b.length - a.length)
}
function addressName(value, city, district) {
  let name = withoutProvince(text(value).replace(/\s+/g, ''))
  const prefix = cityPrefixes(city).find(item => name.startsWith(item))
  if (prefix) name = name.slice(prefix.length)
  const area = text(district).replace(/\s+/g, '')
  if (area && name.startsWith(area)) name = name.slice(area.length)
  return nameKey(name)
}
function communityAddress(value, city, district = '') {
  let name = withoutProvince(communityName(value).replace(/\s+/g, ''))
  // A short city token can be part of an estate's actual name (上海花园).
  const cities = cityPrefixes(city).filter(item => /(?:市|特别行政区|地区|盟|自治州)$/.test(item))
  const prefix = cities.find(item => name.startsWith(item) && name.length > item.length)
  if (prefix) name = name.slice(prefix.length)
  let area = text(district).replace(/\s+/g, '')
  if (area && name.startsWith(area) && name.length > area.length) name = name.slice(area.length)
  else if (!area && prefix) {
    const match = name.match(/^([\u4e00-\u9fff]{1,6}?(?:区|县|旗))(.+)$/)
    // Infer only an administrative prefix after the known city. Estate area
    // suffixes and roads are not evidence for an administrative boundary.
    if (match && !/(?:小区|社区|花园|园区)/.test(match[1]) && !/^[东南西北]区$/.test(match[1]) &&
      !/^(?:[一二三四五六七八九十\d]+期|[东南西北]区)/.test(match[2])) {
      area = match[1]; name = match[2]
    }
  }
  return { name, district: area }
}
module.exports = { communityName, nameKey, addressName, communityAddress, cityPrefixes }
