const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('module')
const EventEmitter = require('events')
const path = require('path')
const createRealNameVerification = require('../../cloudfunctions/api/services/realNameVerification')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function loadRealNameServiceWithJuheResponse(response) {
  const servicePath = path.resolve(__dirname, '../../cloudfunctions/api/services/realNameVerification.js')
  delete require.cache[require.resolve(servicePath)]
  const originalLoad = Module._load
  const requests = []

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'https') {
      return {
        request(options, callback) {
          const req = new EventEmitter()
          req.write = body => requests.push({ options, body })
          req.end = () => {
            const res = new EventEmitter()
            callback(res)
            process.nextTick(() => {
              res.emit('data', JSON.stringify(response))
              res.emit('end')
            })
          }
          req.destroy = () => {}
          req.setTimeout = () => {}
          return req
        }
      }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  try {
    const createService = require(servicePath)
    return {
      service: createService({ now: () => '2026-10-13 11:20:00', safeText: value => String(value || '') }),
      requests
    }
  } finally {
    Module._load = originalLoad
  }
}

test('realNameVerification: 身份证国标 GB 11643-1999 校验与脱敏', () => {
  const service = createRealNameVerification()

  // 1. 有效身份证测试 (数字校验码与X校验码)
  assert.equal(service.isValidIdCard('110101199003072383'), true)
  assert.equal(service.isValidIdCard('11010119900307002X'), true)
  assert.equal(service.isValidIdCard('11010119900307002x'), true) // 小写 x 兼容

  // 2. 校验码算错应拦截
  assert.equal(service.isValidIdCard('110101199003072384'), false) // 校验码应为 3，传了 4
  assert.equal(service.isValidIdCard('110101199003070020'), false) // 校验码应为 X，传了 0

  // 3. 非法日期应拦截
  assert.equal(service.isValidIdCard('110101199002302383'), false) // 2月30日不存在
  assert.equal(service.isValidIdCard('110101199013012383'), false) // 13月不存在
  assert.equal(service.isValidIdCard('110101185001012383'), false) // 年份过早

  // 4. 长度与字符非法
  assert.equal(service.isValidIdCard(''), false)
  assert.equal(service.isValidIdCard(null), false)
  assert.equal(service.isValidIdCard('123456'), false)
  assert.equal(service.isValidIdCard('11010119900307238A'), false)

  // 5. 脱敏函数测试
  assert.equal(service.maskIdCard('110101199003072383'), '110101********2383')
  assert.equal(service.maskIdCard('11010119900307002X'), '110101********002X')
  assert.equal(service.maskIdCard(''), '')
})

test('realNameVerification: 姓名与手机号合法性校验', () => {
  const service = createRealNameVerification()

  // 姓名校验
  assert.equal(service.isValidRealName('张三'), true)
  assert.equal(service.isValidRealName('诸葛孔明'), true)
  assert.equal(service.isValidRealName('买买提·艾力'), true)
  assert.equal(service.isValidRealName('Tom'), false)
  assert.equal(service.isValidRealName('张'), false) // 至少2个字
  assert.equal(service.isValidRealName(''), false)

  // 手机号校验
  assert.equal(service.isValidMobile('13800138000'), true)
  assert.equal(service.isValidMobile('19912345678'), true)
  assert.equal(service.isValidMobile('12800138000'), false) // 12 开头非法
  assert.equal(service.isValidMobile('1380013800'), false) // 10位
  assert.equal(service.isValidMobile('138001380001'), false) // 12位
})

test('realNameVerification: Mock/测试模式下的三要素核验流程', async () => {
  const service = createRealNameVerification({ now: () => '2026-10-13T10:00:00.000Z' })

  // 合法信息通过
  const resSuccess = await service.verifyTelecomThreeElements({
    realname: '李测试',
    idcard: '110101199003072383',
    mobile: '13812345678',
    mock: true
  })
  assert.equal(resSuccess.success, true)
  assert.equal(resSuccess.verified, true)
  assert.equal(resSuccess.resCode, '11')
  assert.equal(resSuccess.isMock, true)

  // 测试特定手机号/身份证模拟不一致
  const resFail = await service.verifyTelecomThreeElements({
    realname: '李测试',
    idcard: '110101199003072383',
    mobile: '13812340000', // 尾号 0000 触发模拟不一致
    mock: true
  })
  assert.equal(resFail.success, false)
  assert.equal(resFail.verified, false)
  assert.equal(resFail.resCode, '21')

  // 非法参数直接拒绝
  await assert.rejects(
    service.verifyTelecomThreeElements({
      realname: 'Invalid',
      idcard: '110101199003072383',
      mobile: '13812345678'
    }),
    /真实姓名格式不正确/
  )

  await assert.rejects(
    service.verifyTelecomThreeElements({
      realname: '张三',
      idcard: '110101199003072384', // 校验码错误
      mobile: '13812345678'
    }),
    /身份证号码格式不正确/
  )
})

