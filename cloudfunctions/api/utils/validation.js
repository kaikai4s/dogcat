function safeText(value) { return value === undefined || value === null ? '' : String(value) }

const MOBILE_PHONE_REGEX = /^1[3-9]\d{9}$/
const CONTACT_PHONE_REGEX = /^(1[3-9]\d{9}|0\d{2,3}-?\d{7,8})$/
function isValidMobilePhone(value) { return MOBILE_PHONE_REGEX.test(safeText(value).trim()) }
function isValidContactPhone(value) { return CONTACT_PHONE_REGEX.test(safeText(value).trim()) }

function makeIdempotencyKey(...parts) {
  return parts.map((part) => safeText(part).trim()).filter(Boolean).join(':')
}

function getClientRequestId(data = {}) {
  return safeText(data.clientRequestId || data.idempotencyKey).trim()
}

module.exports = { safeText, MOBILE_PHONE_REGEX, CONTACT_PHONE_REGEX, isValidMobilePhone, isValidContactPhone, makeIdempotencyKey, getClientRequestId }
