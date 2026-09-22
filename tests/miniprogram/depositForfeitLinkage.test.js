const test = require('node:test')
const assert = require('node:assert/strict')

test('goToFinanceDeposit in sitters list correctly serializes parameters for direct forfeit linkage', () => {
  let navigatedUrl = null
  global.wx = {
    navigateTo: ({ url }) => {
      navigatedUrl = url
    }
  }

  // 模拟 sitters/list 的 goToFinanceDeposit 方法
  const page = {
    goToFinanceDeposit(e) {
      const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
      const staffOpenid = ds.staffOpenid || ''
      const evidenceId = ds.evidenceId || ''
      const suggestAmount = ds.suggestAmount || ''
      const reason = encodeURIComponent(ds.reason || '')
      let url = '/pages/admin/finance/index?tab=deposits'
      if (staffOpenid) {
        url += `&staffOpenid=${staffOpenid}&evidenceId=${evidenceId}&suggestAmount=${suggestAmount}&reason=${reason}`
      }
      global.wx.navigateTo({ url })
    }
  }

  // Case 1: 带有留证和建议扣除金额
  page.goToFinanceDeposit({
    currentTarget: {
      dataset: {
        staffOpenid: 'staff_test_openid_123',
        evidenceId: 'evidence_999',
        suggestAmount: '150',
        reason: '接单超时未到岗: 迟到30分钟失联'
      }
    }
  })

  assert.ok(navigatedUrl.includes('/pages/admin/finance/index?tab=deposits'))
  assert.ok(navigatedUrl.includes('staffOpenid=staff_test_openid_123'))
  assert.ok(navigatedUrl.includes('evidenceId=evidence_999'))
  assert.ok(navigatedUrl.includes('suggestAmount=150'))
  assert.ok(navigatedUrl.includes('reason=' + encodeURIComponent('接单超时未到岗: 迟到30分钟失联')))

  // Case 2: 无特定违规参数的常规跳转
  page.goToFinanceDeposit({})
  assert.equal(navigatedUrl, '/pages/admin/finance/index?tab=deposits')
})