test('submitStaffProfile 集成测试: 提交实名三要素并正确脱敏与落库', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_staff', openid: 'openid_staff', roles: ['client'], status: 'active', phone: '13800138000' }],
    staff_profiles: []
  })
  const fn = loadCloudFunction('api', db, 'openid_staff')

  // 1. 提交非法身份证应报错
  const resInvalid = await fn.main({
    module: 'staff',
    action: 'submitStaffProfile',
    data: {
      realName: '张三',
      gender: 'male',
      idCardNumber: '110101199003072384', // 错误校验码
      phone: '13800138000',
      serviceCity: '上海市',
      serviceAddress: '测试地址',
      serviceLatitude: 31.2,
      serviceLongitude: 121.5,
      idCardFrontFileId: 'cloud://front',
      idCardBackFileId: 'cloud://back',
      facePhotoFileId: 'cloud://face'
    }
  })
  assert.equal(resInvalid.ok, false)
  assert.match(resInvalid.message, /身份证号码格式不正确/)

  // 2. 提交合法身份证应通过并正确脱敏与标记核验
  const resValid = await fn.main({
    module: 'staff',
    action: 'submitStaffProfile',
    data: {
      realName: '张三',
      gender: 'male',
      idCardNumber: '110101199003072383',
      phone: '13800138000',
      serviceCity: '上海市',
      serviceAddress: '测试地址',
      serviceLatitude: 31.2,
      serviceLongitude: 121.5,
      idCardFrontFileId: 'cloud://front',
      idCardBackFileId: 'cloud://back',
      facePhotoFileId: 'cloud://face'
    }
  })
  assert.equal(resValid.ok, true, resValid.message)
  const saved = db.state.staff_profiles[0]
  assert.equal(saved.idCardNumber, '110101199003072383')
  assert.equal(saved.idCardMasked, '110101********2383')
  assert.equal(saved.realNameVerifyStatus, 'verified')
  assert.equal(saved.realNameVerifyResCode, '11')
})

test('submitStaffProfile 限频保护: 10分钟内超过5次提交自动拦截防刷', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_staff2', openid: 'openid_rate_limit', roles: ['client'], status: 'active', phone: '13800138000' }],
    staff_profiles: []
  })
  const fn = loadCloudFunction('api', db, 'openid_rate_limit')
  const payload = {
    realName: '张三',
    gender: 'male',
    idCardNumber: '110101199003072383',
    phone: '13800138000',
    serviceCity: '上海市',
    serviceAddress: '测试地址',
    serviceLatitude: 31.2,
    serviceLongitude: 121.5,
    idCardFrontFileId: 'cloud://front',
    idCardBackFileId: 'cloud://back',
    facePhotoFileId: 'cloud://face'
  }
  for (let i = 0; i < 5; i++) {
    const res = await fn.main({ module: 'staff', action: 'submitStaffProfile', data: payload })
    assert.equal(res.ok, true)
  }
  // 第 6 次必须被 rate limit 拦截
  const blocked = await fn.main({ module: 'staff', action: 'submitStaffProfile', data: payload })
  assert.equal(blocked.ok, false)
  assert.match(blocked.message, /实名认证提交过于频繁/)
})

test('admin: 管理员后台动态配置与清空聚合数据实名 Key', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' }],
    platform_configs: []
  })
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 初始读取为未配置
  const initial = await adminFn.main({ module: 'admin', action: 'getSystemSettings' })
  assert.equal(initial.ok, true)
  assert.equal(initial.data.juheTelecomKeyConfigured, '')

  // 2. 管理员保存新 Key
  const saved = await adminFn.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: { juheTelecomKeyInput: 'juhe_app_key_1234567890' }
  })
  assert.equal(saved.ok, true)
  assert.ok(saved.data.juheTelecomKeyConfigured)
  assert.match(saved.data.juheTelecomKeyConfigured, /^\w+\*+\w+$/) // 脱敏掩码

  // 3. 不传 input 再次保存其他设置，原有 Key 必须保留
  const updatedOther = await adminFn.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: { enableTestAddressMode: true }
  })
  assert.equal(updatedOther.ok, true)
  assert.ok(updatedOther.data.juheTelecomKeyConfigured)

  // 4. 传空字符串可以清空 Key 回到测试模式
  const cleared = await adminFn.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: { juheTelecomKeyInput: '' }
  })
  assert.equal(cleared.ok, true)
  assert.equal(cleared.data.juheTelecomKeyConfigured, '')
})

