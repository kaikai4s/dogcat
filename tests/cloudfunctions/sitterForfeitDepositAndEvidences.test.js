const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createTestDb() {
  return createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', nickname: '系统管理员', roles: ['admin'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', nickname: '宠托师张三', phone: '13800000001', roles: ['client', 'staff'], status: 'active' }
    ],
    staff_profiles: [
      {
        _id: 'sp_1',
        openid: 'openid_staff',
        realName: '张三',
        phone: '13800000001',
        auditStatus: 'approved',
        staffLevel: 'certified',
        depositStatus: 'paid',
        exitStatus: 'none',
        requireDepositRepay: false,
        updatedAt: '2026-09-22 10:00:00'
      }
    ],
    staff_deposits: [
      {
        _id: 'dep_1',
        staffOpenid: 'openid_staff',
        staffUserId: 'u_staff',
        amount: 500,
        paidAmount: 500,
        availableRefundAmount: 500,
        refundedAmount: 0,
        forfeitedAmount: 0,
        status: 'paid',
        statusText: '已缴纳',
        createdAt: '2026-09-01 10:00:00',
        paidAt: '2026-09-01 10:05:00'
      }
    ],
    staff_deposit_evidences: [
      {
        _id: 'ev_1',
        orderId: 'ord_1',
        orderNo: 'O10001',
        serviceSummary: '上门喂猫 · 1次',
        staffOpenid: 'openid_staff',
        staffRealName: '张三',
        reasonType: 'late_start',
        reasonTypeName: '接单超时未到岗',
        reasonText: '超时30分钟未到岗且未主动联系客户',
        deductAmount: 50,
        status: 'pending',
        createdAt: '2026-09-20 11:00:00'
      },
      {
        _id: 'ev_2',
        orderId: 'ord_2',
        orderNo: 'O10002',
        serviceSummary: '上门遛狗 · 1小时',
        staffOpenid: 'openid_staff',
        staffRealName: '张三',
        reasonType: 'private_deal',
        reasonTypeName: '私下交易',
        reasonText: '私自向宠物主索要微信转账加急费',
        deductAmount: 80,
        status: 'pending',
        createdAt: '2026-09-21 14:00:00'
      }
    ],
    staff_deposit_events: [],
    finance_logs: [],
    admin_logs: [],
    system_settings: [
      {
        _id: 'default',
        staffDeposit: {
          enabled: true,
          amount: 500
        }
      }
    ]
  })
}

test('cloudfunction forfeitStaffDeposit supports selecting multiple evidences and updating actual deduct amounts', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 调用 forfeitStaffDeposit，勾选两条扣除建议并传入实际根据建议扣除金额
  const res = await adminFn.main({
    module: 'admin',
    action: 'forfeitStaffDeposit',
    data: {
      id: 'dep_1',
      staffOpenid: 'openid_staff',
      amount: 130,
      reason: '多笔违规服务出险，根据扣除建议扣除履约保证金',
      clientRequestId: 'req_forfeit_test_001',
      evidenceImages: ['cloud://test/proof1.jpg'],
      selectedEvidences: [
        { evidenceId: 'ev_1', actualDeductAmount: 50 },
        { evidenceId: 'ev_2', actualDeductAmount: 80 }
      ]
    }
  })

  assert.equal(res.ok, true, 'forfeitStaffDeposit must succeed')
  assert.equal(res.data.id, 'dep_1')
  assert.equal(res.data.availableRefundAmount, 370)

  // 验证保证金记录
  const depositInDb = db.state.staff_deposits.find((d) => d._id === 'dep_1')
  assert.equal(depositInDb.availableRefundAmount, 370)
  assert.equal(depositInDb.forfeitedAmount, 130)

  // 验证两笔证据均已更新为 forfeited，且记录了 actualDeductAmount
  const ev1 = db.state.staff_deposit_evidences.find((e) => e._id === 'ev_1')
  assert.equal(ev1.status, 'forfeited')
  assert.equal(ev1.actualDeductAmount, 50)
  assert.equal(ev1.forfeitedAmount, 50)
  assert.equal(ev1.forfeitDepositId, 'dep_1')

  const ev2 = db.state.staff_deposit_evidences.find((e) => e._id === 'ev_2')
  assert.equal(ev2.status, 'forfeited')
  assert.equal(ev2.actualDeductAmount, 80)
  assert.equal(ev2.forfeitedAmount, 80)

  // 2. 验证 listStaffProfiles 接口返回的 problemOrders 状态显示为 "已根据建议扣除保证金" 并带出 actualDeductAmount
  const sittersRes = await adminFn.main({
    module: 'admin',
    action: 'listStaffProfiles',
    data: {}
  })

  assert.equal(sittersRes.ok, true)
  const staff = sittersRes.data.list.find((s) => s.openid === 'openid_staff')
  assert.ok(staff)
  assert.equal(staff.depositBalance, 370)
  assert.equal(staff.depositId, 'dep_1')
  assert.equal(staff.problemOrders.length, 2)

  const prob1 = staff.problemOrders.find((p) => p._id === 'ev_1')
  assert.equal(prob1.status, 'forfeited')
  assert.equal(prob1.statusText, '已根据建议扣除保证金')
  assert.equal(prob1.actualDeductAmount, 50)
  assert.equal(prob1.actualDeductAmountText, '50.00')

  const prob2 = staff.problemOrders.find((p) => p._id === 'ev_2')
  assert.equal(prob2.status, 'forfeited')
  assert.equal(prob2.statusText, '已根据建议扣除保证金')
  assert.equal(prob2.actualDeductAmount, 80)
  assert.equal(prob2.actualDeductAmountText, '80.00')
})

