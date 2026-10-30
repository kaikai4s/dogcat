const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const createContext = require('../../cloudfunctions/api/services/context')
const optimistic = require('./optimisticTransactions')

test('admin invitation settings persist a bounded personal cap and reject invalid values', async () => {
  const db = createCollectionStore({ platform_configs: [] })
  const service = createContext({ db, cloud: {} })
  await service.saveSystemSettings({ invitation: { enabled: true, rewardAmount: 5, maxRewardPerUser: 7.5 } })
  assert.equal((await service.getSystemSettings()).invitation.maxRewardPerUser, 7.5)
  for (const maxRewardPerUser of [-1, 7.555, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(() => service.saveSystemSettings({ invitation: { maxRewardPerUser } }), /邀请活动设置/)
  }
})

test('invite binding grants cash only after the invited user creates a pet profile', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin', roles: ['admin'], status: 'active' },
      { _id: 'u_inviter', openid: 'inviter', roles: ['client'], status: 'active' },
      { _id: 'u_invited', openid: 'invited', roles: ['client'], status: 'active', nickname: '好友小猫', avatarUrl: 'cloud://avatar' },
      { _id: 'u_invited2', openid: 'invited2', roles: ['client'], status: 'active', nickname: '好友小狗' }
    ],
    admins: [{ _id: 'a1', openid: 'admin', status: 'active', permissions: ['all'] }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { invitation: { enabled: true, rewardAmount: 5, userMinWithdrawAmount: 5, shareImageUrl: 'cloud://invite-cover' }, staffSupplies: { transfer: { enabled: false } } } }],
    user_invites: [], user_asset_earnings: [], withdraw_requests: [], retro_card_logs: [], finance_logs: [], admin_operation_logs: []
  })
  const inviter = loadCloudFunction('api', db, 'inviter')
  const invited = loadCloudFunction('api', db, 'invited')
  const invited2 = loadCloudFunction('api', db, 'invited2')
  const admin = loadCloudFunction('api', db, 'admin')
  const inviterLogin = await inviter.main({ module: 'auth', action: 'login', data: {} })
  await invited.main({ module: 'auth', action: 'login', data: { inviteCode: inviterLogin.data.inviteCode } })
  await invited.main({ module: 'auth', action: 'login', data: { inviteCode: inviterLogin.data.inviteCode } })
  assert.equal(db.state.user_invites.length, 1)
  assert.equal(db.state.user_asset_earnings.length, 0)
  const pending = await inviter.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(pending.data.invites[0].rewardStatusText, '待好友建档')
  const created = await invited.main({ module: 'pet', action: 'createPet', data: { name: '小猫', avatarFileId: 'cloud://pet.jpg' } })
  assert.equal(created.ok, true, created.message)
  assert.equal(db.state.user_asset_earnings.length, 1)
  assert.equal(db.state.user_asset_earnings[0].amount, 5)
  const summary = await inviter.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(summary.data.availableAmount, 5)
  assert.equal(summary.data.withdrawalRules.minAmountText, '¥5.00')
  assert.equal(summary.data.withdrawalRules.singleMaxAmountText, '¥200.00')
  assert.match(summary.data.withdrawalRules.requestTimeText, /00:00-24:00/)
  assert.match(summary.data.withdrawalRules.arrivalTimeText, /24小时/)
  assert.equal(summary.data.invitationShareImageUrl, 'cloud://invite-cover')
  assert.equal(summary.data.invites[0].invitedNickname, '好友小猫')
  assert.equal(summary.data.invites[0].invitedAvatarUrl, 'cloud://avatar')
  assert.equal(summary.data.invites[0].rewardAmount, 5)
  assert.equal(summary.data.invites[0].rewardStatusText, '已入账')
  db.state.platform_configs[0].value.invitation.rewardAmount = 3
  const changedSummary = await inviter.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(changedSummary.data.invites[0].rewardAmount, 5)
  await invited2.main({ module: 'auth', action: 'login', data: { inviteCode: inviterLogin.data.inviteCode } })
  assert.equal(db.state.user_asset_earnings.length, 1)
  const secondPet = await invited2.main({ module: 'pet', action: 'createPet', data: { name: '小狗', avatarFileId: 'cloud://pet2.jpg' } })
  assert.equal(secondPet.ok, true, secondPet.message)
  const secondSummary = await inviter.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(secondSummary.data.availableAmount, 8)
  assert.deepEqual(secondSummary.data.invites.map(row => row.rewardAmount).sort((a, b) => a - b), [3, 5])
  assert.deepEqual(db.state.user_asset_earnings.map(row => row.amount).sort((a, b) => a - b), [3, 5])
  const request = await inviter.main({ module: 'finance', action: 'createUserAssetWithdraw', data: { amount: 5, clientRequestId: 'asset-1' } })
  assert.equal(request.data.assetType, 'user')
  const approved = await admin.main({ module: 'admin', action: 'auditWithdrawRequest', data: { id: request.data._id, approved: true } })
  assert.equal(approved.data.status, 'approved')
})

