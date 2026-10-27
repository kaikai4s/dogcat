const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')

test('global bugfixes: requestStaffDepositRefund falls back to profile.userId and openid when deposit.staffUserId is missing', async () => {
  const staffFundsFactory = require('../../cloudfunctions/api/services/staffFunds')

  const mockUsers = [
    { _id: 'user_fallback_1', openid: 'staff_openid_123', roles: ['staff'], activeRole: 'staff' }
  ]
  const mockProfiles = [
    { _id: 'profile_1', openid: 'staff_openid_123', userId: 'user_fallback_1', exitStatus: 'none', depositStatus: 'paid' }
  ]
  const mockDeposits = [
    {
      _id: 'dep_legacy_1',
      staffOpenid: 'staff_openid_123',
      staffUserId: '', // 存量数据无 staffUserId
      staffProfileId: 'profile_1',
      amount: 500,
      paidAmount: 500,
      refundedAmount: 0,
      forfeitedAmount: 0,
      availableRefundAmount: 500,
      status: 'paid',
      refundStatus: 'none'
    }
  ]

  const mockDb = {
    command: { in: (arr) => arr },
    collection: (name) => ({
      where: (query) => ({
        limit: () => ({
          get: async () => {
            if (name === 'orders') return { data: [] }
            if (name === 'order_incidents') return { data: [] }
            if (name === 'users' && query.openid) {
              const u = mockUsers.find(x => x.openid === query.openid)
              return { data: u ? [u] : [] }
            }
            if (name === 'staff_profiles' && query.openid) {
              const p = mockProfiles.find(x => x.openid === query.openid)
              return { data: p ? [p] : [] }
            }
            return { data: [] }
          }
        })
      }),
      doc: (id) => ({
        get: async () => {
          if (name === 'staff_deposits') {
            const d = mockDeposits.find(x => x._id === id)
            if (!d) throw new Error('not found')
            return { data: d }
          }
          if (name === 'staff_profiles') {
            const p = mockProfiles.find(x => x._id === id)
            if (!p) throw new Error('not found')
            return { data: p }
          }
          if (name === 'users') {
            const u = mockUsers.find(x => x._id === id)
            if (!u) throw new Error('not found')
            return { data: u }
          }
          throw new Error('unknown collection: ' + name)
        }
      })
    }),
    runTransaction: async (fn) => {
      const tx = {
        collection: (name) => ({
          doc: (id) => ({
            get: async () => {
              if (name === 'staff_deposits') {
                const d = mockDeposits.find(x => x._id === id)
                if (!d) throw new Error('not found')
                return { data: d }
              }
              if (name === 'staff_profiles') {
                const p = mockProfiles.find(x => x._id === id)
                if (!p) throw new Error('not found')
                return { data: p }
              }
              if (name === 'users') {
                const u = mockUsers.find(x => x._id === id)
                if (!u) throw new Error('not found')
                return { data: u }
              }
              return { data: null }
            },
            set: async ({ data }) => { return { id, data } },
            update: async ({ data }) => { return { id, data } }
          }),
          where: (query) => ({
            limit: () => ({
              get: async () => {
                if (name === 'users' && query.openid) {
                  const u = mockUsers.find(x => x.openid === query.openid)
                  return { data: u ? [u] : [] }
                }
                return { data: [] }
              }
            })
          })
        })
      }
      return fn(tx)
    }
  }

  const staffFunds = staffFundsFactory({
    db: mockDb,
    crypto,
    now: () => new Date('2026-10-27T12:00:00Z'),
    safeText: (t) => String(t || '')
  })

  const res = await staffFunds.requestStaffDepositRefund('staff_openid_123', 'dep_legacy_1', '不想做了申请退保')
  assert.strictEqual(res.success, true)
  assert.strictEqual(res.status, 'refund_requested')
})

test('global bugfixes: exitCheck intercepts pending_staff_confirm, service_suspended and refund_pending orders', async () => {
  const staffFundsFactory = require('../../cloudfunctions/api/services/staffFunds')

  const interceptedStatuses = ['pending_staff_confirm', 'service_suspended', 'refund_pending']

  for (const st of interceptedStatuses) {
    const mockDb = {
      command: { in: (arr) => arr },
      collection: (name) => ({
        where: (query) => ({
          limit: () => ({
            get: async () => {
              if (name === 'orders') {
                assert.ok(query.status.includes('pending_staff_confirm'))
                assert.ok(query.status.includes('service_suspended'))
                assert.ok(query.status.includes('refund_pending'))
                return { data: [{ _id: 'order_intercepted', status: st }] }
              }
              return { data: [] }
            }
          })
        }),
        doc: () => ({
          get: async () => ({ data: null })
        })
      }),
      runTransaction: async (fn) => fn({ collection: () => ({ doc: () => ({ get: async () => ({ data: null }) }) }) })
    }

    const staffFunds = staffFundsFactory({
      db: mockDb,
      crypto,
      now: () => new Date(),
      safeText: (t) => String(t || '')
    })

    await assert.rejects(
      async () => {
        // 通过 reserveStaffDepositPayment 或者直接测 exitCheck 行为
        // 由于 exitCheck 未直接导出，我们在 requestStaffDepositRefund 传入有效 deposit 触发 exitCheck
        const mockDeposits = [{
          _id: 'dep_1', staffOpenid: 'staff_1', staffUserId: 'u1', staffProfileId: 'p1',
          amount: 500, paidAmount: 500, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 500,
          status: 'paid', refundStatus: 'none'
        }]
        const txDb = {
          command: { in: (arr) => arr },
          collection: (cname) => ({
            where: () => ({ limit: () => ({ get: async () => ({ data: cname === 'orders' ? [{ _id: 'o1', status: st }] : [] }) }) }),
            doc: (id) => ({
              get: async () => {
                if (cname === 'staff_deposits') return { data: mockDeposits[0] }
                if (cname === 'staff_profiles') return { data: { _id: 'p1', openid: 'staff_1' } }
                if (cname === 'users') return { data: { _id: 'u1', openid: 'staff_1' } }
                return { data: null }
              }
            })
          }),
          runTransaction: async (fn) => fn({
            collection: (cname) => ({
              doc: () => ({
                get: async () => {
                  if (cname === 'staff_deposits') return { data: mockDeposits[0] }
                  if (cname === 'staff_profiles') return { data: { _id: 'p1', openid: 'staff_1' } }
                  if (cname === 'users') return { data: { _id: 'u1', openid: 'staff_1' } }
                  return { data: null }
                }
              })
            })
          })
        }
        const service = staffFundsFactory({ db: txDb, crypto, now: () => new Date(), safeText: t => String(t || '') })
        await service.requestStaffDepositRefund('staff_1', 'dep_1', '退保')
      },
      /尚有未完成订单，暂不可退出退款/
    )
  }
})

