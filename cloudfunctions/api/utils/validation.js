function safeText(value) { return value === undefined || value === null ? '' : String(value) }

function makeIdempotencyKey(...parts) {
  return parts.map((part) => safeText(part).trim()).filter(Boolean).join(':')
}

function getClientRequestId(data = {}) {
  return safeText(data.clientRequestId || data.idempotencyKey).trim()
}

module.exports = { safeText, makeIdempotencyKey, getClientRequestId }