test('invitation maintenance postpones rewards for existing bindings until maintenance ends', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'inviter', openid: 'inviter', roles: ['client'], status: 'active', inviteCode: 'INV123' },
      { _id: 'friend', openid: 'friend', roles: ['client'], status: 'active', inviterOpenid: 'inviter' }
    ],
    user_invites: [{ _id: 'invite_friend', inviterOpenid: 'inviter', invitedOpenid: 'friend', rewardAmount: 5 }],
    pets: [], user_asset_earnings: [],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: {
      maintenance: { invitation: true }, invitation: { enabled: true, rewardAmount: 5 }
    } }]
  })
  const friend = loadCloudFunction('api', db, 'friend')
  const inviter = loadCloudFunction('api', db, 'inviter')
  const created = await friend.main({ module: 'pet', action: 'createPet', data: { name: '小狗', avatarFileId: 'cloud://pet.jpg' } })
  assert.equal(created.ok, true, created.message)
  assert.equal((await friend.main({ module: 'auth', action: 'login', data: {} })).ok, true)
  assert.equal(db.state.user_asset_earnings.length, 0)
  const paused = await inviter.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(paused.data.invites[0].rewardStatusText, '活动维护中')

  db.state.platform_configs[0].value.maintenance.invitation = false
  assert.equal((await friend.main({ module: 'auth', action: 'login', data: {} })).ok, true)
  assert.equal(db.state.user_asset_earnings.length, 1)
  assert.equal(db.state.user_asset_earnings[0].amount, 5)
  const resumed = await inviter.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(resumed.data.invites[0].rewardStatusText, '已入账')
  await friend.main({ module: 'auth', action: 'login', data: {} })
  assert.equal(db.state.user_asset_earnings.length, 1)
})

test('personal commission cap includes withdrawn historical rewards and allows only the remaining cents', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'inviter', openid: 'inviter' }],
    pets: [{ _id: 'pet1', openid: 'friend1', createdAt: '2026-10-29' }, { _id: 'pet2', openid: 'friend2', createdAt: '2026-10-29' }],
    user_invites: [1, 2].map(i => ({ _id: `invite_${i}`, inviterOpenid: 'inviter', invitedOpenid: `friend${i}`, rewardAmount: 5 })),
    user_asset_earnings: [{ _id: 'history', userOpenid: 'inviter', sourceType: 'invite_binding', amount: 4.5, status: 'withdrawn' }]
  })
  const service = createContext({ db, cloud: {} })
  const settings = { enabled: true, rewardAmount: 5, maxRewardPerUser: 7 }
  const first = await service.grantInviteReward(db.state.user_invites[0], { settings })
  assert.equal(first.amount, 2.5)
  assert.equal(db.state.users[0].inviteCommissionEarnedFen, 700)
  const noMore = await service.grantInviteReward(db.state.user_invites[1], { settings })
  assert.equal(noMore, null)
  assert.equal(db.state.user_invites[1].rewardLimitReached, true)
  assert.equal(db.state.user_asset_earnings.length, 2)
  settings.maxRewardPerUser = 10
  const afterIncrease = await service.grantInviteReward(db.state.user_invites[1], { settings })
  assert.equal(afterIncrease.amount, 3)
  assert.equal(db.state.users[0].inviteCommissionEarnedFen, 1000)
  assert.equal((await service.grantInviteReward(db.state.user_invites[1], { settings })).amount, 3)
  assert.equal(db.state.user_asset_earnings.length, 3)
})

test('binding after pet creation pays once and does not revoke historical commission', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'inviter', openid: 'inviter', inviteCode: 'INV123', status: 'active' }, { _id: 'friend', openid: 'friend', status: 'active' }],
    pets: [{ _id: 'pet1', openid: 'friend' }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { invitation: { enabled: true, rewardAmount: 5, maxRewardPerUser: 5 } } }],
    user_invites: [], user_asset_earnings: []
  })
  const client = loadCloudFunction('api', db, 'friend')
  const bound = await client.main({ module: 'finance', action: 'bindInviteCode', data: { inviteCode: 'INV123' } })
  assert.equal(bound.ok, true, bound.message)
  assert.equal(db.state.user_asset_earnings.length, 1)
  assert.equal(db.state.user_asset_earnings[0].amount, 5)
  const service = createContext({ db, cloud: {} })
  db.state.pets = []
  db.state.platform_configs[0].value.invitation.maxRewardPerUser = 1
  await service.grantInviteReward(db.state.user_invites[0], { settings: { enabled: true, rewardAmount: 5, maxRewardPerUser: 1 } })
  assert.equal(db.state.user_asset_earnings.length, 1)
  assert.equal(db.state.user_invites[0].rewardAmount, 5)
})

