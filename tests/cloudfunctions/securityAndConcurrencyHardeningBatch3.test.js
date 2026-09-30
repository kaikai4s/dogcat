const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

const securityMock = {
  msgSecCheck: async ({ content }) => {
    if (content && content.includes('违规敏感词')) {
      const err = new Error('内容包含违法违规信息')
      err.errCode = 87014
      throw err
    }
    return { errCode: 0, errMsg: 'ok' }
  },
  imgSecCheck: async ({ media }) => {
    if (media && media.value && media.value.toString().includes('bad-image')) {
      const err = new Error('图片包含违规内容')
      err.errCode = 87014
      throw err
    }
    return { errCode: 0, errMsg: 'ok' }
  }
}

test('ai & pet: aiPetAssistant and recognizePetBreed enforce content security', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    pets: [
      { _id: 'pet_1', openid: 'openid_client', name: '豆豆', species: 'dog', breed: '柯基', weight: 10 }
    ],
    risk_bypass_logs: [],
    platform_configs: []
  })

  let modelReturnText = '这是健康的宠物护理建议'
  const mockAiModel = {
    generateText: async () => ({
      choices: [{ message: { content: modelReturnText } }]
    })
  }

  const clientFn = loadCloudFunction('api', db, 'openid_client', {
    security: securityMock,
    downloadFile: async ({ fileID }) => ({
      fileContent: fileID && fileID.includes('bad') ? Buffer.from('bad-image') : Buffer.from('good-image')
    }),
    extend: {
      AI: {
        createModel: () => mockAiModel
      }
    }
  })

  // 1. aiPetAssistant 提问包含违规词被拦截
  const resBadQ = await clientFn.main({
    module: 'ai',
    action: 'aiPetAssistant',
    data: {
      question: '请问如何购买违规敏感词商品？',
      petId: 'pet_1'
    }
  })
  assert.equal(resBadQ.ok, false)
  assert.match(resBadQ.message, /包含敏感或不合规|违规/)

  // 2. aiPetAssistant 模型回答包含违规敏感词被拦截
  modelReturnText = '这个回答里面包含了违规敏感词内容'
  const resBadA = await clientFn.main({
    module: 'ai',
    action: 'aiPetAssistant',
    data: {
      question: '狗狗最近食欲不好怎么办？',
      petId: 'pet_1'
    }
  })
  assert.equal(resBadA.ok, false)
  assert.match(resBadA.message, /包含敏感或不合规|违规/)

  // 3. aiPetAssistant 正常问答成功
  modelReturnText = '建议少食多餐，观察精神状态，适量饮水。'
  const resGood = await clientFn.main({
    module: 'ai',
    action: 'aiPetAssistant',
    data: {
      question: '狗狗最近食欲不好怎么办？',
      petId: 'pet_1'
    }
  })
  assert.equal(resGood.ok, true)
  assert.match(resGood.data.answer, /少食多餐/)

  // 4. recognizePetBreed 上传违规图片被拦截
  const resBadImg = await clientFn.main({
    module: 'pet',
    action: 'recognizePetBreed',
    data: {
      avatarFileId: 'cloud://test/bad-image.jpg'
    }
  })
  assert.equal(resBadImg.ok, false)
  assert.match(resBadImg.message, /包含违规敏感内容|包含敏感或不合规|违规/)
})

test('order & mall: createOrder enforces address and notes text security', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', phone: '13800000000', roles: ['client'], status: 'active' }
    ],
    pets: [
      { _id: 'pet_1', openid: 'openid_client', name: '花花', species: 'cat' }
    ],
    orders: [],
    mall_products: [
      {
        _id: 'prod_1',
        name: '猫抓板',
        status: 'on_sale',
        specMode: 'single',
        stock: 10,
        skus: [{ skuId: 'default', stock: 10, price: 29.9 }],
        price: 29.9
      }
    ],
    mall_orders: [],
    risk_bypass_logs: [],
    service_prices: [
      { serviceType: 'cat_care', basePrice: 50, durationMinutes: 60, status: 'active' }
    ],
    platform_configs: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client', {
    security: securityMock
  })

  // 1. 服务订单地址包含违规敏感词被拦截
  const resBadOrderAddr = await clientFn.main({
    module: 'order',
    action: 'createOrder',
    data: {
      petIds: ['pet_1'],
      serviceType: 'cat_care',
      serviceAddress: '北京市海淀区中关村南大街违规敏感词号院',
      addressDetail: '1号楼1单元',
      doorplate: '101',
      serviceDate: '2026-10-10',
      startTime: '2026-10-10 14:00',
      durationMinutes: 60,
      saveAddress: false
    }
  })
  assert.equal(resBadOrderAddr.ok, false)
  assert.match(resBadOrderAddr.message, /包含敏感或不合规|违规/)

  // 2. 商城订单收货地址包含违规敏感词被拦截
  const resBadMallAddr = await clientFn.main({
    module: 'mall',
    action: 'createOrder',
    data: {
      productId: 'prod_1',
      skuId: 'default',
      quantity: 1,
      shippingAddress: {
        contactName: '张三',
        contactPhone: '13800000000',
        serviceAddress: '北京市朝阳区',
        addressDetail: '这里有违规敏感词内容',
        doorplate: '502'
      }
    }
  })
  assert.equal(resBadMallAddr.ok, false)
  assert.match(resBadMallAddr.message, /包含敏感或不合规|违规/)
})

