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

test('mall: applyRefund enforces checkTextSecurity and checkImageSecurity', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    mall_orders: [
      {
        _id: 'mall_ord_1',
        orderNo: 'MO123456',
        clientOpenid: 'openid_client',
        clientUserId: 'u_client',
        status: 'shipped',
        paymentStatus: 'paid',
        payAmount: 88
      }
    ],
    risk_bypass_logs: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client', {
    security: securityMock,
    downloadFile: async ({ fileID }) => ({
      fileContent: fileID && fileID.includes('bad') ? Buffer.from('bad-image') : Buffer.from('good-image')
    })
  })

  // 1. 提交违规售后退款原因被拦截
  const resBadReason = await clientFn.main({
    module: 'mall',
    action: 'applyRefund',
    data: {
      orderId: 'mall_ord_1',
      reason: '这里有违规敏感词商品质量太差'
    }
  })
  assert.equal(resBadReason.ok, false)
  assert.match(resBadReason.message, /包含敏感或不合规|违规/)

  // 2. 提交违规凭证图片被拦截
  const resBadImg = await clientFn.main({
    module: 'mall',
    action: 'applyRefund',
    data: {
      orderId: 'mall_ord_1',
      reason: '正常退款申请',
      images: ['cloud://test/bad_refund_proof.jpg']
    }
  })
  assert.equal(resBadImg.ok, false)
  assert.match(resBadImg.message, /包含违规敏感内容|包含敏感或不合规|违规/)

  // 3. 正常退款申请成功
  const resOk = await clientFn.main({
    module: 'mall',
    action: 'applyRefund',
    data: {
      orderId: 'mall_ord_1',
      reason: '尺码不合适',
      images: ['cloud://test/good_refund_proof.jpg']
    }
  })
  assert.equal(resOk.ok, true)
  assert.equal(resOk.data.refundStatus, 'applied')
})

test('client: saveAddress enforces checkTextSecurity', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    user_addresses: [],
    risk_bypass_logs: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client', {
    security: securityMock
  })

  // 1. 提交包含违规敏感词的详细地址
  const resBad = await clientFn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      serviceAddress: '北京市朝阳区阳光花园',
      addressDetail: '1单元包含违规敏感词',
      doorplate: '1001'
    }
  })
  assert.equal(resBad.ok, false)
  assert.match(resBad.message, /包含敏感或不合规|违规/)

  // 2. 正常地址保存成功
  const resOk = await clientFn.main({
    module: 'client',
    action: 'saveAddress',
    data: {
      serviceAddress: '北京市朝阳区阳光花园',
      addressDetail: '1号楼1单元',
      doorplate: '1001室'
    }
  })
  assert.equal(resOk.ok, true)
  assert.ok(resOk.data._id)
})

test('pet & staff: beauty photos and staff background checkImageSecurity', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    pets: [
      {
        _id: 'pet_1',
        openid: 'openid_client',
        name: '可可',
        avatarFileId: 'cloud://test/good_avatar.jpg',
        beautyPhotos: []
      }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'openid_staff',
        userId: 'u_staff',
        realName: '张师傅',
        auditStatus: 'approved',
        serviceAddress: '北京市海淀区中关村南大街1号',
        serviceLatitude: 39.95,
        serviceLongitude: 116.32,
        profileBackgroundFileId: ''
      }
    ],
    risk_bypass_logs: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client', {
    security: securityMock,
    downloadFile: async ({ fileID }) => ({
      fileContent: fileID && fileID.includes('bad') ? Buffer.from('bad-image') : Buffer.from('good-image')
    })
  })

  const staffFn = loadCloudFunction('api', db, 'openid_staff', {
    security: securityMock,
    downloadFile: async ({ fileID }) => ({
      fileContent: fileID && fileID.includes('bad') ? Buffer.from('bad-image') : Buffer.from('good-image')
    })
  })

  // 1. 宠物上传违规相册美照
  const resBadPetPhoto = await clientFn.main({
    module: 'pet',
    action: 'createPet',
    data: {
      name: '乐乐',
      avatarFileId: 'cloud://test/good_avatar.jpg',
      beautyPhotos: [
        { fileId: 'cloud://test/bad_beauty.jpg' }
      ]
    }
  })
  assert.equal(resBadPetPhoto.ok, false)
  assert.match(resBadPetPhoto.message, /包含违规敏感内容|包含敏感或不合规|违规/)

  // 2. 宠托师更新违规主页背景图
  const resBadStaffBg = await staffFn.main({
    module: 'staff',
    action: 'updateStaffProfileConfig',
    data: {
      profileBackgroundFileId: 'cloud://test/bad_bg.jpg'
    }
  })
  assert.equal(resBadStaffBg.ok, false)
  assert.match(resBadStaffBg.message, /包含违规敏感内容|包含敏感或不合规|违规/)
})

test('couponIssuance: totalIssueLimit prevents overissuance in fallback mode', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    orders: [],
    mall_orders: [],
    coupon_templates: [
      {
        _id: 'tpl_limited',
        name: '限量优惠券',
        type: 'fixed_discount',
        discountAmount: 10,
        minOrderAmount: 50,
        totalIssueLimit: 1,
        issuedCount: 1,
        perUserLimit: 5,
        newbieOnly: true,
        enabled: true
      }
    ],
    user_coupons: [],
    platform_configs: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client')

  // 发放已达到总限量的券应抛出异常
  const res = await clientFn.main({
    module: 'coupon',
    action: 'claimNewbieCoupon',
    data: {
      templateId: 'tpl_limited'
    }
  })
  assert.equal(res.ok, false)
  assert.match(res.message, /发放上限/)
})
