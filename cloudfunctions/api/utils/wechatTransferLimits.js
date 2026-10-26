const WECHAT_MIN_TRANSFER_CENTS = 10
const WECHAT_MAX_TRANSFER_CENTS = 20000

// This evidence is passed only by the server after querying the original
// merchant and bill. It is never read from an administrator's request payload.
function isAbsentSmallTransfer(request, evidence) {
  if (!request || !evidence || request.payoutChannel !== 'wechat_wallet' ||
      !['approved', 'transferring', 'transfer_failed'].includes(request.status)) return false
  const amountFen = Math.round(Number(request.amount) * 100)
  return Number.isSafeInteger(amountFen) && amountFen > 0 && amountFen < WECHAT_MIN_TRANSFER_CENTS &&
    (request.amountFen == null || request.amountFen === amountFen) && evidence.amountFen === amountFen &&
    Boolean(request.outBillNo || request.outDetailNo) && (request.outBillNo || request.outDetailNo) === evidence.outBillNo &&
    Boolean(request.transferMchId) && request.transferMchId === evidence.mchId &&
    Boolean(request.transferAppId) && request.transferAppId === evidence.appId &&
    Number(request.transferAttemptCount || 0) === evidence.attemptCount
}

module.exports = { WECHAT_MIN_TRANSFER_CENTS, WECHAT_MAX_TRANSFER_CENTS, isAbsentSmallTransfer }
