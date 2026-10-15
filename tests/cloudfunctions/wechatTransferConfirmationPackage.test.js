const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore } = require('./helpers')
const createWechatTransferService = require('../../cloudfunctions/api/services/wechatTransfers')
const createFinanceHandler = require('../../cloudfunctions/api/handlers/finance')
const validation = require('../../cloudfunctions/api/utils/validation')

test('applyWechatTransferResult preserves existing wechatPackageInfo on query responses', async () => {
  const db = createCollectionStore({
    withdraw_requests: [{
      _id: 'wd_001',
      status: 'transferring',
      payoutChannel: 'wechat_wallet',
      outBillNo: 'WD_001',
      wechatTransferState: 'WAIT_USER_CONFIRM',
      wechatPackageInfo: 'original_package_info_123',
      amount: 0.14
    }]
  })

  const service = createWechatTransferService({
    crypto: require('node:crypto'),
    db,
    getSystemSettings: async () => ({ payment: { mchId: 'mch_test', appId: 'app_test' } }),
    getWechatTransferConfig: () => ({ appId: 'app_test' }),
    wechatPayRequest: async () => ({}),
    encryptWechatTransferUserName: () => '',
    sanitizeWechatTransferPayload: (p) => p,
    markWechatWithdrawalPaid: async () => {},
    markWechatWithdrawalFailed: async () => {},
    prepareWechatSubmissionQuota: async () => {},
    now: () => new Date().toISOString(),
    ...validation
  })

  // Simulate query response from WeChat Pay (query API does not include package_info)
  await service.applyWechatTransferResult('wd_001', {
    state: 'WAIT_USER_CONFIRM',
    transfer_bill_no: '13300000001'
  }, 'query')

  const doc = db.state.withdraw_requests.find(w => w._id === 'wd_001')
  assert.equal(doc.wechatTransferState, 'WAIT_USER_CONFIRM')
  assert.equal(doc.wechatPackageInfo, 'original_package_info_123', 'Existing package_info should NOT be overwritten by empty query response')
})

test('getMyWithdrawTransferConfirmation auto-recovers packageInfo if WAIT_USER_CONFIRM was missing it', async () => {
  let submitCalled = false
  const db = createCollectionStore({
    withdraw_requests: [{
      _id: 'wd_002',
      staffOpenid: 'staff_1',
      status: 'transferring',
      payoutChannel: 'wechat_wallet',
      outBillNo: 'WD_002',
      wechatTransferState: 'WAIT_USER_CONFIRM',
      wechatPackageInfo: '', // Previously wiped or missing
      amount: 0.14
    }]
  })

  const mockSubmit = async (id) => {
    submitCalled = true
    const doc = db.state.withdraw_requests.find(w => w._id === id)
    doc.wechatPackageInfo = 'recovered_package_info_456'
    return { request: doc }
  }

  const handler = createFinanceHandler({
    db,
    getUser: async () => ({}),
    getSystemSettings: async () => ({ payment: { mchId: 'mch_123', appId: 'wx_123' } }),
    submitWechatWithdrawalTransfer: mockSubmit,
    readScopedDocuments: async () => [],
    safeText: validation.safeText
  })

  const res = await handler('staff_1', 'getMyWithdrawTransferConfirmation', { id: 'wd_002' })
  assert.equal(submitCalled, true, 'submitWechatWithdrawalTransfer should be invoked to recover package_info')
  assert.equal(res.status, 'WAIT_USER_CONFIRM')
  assert.equal(res.packageInfo, 'recovered_package_info_456')
  assert.equal(res.mchId, 'mch_123')
  assert.equal(res.appId, 'wx_123')
})
