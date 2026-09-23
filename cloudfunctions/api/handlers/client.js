module.exports = function createHandler(context) {
  const {
    db,
    getUser,
    now,
    paginateList,
    safeText,
    saveUserAddress
  } = context
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
  return async function client(openid, action, data) {
    const user = await getUser(openid)

    if (action === 'listAddresses') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const list = (await readUserAddresses(openid))
        .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
        .filter((address) => !keyword || [address.label, address.serviceAddress, address.addressDetail, address.doorplate].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }

    if (action === 'saveAddress') {
      return saveUserAddress(openid, user, data)
    }

    if (action === 'deleteAddress') {
      const addressId = safeText(data && data.id).trim()
      if (!addressId) throw new Error('缺少地址ID')
      const existing = await db.collection('user_addresses').doc(addressId).get().catch(() => ({ data: null }))
      if (!existing || !existing.data) throw new Error('地址不存在')
      if (existing.data.openid !== openid) throw new Error('无权操作地址')
      await db.collection('user_addresses').doc(addressId).remove()
      return { id: addressId }
    }

    if (action === 'setDefaultAddress') {
      const addressId = safeText(data && data.id).trim()
      if (!addressId) throw new Error('缺少地址ID')
      const existing = await db.collection('user_addresses').doc(addressId).get().catch(() => ({ data: null }))
      if (!existing || !existing.data) throw new Error('地址不存在')
      if (existing.data.openid !== openid) throw new Error('无权操作地址')
      const time = now()
      const addresses = await readUserAddresses(openid)
      await Promise.all(addresses.map((item) => db.collection('user_addresses').doc(item._id).update({ data: { isDefault: item._id === addressId, updatedAt: time } })))
      return { id: addressId }
    }

    throw new Error('未知 client 操作')
  }
}
