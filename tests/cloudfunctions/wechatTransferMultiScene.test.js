const test = require('node:test')
const assert = require('node:assert/strict')
const createStaffTraining = require('../../cloudfunctions/api/services/staffTraining')
const createWechatPay = require('../../cloudfunctions/api/services/wechatPay')
const createWechatTransfers = require('../../cloudfunctions/api/services/wechatTransfers')

test('staffTraining: normalizeStaffSuppliesConfig supports multi-scene transfer configuration', () => {
  const constants = require('../../cloudfunctions/api/config/constants')
  const service = createStaffTraining({
    ...constants,
    cloud: {}, db: {}, now: () => new Date(), safeText: s => String(s || ''),
    checkTextSecurity: async () => {}, idFor: () => 'id'
  })

  const normalized = service.normalizeStaffSuppliesConfig({
    transfer: {
      enabled: true,
      scenes: {
        commission: {
          sceneId: '1005',
          userRecvPerception: '宠托师服务收益提现',
          sceneReportInfos: [{ info_type: '岗位类型', info_content: '宠托师' }]
        },
        marketing: {
          sceneId: '1000',
          userRecvPerception: '活动推广现金奖励',
          sceneReportInfos: [{ info_type: '活动名称', info_content: '邀请好友有礼' }]
        },
        reimbursement: {
          sceneId: '1006',
          userRecvPerception: '一次性用品采购报销',
          sceneReportInfos: [{ info_type: '费用类型', info_content: '服务用品报销' }]
        }
      }
    }
  })

  assert.equal(normalized.transfer.enabled, true)
  assert.equal(normalized.transfer.sceneId, '1005')
  assert.equal(normalized.transfer.userRecvPerception, '宠托师服务收益提现')
  assert.equal(normalized.transfer.scenes.commission.sceneId, '1005')
  assert.equal(normalized.transfer.scenes.marketing.sceneId, '1000')
  assert.equal(normalized.transfer.scenes.reimbursement.sceneId, '1006')
  assert.deepEqual(normalized.transfer.scenes.marketing.sceneReportInfos, [{ info_type: '活动名称', info_content: '邀请好友有礼' }])
})

test('wechatPay: getWechatTransferConfig includes scenes in returned config', () => {
  const service = createWechatPay({
    crypto: require('node:crypto'),
    safeText: s => String(s || ''),
    now: () => new Date()
  })

  const settings = {
    payment: {
      enabled: true,
      mode: 'wechat',
      appId: 'wx_app_id',
      mchId: '1900000109',
      notifyUrl: 'https://pay.example.com/notify',
      certSerialNo: 'MCH_CERT_SERIAL',
      apiV3Key: '12345678901234567890123456789012',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----'
    },
    staffSupplies: {
      transfer: {
        enabled: true,
        scenes: {
          commission: { sceneId: '1005', userRecvPerception: '宠托师服务收益提现' },
          marketing: { sceneId: '1000', userRecvPerception: '活动推广现金奖励' }
        }
      }
    }
  }

  const config = service.getWechatTransferConfig(settings)
  assert.equal(config.transferEnabled, true)
  assert.equal(config.transferSceneId, '1005')
  assert.equal(config.userRecvPerception, '宠托师服务收益提现')
  assert.equal(config.scenes.marketing.sceneId, '1000')
})

