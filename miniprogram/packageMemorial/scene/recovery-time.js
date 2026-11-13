function deadline(time) {
  if (!Number.isFinite(time)) return ''
  return new Date(time + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ')
}
module.exports = { deadline }
