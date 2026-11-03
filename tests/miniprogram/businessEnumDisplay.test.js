const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const format = require('../../miniprogram/utils/format')

const root = path.resolve(__dirname, '../../miniprogram')
const flush = () => new Promise(resolve => setImmediate(resolve))

function createPage(file, respond) {
  let page
  const calls = [], errors = []
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    Page(config) { page = config },
    wx: { showToast() {} },
    require(name) {
      if (name.endsWith('/format')) return format
      return {
        callFunction(module, action, data) { calls.push({ module, action, data }); return Promise.resolve(respond(action, data)) },
        showError(error) { errors.push(error) }
      }
    }
  })
  page.setData = function (patch, callback) { Object.assign(this.data, patch); if (callback) callback.call(this) }
  return { page, calls, errors }
}

const logs = [
  { _id: 'lottery', sourceType: 'lottery_reward', delta: 20, balance: 30, reason: '抽奖获得 20 积分', createdAt: '2026-11-02T01:00:00Z' },
  { _id: 'duplicate', sourceType: 'pet_title_duplicate', delta: 10, balance: 40 },
  { _id: 'care', sourceType: 'playground_care', delta: 5, balance: 45 },
  { _id: 'unknown', sourceType: 'future_reward', delta: -2, balance: 43, reason: '备注 ABC_123' },
  { _id: 'empty', delta: 1, balance: 44 }
]

test('client point history localizes current and unknown sources across pagination', async () => {
  const { page, calls, errors } = createPage('pages/client/points/index.js', (_, data) => ({
    logs: data.page === 1 ? logs.slice(0, 3) : logs.slice(3), page: data.page, total: logs.length, points: 44, totalPoints: 46
  }))
  page.load(1)
  await flush()
  assert.deepEqual(Array.from(page.data.logs, log => log.sourceLabel), ['抽奖奖励', '重复头衔补偿', '每日关爱照料'])
  page.loadMore()
  await flush()
  assert.deepEqual(Array.from(page.data.logs, log => log.sourceLabel), ['抽奖奖励', '重复头衔补偿', '每日关爱照料', '其他积分变动', '其他积分变动'])
  assert.equal(page.data.logs[3].sourceType, 'future_reward')
  assert.equal(page.data.logs[3].reason, '备注 ABC_123')
  assert.equal(page.data.logs[3].delta, -2)
  assert.equal(page.data.logs[3].sign, '')
  assert.equal(page.data.logs[0].sign, '+')
  assert.equal(page.data.logs[0].createdAt, '11-02 09:00')
  assert.equal(page.data.points, 44)
  assert.equal(page.data.totalPoints, 46)
  assert.deepEqual(calls.map(call => call.data.page), [1, 2])
  assert.equal(errors.length, 0)
})

test('admin point history uses the same Chinese labels for paged and legacy responses', async () => {
  const { page, calls, errors } = createPage('pages/admin/points/index.js', (_, data) => ({
    list: data.page === 1 ? logs.slice(0, 3) : logs.slice(3), total: logs.length, hasMore: data.page === 1
  }))
  page.load(true)
  await flush()
  page.onReachBottom()
  await flush()
  assert.deepEqual(Array.from(page.data.logs, log => log.sourceLabel), ['抽奖奖励', '重复头衔补偿', '每日关爱照料', '其他积分变动', '其他积分变动'])
  assert.equal(page.data.logs[3].reason, '备注 ABC_123')
  assert.equal(page.data.logs[3].sourceType, 'future_reward')
  assert.deepEqual(calls.map(call => call.data.page), [1, 2])
  assert.equal(errors.length, 0)
  const legacy = createPage('pages/admin/points/index.js', () => logs).page
  legacy.load(true)
  await flush()
  assert.equal(legacy.data.logs[0].sourceLabel, '抽奖奖励')
  assert.equal(legacy.data.logs[4].sourceLabel, '其他积分变动')
})