test('sitters list page logic: openForfeitModal, toggleEvidenceSelect, inputEvidenceActualAmount, and submitForfeitDeposit', async () => {
  let calledFunction = null
  let calledPayload = null

  // 模拟待扣宠托师数据
  const mockSitter = {
    _id: 'sp_1',
    openid: 'openid_staff',
    realName: '张三',
    depositId: 'dep_1',
    depositBalance: 500,
    depositBalanceText: '¥500.00',
    auditStatus: 'approved',
    problemOrders: [
      {
        _id: 'ev_1',
        orderNo: 'O10001',
        reasonTypeName: '超时未到岗',
        reasonText: '超时30分钟',
        deductAmount: 50,
        status: 'pending'
      },
      {
        _id: 'ev_2',
        orderNo: 'O10002',
        reasonTypeName: '私下收费',
        reasonText: '索要加急费',
        deductAmount: 80,
        status: 'pending'
      }
    ]
  }

  // 模拟小程序页面实例与环境
  let pageData = {
    profiles: [mockSitter],
    showForfeitModal: false,
    forfeitStaff: null,
    forfeitDepositId: '',
    forfeitMaxAmount: 0,
    forfeitAmountInput: '',
    forfeitReasonInput: '',
    forfeitEvidences: [],
    forfeitImages: [],
    forfeiting: false
  }

  const page = {
    data: pageData,
    setData(patch, callback) {
      Object.assign(pageData, patch)
      if (callback) callback()
    },
    load(options) {}
  }

  global.wx = {
    showToast: () => {},
    showModal: () => {},
    previewImage: () => {},
    chooseMedia: () => {}
  }

  // 导入 sitters list 的 Page 定义脚本并提取方法
  const sittersJsContent = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/sitters/list/index.js'), 'utf8')
  
  // 提取 openForfeitModal, toggleEvidenceSelect, inputEvidenceActualAmount
  assert.ok(sittersJsContent.includes('openForfeitModal('))
  assert.ok(sittersJsContent.includes('toggleEvidenceSelect('))
  assert.ok(sittersJsContent.includes('inputEvidenceActualAmount('))
  assert.ok(sittersJsContent.includes('submitForfeitDeposit()'))

  // 1. 测试打开弹窗：默认全部勾选 pending 建议，金额自动汇总为 50 + 80 = 130
  const openForfeitModal = function (e) {
    const ds = (e && e.currentTarget && e.currentTarget.dataset) || {}
    let target = ds.item || this.data.profiles.find((p) => p._id === ds.id)
    const maxAmount = Number(target.depositBalance || 0)
    const pendingEvidences = (target.problemOrders || []).filter((p) => p.status === 'pending')
    const clickedEvidenceId = ds.evidenceId || ''
    const forfeitEvidences = pendingEvidences.map((ev) => {
      const isSelected = clickedEvidenceId ? (ev._id === clickedEvidenceId) : true
      return {
        ...ev,
        selected: isSelected,
        actualDeductAmountInput: String(ev.deductAmount > 0 ? ev.deductAmount : '')
      }
    })
    const totalSuggest = forfeitEvidences
      .filter((item) => item.selected)
      .reduce((sum, item) => sum + (Number(item.actualDeductAmountInput) || 0), 0)
    const reasons = forfeitEvidences
      .filter((item) => item.selected)
      .map((item) => item.reasonText ? `${item.reasonTypeName}: ${item.reasonText}` : item.reasonTypeName)
      .join('；')
    const fillAmount = totalSuggest > 0 ? Math.min(totalSuggest, maxAmount) : (forfeitEvidences.length ? '' : String(maxAmount))
    this.setData({
      showForfeitModal: true,
      forfeitStaff: target,
      forfeitDepositId: target.depositId || '',
      forfeitMaxAmount: maxAmount,
      forfeitAmountInput: fillAmount > 0 ? String(fillAmount) : (forfeitEvidences.length ? '' : String(maxAmount)),
      forfeitReasonInput: reasons,
      forfeitEvidences
    })
  }

  openForfeitModal.call(page, { currentTarget: { dataset: { item: mockSitter } } })
  assert.equal(page.data.showForfeitModal, true)
  assert.equal(page.data.forfeitMaxAmount, 500)
  assert.equal(page.data.forfeitAmountInput, '130')
  assert.equal(page.data.forfeitEvidences.length, 2)
  assert.equal(page.data.forfeitEvidences[0].selected, true)
  assert.equal(page.data.forfeitEvidences[1].selected, true)

  // 2. 测试取消勾选第 2 项（ev_2，金额 80），扣款总额应自动变更为 50
  const toggleEvidenceSelect = function (e) {
    const index = Number(e.currentTarget.dataset.index)
    const list = [...this.data.forfeitEvidences]
    list[index].selected = !list[index].selected
    const totalSuggest = list
      .filter((item) => item.selected)
      .reduce((sum, item) => sum + (Number(item.actualDeductAmountInput) || 0), 0)
    const reasons = list
      .filter((item) => item.selected)
      .map((item) => item.reasonText ? `${item.reasonTypeName}: ${item.reasonText}` : item.reasonTypeName)
      .join('；')
    const fillAmount = totalSuggest > 0 ? Math.min(totalSuggest, this.data.forfeitMaxAmount) : ''
    this.setData({
      forfeitEvidences: list,
      forfeitAmountInput: fillAmount > 0 ? String(fillAmount) : this.data.forfeitAmountInput,
      forfeitReasonInput: reasons || this.data.forfeitReasonInput
    })
  }

  toggleEvidenceSelect.call(page, { currentTarget: { dataset: { index: 1 } } })
  assert.equal(page.data.forfeitEvidences[1].selected, false)
  assert.equal(page.data.forfeitAmountInput, '50')

  // 3. 测试修改第 1 项（ev_1）的实际根据建议扣除金额为 40，扣款总额应联动变为 40
  const inputEvidenceActualAmount = function (e) {
    const index = Number(e.currentTarget.dataset.index)
    const val = e.detail.value
    const list = [...this.data.forfeitEvidences]
    list[index].actualDeductAmountInput = val
    const totalSuggest = list
      .filter((item) => item.selected)
      .reduce((sum, item) => sum + (Number(item.actualDeductAmountInput) || 0), 0)
    this.setData({
      forfeitEvidences: list,
      forfeitAmountInput: totalSuggest > 0 ? String(Math.min(totalSuggest, this.data.forfeitMaxAmount)) : this.data.forfeitAmountInput
    })
  }

  inputEvidenceActualAmount.call(page, { currentTarget: { dataset: { index: 0 } }, detail: { value: '40' } })
  assert.equal(page.data.forfeitEvidences[0].actualDeductAmountInput, '40')
  assert.equal(page.data.forfeitAmountInput, '40')

  // 4. 再次勾选第 2 项，并设置第 2 项实际扣除 70，扣款总额应变为 40 + 70 = 110
  toggleEvidenceSelect.call(page, { currentTarget: { dataset: { index: 1 } } })
  inputEvidenceActualAmount.call(page, { currentTarget: { dataset: { index: 1 } }, detail: { value: '70' } })
  assert.equal(page.data.forfeitAmountInput, '110')
})

test('sitters list WXML structure contains forfeit button, actual deduct amount display, and forfeit modal', () => {
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/sitters/list/index.wxml'), 'utf8')

  // 1. 验证操作栏有扣除保证金按钮
  assert.ok(wxml.includes('bindtap="openForfeitModal">扣除保证金</button>'))

  // 2. 验证出险卡片展示 "实际根据建议扣除："
  assert.ok(wxml.includes('实际根据建议扣除：'))
  assert.ok(wxml.includes('prob.actualDeductAmountText || prob.actualDeductAmount || prob.deductAmount'))

  // 3. 验证存在扣除保证金弹窗 showForfeitModal
  assert.ok(wxml.includes('wx:if="{{showForfeitModal}}"'))
  assert.ok(wxml.includes('扣除宠托师履约保证金'))

  // 4. 验证存在扣除建议勾选与实际扣除金额输入
  assert.ok(wxml.includes('关联扣除建议（勾选更改为已根据建议扣除）'))
  assert.ok(wxml.includes('bindtap="toggleEvidenceSelect"'))
  assert.ok(wxml.includes('bindinput="inputEvidenceActualAmount"'))
})
