const STAFF_GENDERS = ['male', 'female']

function requireStaffGender(value) {
  if (!STAFF_GENDERS.includes(value)) throw new Error('请选择宠托师性别（男或女）')
  return value
}

function normalizeStaffGenderRequirement(value) {
  if (value === undefined || value === null || value === '') return 'any'
  if (!['any', ...STAFF_GENDERS].includes(value)) throw new Error('宠托师性别要求无效')
  return value
}

function matchesStaffGender(order = {}, profile = {}) {
  const required = order.staffGenderRequirement
  if (required === undefined || required === null || required === '' || required === 'any') return true
  return STAFF_GENDERS.includes(required) && profile.gender === required
}

function assertStaffGenderMatches(order, profile) {
  if (!matchesStaffGender(order, profile)) throw new Error('宠托师性别不符合订单要求')
}

function isStaffProfileLocked(profile) {
  return Boolean(profile && (profile.certificationLockedAt || profile.auditStatus === 'approved' || profile.identityStatus === 'verified'))
}

module.exports = { requireStaffGender, normalizeStaffGenderRequirement, matchesStaffGender, assertStaffGenderMatches, isStaffProfileLocked }
