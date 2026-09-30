const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('phone auth failure with 40029 throws error and NEVER pollutes user phone with test number', async () => {
  const db = createCollectionStore({
    users: [
      {
        _id: 'u_existing',
        openid: 'openid_real_user',
        phone: '13912345678',
        roles: ['client'],
        status: 'active'
      }
    ],
    platform_configs: [
      {
        _id: 'cfg_1',
        key: 'system_settings',
        value: { enableTestAddressMode: false }
      }
    ]
  })

  // 模拟微信 openapi 返回 40029（code 过期或无效）
  const cloudOverrides = {
    openapi: {
      phonenumber: {
        async getPhoneNumber() {
          const err = new Error('errcode: 40029, errmsg: invalid code rid: 67890-abcdef')
          err.errCode = 40029
          throw err
        }
      }
    }
  }

  const fn = loadCloudFunction('api', db, 'openid_real_user', cloudOverrides)

  const res = await fn.main({
    module: 'auth',
    action: 'loginByPhoneCode',
    data: { code: 'real_wx_phone_code_123' }
  })

  assert.equal(res.ok, false)
  assert.match(res.message, /手机号授权已过期或失效/)

  // 验证用户手机号绝对没有被篡改为测试号码 13800138000
  const user = db.state.users.find((u) => u.openid === 'openid_real_user')
  assert.equal(user.phone, '13912345678')
})

test('phone auth network or server failure throws error and blocks dirty data creation', async () => {
  const db = createCollectionStore({
    users: [],
    platform_configs: [
      {
        _id: 'cfg_1',
        key: 'system_settings',
        value: { enableTestAddressMode: false }
      }
    ]
  })

  const cloudOverrides = {
    openapi: {
      phonenumber: {
        async getPhoneNumber() {
          throw new Error('connect ETIMEDOUT api.weixin.qq.com')
        }
      }
    }
  }

  const fn = loadCloudFunction('api', db, 'openid_new_user', cloudOverrides)

  const res = await fn.main({
    module: 'auth',
    action: 'loginByPhoneCode',
    data: { code: 'real_wx_phone_code_timeout' }
  })

  assert.equal(res.ok, false)
  assert.match(res.message, /调用微信手机号接口失败/)

  // 验证新用户不会以 13800138000 手机号创建入库
  assert.equal(db.state.users.length, 0)
})

test('production rejects explicit mock phone authorization code', async () => {
  const previousPaymentEnv = process.env.PAYMENT_ENV
  process.env.PAYMENT_ENV = 'production'
  try {
    const db = createCollectionStore({
      users: [],
      platform_configs: [
        { _id: 'cfg_1', key: 'system_settings', value: { enableTestAddressMode: false } }
      ]
    })
    const fn = loadCloudFunction('api', db, 'openid_prod_mock')
    const res = await fn.main({ module: 'auth', action: 'loginByPhoneCode', data: { code: 'the code is a mock one' } })
    assert.equal(res.ok, false)
    assert.match(res.error || res.message, /正式环境禁止使用模拟手机号授权码/)
    assert.equal(db.state.users.length, 0)
  } finally {
    if (previousPaymentEnv === undefined) delete process.env.PAYMENT_ENV
    else process.env.PAYMENT_ENV = previousPaymentEnv
  }
})

test('loginByPhoneCode rejects phone already bound by another active account', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_existing', openid: 'openid_existing', phone: '19900006302', roles: ['client'], status: 'active' }],
    platform_configs: [{ _id: 'cfg_1', key: 'system_settings', value: { enableTestAddressMode: false } }]
  })
  const fn = loadCloudFunction('api', db, 'openid_new_duplicate')
  const res = await fn.main({ module: 'auth', action: 'loginByPhoneCode', data: { code: 'real_wx_code' } })
  assert.equal(res.ok, false)
  assert.match(res.error || res.message, /已被其他账号绑定/)
  assert.equal(db.state.users.length, 1)
})

test('loginByPhoneCode protects initial admin whitelist phone with secret', async () => {
  const previousPhones = process.env.INIT_ADMIN_PHONES
  const previousSecret = process.env.INIT_ADMIN_SECRET
  process.env.INIT_ADMIN_PHONES = '19900006302'
  process.env.INIT_ADMIN_SECRET = 'admin-secret'
  try {
    const db = createCollectionStore({
      users: [],
      platform_configs: [{ _id: 'cfg_1', key: 'system_settings', value: { enableTestAddressMode: false } }]
    })
    const fn = loadCloudFunction('api', db, 'openid_admin_phone_claim')
    const blocked = await fn.main({ module: 'auth', action: 'loginByPhoneCode', data: { code: 'real_wx_code' } })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error || blocked.message, /受系统安全保护/)

    const allowed = await fn.main({ module: 'auth', action: 'loginByPhoneCode', data: { code: 'real_wx_code_2', secret: 'admin-secret' } })
    assert.equal(allowed.ok, true)
    assert.equal(allowed.data.phone, '19900006302')
  } finally {
    if (previousPhones === undefined) delete process.env.INIT_ADMIN_PHONES
    else process.env.INIT_ADMIN_PHONES = previousPhones
    if (previousSecret === undefined) delete process.env.INIT_ADMIN_SECRET
    else process.env.INIT_ADMIN_SECRET = previousSecret
  }
})

test('explicit mock code or enableTestAddressMode still allows test phone fallback for dev/testing', async () => {
  const db = createCollectionStore({
    users: [],
    platform_configs: [
      {
        _id: 'cfg_1',
        key: 'system_settings',
        value: { enableTestAddressMode: false }
      }
    ]
  })

  // 不注入 mock openapi，使用显式 mock code
  const fn = loadCloudFunction('api', db, 'openid_mock_user')

  const res1 = await fn.main({
    module: 'auth',
    action: 'loginByPhoneCode',
    data: { code: 'the code is a mock one' }
  })
  assert.equal(res1.ok, true)
  assert.equal(res1.data.phone, '13800138000')

  // 开启 enableTestAddressMode 时
  db.state.platform_configs[0].value.enableTestAddressMode = true
  const fn2 = loadCloudFunction('api', db, 'openid_test_env_user')
  const res2 = await fn2.main({
    module: 'auth',
    action: 'loginByPhoneCode',
    data: { code: 'any_code_in_test_mode' }
  })
  assert.equal(res2.ok, true)
  assert.equal(res2.data.phone, '13800138000')
})
