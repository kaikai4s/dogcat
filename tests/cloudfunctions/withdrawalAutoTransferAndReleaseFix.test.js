const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { createCollectionStore } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const createTransfers = require('../../cloudfunctions/api/services/wechatTransfers')
const createAdminHandler = require('../../cloudfunctions/api/handlers/admin')

test('sub-10-cent failed withdrawal allows release directly without gateway confirmation', async () => {
  const db = createCollectionStore({
    withdraw_requests: [{
      _id: 'w_small',
      staffOpenid: 'staff_1',
      amount: 0.07,
      payoutChannel: 'wechat_wallet',
      status: 'transfer_failed',
      earningIds: ['e_small']
    }],
    staff_earnings: [{
      _id: 'e_small',
      staffOpenid: 'staff_1',
      amount: 0.07,
      status: 'withdrawing',
      withdrawRequestId: 'w_small'
    }],
    finance_logs: []
  })
  const context = createContext({ db, cloud: {} })
  context.checkTextSecurity = async () => {}
  const res = await context.releaseFailedWithdrawal({ openid: 'admin' }, { id: 'w_small' })
  assert.equal(res.changed, true)
  assert.equal(db.state.withdraw_requests[0].status, 'rejected')
  assert.equal(db.state.withdraw_requests[0].transferStatus, 'released')
  assert.equal(db.state.staff_earnings[0].status, 'available')
  assert.equal(db.state.staff_earnings[0].withdrawRequestId, '')
})

test('querying WeChat when RESOURCE_NOT_EXISTS confirms gateway failure and allows release', async () => {
  const calls = []
  const db = createCollectionStore({
    withdraw_requests: [{
      _id: 'w_missing',
      staffOpenid: 'staff_1',
      amount: 1.00,
      payoutChannel: 'wechat_wallet',
      outBillNo: 'BILL_NOT_ON_WECHAT',
      status: 'transfer_failed',
      earningIds: ['e_missing']
    }],
    staff_earnings: [{
      _id: 'e_missing',
      staffOpenid: 'staff_1',
      amount: 1.00,
      status: 'withdrawing',
      withdrawRequestId: 'w_missing'
    }],
    finance_logs: []
  })
  const transfers = createTransfers({
    db, crypto, now: () => new Date(), safeText: v => String(v || ''),
    getSystemSettings: async () => ({}),
    getWechatTransferConfig: () => ({ mchId: 'merchant', appId: 'app', transferMaxAmount: 200, transferSceneId: '1005' }),
    wechatPayRequest: async (method, path) => {
      calls.push({ method, path })
      throw Object.assign(new Error('not found'), { code: 'RESOURCE_NOT_EXISTS' })
    },
    encryptWechatTransferUserName: () => '',
    sanitizeWechatTransferPayload: v => v,
    markWechatWithdrawalPaid: async () => {},
    markWechatWithdrawalFailed: async (id, result) => {
      await db.collection('withdraw_requests').doc(id).update({
        data: {
          status: 'transfer_failed',
          gatewayFailureConfirmed: result.gatewayTerminalConfirmed === true,
          wechatTransferState: result.state,
          lastTransferError: result.failReason
        }
      })
      return { request: db.state.withdraw_requests[0] }
    },
    prepareWechatSubmissionQuota: async () => {}
  })

  // Manual query on the failed transfer
  await transfers.queryWechatWithdrawalTransfer('w_missing')
  assert.equal(db.state.withdraw_requests[0].gatewayFailureConfirmed, true)
  assert.equal(db.state.withdraw_requests[0].wechatTransferState, 'NOT_FOUND')

  // Now release succeeds
  const context = createContext({ db, cloud: {} })
  context.checkTextSecurity = async () => {}
  const releaseRes = await context.releaseFailedWithdrawal({ openid: 'admin' }, { id: 'w_missing' })
  assert.equal(releaseRes.changed, true)
  assert.equal(db.state.staff_earnings[0].status, 'available')
  assert.equal(db.state.staff_earnings[0].withdrawRequestId, '')
})