test('manual invite binding succeeds despite a temporary reward read failure and pays on login retry', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'inviter', openid: 'inviter', inviteCode: 'INV123', status: 'active' }, { _id: 'friend', openid: 'friend', status: 'active' }],
    pets: [{ _id: 'pet1', openid: 'friend' }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { invitation: { enabled: true, rewardAmount: 5 } } }],
    user_invites: [], user_asset_earnings: []
  })
  const runTransaction = db.runTransaction.bind(db)
  let readFails = true
  db.runTransaction = callback => runTransaction(tx => callback({
    ...tx,
    collection(name) {
      const collection = tx.collection(name)
      if (name === 'pets' && readFails) collection.where = () => { throw new Error('temporary pet read failure') }
      return collection
    }
  }))
  const friend = loadCloudFunction('api', db, 'friend')
  const bound = await friend.main({ module: 'finance', action: 'bindInviteCode', data: { inviteCode: 'INV123' } })
  assert.equal(bound.ok, true, bound.message)
  assert.equal(db.state.users[1].inviterOpenid, 'inviter')
  assert.equal(db.state.user_invites.length, 1)
  assert.equal(db.state.user_asset_earnings.length, 0)

  readFails = false
  const login = await friend.main({ module: 'auth', action: 'login', data: {} })
  assert.equal(login.ok, true, login.message)
  assert.equal(db.state.user_asset_earnings.length, 1)
  assert.equal(db.state.user_asset_earnings[0].amount, 5)
})

test('partial withdrawal keeps the invitation award total and permits no duplicate payout', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'inviter', openid: 'inviter', inviteCode: 'INV123', status: 'active' }],
    pets: [{ _id: 'pet1', openid: 'friend' }],
    user_invites: [{ _id: 'invite_friend', inviterOpenid: 'inviter', invitedOpenid: 'friend', rewardAmount: 5, rewardEarningId: 'earning_original', rewarded: true }],
    user_asset_earnings: [
      { _id: 'earning_original', userOpenid: 'inviter', sourceType: 'invite_binding', sourceId: 'invite_friend', amount: 3, status: 'available' },
      { _id: 'earning_slice', userOpenid: 'inviter', sourceType: 'invite_binding', sourceId: 'invite_friend', splitFromEarningId: 'earning_original', amount: 2, status: 'withdrawn' }
    ]
  })
  const service = createContext({ db, cloud: {} })
  const rewarded = await service.grantInviteReward(db.state.user_invites[0], { settings: { enabled: true, rewardAmount: 5, maxRewardPerUser: 3 } })
  assert.equal(rewarded._id, 'earning_original')
  assert.equal(db.state.user_invites[0].rewardAmount, 5)
  assert.equal(db.state.user_asset_earnings.length, 2)
  const summary = await service.getUserAssetSummary('inviter')
  assert.equal(summary.invites[0].rewardAmount, 5)
  assert.equal(summary.invites[0].rewardStatusText, '已入账')
})

