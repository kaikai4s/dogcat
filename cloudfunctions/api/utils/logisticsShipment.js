// A tracking number can be reused or corrected during a reshipment. Bind cached
// delivery evidence to the carrier and this specific shipping event as well.
function shipmentIdentity(order = {}) {
  return {
    trackingNo: String(order.trackingNo || '').trim(),
    expressCompany: String(order.expressCompany || '').trim().toLowerCase(),
    shippedAt: new Date(order.shippedAt || 0).getTime()
  }
}

function sameShipment(left, right) {
  if (!left || !right) return false
  const a = shipmentIdentity(left), b = shipmentIdentity(right)
  return Boolean(a.trackingNo && a.expressCompany && Number.isFinite(a.shippedAt) && a.shippedAt > 0 &&
    a.trackingNo === b.trackingNo && a.expressCompany === b.expressCompany && a.shippedAt === b.shippedAt)
}

module.exports = { shipmentIdentity, sameShipment }