test('refreshStaffEarnings cleans up stale withdrawRequestId on available earnings', async () => {
  const db = createCollectionStore({
    withdraw_requests: [{
      _id: 'w_old_rejected',
      staffOpenid: 'staff_1',
      amount: 0.35,
      status: 'rejected',
      transferStatus: 'released'
    }],
    staff_earnings: [{
      _id: 'e_stale',
      staffOpenid: 'staff_1',
      amount: 0.35,
      status: 'available',
      withdrawRequestId: 'w_old_rejected'
    }],
    payments: [],
    orders: []
  })
  const context = createContext({ db, cloud: {} })
  context.checkTextSecurity = async () => {}
  await context.refreshStaffEarnings('staff_1')
  assert.equal(db.state.staff_earnings[0].withdrawRequestId, '')
  assert.equal(db.state.staff_earnings[0].status, 'available')
})

test('admin auditWithdrawRequest automatically triggers submitWechatWithdrawalTransfer when approved', async () => {
  const transferCalls = []
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' },
      { _id: 'staff_1', openid: 'staff_1', roles: ['staff'], status: 'active' }
    ],
    withdraw_requests: [{
      _id: 'w_approve',
      staffOpenid: 'staff_1',
      amount: 50,
      payoutChannel: 'wechat_wallet',
      status: 'pending',
      earningIds: ['e_approve']
    }],
    staff_earnings: [{
      _id: 'e_approve',
      staffOpenid: 'staff_1',
      amount: 50,
      status: 'withdrawing',
      withdrawRequestId: 'w_approve'
    }],
    finance_logs: [],
    admin_operation_logs: [],
    platform_configs: [{
      key: 'system_settings',
      value: {
        staffSupplies: {
          transfer: { enabled: true }
        }
      }
    }]
  })
  const context = createContext({ db, cloud: {} })
  context.checkTextSecurity = async () => {}
  context.submitWechatWithdrawalTransfer = async (id, operator) => {
    transferCalls.push({ id, operator })
    await db.collection('withdraw_requests').doc(id).update({
      data: { status: 'transferring', transferStatus: 'processing' }
    })
    return {
      request: {
        ...db.state.withdraw_requests[0],
        status: 'transferring',
        transferStatus: 'processing'
      }
    }
  }

  const handler = createAdminHandler(context)
  const res = await handler('admin', 'auditWithdrawRequest', {
    id: 'w_approve',
    approved: true,
    auditRemark: '审核通过'
  })

  assert.equal(transferCalls.length, 1)
  assert.equal(transferCalls[0].id, 'w_approve')
  assert.equal(res.status, 'transferring')
  assert.equal(res.transferStatus, 'processing')
  assert.equal(res.autoTransferred, true)
})

test('admin auditWithdrawRequest: auto transfer failure automatically transitions to transfer_failed status', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' },
      { _id: 'staff_1', openid: 'staff_1', roles: ['staff'], status: 'active' }
    ],
    withdraw_requests: [{
      _id: 'w_fail_auto',
      staffOpenid: 'staff_1',
      amount: 0.07,
      payoutChannel: 'wechat_wallet',
      status: 'pending',
      earningIds: ['e_fail_auto']
    }],
    staff_earnings: [{
      _id: 'e_fail_auto',
      staffOpenid: 'staff_1',
      amount: 0.07,
      status: 'withdrawing',
      withdrawRequestId: 'w_fail_auto'
    }],
    finance_logs: [],
    admin_operation_logs: [],
    platform_configs: [{
      key: 'system_settings',
      value: {
        staffSupplies: {
          transfer: { enabled: true }
        }
      }
    }]
  })
  const context = createContext({ db, cloud: {} })
  context.checkTextSecurity = async () => {}
  context.submitWechatWithdrawalTransfer = async () => {
    throw new Error('用户姓名与微信支付实名不匹配 (NOT_AUTH_USER_NAME)')
  }

  const handler = createAdminHandler(context)
  const res = await handler('admin', 'auditWithdrawRequest', {
    id: 'w_fail_auto',
    approved: true,
    auditRemark: '审核通过'
  })

  assert.equal(res.status, 'transfer_failed')
  assert.equal(res.autoTransferred, false)
  assert.ok(res.transferError.includes('NOT_AUTH_USER_NAME'))
  assert.equal(db.state.withdraw_requests[0].status, 'transfer_failed')
})