test('wechatTransfers: resolveTransferScene and buildTransferPayload route between commission, marketing and reimbursement', () => {
  const transfersService = createWechatTransfers({
    db: { collection: () => ({ doc: () => ({ get: async () => ({ data: null }), update: async () => {} }) }) },
    now: () => new Date('2026-10-14T10:00:00Z'),
    safeText: s => String(s || ''),
    getSystemSettings: async () => ({}),
    getWechatTransferConfig: () => ({
      appId: 'wx123',
      transferMaxAmount: 5000,
      transferSceneId: '1005',
      userRecvPerception: '宠托师服务收益提现',
      sceneReportInfos: [{ info_type: '岗位类型', info_content: '宠托师' }],
      scenes: {
        commission: {
          sceneId: '1005',
          userRecvPerception: '宠托师服务收益提现',
          sceneReportInfos: [{ info_type: '岗位类型', info_content: '宠托师' }]
        },
        marketing: {
          sceneId: '1000',
          userRecvPerception: '活动推广现金奖励',
          sceneReportInfos: [
            { info_type: '活动名称', info_content: '邀请好友有礼' },
            { info_type: '奖励说明', info_content: '邀请好友现金奖励' }
          ]
        },
        reimbursement: {
          sceneId: '1006',
          userRecvPerception: '一次性用品采购报销',
          sceneReportInfos: [
            { info_type: '费用类型', info_content: '服务用品报销' }
          ]
        }
      }
    }),
    wechatPayRequest: async () => ({}),
    prepareWechatSubmissionQuota: async () => {},
    applyWechatTransferResult: () => ({}),
    markWechatWithdrawalFailed: () => ({})
  })

  const config = transfersService.getWechatTransferConfig ? transfersService.getWechatTransferConfig() : {
    appId: 'wx123',
    transferMaxAmount: 5000,
    transferSceneId: '1005',
    userRecvPerception: '宠托师服务收益提现',
    sceneReportInfos: [{ info_type: '岗位类型', info_content: '宠托师' }],
    scenes: {
      commission: {
        sceneId: '1005',
        userRecvPerception: '宠托师服务收益提现',
        sceneReportInfos: [{ info_type: '岗位类型', info_content: '宠托师' }]
      },
      marketing: {
        sceneId: '1000',
        userRecvPerception: '活动推广现金奖励',
        sceneReportInfos: [
          { info_type: '活动名称', info_content: '邀请好友有礼' },
          { info_type: '奖励说明', info_content: '邀请好友现金奖励' }
        ]
      },
      reimbursement: {
        sceneId: '1006',
        userRecvPerception: '一次性用品采购报销',
        sceneReportInfos: [
          { info_type: '费用类型', info_content: '服务用品报销' }
        ]
      }
    }
  }

  // 1. 宠托师佣金提现
  const staffPayload = transfersService.buildTransferPayload({
    outBillNo: 'bill_staff_1',
    staffOpenid: 'staff_openid_1',
    amount: 50
  }, config)
  assert.equal(staffPayload.transfer_scene_id, '1005')
  assert.equal(staffPayload.openid, 'staff_openid_1')
  assert.equal(staffPayload.user_recv_perception, '宠托师服务收益提现')
  assert.deepEqual(staffPayload.transfer_scene_report_infos, [{ info_type: '岗位类型', info_content: '宠托师' }])

  // 2. 用户资产邀请奖励提现 (assetType: 'user')
  const marketingPayload = transfersService.buildTransferPayload({
    outBillNo: 'bill_user_1',
    assetType: 'user',
    userOpenid: 'client_openid_1',
    recipientOpenid: 'client_openid_1',
    amount: 10
  }, config)
  assert.equal(marketingPayload.transfer_scene_id, '1000')
  assert.equal(marketingPayload.user_recv_perception, '活动推广现金奖励')
  assert.deepEqual(marketingPayload.transfer_scene_report_infos, [
    { info_type: '活动名称', info_content: '邀请好友有礼' },
    { info_type: '奖励说明', info_content: '邀请好友现金奖励' }
  ])

  // 3. 用品采购报销打款 (assetType: 'reimbursement')
  const reimbursementPayload = transfersService.buildTransferPayload({
    outBillNo: 'bill_reimb_1',
    assetType: 'reimbursement',
    staffOpenid: 'staff_openid_1',
    amount: 30
  }, config)
  assert.equal(reimbursementPayload.transfer_scene_id, '1006')
  assert.equal(reimbursementPayload.user_recv_perception, '一次性用品采购报销')
  assert.deepEqual(reimbursementPayload.transfer_scene_report_infos, [{ info_type: '费用类型', info_content: '服务用品报销' }])

  assert.throws(
    () => transfersService.buildTransferPayload({ outBillNo: 'bill_too_large', staffOpenid: 'staff_openid_1', amount: 200.01 }, config),
    /单笔上限.*200\.00/
  )
  assert.throws(
    () => transfersService.buildTransferPayload({ outBillNo: 'bill_missing_recipient', amount: 1 }, config),
    /收款openid缺失/
  )
})

test('wechatTransfers: single commission scene is automatically reused for user marketing withdrawals', () => {
  const transfersService = createWechatTransfers({
    db: { collection: () => ({ doc: () => ({ get: async () => ({ data: null }), update: async () => {} }) }) },
    now: () => new Date('2026-10-14T10:00:00Z'),
    safeText: s => String(s || ''),
    getSystemSettings: async () => ({}),
    getWechatTransferConfig: () => ({}),
    wechatPayRequest: async () => ({}),
    prepareWechatSubmissionQuota: async () => {},
    applyWechatTransferResult: () => ({}),
    markWechatWithdrawalFailed: () => ({})
  })

  // Single-scene configuration: only 1005 commission scene is approved on WeChat Pay
  const singleSceneConfig = {
    appId: 'wx123',
    transferMaxAmount: 200,
    transferSceneId: '1005',
    userRecvPerception: '佣金报酬',
    scenes: {
      commission: {
        sceneId: '1005',
        userRecvPerception: '佣金报酬',
        sceneReportInfos: [
          { info_type: '岗位类型', info_content: '宠托师' },
          { info_type: '报酬说明', info_content: '宠托师上门服务收益提现' }
        ]
      },
      marketing: {
        sceneId: '1005'
      }
    }
  }

  // 1. Staff withdrawal uses 1005 (佣金报酬 automatically normalized to compliant 劳务报酬)
  const staffPayload = transfersService.buildTransferPayload({
    outBillNo: 'bill_staff_single',
    staffOpenid: 'staff_1',
    amount: 50
  }, singleSceneConfig)
  assert.equal(staffPayload.transfer_scene_id, '1005')
  assert.equal(staffPayload.user_recv_perception, '劳务报酬')
  assert.deepEqual(staffPayload.transfer_scene_report_infos, [
    { info_type: '岗位类型', info_content: '宠托师' },
    { info_type: '报酬说明', info_content: '宠托师上门服务收益提现' }
  ])

  // 2. User referral commission withdrawal also uses 1005 with compliant parameters
  const userPayload = transfersService.buildTransferPayload({
    outBillNo: 'bill_user_single',
    assetType: 'user',
    userOpenid: 'user_1',
    amount: 20
  }, singleSceneConfig)
  assert.equal(userPayload.transfer_scene_id, '1005')
  assert.equal(userPayload.user_recv_perception, '劳务报酬')
  assert.deepEqual(userPayload.transfer_scene_report_infos, [
    { info_type: '岗位类型', info_content: '平台推广顾问' },
    { info_type: '报酬说明', info_content: '邀请好友推广佣金提现' }
  ])
  assert.equal(userPayload.transfer_remark, '邀请好友推广佣金提现')
})

