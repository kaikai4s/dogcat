const labels = {
  approved: ['审核通过', '审核已通过，请查看提现进度'],
  wait_confirm: ['待确认', '请确认收款，24小时未确认将放弃提现'],
  rejected: ['已驳回', '提现未通过，请查看原因后重新申请'],
  paid: ['已到账', '提现已到账，请留意微信零钱'],
  transfer_failed: ['打款失败', '提现打款失败，请查看详情联系平台']
}

function buildWithdrawalSubscriptionData(request, event) {
  const [status, tip] = labels[event] || labels.approved
  return {
    amount1: { value: Number(request.amount || 0).toFixed(2) },
    phrase2: { value: status },
    thing3: { value: tip }
  }
}

function withdrawalNotification(request, event) {
  const userAsset = request.assetType === 'user'
  const withdrawalId = request._id
  const billNo = request.outBillNo || request.outDetailNo || ''
  return {
    openid: userAsset ? request.userOpenid : request.staffOpenid,
    templateKey: 'withdrawResult',
    page: `${userAsset ? 'pages/client/profile/assets/index' : 'pages/staff/earnings/index'}?tab=withdraws`,
    messageData: buildWithdrawalSubscriptionData(request, event),
    orderId: '',
    withdrawalId,
    withdrawalEvent: event,
    withdrawalBillNo: billNo,
    deliveryKey: `withdraw:${withdrawalId}:${event}${event === 'wait_confirm' ? ':' + billNo : ''}`
  }
}

module.exports = { buildWithdrawalSubscriptionData, withdrawalNotification }
