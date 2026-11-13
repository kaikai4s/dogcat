function hasStandard(profile = {}) {
  const value = profile.depositStandardAmount
  return value !== undefined && value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0
}

function standardAmount(profile, fallback = 0) {
  const amount = hasStandard(profile || {}) ? Number(profile.depositStandardAmount) : Number(fallback || 0)
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100) / 100) : 0
}

function balanceAmount(deposits = []) {
  return deposits.reduce((cents, deposit) => {
    const available = deposit.availableRefundAmount != null ? Number(deposit.availableRefundAmount)
      : Number(deposit.paidAmount || 0) - Number(deposit.refundedAmount || 0) - Number(deposit.forfeitedAmount || 0) - Number(deposit.supplyFeeDeductedAmount || 0)
    return cents + (Number.isFinite(available) ? Math.max(0, Math.round(available * 100)) : 0)
  }, 0) / 100
}

function refundPending(deposits) {
  return deposits.some(row => ['refund_requested', 'refund_approved', 'refunding'].includes(row.status)
    || ['requested', 'approved', 'processing'].includes(row.refundStatus))
}

function supplyPolicyDeposit(profile, deposits = []) {
  const shipped = deposits.find(row => row._id === profile?.supplyShipmentDepositId)
  if (shipped) return shipped
  return deposits.filter(row => row.supplyPolicyAcceptedAt && ['paid', 'partially_refunded'].includes(row.status) && balanceAmount([row]) > 0)
    .sort((a, b) => new Date(a.createdAt || a.supplyPolicyAcceptedAt).getTime() - new Date(b.createdAt || b.supplyPolicyAcceptedAt).getTime() || String(a._id).localeCompare(String(b._id)))[0] || null
}

// CloudBase transactions support document reads. Discover IDs in pages, then
// read balances in the transaction; callers also read/write the staff profile.
async function readDeposits(db, openid, tx = null) {
  const rows = []
  let cursor = ''
  for (;;) {
    const where = { staffOpenid: openid }
    if (cursor) where._id = db.command.gt(cursor)
    const page = (await db.collection('staff_deposits').where(where).orderBy('_id', 'asc').limit(100).get()).data || []
    for (const row of page) {
      const current = tx ? (await tx.collection('staff_deposits').doc(row._id).get()).data : row
      if (current && current.staffOpenid === openid) rows.push(current)
    }
    if (page.length < 100) return rows
    cursor = page[page.length - 1]._id
  }
}

module.exports = { hasStandard, standardAmount, balanceAmount, refundPending, readDeposits, supplyPolicyDeposit }
