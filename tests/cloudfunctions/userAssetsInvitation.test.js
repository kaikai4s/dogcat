const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('invite binding grants one idempotent user asset earning and supports user withdrawal', async () => {
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
  assert.equal(db.state.user_asset_earnings.length, 1)
  assert.equal(db.state.user_asset_earnings[0].amount, 5)
  const summary = await inviter.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(summary.data.availableAmount, 5)
  assert.equal(summary.data.invitationShareImageUrl, 'cloud://invite-cover')
  assert.equal(summary.data.invites[0].invitedNickname, '好友小猫')
  assert.equal(summary.data.invites[0].invitedAvatarUrl, 'cloud://avatar')
  assert.equal(summary.data.invites[0].rewardAmount, 5)
  assert.equal(summary.data.invites[0].rewardStatusText, '已入账')
  db.state.platform_configs[0].value.invitation.rewardAmount = 3
  const changedSummary = await inviter.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(changedSummary.data.invites[0].rewardAmount, 5)
  await invited2.main({ module: 'auth', action: 'login', data: { inviteCode: inviterLogin.data.inviteCode } })
  const secondSummary = await inviter.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(secondSummary.data.availableAmount, 8)
  assert.deepEqual(secondSummary.data.invites.map(row => row.rewardAmount).sort((a, b) => a - b), [3, 5])
  assert.deepEqual(db.state.user_asset_earnings.map(row => row.amount).sort((a, b) => a - b), [3, 5])
  const request = await inviter.main({ module: 'finance', action: 'createUserAssetWithdraw', data: { amount: 5, clientRequestId: 'asset-1' } })
  assert.equal(request.data.assetType, 'user')
  const approved = await admin.main({ module: 'admin', action: 'auditWithdrawRequest', data: { id: request.data._id, approved: true } })
  assert.equal(approved.data.status, 'approved')
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
  db.state.withdraw_requests.find((row) => row._id === second.data._id).status = 'transferring'
  const paid = await admin.main({ module: 'admin', action: 'markWithdrawPaid', data: { id: second.data._id } })
  assert.equal(paid.data.status, 'paid')
  const paidSlice = db.state.user_asset_earnings.find((row) => row.withdrawRequestId === second.data._id)
  assert.equal(paidSlice.status, 'withdrawn')
  assert.equal(paidSlice.amount, 2)
  const summary = await client.main({ module: 'finance', action: 'getUserAssetSummary' })
  assert.equal(summary.data.availableAmount, 3)
  assert.equal(summary.data.withdrawnAmount, 2)
  const listed = await admin.main({ module: 'admin', action: 'listWithdrawRequests', data: {} })
  const listedUser = listed.data.find((row) => row.assetType === 'user')
  assert.equal(listedUser.currentAvailableAmount, 3)
  assert.equal(listedUser.withdrawnAmount, 2)
  assert.equal(listedUser.withdrawCount, 2)
  assert.equal(listedUser.withdrawHistory.length, 2)
})
