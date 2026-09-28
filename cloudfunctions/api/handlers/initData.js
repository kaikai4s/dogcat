module.exports = function createHandler(context) {
  const {
    collections,
    db,
    formatDateTime,
    defaultServiceCheckinRules,
    defaultServicePrices,
    getUser,
    normalizeServiceCheckinRule,
    normalizeServicePrice,
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
      const usersRes = await db.collection('users').where({ status: 'active', roles: db.command.in(['admin']) }).limit(1).get()
      return usersRes.data.length > 0
    }

    async function requireInitSecretOrAdmin() {
      if (await hasActiveAdmin()) return requireAdmin(openid)
      assertInitAdminSecret()
      return null
    }

    if (action === 'setupDatabase' || action === 'initAllCollections') {
      const createdCollections = []
      const existingCollections = []
      const errors = []

      // 1. 批量创建全量 73 个集合
      for (const colName of collections) {
        try {
          if (typeof db.createCollection === 'function') {
            await db.createCollection(colName)
            createdCollections.push(colName)
          } else {
            await db.collection(colName).limit(1).get().catch(() => null)
            existingCollections.push(colName)
          }
        } catch (err) {
          const msg = String(err.message || err.errMsg || err)
          if (msg.includes('already exists') || msg.includes('exist') || msg.includes('已存在')) {
            existingCollections.push(colName)
          } else {
            try {
              await db.collection(colName).limit(1).get()
              existingCollections.push(colName)
            } catch (probeErr) {
              errors.push({ collection: colName, error: msg })
            }
          }
        }
      }

      // 2. 顺带自动创建全量核心业务索引
      const REQUIRED_INDEXES = [
        { collection: 'orders', name: 'idx_client_orders', keys: { clientOpenid: 1, createdAt: -1 }, unique: false },
        { collection: 'orders', name: 'idx_staff_orders', keys: { staffOpenid: 1, status: 1 }, unique: false },
        { collection: 'orders', name: 'idx_order_no', keys: { orderNo: 1 }, unique: true },
        { collection: 'orders', name: 'idx_order_status', keys: { status: 1 }, unique: false },
        { collection: 'mall_orders', name: 'idx_mall_client_orders', keys: { clientOpenid: 1, createdAt: -1 }, unique: false },
        { collection: 'mall_orders', name: 'idx_mall_order_no', keys: { orderNo: 1 }, unique: true },
        { collection: 'users', name: 'idx_user_openid', keys: { openid: 1 }, unique: true },
        { collection: 'users', name: 'idx_user_phone', keys: { phone: 1 }, unique: false },
        { collection: 'staff_profiles', name: 'idx_staff_openid', keys: { openid: 1 }, unique: true },
        { collection: 'staff_profiles', name: 'idx_staff_audit_status', keys: { auditStatus: 1 }, unique: false },
        { collection: 'user_coupons', name: 'idx_user_coupons', keys: { openid: 1, status: 1 }, unique: false },
        { collection: 'payments', name: 'idx_payment_no', keys: { paymentNo: 1 }, unique: true },
        { collection: 'payments', name: 'idx_payment_order_id', keys: { orderId: 1 }, unique: false },
        { collection: 'staff_earnings', name: 'idx_staff_earnings', keys: { staffOpenid: 1, status: 1 }, unique: false },
        { collection: 'staff_schedule_exceptions', name: 'idx_staff_schedule', keys: { staffOpenid: 1, dateKey: 1 }, unique: false },
        { collection: 'pets', name: 'idx_client_pets', keys: { openid: 1 }, unique: false },
        { collection: 'refunds', name: 'idx_refund_order_id', keys: { orderId: 1 }, unique: false },
        { collection: 'refunds', name: 'idx_refund_no', keys: { refundNo: 1 }, unique: false },
        { collection: 'order_incidents', name: 'idx_incident_order_id', keys: { orderId: 1 }, unique: false },
        { collection: 'order_messages', name: 'idx_order_messages', keys: { conversationId: 1, createdAt: -1 }, unique: false },
        { collection: 'point_logs', name: 'idx_point_logs', keys: { openid: 1, createdAt: -1 }, unique: false },
        { collection: 'withdraw_requests', name: 'idx_withdraw_staff', keys: { staffOpenid: 1, createdAt: -1 }, unique: false }
      ]

      const indexResults = []
      let indexesCreated = 0
      for (const item of REQUIRED_INDEXES) {
        try {
          const col = db.collection(item.collection)
          if (typeof col.createIndex === 'function') {
            await col.createIndex({
              name: item.name,
              keys: item.keys,
              unique: item.unique === true
            })
            indexesCreated++
            indexResults.push({ collection: item.collection, name: item.name, status: 'created' })
          } else {
            indexResults.push({ collection: item.collection, name: item.name, status: 'skipped_mock_env' })
          }
        } catch (idxErr) {
          const msg = String(idxErr.message || idxErr.errMsg || idxErr)
          if (msg.includes('already exists') || msg.includes('exist') || msg.includes('已存在')) {
            indexResults.push({ collection: item.collection, name: item.name, status: 'already_exists' })
          } else {
            try {
              const col = db.collection(item.collection)
              if (typeof col.createIndex === 'function') {
                const legacyKeys = Object.entries(item.keys).map(([name, dir]) => ({ name, direction: dir === -1 || dir === 'desc' ? 'desc' : 'asc' }))
                await col.createIndex({ keys: legacyKeys, name: item.name, unique: item.unique === true })
                indexesCreated++
                indexResults.push({ collection: item.collection, name: item.name, status: 'created_legacy' })
                continue
              }
            } catch (legacyErr) {
              // ignore
            }
            indexResults.push({ collection: item.collection, name: item.name, status: 'failed', error: msg })
          }
        }
      }

      // 2. 初始化核心服务定价 (service_prices)
      const time = now()
      let pricesInitialized = 0
      const pricesToSeed = Array.isArray(defaultServicePrices) ? defaultServicePrices : (context.defaultServicePrices || [])
      for (const preset of pricesToSeed) {
        const existing = await db.collection('service_prices').where({ key: preset.key }).limit(1).get().catch(() => ({ data: [] }))
        if (!existing.data || existing.data.length === 0) {
          const payload = typeof normalizeServicePrice === 'function' ? normalizeServicePrice(preset) : preset
          await db.collection('service_prices').add({ data: { ...payload, createdAt: time, updatedAt: time } })
          pricesInitialized++
        }
      }

      // 3. 初始化服务打卡规则 (service_checkin_rules)
      let checkinRulesInitialized = 0
      const rulesToSeed = Array.isArray(defaultServiceCheckinRules) ? defaultServiceCheckinRules : (context.defaultServiceCheckinRules || [])
      for (const rule of rulesToSeed) {
        const existing = await db.collection('service_checkin_rules').where({ serviceType: rule.serviceType, eventType: rule.eventType }).limit(1).get().catch(() => ({ data: [] }))
        if (!existing.data || existing.data.length === 0) {
          const payload = typeof normalizeServiceCheckinRule === 'function' ? normalizeServiceCheckinRule(rule) : rule
          await db.collection('service_checkin_rules').add({ data: { ...payload, createdAt: time, updatedAt: time } })
          checkinRulesInitialized++
        }
      }

      // 4. 初始化全局系统配置
      const existingSettings = await db.collection('system_settings').doc('global').get().catch(() => ({ data: null }))
      let settingsInitialized = false
      if (!existingSettings || !existingSettings.data) {
        await db.collection('system_settings').doc('global').set({
          data: {
            payment: { mode: 'wechat', refundEnabled: true },
            settlement: { minWithdrawAmount: 10 },
            enableTestAddressMode: false,
            enablePetBreedAi: true,
            createdAt: time,
            updatedAt: time
          }
        }).catch(() => null)
        settingsInitialized = true
      }

      // 5. 若指定了首个管理员 openid 或当前执行者有 openid 且库中无管理员，则自动绑定首位超级管理员
      let initialAdminBound = null
      const targetAdminOpenid = safeText(data.adminOpenid || openid).trim()
      const hasAdmin = await hasActiveAdmin()
      if (!hasAdmin && targetAdminOpenid) {
        const uRes = await db.collection('users').where({ openid: targetAdminOpenid }).limit(1).get().catch(() => ({ data: [] }))
        const u = uRes.data && uRes.data[0]
        if (u) {
          const roles = Array.from(new Set([...(Array.isArray(u.roles) ? u.roles : ['client']), 'admin']))
          await db.collection('users').doc(u._id).update({ data: { roles, activeRole: 'admin', status: 'active', updatedAt: time } })
          initialAdminBound = targetAdminOpenid
        } else {
          await db.collection('users').add({
            data: {
              openid: targetAdminOpenid,
              roles: ['admin', 'client'],
              activeRole: 'admin',
              status: 'active',
              createdAt: time,
              updatedAt: time
            }
          })
          initialAdminBound = targetAdminOpenid
        }
      }

      return {
        success: true,
        message: '正式环境数据库与业务索引初始化成功',
        totalCollections: collections.length,
        createdCount: createdCollections.length,
        existingCount: existingCollections.length,
        totalIndexesConfigured: REQUIRED_INDEXES.length,
        indexesCreated,
        indexResults,
        errors,
        pricesInitialized,
        checkinRulesInitialized,
        settingsInitialized,
        initialAdminBound,
        securityRuleNotice: '重要提示：所有集合数据权限均需在云开发控制台保持为【所有用户不可读写】以确保安全'
      }
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
        const orderData = { orderNo: `D${Date.now()}`, clientUserId: user._id, clientOpenid: openid, staffUserId: '', staffOpenid: '', staffProfileId: '', publishMode: 'open', requestedStaffProfileId: '', requestedStaffUserId: '', requestedStaffOpenid: '', requestedStaffName: '', requestedStaffSnapshot: null, assignmentSource: '', petId: pet._id, petName: pet.name, serviceType: 'walk', serviceTypes: ['walk'], serviceLabels: ['上门遛狗'], serviceSummary: '上门遛狗', serviceAddress: '演示小区 1 号楼', addressDetail: '1号楼 101', doorplate: '门牌 101', addressLatitude: 0, addressLongitude: 0, startTime: formatDateTime(start), endTime: formatDateTime(end), durationMinutes: 60, amount: 89, payAmount: 89, priceSnapshot: { services: [{ key: 'walk', label: '上门遛狗', price: 89 }], durationMinutes: 60, weight: 12 }, paymentStatus: 'paid', status: 'paid', requiredCheckins: requiredCheckins('walk', ['walk']), insurancePolicyNo: '', cancelReason: '', paidAt: time, createdAt: time, updatedAt: time }
        const createdOrder = await db.collection('orders').add({ data: orderData })
        order = { _id: createdOrder._id, ...orderData }
      }
      return { user, pet, order }
    }
    throw new Error('未知 initData 操作')
  }
}
