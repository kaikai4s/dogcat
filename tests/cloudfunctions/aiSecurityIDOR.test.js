const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createAiSecurityDb() {
  return createCollectionStore({
    users: [
      { _id: 'u_victim', openid: 'openid_victim', roles: ['client'], status: 'active', nickname: '受害者' },
      { _id: 'u_attacker', openid: 'openid_attacker', roles: ['client'], status: 'active', nickname: '攻击者' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['client', 'staff'], status: 'active', nickname: '服务宠托师' },
      { _id: 'u_admin', openid: 'openid_admin', roles: ['client', 'admin'], status: 'active', nickname: '平台管理员' }
    ],
    pets: [
      {
        _id: 'pet_victim',
        openid: 'openid_victim',
        name: '富贵',
        species: 'cat',
        breed: '金渐层',
        personality: '高冷胆小',
        specialNotes: '只吃特定冻干，陌生人进门易应激',
        weight: 4.5
      }
    ],
    orders: [
      {
        _id: 'order_victim_1',
        orderNo: 'MO202609230001',
        clientOpenid: 'openid_victim',
        clientUserId: 'u_victim',
        staffOpenid: 'openid_staff',
        status: 'completed',
        serviceSummary: '上门喂猫（特需护理）',
        petName: '富贵',
        createdAt: '2026-09-23 10:00'
      }
    ],
    checkin_logs: [
      {
        _id: 'chk_1',
        orderId: 'order_victim_1',
        eventType: 'feed',
        createdAt: '2026-09-23 10:30'
      },
      {
        _id: 'chk_2',
        orderId: 'order_victim_1',
        eventType: 'safety_check',
        createdAt: '2026-09-23 10:50'
      }
    ]
  })
}

const mockAiExt = {
  createModel() {
    return {
      async generateText() {
        return {
          choices: [{ message: { content: '建议多陪伴并按医嘱喂养。' } }]
        }
      }
    }
  }
}

test('aiPetAssistant: cross-user pet ID access is rejected with authorization error', async () => {
  const db = createAiSecurityDb()

  const attackerFn = loadCloudFunction('api', db, 'openid_attacker', { extend: { AI: mockAiExt } })
  const ownerFn = loadCloudFunction('api', db, 'openid_victim', { extend: { AI: mockAiExt } })

  // 1. 攻击者试图探查受害者的宠物资料
  const attackRes = await attackerFn.main({
    module: 'ai',
    action: 'aiPetAssistant',
    data: {
      question: '这只猫平时有什么特殊习惯？',
      petId: 'pet_victim'
    }
  })
  assert.equal(attackRes.ok, false)
  assert.match(attackRes.message, /无权访问/)

  // 2. 真实主人可以正常咨询
  const ownerRes = await ownerFn.main({
    module: 'ai',
    action: 'aiPetAssistant',
    data: {
      question: '猫咪最近食欲如何改善？',
      petId: 'pet_victim'
    }
  })
  assert.equal(ownerRes.ok, true)
  assert.equal(ownerRes.data.answer, '建议多陪伴并按医嘱喂养。')
})

test('generatePetVoice: cross-user pet ID voice generation is rejected with authorization error', async () => {
  const db = createAiSecurityDb()

  const attackerFn = loadCloudFunction('api', db, 'openid_attacker', { extend: { AI: mockAiExt } })
  const ownerFn = loadCloudFunction('api', db, 'openid_victim', { extend: { AI: mockAiExt } })

  // 1. 攻击者试图利用受害者的宠物生成心声语音探测性格和习惯
  const attackRes = await attackerFn.main({
    module: 'ai',
    action: 'generatePetVoice',
    data: {
      petId: 'pet_victim',
      startDate: '2026-09-23'
    }
  })
  assert.equal(attackRes.ok, false)
  assert.match(attackRes.message, /无权访问/)

  // 2. 真实主人正常生成语音
  const ownerRes = await ownerFn.main({
    module: 'ai',
    action: 'generatePetVoice',
    data: {
      petId: 'pet_victim',
      startDate: '2026-09-23'
    }
  })
  assert.equal(ownerRes.ok, true)
  assert.equal(ownerRes.data.name, '富贵')
})

test('aiGenerateReport: unauthorized order ID access is rejected, while order parties can access', async () => {
  const db = createAiSecurityDb()

  const attackerFn = loadCloudFunction('api', db, 'openid_attacker')
  const clientFn = loadCloudFunction('api', db, 'openid_victim')
  const staffFn = loadCloudFunction('api', db, 'openid_staff')
  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 无关用户试图窃取订单报告与打卡记录
  const attackRes = await attackerFn.main({
    module: 'ai',
    action: 'aiGenerateReport',
    data: {
      orderId: 'order_victim_1'
    }
  })
  assert.equal(attackRes.ok, false)
  assert.match(attackRes.message, /无权访问订单/)

  // 2. 订单宠物主可以正常生成并获取报告
  const clientRes = await clientFn.main({
    module: 'ai',
    action: 'aiGenerateReport',
    data: {
      orderId: 'order_victim_1'
    }
  })
  assert.equal(clientRes.ok, true)
  assert.match(clientRes.data.reportSummary, /富贵/)
  assert.match(clientRes.data.reportSummary, /关键服务打卡记录：2 次/)

  // 3. 负责该订单的宠托师可以生成报告
  const staffRes = await staffFn.main({
    module: 'ai',
    action: 'aiGenerateReport',
    data: {
      orderId: 'order_victim_1'
    }
  })
  assert.equal(staffRes.ok, true)
  assert.match(staffRes.data.reportSummary, /关键服务打卡记录：2 次/)

  // 4. 平台管理员可以生成/查阅报告
  const adminRes = await adminFn.main({
    module: 'ai',
    action: 'aiGenerateReport',
    data: {
      orderId: 'order_victim_1'
    }
  })
  assert.equal(adminRes.ok, true)
  assert.match(adminRes.data.reportSummary, /关键服务打卡记录：2 次/)
})
