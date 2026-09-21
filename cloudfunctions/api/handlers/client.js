module.exports = function createHandler(context) {
  const {
    db,
    getUser,
    now,
    paginateList,
    safeText,
    saveUserAddress
  } = context
  return async function client(openid, action, data) {
    const user = await getUser(openid)

    if (action === 'listAddresses') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const res = await db.collection('user_addresses').where({ openid }).orderBy('updatedAt', 'desc').get()
      const list = (res.data || []).filter((address) => !keyword || [address.label, address.serviceAddress, address.addressDetail, address.doorplate].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }

    if (action === 'saveAddress') {
      return saveUserAddress(openid, user, data)
    }

    if (action === 'deleteAddress') {
      const existing = await db.collection('user_addresses').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权操作地址')
      await db.collection('user_addresses').doc(data.id).remove()
      return { id: data.id }
    }

    if (action === 'setDefaultAddress') {
      const existing = await db.collection('user_addresses').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权操作地址')
      const time = now()
      const addresses = await db.collection('user_addresses').where({ openid }).get()
      await Promise.all(addresses.data.map((item) => db.collection('user_addresses').doc(item._id).update({ data: { isDefault: item._id === data.id, updatedAt: time } })))
      return { id: data.id }
    }

    throw new Error('未知 client 操作')
  }
}