test('admin finance page correctly parses direct forfeit parameters and auto-opens prefilled modal', async () => {
  let modalTitle = null
  let modalContent = null
  let toastTitle = null
  let storageMap = {}
  let calledFunction = null
  let calledPayload = null

  global.wx = {
    showModal: ({ title, content }) => {
      modalTitle = title
      modalContent = content
    },
    showToast: ({ title }) => {
      toastTitle = title
    },
    getStorageSync: (key) => storageMap[key],
    setStorageSync: (key, val) => { storageMap[key] = val },
    removeStorageSync: (key) => { delete storageMap[key] }
  }

  function money(value) {
    return Number(value || 0).toFixed(2)
  }

  function decorateStaffFinance(item) {
    const result = { ...item, id: item._id || item.id }
    ;['amount', 'paidAmount', 'refundedAmount', 'forfeitedAmount', 'availableRefundAmount', 'approvedAmount'].forEach((key) => {
      result[`${key}Text`] = item[key] === undefined || item[key] === null ? '待核实' : money(item[key])
    })
    result.refundPending = ['pending', 'requested', 'refund_requested', 'refund_pending'].includes(item.refundStatus) || ['refund_requested', 'refund_pending'].includes(item.status)
    result.canForfeit = item.availableRefundAmount > 0 && ['paid', 'partially_refunded'].includes(item.status) && !['requested', 'approved', 'processing', 'refunding', 'success'].includes(item.refundStatus)
    result.transferConfirmed = item.status === 'paid' || item.transferStatus === 'SUCCESS'
    return result
  }

  // 构造模拟的 finance page 实例
  const financePage = {
    data: {
      activeTab: 'withdraws',
      targetStaffOpenid: '',
      targetStaffLabel: '',
      forfeitEvidenceId: '',
      forfeitStaffName: '',
      deposits: [],
      supplies: [],
      showForfeitModal: false,
      forfeitDepositId: '',
      forfeitMaxAmount: 0,
      forfeitAmountInput: '',
      forfeitReasonInput: '',
      forfeiting: false
    },
    setData(patch, cb) {
      Object.assign(this.data, patch)
      if (typeof cb === 'function') cb()
    },
    onLoad(q) {
      const activeTab = (q && q.tab) ? q.tab : this.data.activeTab
      const targetStaffOpenid = (q && q.staffOpenid) || ''
      const targetEvidenceId = (q && q.evidenceId) || ''
      const suggestAmount = (q && q.suggestAmount) || ''
      const reason = (q && q.reason) ? decodeURIComponent(q.reason) : ''

      if (targetStaffOpenid) {
        this._autoForfeitParams = {
          staffOpenid: targetStaffOpenid,
          evidenceId: targetEvidenceId,
          suggestAmount,
          reason
        }
      }

      this.setData({
        activeTab,
        targetStaffOpenid
      })
    },
    clearStaffFilter() {
      this.setData({ targetStaffOpenid: '', targetStaffLabel: '' })
    },
    loadStaffFinanceMock(mockDeposits) {
      const rawDeposits = (mockDeposits || []).map(decorateStaffFinance)
      const targetStaffOpenid = this.data.targetStaffOpenid

      let targetStaffLabel = ''
      if (targetStaffOpenid) {
        const matched = rawDeposits.find(d => d.staffOpenid === targetStaffOpenid)
        if (matched) {
          targetStaffLabel = matched.staffRealName || matched.staffNickname || targetStaffOpenid
        }
      }

      this.setData({
        deposits: rawDeposits,
        targetStaffLabel
      })

      if (this._autoForfeitParams && this._autoForfeitParams.staffOpenid) {
        const params = this._autoForfeitParams
        this._autoForfeitParams = null

        const candidateDeposits = rawDeposits.filter(d => d.staffOpenid === params.staffOpenid)
        const target = candidateDeposits.find(d => d.canForfeit) || candidateDeposits[0]

        if (target) {
          if (target.canForfeit) {
            const maxAmount = Number(target.availableRefundAmount || 0)
            let fillAmount = maxAmount > 0 ? String(maxAmount) : ''
            if (params.suggestAmount && Number(params.suggestAmount) > 0) {
              const parsedSuggest = Number(params.suggestAmount)
              fillAmount = String(Math.min(parsedSuggest, maxAmount))
            }
            const fillReason = params.reason || '违规出险扣除保证金'
            this.setData({
              showForfeitModal: true,
              forfeitDepositId: target._id || target.id,
              forfeitMaxAmount: maxAmount,
              forfeitAmountInput: fillAmount,
              forfeitReasonInput: fillReason,
              forfeitEvidenceId: params.evidenceId || '',
              forfeitStaffName: target.staffRealName || target.staffNickname || target.staffOpenid
            })
          } else {
            global.wx.showModal({
              title: '无法扣除保证金',
              content: `宠托师（${target.staffRealName || target.staffNickname || params.staffOpenid}）当前保证金可用余额为 ¥${target.availableRefundAmountText || '0.00'}，暂无可扣除额度。`,
              showCancel: false
            })
          }
        } else {
          global.wx.showModal({
            title: '未找到保证金记录',
            content: `未找到宠托师（${params.staffOpenid}）的保证金缴纳记录，该宠托师可能尚未缴纳履约保证金。`,
            showCancel: false
          })
        }
      }
    },
    submitForfeitDepositMock(callFunc) {
      const id = this.data.forfeitDepositId
      const amount = Number(this.data.forfeitAmountInput)
      const maxAmount = this.data.forfeitMaxAmount
      const reason = String(this.data.forfeitReasonInput || '').trim()
      const evidenceId = this.data.forfeitEvidenceId || ''

      if (!amount || isNaN(amount) || amount <= 0) return
      if (amount > maxAmount) return
      if (!reason) return

      const payload = { id, amount, reason, clientRequestId: 'req_123' }
      if (evidenceId) {
        payload.evidenceId = evidenceId
      }

      callFunc('admin', 'forfeitStaffDeposit', payload)
    }
  }

  // 1. 测试自动预填及弹窗
  financePage.onLoad({
    tab: 'deposits',
    staffOpenid: 'sitter_alex',
    evidenceId: 'ev_001',
    suggestAmount: '80',
    reason: encodeURIComponent('违规私单交易')
  })

  assert.equal(financePage.data.activeTab, 'deposits')
  assert.equal(financePage.data.targetStaffOpenid, 'sitter_alex')

  const mockDeposits = [
    {
      _id: 'dep_alex',
      staffOpenid: 'sitter_alex',
      staffRealName: '亚历克斯',
      status: 'paid',
      refundStatus: 'none',
      availableRefundAmount: 200,
      amount: 200,
      paidAmount: 200
    },
    {
      _id: 'dep_bob',
      staffOpenid: 'sitter_bob',
      staffRealName: '鲍勃',
      status: 'paid',
      refundStatus: 'none',
      availableRefundAmount: 200,
      amount: 200,
      paidAmount: 200
    }
  ]

  financePage.loadStaffFinanceMock(mockDeposits)

  // 验证弹窗是否被自动唤起，且参数正确预填
  assert.equal(financePage.data.showForfeitModal, true)
  assert.equal(financePage.data.forfeitDepositId, 'dep_alex')
  assert.equal(financePage.data.forfeitMaxAmount, 200)
  assert.equal(financePage.data.forfeitAmountInput, '80') // 建议金额 80 < 200，取 80
  assert.equal(financePage.data.forfeitReasonInput, '违规私单交易')
  assert.equal(financePage.data.forfeitEvidenceId, 'ev_001')
  assert.equal(financePage.data.forfeitStaffName, '亚历克斯')
  assert.equal(financePage.data.targetStaffLabel, '亚历克斯')

  // 2. 验证提交时携带了 evidenceId
  financePage.submitForfeitDepositMock((module, action, payload) => {
    calledFunction = action
    calledPayload = payload
  })

  assert.equal(calledFunction, 'forfeitStaffDeposit')
  assert.equal(calledPayload.id, 'dep_alex')
  assert.equal(calledPayload.amount, 80)
  assert.equal(calledPayload.reason, '违规私单交易')
  assert.equal(calledPayload.evidenceId, 'ev_001')

  // 3. 验证清除筛选
  financePage.clearStaffFilter()
  assert.equal(financePage.data.targetStaffOpenid, '')
  assert.equal(financePage.data.targetStaffLabel, '')

  // 4. 验证当建议金额超出可用余额时，取最大可用余额
  financePage.onLoad({
    tab: 'deposits',
    staffOpenid: 'sitter_alex',
    evidenceId: 'ev_002',
    suggestAmount: '500', // 超出可用 200
    reason: encodeURIComponent('多次严重失联')
  })
  financePage.loadStaffFinanceMock(mockDeposits)
  assert.equal(financePage.data.forfeitAmountInput, '200') // 取 Math.min(500, 200) = 200

  // 5. 验证宠托师无可扣款额度时弹出友好提示
  const mockZeroDeposits = [
    {
      _id: 'dep_alex_zero',
      staffOpenid: 'sitter_alex',
      staffRealName: '亚历克斯',
      status: 'paid',
      refundStatus: 'none',
      availableRefundAmount: 0, // 余额为 0
      amount: 200,
      paidAmount: 200
    }
  ]
  financePage.onLoad({
    tab: 'deposits',
    staffOpenid: 'sitter_alex',
    evidenceId: 'ev_003',
    suggestAmount: '50'
  })
  financePage.loadStaffFinanceMock(mockZeroDeposits)
  assert.equal(modalTitle, '无法扣除保证金')
  assert.ok(modalContent.includes('暂无可扣除额度'))

  // 6. 验证未查到记录时的提示
  financePage.onLoad({
    tab: 'deposits',
    staffOpenid: 'sitter_unknown',
    evidenceId: 'ev_004',
    suggestAmount: '50'
  })
  financePage.loadStaffFinanceMock(mockDeposits)
  assert.equal(modalTitle, '未找到保证金记录')
})
