const test = require('node:test')
const assert = require('node:assert/strict')
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
        requireDepositRepay: false
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
        staffOpenid: 'openid_staff',
        status: 'pending',
        suggestDeductAmount: 150,
        reason: '接单后私自向宠物主索要高额加急费，客户提供微信转账截图举证',
        createdAt: '2026-09-20 11:00:00'
      }
    ],
    staff_deposit_events: [],
    system_settings: [
      {
        _id: 'default',
        staffDeposit: {
          enabled: true,
          amount: 500,
          rulesText: '履约保证金500元',
          refundRulesText: '退出全额退还',
          forfeitRulesText: '违规将予以没收'
        }
      }
    ]
  })
}

test('admin forfeitStaffDeposit with internal evidence photos: saves images in staff_deposits, events, and evidences', async () => {
  const db = createTestDb()
  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  const evidencePhotos = [
    'cloud://dogcat-env/deposit_forfeits/evidence_chat_1.jpg',
    'cloud://dogcat-env/deposit_forfeits/evidence_payment_2.png'
  ]

  // 1. 管理员执行违规没收保证金并上传内部举证照片
  const forfeitRes = await adminFn.main({
    module: 'admin',
    action: 'forfeitStaffDeposit',
    data: {
      id: 'dep_1',
      amount: 150,
      reason: '私下加收费用违规留证',
      clientRequestId: 'forfeit_req_001',
      evidenceId: 'ev_1',
      evidenceImages: evidencePhotos
    }
  })

  assert.equal(forfeitRes.ok, true, 'forfeitStaffDeposit must succeed')
  assert.equal(forfeitRes.data.availableRefundAmount, 350)

  // 2. 验证 staff_deposits 中保存了 lastForfeitImages
  const depositInDb = db.state.staff_deposits.find((d) => d._id === 'dep_1')
  assert.deepEqual(depositInDb.lastForfeitImages, evidencePhotos, 'staff_deposits must store lastForfeitImages')

  // 3. 验证 staff_deposit_events 中保存了 evidenceImages
  const eventInDb = db.state.staff_deposit_events.find((e) => e.depositId === 'dep_1' && e.type === 'forfeit')
  assert.ok(eventInDb, 'forfeit event must exist in staff_deposit_events')
  assert.deepEqual(eventInDb.evidenceImages, evidencePhotos, 'event must include evidenceImages')

  // 4. 验证关联证据 staff_deposit_evidences 保存了 forfeitProofImages
  const evidenceInDb = db.state.staff_deposit_evidences.find((e) => e._id === 'ev_1')
  assert.equal(evidenceInDb.status, 'forfeited')
  assert.deepEqual(evidenceInDb.forfeitProofImages, evidencePhotos, 'evidence record must store forfeitProofImages')

  // 5. 管理员端获取保证金详情：必须能看到 internal evidence images
  const adminDetailRes = await adminFn.main({
    module: 'admin',
    action: 'getStaffDepositDetail',
    data: { staffOpenid: 'openid_staff' }
  })
  assert.equal(adminDetailRes.ok, true)
  assert.deepEqual(adminDetailRes.data.deposit.lastForfeitImages, evidencePhotos, 'admin must see lastForfeitImages in deposit')
  const forfeitEventForAdmin = adminDetailRes.data.events.find((e) => e.type === 'forfeit')
  assert.ok(forfeitEventForAdmin)
  assert.deepEqual(forfeitEventForAdmin.evidenceImages, evidencePhotos, 'admin must see evidenceImages in events')

  // 6. 宠托师端拉取保证金状态：严格数据脱敏，绝对不可见内部留存照片
  const staffStatusRes = await staffFn.main({
    module: 'staff',
    action: 'getDepositStatus'
  })
  assert.equal(staffStatusRes.ok, true)
  const sitterDeposit = staffStatusRes.data.deposit
  assert.ok(sitterDeposit, 'sitter deposit must be returned')
  assert.equal(sitterDeposit.availableRefundAmount, 350)
  assert.equal(sitterDeposit.lastForfeitImages, undefined, 'sitter deposit must NOT contain lastForfeitImages')
  assert.equal(sitterDeposit.evidenceImages, undefined, 'sitter deposit must NOT contain evidenceImages')
  assert.equal(sitterDeposit.forfeitProofImages, undefined, 'sitter deposit must NOT contain forfeitProofImages')

  // 7. 宠托师端查看保证金流水列表：事件中绝不包含 evidenceImages
  const sitterForfeitEvent = staffStatusRes.data.events.find((e) => e.type === 'forfeit')
  assert.ok(sitterForfeitEvent)
  assert.equal(sitterForfeitEvent.evidenceImages, undefined, 'sitter events must NOT leak evidenceImages')
  assert.equal(sitterForfeitEvent.reason, '私下加收费用违规留证', 'sitter can see reason text')
})