test('lottery: totalIssueLimit prevents overissuance and compensates points', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', points: 0 }
    ],
    lottery_activities: [
      {
        _id: 'act_1',
        name: '国庆转盘大抽奖',
        enabled: true,
        prizes: [
          {
            id: 'prize_coupon',
            name: '大额神券',
            type: 'coupon',
            templateId: 'tpl_limited',
            probability: 100,
            stockLeft: 10
          }
        ]
      }
    ],
    coupon_templates: [
      {
        _id: 'tpl_limited',
        name: '50元神券',
        type: 'fixed_discount',
        discountAmount: 50,
        minOrderAmount: 100,
        totalIssueLimit: 1,
        issuedCount: 1, // 已达到上限
        enabled: true
      }
    ],
    user_coupons: [],
    lottery_records: [],
    point_logs: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client')

  // 抽中已达总限量的优惠券，自动折算积分补偿
  const res = await clientFn.main({
    module: 'lottery',
    action: 'draw',
    data: {
      activityId: 'act_1'
    }
  })
  assert.equal(res.ok, true)
  assert.match(res.data.prizeName, /已发完折算10积分/)
  assert.equal(res.data.points, 10)
  assert.equal(res.data.couponId, '')

  // 确保 user_coupons 没有被超发写入
  const userCoupons = await db.collection('user_coupons').where({ openid: 'openid_client' }).get()
  assert.equal(userCoupons.data.length, 0)
})

test('staff: submitSupplyReimbursement enforces checkImageSecurity and checkTextSecurity', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'openid_staff',
        userId: 'u_staff',
        realName: '李师傅',
        auditStatus: 'approved',
        staffLevel: 'certified'
      }
    ],
    staff_supply_reimbursements: [],
    risk_bypass_logs: []
  })

  const staffFn = loadCloudFunction('api', db, 'openid_staff', {
    security: securityMock,
    downloadFile: async ({ fileID }) => ({
      fileContent: fileID && fileID.includes('bad') ? Buffer.from('bad-image') : Buffer.from('good-image')
    })
  })

  // 1. 提交违规凭证截图被拦截
  const resBadImg = await staffFn.main({
    module: 'staff',
    action: 'submitSupplyReimbursement',
    data: {
      mediaFileIds: ['cloud://test/bad-image.jpg'],
      amount: 50,
      remark: '购买牵引绳和拾便袋'
    }
  })
  assert.equal(resBadImg.ok, false)
  assert.match(resBadImg.message, /包含违规敏感内容|包含敏感或不合规|违规/)

  // 2. 提交包含违规敏感词的备注被拦截
  const resBadText = await staffFn.main({
    module: 'staff',
    action: 'submitSupplyReimbursement',
    data: {
      mediaFileIds: ['cloud://test/good-receipt.jpg'],
      amount: 50,
      remark: '这里有违规敏感词买用品'
    }
  })
  assert.equal(resBadText.ok, false)
  assert.match(resBadText.message, /包含敏感或不合规|违规/)

  // 3. 正常报销申请成功
  const resOk = await staffFn.main({
    module: 'staff',
    action: 'submitSupplyReimbursement',
    data: {
      mediaFileIds: ['cloud://test/good-receipt.jpg'],
      amount: 50,
      remark: '购买首次服务工具包'
    }
  })
  assert.equal(resOk.ok, true)
  assert.equal(resOk.data.status, 'pending')
})