test('simultaneous pet-qualified invitations cannot exceed the personal commission cap', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'inviter', openid: 'inviter' }],
    pets: [{ _id: 'pet1', openid: 'friend1' }, { _id: 'pet2', openid: 'friend2' }],
    user_invites: [1, 2].map(i => ({ _id: `invite_${i}`, inviterOpenid: 'inviter', invitedOpenid: `friend${i}`, rewardAmount: 5 })),
    user_asset_earnings: []
  })
  const service = createContext({ db, cloud: {} })
  optimistic(db)
  await Promise.all(db.state.user_invites.map(invite => service.grantInviteReward(invite, {
    settings: { enabled: true, rewardAmount: 5, maxRewardPerUser: 7 }
  })))
  assert.equal(db.state.user_asset_earnings.reduce((sum, earning) => sum + earning.amount, 0), 7)
  assert.equal(db.state.users[0].inviteCommissionEarnedFen, 700)
})
test('user asset withdrawal splits earnings and settles after transfer starts', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_admin', openid: 'admin', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'client', roles: ['client'], status: 'active', nickname: '邀请用户' }
    ],
    admins: [{ _id: 'a1', openid: 'admin', status: 'active', permissions: ['all'] }],
    platform_configs: [{ _id: 'settings', key: 'system_settings', value: { invitation: { enabled: true, rewardAmount: 5, userMinWithdrawAmount: 1 }, staffSupplies: { transfer: { enabled: false } } } }],
    user_asset_earnings: [{ _id: 'earning_1', userOpenid: 'client', sourceType: 'invite_binding', amount: 5, status: 'available', createdAt: '2026-10-01 10:00' }],
    user_invites: [], withdraw_requests: [], finance_logs: [], admin_operation_logs: [], retro_card_logs: []
  })
  const client = loadCloudFunction('api', db, 'client')
  const admin = loadCloudFunction('api', db, 'admin')

  const first = await client.main({ module: 'finance', action: 'createUserAssetWithdraw', data: { amount: 2, clientRequestId: 'split-reject' } })
  assert.equal(first.ok, true)
  assert.equal(first.data.amount, 2)
  assert.equal(db.state.user_asset_earnings.find((row) => row._id === 'earning_1').amount, 3)
  assert.equal(db.state.user_asset_earnings.find((row) => row.withdrawRequestId === first.data._id).amount, 2)
  const rejected = await admin.main({ module: 'admin', action: 'auditWithdrawRequest', data: { id: first.data._id, approved: false, auditRemark: '请补充说明' } })
  assert.equal(rejected.ok, true)
  assert.equal(db.state.user_asset_earnings.filter((row) => row.status === 'available').reduce((sum, row) => sum + row.amount, 0), 5)

  const second = await client.main({ module: 'finance', action: 'createUserAssetWithdraw', data: { amount: 2, clientRequestId: 'split-paid' } })
  assert.equal(second.ok, true)
  const approved = await admin.main({ module: 'admin', action: 'auditWithdrawRequest', data: { id: second.data._id, approved: true } })
  assert.equal(approved.data.status, 'approved')
  const reqItem = db.state.withdraw_requests.find((row) => row._id === second.data._id)
  reqItem.status = 'transferring'
  reqItem.wechatTransferState = 'WAIT_USER_CONFIRM'

  const waitingSummary = await client.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(waitingSummary.data.hasPendingWithdrawConfirm, true)
  const waitingWithdraw = waitingSummary.data.withdraws.find(w => w._id === second.data._id)
  assert.equal(waitingWithdraw.canConfirmTransfer, true)
  assert.equal(waitingWithdraw.statusText, '待确认收款')
  assert.equal(waitingWithdraw.wechatTransferStateText, '待收款人确认收款')
  assert.equal(waitingWithdraw.amountText, '2.00')

  const manualPaid = await admin.main({ module: 'admin', action: 'markWithdrawPaid', data: { id: second.data._id } })
  assert.equal(manualPaid.ok, false)
  assert.match(manualPaid.message, /不能手动标记打款/)
  const settlement = require('../../cloudfunctions/api/services/context')({ db, cloud: {} })
  const paid = await settlement.markUserAssetPaid(second.data._id, { state: 'SUCCESS', transferBillNo: 'verified-bill' })
  assert.equal(paid.request.status, 'paid')
  const paidSlice = db.state.user_asset_earnings.find((row) => row.withdrawRequestId === second.data._id)
  assert.equal(paidSlice.status, 'withdrawn')
  assert.equal(paidSlice.amount, 2)
  const summary = await client.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(summary.data.availableAmount, 3)
  assert.equal(summary.data.withdrawnAmount, 2)
  assert.equal(summary.data.hasPendingWithdrawConfirm, false)
  const paidWithdraw = summary.data.withdraws.find(w => w._id === second.data._id)
  assert.equal(paidWithdraw.canConfirmTransfer, false)
  assert.equal(paidWithdraw.statusText, '已到账')

  const listed = await admin.main({ module: 'admin', action: 'listWithdrawRequests', data: {} })
  const listedUser = listed.data.find((row) => row.assetType === 'user')
  assert.equal(listedUser.currentAvailableAmount, 3)
  assert.equal(listedUser.withdrawnAmount, 2)
  assert.equal(listedUser.withdrawCount, 2)
  assert.equal(listedUser.withdrawHistory.length, 2)
  const transferQuery = await client.main({ module: 'finance', action: 'queryMyWithdrawTransfer', data: { id: second.data._id } })
  assert.equal(transferQuery.ok, true)
  assert.equal(transferQuery.data.status, 'paid')
  const confirmation = await client.main({ module: 'finance', action: 'getMyWithdrawTransferConfirmation', data: { id: second.data._id } })
  assert.equal(confirmation.ok, true)
})
