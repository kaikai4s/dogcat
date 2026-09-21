module.exports = function createService({
  db,
  now
}) {
  async function saveUserAddress(openid, user, data) {
    if (!data.serviceAddress) throw new Error('请选择服务地址')
    if (!data.addressDetail) throw new Error('请填写详细地址')
    if (!data.doorplate) throw new Error('请填写门牌号或入户说明')
    const time = now()
    const existingAddresses = await db.collection('user_addresses').where({ openid }).get()
    const isNewAddress = !data.id
    const shouldBeDefault = data.isDefault === true || (isNewAddress && existingAddresses.data.length === 0)
    const payload = {
      userId: user._id,
      openid,
      label: data.label || '常用地址',
      contactName: data.contactName || '',
      contactPhone: data.contactPhone || '',
      serviceAddress: data.serviceAddress || '',
      addressDetail: data.addressDetail || '',
      doorplate: data.doorplate || '',
      latitude: Number(data.latitude || data.addressLatitude || 0),
      longitude: Number(data.longitude || data.addressLongitude || 0),
      isDefault: shouldBeDefault,
      updatedAt: time
    }
    if (payload.isDefault) {
      await Promise.all(existingAddresses.data.map((item) => db.collection('user_addresses').doc(item._id).update({ data: { isDefault: false, updatedAt: time } })))
    }
    if (data.id) {
      const existing = await db.collection('user_addresses').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权操作地址')
      await db.collection('user_addresses').doc(data.id).update({ data: payload })
      return { _id: data.id, ...existing.data, ...payload }
    }
    const created = await db.collection('user_addresses').add({ data: { ...payload, createdAt: time } })
    return { _id: created._id, ...payload, createdAt: time }
  }

  return {
    saveUserAddress
  }
}
