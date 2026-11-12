// Stable row/column numbers; filtering occupied plots never renumbers a place.
function plotNumber(id) {
  const match = /:(\d+):(\d+)$/.exec(String(id || ''))
  return match ? [match[1], match[2]].map(n => String(Number(n) + 1).padStart(2, '0')).join('-') : '—'
}
module.exports = { plotNumber }
