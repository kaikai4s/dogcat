const { createHash } = require('node:crypto')

function canonical(value) {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

// Includes stock and SKU values, not just a timestamp that can share a millisecond.
module.exports = product => createHash('sha256').update(JSON.stringify(canonical(product))).digest('hex')