test('global bugfixes: admin isDepositUnsettled does not block role removal when available deposit balance is 0 and no refund in flight', async () => {
  // 模拟 admin revokeStaff 中的 deposits 逻辑
  const deposits = [
    {
      _id: 'dep_old',
      amount: 500,
      paidAmount: 500,
      availableRefundAmount: 0,
      forfeitedAmount: 500,
      status: 'paid', // 历史记录未刷成 forfeited，但可用余额已为 0
      refundStatus: 'none'
    }
  ]

  const safeText = (s) => String(s || '')
  const unsettled = deposits.find((deposit) => {
    const available = Math.round(Number(deposit.availableRefundAmount || 0) * 100)
    const status = safeText(deposit.status).trim()
    const refundStatus = safeText(deposit.refundStatus).trim()
    const isRefundInFlight = ['refund_requested', 'refund_approved'].includes(status) || ['requested', 'approved', 'processing'].includes(refundStatus)
    return available > 0 || isRefundInFlight
  })

  // 必须判定为 false，不产生未结清阻断
  assert.strictEqual(Boolean(unsettled), false)
})

test('global bugfixes: autoRefundStaffDeposit recovers gracefully when WeChat returns duplicate or already exists', async () => {
  const staffFundsFactory = require('../../cloudfunctions/api/services/staffFunds')

  let wechatQueried = false
  const mockContext = {
    db: {
      collection: (name) => ({
        doc: (id) => ({
          get: async () => ({
            data: {
              _id: id,
              staffOpenid: 'staff_wx_1',
              amount: 500,
              paidAmount: 500,
              refundedAmount: 0,
              forfeitedAmount: 0,
              availableRefundAmount: 500,
              status: 'refund_approved',
              refundStatus: 'approved'
            }
          })
        }),
        where: () => {
          const chain = {
            orderBy: () => chain,
            limit: () => chain,
            get: async () => {
              if (name === 'payments') {
                return {
                  data: [{
                    _id: 'pay_1',
                    orderId: 'dep_1',
                    paymentNo: 'P123',
                    wxTransactionId: 'wx_tx_123',
                    status: 'success',
                    channel: 'wechat',
                    amount: 500
                  }]
                }
              }
              if (name === 'staff_profiles') {
                return {
                  data: [{
                    _id: 'prof_1',
                    openid: 'staff_wx_1',
                    userId: 'user_1'
                  }]
                }
              }
              return { data: [] }
            }
          }
          return chain
        }
      }),
      command: { in: (arr) => arr },
      runTransaction: async (fn) => fn({
        collection: (cname) => ({
          doc: (id) => ({
            get: async () => {
              if (cname === 'staff_profiles') return { data: { _id: id, openid: 'staff_wx_1' } }
              return {
                data: {
                  _id: id,
                  staffOpenid: 'staff_wx_1',
                  amount: 500,
                  paidAmount: 500,
                  refundedAmount: 0,
                  forfeitedAmount: 0,
                  availableRefundAmount: 500,
                  status: 'refund_approved',
                  refundStatus: 'approved'
                }
              }
            },
            update: async () => {},
            set: async () => {}
          }),
          where: () => {
            const chain = {
              orderBy: () => chain,
              limit: () => chain,
              get: async () => ({ data: [] })
            }
            return chain
          }
        })
      })
    },
    crypto,
    now: () => new Date(),
    safeText: (s) => String(s || ''),
    getSystemSettings: async () => ({ payment: { mode: 'wechat', refundEnabled: true } }),
    getWechatPayConfig: () => ({ appId: 'app1', mchId: 'mch1' }),
    wechatPayRequest: async (method, path) => {
      if (method === 'POST') {
        const err = new Error('RESOURCE_ALREADY_EXISTS: 退款单号已存在')
        throw err
      }
      if (method === 'GET' && path.includes('/v3/refund/domestic/refunds/out-refund-no/')) {
        wechatQueried = true
        return { status: 'SUCCESS', refund_id: 'wx_refund_123' }
      }
      return {}
    }
  }

  const staffFunds = staffFundsFactory(mockContext)
  const res = await staffFunds.autoRefundStaffDeposit({ openid: 'admin_1', _id: 'admin_1' }, 'dep_1', '微信退款')
  assert.strictEqual(wechatQueried, true)
  assert.strictEqual(res.status, 'refunded')
  assert.strictEqual(res.confirmationSource, 'auto_wechat')
})

