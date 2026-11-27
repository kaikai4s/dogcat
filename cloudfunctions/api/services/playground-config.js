const DEFAULT_GROUP = { enabled: true, minHouseholds: 2, discountRate: 0.88, waiveVisitFee: true, recruitHours: 12 }
const DEFAULT_CARE = { energyDecay: 8, satietyDecay: 12, hydrationDecay: 18, peeGrowth: 22.22, poopGrowth: 11.11, sleepRate: 0.16, eatRate: 0.24, drinkRate: 0.3, peeThreshold: 20, poopThreshold: 40, peeDelaySeconds: 45, poopDelaySeconds: 120 }
function number(value, fallback, min, max, label, integer = false) {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`${label}须在 ${min}～${max} 之间${integer ? '，且为整数' : ''}`)
  return n
}
function groupConfig(value = {}) {
  return { enabled: value.enabled !== false,
    minHouseholds: number(value.minHouseholds, 2, 2, 20, '成团户数', true),
    discountRate: number(value.discountRate, 0.88, 0.01, 1, '拼单折扣比例'),
    waiveVisitFee: value.waiveVisitFee !== false,
    recruitHours: number(value.recruitHours, 12, 1, 48, '拼单募集小时数', true) }
}
function careConfig(value = {}) {
  const result = {}
  for (const species of ['cat', 'dog']) {
    const input = value[species] || {}, row = {}
    for (const [key, fallback] of Object.entries(DEFAULT_CARE)) {
      const rate = key.endsWith('Rate'), delay = key.endsWith('Seconds'), threshold = key.endsWith('Threshold')
      row[key] = number(input[key], fallback, rate ? 0.01 : 1, rate ? 10 : delay ? 600 : 100, `宠物${species === 'cat' ? '猫' : '狗'} ${key}`)
      if (threshold && row[key] > 100) throw new Error('排泄阈值不能超过100')
    }
    result[species] = row
  }
  return result
}
async function readConfig(db) {
  const res = await db.collection('platform_configs').where({ key: 'system_settings' }).limit(1).get()
  const value = (res.data && res.data[0] && res.data[0].value) || {}
  return { enableManor3d: value.enableManor3d !== false, groupBuy: groupConfig(value.playgroundGroupBuy), care: careConfig(value.playgroundCare) }
}
async function isManor3dEnabled(db, getSystemSettings) {
  if (typeof getSystemSettings === 'function') {
    const settings = await getSystemSettings()
    return settings?.enableManor3d !== false
  }
  if (!db || typeof db.collection !== 'function') return true
  const res = await db.collection('platform_configs').where({ key: 'system_settings' }).limit(1).get()
  const value = (res.data && res.data[0] && res.data[0].value) || {}
  return value.enableManor3d !== false
}
async function assertManor3dEnabled(db, getSystemSettings) {
  if (!(await isManor3dEnabled(db, getSystemSettings))) {
    throw Object.assign(new Error('3D 庄园暂未开放'), { code: 'MANOR3D_DISABLED' })
  }
}
module.exports = { DEFAULT_GROUP, DEFAULT_CARE, groupConfig, careConfig, readConfig, isManor3dEnabled, assertManor3dEnabled }
