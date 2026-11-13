const KINDS = ['flower', 'snack']
const MAX_VISIBLE = 12
const cachedCounts = new WeakMap()
function activeCounts(display, time) {
  const minute = Math.floor(time / 60000), cached = display && cachedCounts.get(display)
  if (cached && cached.minute === minute && cached.flower === display.flower && cached.snack === display.snack) return cached.value
  const value = Object.fromEntries(KINDS.map(kind => [kind, (display && Array.isArray(display[kind]) ? display[kind] : [])
    .reduce((sum, row) => Array.isArray(row) && Number.isSafeInteger(row[0]) && row[0] * 60000 > time &&
      Number.isSafeInteger(row[1]) && row[1] > 0 ? sum + row[1] : sum, 0)]))
  if (display && typeof display === 'object') cachedCounts.set(display, { minute, value, flower: display.flower, snack: display.snack })
  return value
}
function slot(memorial, kind, index) {
  const ratio = memorial.legacy ? .7 : 1
  return { x: memorial.x + (kind === 'flower' ? -1 : 1) * (36 + index % 3 * 11) * ratio,
    y: memorial.y + (26 + Math.floor(index / 3) * 9) * ratio, size: 22 * ratio }
}
function placements(memorial, time) {
  const counts = activeCounts(memorial.offeringScene, time), rows = []
  for (const kind of KINDS) {
    for (let i = 0; i < Math.min(counts[kind], MAX_VISIBLE); i++) rows.push({ ...slot(memorial, kind, i), kind })
    // Dense offerings stay on their own plot; the marker gives the exact active quantity.
    if (counts[kind] > MAX_VISIBLE) rows.push({ ...slot(memorial, kind, 10), y: memorial.y + (memorial.legacy ? 47 : 65), kind, label: '×' + counts[kind] })
  }
  return rows
}
function drawOffering(c, image, item) {
  if (item.label) {
    c.save(); c.font = '10px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'
    const width = c.measureText(item.label).width + 10
    c.fillStyle = '#fff8e6'; c.fillRect(item.x - width / 2, item.y - 7, width, 14)
    c.fillStyle = '#66533a'; c.fillText(item.label, item.x, item.y); c.restore()
  } else if (image) c.drawImage(image, item.x - item.size / 2, item.y - item.size * 124 / 128, item.size, item.size)
}
module.exports = { activeCounts, slot, placements, drawOffering, MAX_VISIBLE }