test('asset records localize earnings and unknown transfer states without trusting raw display fields', async () => {
  const summary = {
    availableAmount: 5,
    earnings: [{ sourceType: 'invite_binding', amount: 3 }, { sourceType: 'future_earning', amount: 2 }],
    withdraws: [
      { _id: 'known', status: 'transferring', payoutChannel: 'wechat_wallet', wechatTransferState: 'WAIT_USER_CONFIRM' },
      { _id: 'unknown', status: 'future_status', statusText: 'future_status', wechatTransferState: 'FUTURE_STATE', wechatTransferStateText: 'FUTURE_STATE' }
    ]
  }
  const { page, errors } = createPage('pages/client/profile/assets/index.js', action => action === 'getUserAssetSummary' ? summary : {})
  page.setData({ invitationMaintenance: true, maintenanceLoading: false })
  await page.load()
  assert.deepEqual(Array.from(page.data.summary.earnings, item => item.sourceLabel), ['邀请活动佣金', '其他收益'])
  assert.equal(page.data.summary.earnings[1].sourceType, 'future_earning')
  assert.equal(page.data.summary.withdraws[0].statusText, '待确认收款')
  assert.equal(page.data.summary.withdraws[0].canConfirmTransfer, true)
  assert.equal(page.data.summary.withdraws[1].statusText, '处理中')
  assert.equal(page.data.summary.withdraws[1].wechatTransferStateText, '微信处理状态待查询')
  assert.equal(page.data.summary.withdraws[1].wechatTransferState, 'FUTURE_STATE')
  page.setData({ invitationMaintenance: false, incomingInviteCode: 'OTHER' })
  await page.autoBindIncomingInvite({ inviteCode: 'SELF' })
  assert.deepEqual(Array.from(page.data.summary.earnings, item => item.sourceLabel), ['邀请活动佣金', '其他收益'])
  assert.equal(errors.length, 0)
})

test('playground service diary localizes enums and preserves separate custom summaries', async () => {
  let page, response
  const file = path.join(root, 'packagePlayground/pages/world.js')
  const context = vm.createContext({
    Page(config) { page = config },
    require(name) {
      if (name.endsWith('/format')) return format
      if (name.endsWith('/cloud')) return { callFunction: async () => response }
      return {}
    }
  })
  vm.runInContext(fs.readFileSync(file, 'utf8'), context)
  page.setData = patch => Object.assign(page.data, patch)
  const decorate = vm.runInContext('withServiceText', context)
  for (const [serviceType, serviceSummary, expected] of [
    ['feed', '', '喂养服务'],
    ['future_service', '', '其他服务'],
    ['walk', 'Custom care / 专业照料', 'Custom care / 专业照料']
  ]) {
    const raw = { serviceType, serviceSummary, staffName: '自由昵称 ABC_123' }
    assert.equal(decorate(raw).serviceTypeText, expected)
    assert.equal(raw.serviceTypeText, undefined)
    response = { activeOrder: raw, latestCheckins: [] }
    await page.loadServiceTwin()
    assert.equal(page.data.activeService.serviceTypeText, expected)
    assert.equal(page.data.serviceDiary.activeOrder.serviceTypeText, expected)
    assert.equal(page.data.activeService.serviceType, serviceType)
    assert.equal(page.data.activeService.staffName, raw.staffName)
  }
})

function files(directory, extension) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'node_modules') return []
    const file = path.join(directory, entry.name)
    return entry.isDirectory() ? files(file, extension) : entry.name.endsWith(extension) ? [file] : []
  })
}

test('every literal backend point-award source has a Chinese label', () => {
  const sources = new Set()
  const backend = path.resolve(__dirname, '../../cloudfunctions/api')
  for (const file of files(backend, '.js')) {
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\baddPoints\s*\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*'([^']+)'/g)) sources.add(match[1])
    if (file.endsWith('playground-disputes.js')) {
      for (const match of source.matchAll(/\baward\s*\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*'([^']+)'/g)) sources.add(match[1])
    }
  }
  assert.ok(sources.size >= 12, 'must discover the current award producers')
  for (const source of sources) assert.notEqual(format.formatPointSource(source), '其他积分变动', `Missing point source label: ${source}`)
})

test('visible WXML never prints raw business enums or falls back to their codes', () => {
  const enumField = '(?:status|sourceType|source|type|action|actorRole|eventType|serviceType|paymentStatus|refundStatus|transferStatus|wechatTransferState|targetType|staffLevel|onboardingStatus|videoAuditStatus|promotionStatus|auditStatus|errorCode|lastTransferErrorCode)'
  const rawValue = `(?:[a-zA-Z_$][\\w$]*\\.)+${enumField}`
  const direct = new RegExp(`^\\s*${rawValue}\\s*(?:\\|\\|[^]*)?$`)
  const fallback = new RegExp(`(?:\\|\\||:)\\s*${rawValue}\\s*$`)
  const violations = []
  for (const file of files(root, '.wxml')) {
    const markup = fs.readFileSync(file, 'utf8')
    const visible = markup.replace(/<!--[^]*?-->/g, '').replace(/<\/?[a-zA-Z!](?:[^"'<>]|"[^"]*"|'[^']*')*>/g, '')
    for (const match of visible.matchAll(/\{\{([^]*?)\}\}/g)) {
      if (direct.test(match[1]) || fallback.test(match[1])) violations.push(`${path.relative(root, file)}: {{${match[1]}}}`)
    }
  }
  assert.deepEqual(violations, [])
})
