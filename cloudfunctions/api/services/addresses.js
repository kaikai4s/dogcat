module.exports = function createService({
  db,
  now
}) {
  async function readUserAddresses(openid) {
    const rows = []
    let cursor = ''
    while (true) {
      const where = { openid }
      if (cursor) where._id = db.command.gt(cursor)
      const page = (await db.collection('user_addresses').where(where).orderBy('_id', 'asc').limit(100).get()).data || []
      rows.push(...page)
      if (page.length < 100) return rows
      cursor = page[page.length - 1]._id
    }
  }
  async function saveUserAddress(openid, user, data = {}) {
    const addressId = String(data.id || data._id || '').trim()
    let existingRecord = null
    if (addressId) {
      const existing = await db.collection('user_addresses').doc(addressId).get().catch(() => ({ data: null }))
      if (!existing || !existing.data) throw new Error('地址不存在')
      if (existing.data.openid !== openid) throw new Error('无权操作地址')
      existingRecord = existing.data
    }
    if (!data.serviceAddress) throw new Error('请选择服务地址')
    if (!data.addressDetail) throw new Error('请填写详细地址')
    if (!data.doorplate) throw new Error('请填写门牌号或入户说明')
    const time = now()
    const existingAddresses = { data: await readUserAddresses(openid) }
    const isNewAddress = !addressId
    const shouldBeDefault = data.isDefault === true || (isNewAddress && existingAddresses.data.length === 0)
    const payload = {
      userId: user._id,
      openid,
      label: data.label || '常用地址',
      contactName: data.contactName || '',
      contactPhone: data.contactPhone || '',
      serviceAddress: data.serviceAddress || '',
      addressDetail: data.addressDetail || '',
      doorplate: data.doorplate || ''
    }
    const rawLat = data.latitude !== undefined ? data.latitude : data.addressLatitude
    const rawLng = data.longitude !== undefined ? data.longitude : data.addressLongitude
    let latitude = 0
    let longitude = 0
    if (rawLat !== undefined || rawLng !== undefined) {
      const numLat = Number(rawLat || 0)
      const numLng = Number(rawLng || 0)
      if (!Number.isFinite(numLat) || !Number.isFinite(numLng) || numLat < -90 || numLat > 90 || numLng < -180 || numLng > 180) {
        throw new Error('地址经纬度坐标无效')
      }
      latitude = numLat
      longitude = numLng
    }
    payload.latitude = latitude
    payload.longitude = longitude
    payload.isDefault = shouldBeDefault
    payload.updatedAt = time
    if (payload.isDefault) {
      await Promise.all(existingAddresses.data.map((item) => db.collection('user_addresses').doc(item._id).update({ data: { isDefault: false, updatedAt: time } })))
    }
    if (addressId) {
      await db.collection('user_addresses').doc(addressId).update({ data: payload })
      return { _id: addressId, ...existingRecord, ...payload }
    }
    const created = await db.collection('user_addresses').add({ data: { ...payload, createdAt: time } })
    return { _id: created._id, ...payload, createdAt: time }
  }

  return {
    saveUserAddress
  }
}
