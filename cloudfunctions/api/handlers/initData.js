module.exports = function createHandler(context) {
  const {
    collections,
    db,
    getUser,
    now,
    requireAdmin,
    requiredCheckins,
    safeText
  } = context
  return async function initData(openid, action, data = {}) {
    function getInitAdminSecret() {
      return safeText(process.env.INIT_ADMIN_SECRET).trim()
    }

    function assertInitAdminSecret() {
      const secret = getInitAdminSecret()
      if (!secret) throw new Error('初始管理员配置未完成')
      if (safeText(data.secret).trim() !== secret) throw new Error('初始化密钥不正确')
    }

    async function hasActiveAdmin() {
      const usersRes = await db.collection('users').get()
      return (usersRes.data || []).some((user) => user.status === 'active' && Array.isArray(user.roles) && user.roles.includes('admin'))
    }

    async function requireInitSecretOrAdmin() {
      if (await hasActiveAdmin()) return requireAdmin(openid)
      assertInitAdminSecret()
      return null
    }

    if (action === 'checkCollections') {
      await requireInitSecretOrAdmin()
      const result = []
      for (let i = 0; i < collections.length; i += 1) {
        const name = collections[i]
        try {
          await db.collection(name).limit(1).get()
          result.push({ name, exists: true })
        } catch (error) {
          result.push({ name, exists: false, message: '请在云开发控制台创建该集合' })
        }
      }
      return result
    }

    async function claimInitialAdmin() {
      assertInitAdminSecret()
      const allowedPhones = safeText(process.env.INIT_ADMIN_PHONES)
        .split(',')
        .map((phone) => phone.trim())
        .filter(Boolean)
      if (!allowedPhones.length) throw new Error('初始管理员配置未完成')
      const user = await getUser(openid)
      const phone = safeText(user.phone).trim()
      if (!phone) throw new Error('请先绑定手机号')
      if (!allowedPhones.includes(phone)) throw new Error('当前手机号不在初始管理员白名单')
      if (await hasActiveAdmin()) throw new Error('初始管理员已存在')
      const time = now()
      const roles = Array.from(new Set([...(Array.isArray(user.roles) ? user.roles : ['client']), 'admin']))
      await db.collection('users').doc(user._id).update({ data: { roles, activeRole: 'admin', status: 'active', updatedAt: time } })
      return { ...user, roles, activeRole: 'admin', status: 'active', updatedAt: time }
    }

    if (action === 'claimInitialAdmin' || action === 'seedAdmin') return claimInitialAdmin()
    if (action === 'seedDemoData') {
      const user = await requireAdmin(openid)
      const time = now()
      const petRes = await db.collection('pets').where({ openid, name: '可乐' }).limit(1).get()
      let pet = petRes.data[0]
      if (!pet) {
        const petData = { userId: user._id, openid, name: '可乐', species: 'dog', breed: '柴犬', weight: 12, specialNotes: '有轻微爆冲，需短牵。', createdAt: time, updatedAt: time }
        const createdPet = await db.collection('pets').add({ data: petData })
        pet = { _id: createdPet._id, ...petData }
      }
      const orderRes = await db.collection('orders').where({ clientOpenid: openid, petId: pet._id }).limit(1).get()
      let order = orderRes.data[0]
      if (!order) {
        const start = new Date(Date.now() + 60 * 60 * 1000)
        const end = new Date(Date.now() + 2 * 60 * 60 * 1000)
        const orderData = { orderNo: `D${Date.now()}`, clientUserId: user._id, clientOpenid: openid, staffUserId: '', staffOpenid: '', staffProfileId: '', publishMode: 'open', requestedStaffProfileId: '', requestedStaffUserId: '', requestedStaffOpenid: '', requestedStaffName: '', requestedStaffSnapshot: null, assignmentSource: '', petId: pet._id, petName: pet.name, serviceType: 'walk', serviceTypes: ['walk'], serviceLabels: ['上门遛狗'], serviceSummary: '上门遛狗', serviceAddress: '演示小区 1 号楼', addressDetail: '1号楼 101', doorplate: '门牌 101', addressLatitude: 0, addressLongitude: 0, startTime: start.toISOString().slice(0, 16).replace('T', ' '), endTime: end.toISOString().slice(0, 16).replace('T', ' '), durationMinutes: 60, amount: 89, payAmount: 89, priceSnapshot: { services: [{ key: 'walk', label: '上门遛狗', price: 89 }], durationMinutes: 60, weight: 12 }, paymentStatus: 'paid', status: 'paid', requiredCheckins: requiredCheckins('walk', ['walk']), insurancePolicyNo: '', cancelReason: '', paidAt: time, createdAt: time, updatedAt: time }
        const createdOrder = await db.collection('orders').add({ data: orderData })
        order = { _id: createdOrder._id, ...orderData }
      }
      return { user, pet, order }
    }
    throw new Error('未知 initData 操作')
  }
}
