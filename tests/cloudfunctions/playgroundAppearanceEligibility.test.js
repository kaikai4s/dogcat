const test = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')

test('Playground Appearance: eligibility rules (client 3 orders, staff 1 order, month quota, disable/enable)', async () => {
  const appearanceFactory = require('../../cloudfunctions/api/services/playground-appearance')
  const { publicAppearance } = require('../../cloudfunctions/api/services/playground-appearance-record')
  const { hash } = require('../../cloudfunctions/api/services/playground-world')

  let nowMs = new Date('2026-10-27T12:00:00+08:00').getTime()
  const users = [
    { _id: 'u_client_1', openid: 'openid_client_1', nickname: '客户张三', status: 'active', roles: ['client'] },
    { _id: 'u_staff_1', openid: 'openid_staff_1', nickname: '宠托师李四', status: 'active', roles: ['client', 'staff'] }
  ]
  const pets = [
    { _id: 'pet_cat_1', openid: 'openid_client_1', name: '咪咪', species: 'cat', deletedAt: null },
    { _id: 'pet_dog_1', openid: 'openid_staff_1', name: '旺财', species: 'dog', deletedAt: null }
  ]
  let orders = []
  let requests = []
  let bindings = []
  let plots = []
  let adminLogs = []

  const mockDb = {
    runTransaction: async (callback) => callback(mockDb),
    command: {
      set: (val) => val,
      gte: (val) => val,
      gt: (val) => val
    },
    collection: (cname) => ({
      where: (query) => {
        const chain = {
          orderBy: () => chain,
          limit: () => chain,
          count: async () => {
            let matched = 0
            if (cname === 'orders') {
              matched = orders.filter((o) => {
                if (query.clientOpenid && o.clientOpenid !== query.clientOpenid) return false
                if (query.staffOpenid && o.staffOpenid !== query.staffOpenid) return false
                if (query.status && o.status !== query.status) return false
                return true
              }).length
            }
            return { total: matched }
          },
          get: async () => {
            if (cname === 'users') {
              const u = users.filter((x) => !query.openid || x.openid === query.openid)
              return { data: u }
            }
            if (cname === 'pets') {
              const p = pets.filter((x) => !query.openid || x.openid === query.openid)
              return { data: p }
            }
            if (cname === 'orders') {
              const o = orders.filter((item) => {
                if (query.clientOpenid && item.clientOpenid !== query.clientOpenid) return false
                if (query.staffOpenid && item.staffOpenid !== query.staffOpenid) return false
                if (query.status && item.status !== query.status) return false
                return true
              })
              return { data: o }
            }
            if (cname === 'pet_playground_appearance_requests') {
              const r = requests.filter((item) => {
                if (query.ownerOpenid && item.ownerOpenid !== query.ownerOpenid) return false
                return true
              })
              return { data: r }
            }
            return { data: [] }
          }
        }
        return chain
      },
      doc: (id) => ({
        get: async () => {
          if (cname === 'users') {
            const u = users.find((x) => x._id === id)
            if (!u) throw new Error('user not found')
            return { data: u }
          }
          if (cname === 'pets') {
            const p = pets.find((x) => x._id === id)
            if (!p) throw new Error('pet not found')
            return { data: p }
          }
          if (cname === 'pet_playground_appearance_requests') {
            const r = requests.find((x) => x._id === id)
            if (!r) throw new Error('request not found')
            return { data: r }
          }
          if (cname === 'pet_playground_appearance_bindings') {
            const b = bindings.find((x) => x._id === id)
            return { data: b || null }
          }
          if (cname === 'pet_playground_plots') {
            const pl = plots.find((x) => x._id === id)
            return { data: pl || null }
          }
          return { data: null }
        },
        set: async ({ data }) => {
          if (cname === 'pet_playground_appearance_requests') {
            requests.push({ _id: id, ...data })
          }
          if (cname === 'pet_playground_appearance_bindings') {
            const idx = bindings.findIndex((x) => x._id === id)
            if (idx >= 0) bindings[idx] = { _id: id, ...data }
            else bindings.push({ _id: id, ...data })
          }
          if (cname === 'pet_playground_plots') {
            const idx = plots.findIndex((x) => x._id === id)
            if (idx >= 0) plots[idx] = { _id: id, ...data }
            else plots.push({ _id: id, ...data })
          }
          if (cname === 'admin_operation_logs') {
            adminLogs.push({ _id: id, ...data })
          }
          return { id }
        },
        update: async ({ data }) => {
          if (cname === 'users') {
            const u = users.find((x) => x._id === id)
            if (u) Object.assign(u, data)
          }
          if (cname === 'pets') {
            const p = pets.find((x) => x._id === id)
            if (p) Object.assign(p, data)
          }
          if (cname === 'pet_playground_appearance_requests') {
            const r = requests.find((x) => x._id === id)
            if (r) Object.assign(r, data)
          }
          if (cname === 'pet_playground_appearance_bindings') {
            const b = bindings.find((x) => x._id === id)
            if (b) Object.assign(b, data)
          }
          return { updated: 1 }
        }
      })
    })
  }

  const mockContext = {
    db: mockDb,
    cloud: {},
    nowMs: () => nowMs
  }

  const appearanceService = appearanceFactory(mockContext)

  // 1. 客户未完成 3 单：资格检查应不通过
  const opt1 = await appearanceService.options('openid_client_1')
  assert.strictEqual(opt1.eligibility.canApply, false)
  assert.strictEqual(opt1.eligibility.clientCompletedCount, 0)
  assert.strictEqual(opt1.eligibility.clientEarnedChances, 0)
  assert.strictEqual(opt1.eligibility.availableChances, 0)
  assert.strictEqual(opt1.eligibility.clientNextChanceNeeded, 3)
  assert.ok(opt1.eligibility.unavailableReason.includes('每完成3笔服务订单可获1次定制机会'))

  // 创建草稿直接拦截
  await assert.rejects(
    async () => {
      await appearanceService.createDraft('openid_client_1', { targetType: 'character' })
    },
    /未达到专属形象定制申请条件/
  )

  // 客户完成 2 单仍不通过（还差 1 单）
  orders.push({ _id: 'o1', clientOpenid: 'openid_client_1', status: 'completed' })
  orders.push({ _id: 'o2', clientOpenid: 'openid_client_1', status: 'completed' })
  const opt2 = await appearanceService.options('openid_client_1')
  assert.strictEqual(opt2.eligibility.canApply, false)
  assert.strictEqual(opt2.eligibility.clientCompletedCount, 2)
  assert.strictEqual(opt2.eligibility.availableChances, 0)
  assert.strictEqual(opt2.eligibility.clientNextChanceNeeded, 1)

  // 客户完成第 3 单：获得第 1 次机会！
  orders.push({ _id: 'o3', clientOpenid: 'openid_client_1', status: 'completed' })
  const opt3 = await appearanceService.options('openid_client_1')
  assert.strictEqual(opt3.eligibility.canApply, true)
  assert.strictEqual(opt3.eligibility.clientCompletedCount, 3)
  assert.strictEqual(opt3.eligibility.clientEarnedChances, 1)
  assert.strictEqual(opt3.eligibility.availableChances, 1)
  assert.strictEqual(opt3.eligibility.monthRemaining, 1)

  // 客户发起定制角色草稿
  const draftChar = await appearanceService.createDraft('openid_client_1', { targetType: 'character' })
  assert.ok(draftChar._id)
  assert.strictEqual(draftChar.targetType, 'character')

  // 模拟客户提交申请（进入 pending，消耗该次机会）
  const submitReq = requests.find((r) => r._id === draftChar._id)
  submitReq.status = 'pending'

  // 核心规则验证 A：本月已消耗额度，当月再次申请立即被月度限额（每月限1次）拦截
  const optMonthExceeded = await appearanceService.options('openid_client_1')
  assert.strictEqual(optMonthExceeded.eligibility.canApply, false)
  assert.strictEqual(optMonthExceeded.eligibility.totalEarnedChances, 1)
  assert.strictEqual(optMonthExceeded.eligibility.totalUsedChances, 1)
  assert.strictEqual(optMonthExceeded.eligibility.availableChances, 0)
  assert.strictEqual(optMonthExceeded.eligibility.monthRemaining, 0)

  await assert.rejects(
    async () => {
      await appearanceService.createDraft('openid_client_1', { targetType: 'pet', petId: 'pet_cat_1' })
    },
    /已全部使用/
  )

  // 核心规则验证 B：跨月后（到了11月），如果未完成新的3单，不能“因为之前完成过3单就每月白嫖1次机会”！
  nowMs = new Date('2026-11-05T12:00:00+08:00').getTime()
  const optNextMonth = await appearanceService.options('openid_client_1')
  // 11月份虽然月度限额恢复为1，但因总机会只有1次且已用完，可用机会仍为0，绝对不可申请！
  assert.strictEqual(optNextMonth.eligibility.monthRemaining, 1)
  assert.strictEqual(optNextMonth.eligibility.availableChances, 0)
  assert.strictEqual(optNextMonth.eligibility.canApply, false)
  assert.ok(optNextMonth.eligibility.unavailableReason.includes('已全部使用'))

  await assert.rejects(
    async () => {
      await appearanceService.createDraft('openid_client_1', { targetType: 'pet', petId: 'pet_cat_1' })
    },
    /已全部使用/
  )

  // 核心规则验证 C：客户在11月又完成了3单（累计达6单），获得第2次定制机会！
  orders.push({ _id: 'o4', clientOpenid: 'openid_client_1', status: 'completed' })
  orders.push({ _id: 'o5', clientOpenid: 'openid_client_1', status: 'completed' })
  orders.push({ _id: 'o6', clientOpenid: 'openid_client_1', status: 'completed' })

  const optEarnSecond = await appearanceService.options('openid_client_1')
  assert.strictEqual(optEarnSecond.eligibility.clientCompletedCount, 6)
  assert.strictEqual(optEarnSecond.eligibility.totalEarnedChances, 2)
  assert.strictEqual(optEarnSecond.eligibility.totalUsedChances, 1)
  assert.strictEqual(optEarnSecond.eligibility.availableChances, 1)
  assert.strictEqual(optEarnSecond.eligibility.monthRemaining, 1)
  assert.strictEqual(optEarnSecond.eligibility.canApply, true)

  // 此时可以为宠物猫咪发起定制草稿！
  const draftCat = await appearanceService.createDraft('openid_client_1', { targetType: 'pet', petId: 'pet_cat_1' })
  assert.ok(draftCat._id)
  assert.strictEqual(draftCat.targetType, 'pet')
  assert.strictEqual(draftCat.targetName, '咪咪')

  // 模拟猫咪定制提交
  const catReq = requests.find((r) => r._id === draftCat._id)
  catReq.status = 'pending'

  // 2. 宠托师资格验证：
  // 宠托师履约 0 单且客户 0 单时：不通过
  const optStaff0 = await appearanceService.options('openid_staff_1')
  assert.strictEqual(optStaff0.eligibility.canApply, false)
  assert.strictEqual(optStaff0.eligibility.isStaff, true)
  assert.strictEqual(optStaff0.eligibility.staffCompletedCount, 0)
  assert.strictEqual(optStaff0.eligibility.staffEarnedChances, 0)
  assert.strictEqual(optStaff0.eligibility.availableChances, 0)

  // 宠托师完成 1 单履约：获得 1 次机会！
  orders.push({ _id: 'o_staff_1', staffOpenid: 'openid_staff_1', status: 'completed' })
  const optStaff1 = await appearanceService.options('openid_staff_1')
  assert.strictEqual(optStaff1.eligibility.canApply, true)
  assert.strictEqual(optStaff1.eligibility.staffCompletedCount, 1)
  assert.strictEqual(optStaff1.eligibility.staffEarnedChances, 1)
  assert.strictEqual(optStaff1.eligibility.availableChances, 1)
  assert.strictEqual(optStaff1.eligibility.monthRemaining, 1)

  // 宠托师为宠物旺财申请定制草稿
  const draftPet = await appearanceService.createDraft('openid_staff_1', { targetType: 'pet', petId: 'pet_dog_1' })
  assert.ok(draftPet._id)
  assert.strictEqual(draftPet.targetType, 'pet')
  assert.strictEqual(draftPet.targetName, '旺财')

  // 模拟宠托师提交
  const petReq = requests.find((r) => r._id === draftPet._id)
  petReq.status = 'pending'

  // 宠托师已消耗机会后，可用机会归零，必须再次履约才能再获得机会
  const optStaffUsed = await appearanceService.options('openid_staff_1')
  assert.strictEqual(optStaffUsed.eligibility.availableChances, 0)
  assert.strictEqual(optStaffUsed.eligibility.canApply, false)
  assert.ok(optStaffUsed.eligibility.unavailableReason.includes('已全部使用'))

  // 宠托师再完成1单履约，可用机会再次变为 1
  orders.push({ _id: 'o_staff_2', staffOpenid: 'openid_staff_1', status: 'completed' })
  const optStaffSecond = await appearanceService.options('openid_staff_1')
  assert.strictEqual(optStaffSecond.eligibility.staffCompletedCount, 2)
  assert.strictEqual(optStaffSecond.eligibility.staffEarnedChances, 2)
  assert.strictEqual(optStaffSecond.eligibility.totalUsedChances, 1)
  assert.strictEqual(optStaffSecond.eligibility.availableChances, 1)

  // 3. 形象作废与重新启用验证
  // 模拟宠物旺财已绑定完成生效的专属形象
  const lookId = 'look_0123456789abcdef0123456789abcdef'
  const mockAtlas = {
    fileID: 'cloud://dev/packagePlayground/custom/test/walk.png',
    frames: 24,
    columns: 4,
    rows: 6,
    frameSize: 256
  }
  const appearanceDoc = {
    id: lookId,
    targetType: 'pet',
    targetId: 'pet_dog_1',
    ownerId: 'presence_' + hash('openid_staff_1'),
    revision: 1,
    walk: mockAtlas,
    disabled: false
  }

  const petDog = pets.find((p) => p._id === 'pet_dog_1')
  petDog.playgroundAppearance = { ...appearanceDoc }

  // 正常生效状态：publicAppearance 正常返回图集
  const activeAppearance = publicAppearance(petDog.playgroundAppearance, 'pet', 'pet_dog_1', 'openid_staff_1')
  assert.ok(activeAppearance)
  assert.strictEqual(activeAppearance.id, lookId)
  assert.strictEqual(activeAppearance.walk.frameSize, 256)

  // 管理员因宠托师违规作废专属形象
  const disableRes = await appearanceService.disableAppearance('admin_tester', {
    targetType: 'pet',
    targetId: 'pet_dog_1',
    ownerOpenid: 'openid_staff_1',
    reason: '宠托师私下接单违规，暂扣乐园专属形象'
  })
  assert.strictEqual(disableRes.success, true)
  assert.strictEqual(disableRes.disabled, true)
  assert.strictEqual(petDog.playgroundAppearance.disabled, true)
  assert.strictEqual(petDog.playgroundAppearance.disabledReason, '宠托师私下接单违规，暂扣乐园专属形象')

  // 此时庄园场景中：publicAppearance 返回 null（回退通用默认形象）
  const fallbackAppearance = publicAppearance(petDog.playgroundAppearance, 'pet', 'pet_dog_1', 'openid_staff_1')
  assert.strictEqual(fallbackAppearance, null)

  // 管理员处罚结束重新启用形象
  const enableRes = await appearanceService.enableAppearance('admin_tester', {
    targetType: 'pet',
    targetId: 'pet_dog_1',
    ownerOpenid: 'openid_staff_1'
  })
  assert.strictEqual(enableRes.success, true)
  assert.strictEqual(enableRes.disabled, false)
  assert.strictEqual(petDog.playgroundAppearance.disabled, false)

  // 场景中立即恢复专属图集
  const restoredAppearance = publicAppearance(petDog.playgroundAppearance, 'pet', 'pet_dog_1', 'openid_staff_1')
  assert.ok(restoredAppearance)
  assert.strictEqual(restoredAppearance.id, lookId)
})