test('realNameVerification: 聚合数据真实接口成功响应映射正确', async () => {
  const { service, requests } = loadRealNameServiceWithJuheResponse({
    error_code: 0,
    result: {
      res: 1,
      rescode: '11',
      resmsg: '三要素身份验证一致',
      orderid: 'JH202610130001',
      type: 'CMCC',
      province: '上海',
      city: '上海'
    }
  })

  const result = await service.verifyTelecomThreeElements({
    realname: '张三',
    idcard: '110101199003072383',
    mobile: '13800138000',
    apiKey: 'real_app_key_123'
  })

  assert.equal(result.success, true)
  assert.equal(result.verified, true)
  assert.equal(result.resCode, '11')
  assert.equal(result.orderId, 'JH202610130001')
  assert.equal(result.operatorType, 'CMCC')
  assert.equal(result.province, '上海')
  assert.equal(result.city, '上海')
  assert.equal(result.verifiedAt, '2026-10-13 11:20:00')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].options.hostname, 'v.juhe.cn')
  assert.equal(requests[0].options.path, '/telecom/query')
  assert.match(requests[0].body, /key=real_app_key_123/)
  assert.match(requests[0].body, /idcard=110101199003072383/)
  assert.match(requests[0].body, /mobile=13800138000/)
  assert.match(requests[0].body, /detail=1/)
  assert.match(requests[0].body, /showid=1/)
})

test('realNameVerification: 聚合数据不一致和常见错误码会转成友好结果', async () => {
  const mismatch = loadRealNameServiceWithJuheResponse({
    error_code: 0,
    result: { res: 2, rescode: '22', resmsg: '不一致', orderid: 'JH202610130002' }
  })
  const mismatchResult = await mismatch.service.verifyTelecomThreeElements({
    realname: '张三',
    idcard: '110101199003072383',
    mobile: '13800138000',
    apiKey: 'real_app_key_123'
  })
  assert.equal(mismatchResult.success, false)
  assert.equal(mismatchResult.verified, false)
  assert.equal(mismatchResult.resCode, '22')
  assert.match(mismatchResult.message, /身份证号码与手机号实名登记不一致/)

  const notFound = loadRealNameServiceWithJuheResponse({ error_code: 220803, reason: '无记录' })
  const notFoundResult = await notFound.service.verifyTelecomThreeElements({
    realname: '张三',
    idcard: '110101199003072383',
    mobile: '13800138000',
    apiKey: 'real_app_key_123'
  })
  assert.equal(notFoundResult.verified, false)
  assert.equal(notFoundResult.resCode, 'NOT_FOUND')
  assert.match(notFoundResult.message, /运营商查询无此记录/)

  const overLimit = loadRealNameServiceWithJuheResponse({ error_code: 10012, reason: '超过每日可允许请求次数' })
  await assert.rejects(
    () => overLimit.service.verifyTelecomThreeElements({
      realname: '张三',
      idcard: '110101199003072383',
      mobile: '13800138000',
      apiKey: 'real_app_key_123'
    }),
    /调用次数已超限/
  )
})

test('submitStaffProfile: 聚合实名核验不一致会阻断宠托师资料落库', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'u_staff_mismatch', openid: 'openid_staff_mismatch', roles: ['client'], status: 'active', phone: '13812340000' }],
    staff_profiles: [],
    platform_configs: [{ key: 'system_settings', value: { juheTelecomKey: 'MOCK' } }],
    rate_limits: []
  })
  const fn = loadCloudFunction('api', db, 'openid_staff_mismatch')
  const blocked = await fn.main({
    module: 'staff',
    action: 'submitStaffProfile',
    data: {
      realName: '张三',
      gender: 'male',
      idCardNumber: '110101199003072383',
      phone: '13812340000',
      serviceCity: '上海市',
      serviceAddress: '测试地址',
      serviceLatitude: 31.2,
      serviceLongitude: 121.5,
      idCardFrontFileId: 'cloud://front',
      idCardBackFileId: 'cloud://back',
      facePhotoFileId: 'cloud://face'
    }
  })

  assert.equal(blocked.ok, false)
  assert.match(blocked.message || blocked.error, /实名|不一致|不匹配/)
  assert.equal(db.state.staff_profiles.length, 0)
})
