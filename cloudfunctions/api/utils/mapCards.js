function mapRefreshIds(value) {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.length > 2000 || value.some(id => typeof id !== 'string' || !id || id.length > 128)) {
    throw new Error('地图刷新参数无效，请重新打开小区')
  }
  return [...new Set(value)]
}
function visibleMapRows(rows, ids) {
  const byId = new Map(rows.map(row => [row._id, row]))
  return ids.map(id => byId.get(id)).filter(Boolean)
}
async function mapConcurrent(rows, transform, limit = 12) {
  const results = new Array(rows.length)
  let next = 0, failed = false
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (!failed && next < rows.length) {
      const index = next++
      try { results[index] = await transform(rows[index]) } catch (error) { failed = true; throw error }
    }
  }))
  return results
}
module.exports = { mapRefreshIds, visibleMapRows, mapConcurrent }
