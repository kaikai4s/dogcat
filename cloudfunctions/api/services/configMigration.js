const crypto = require('crypto')
const { readDocuments, readOptionalDocument } = require('../utils/documentPages')
const { transaction } = require('./playground-transaction')
const { ASSET_ROOTS } = require('./playground-shared/asset-roots')
const FORMAT = 'dogcat-config'
const VERSION = 1
const MAX_BYTES = 768 * 1024
const MAX_ROWS = 400
const SPECS = {
  prices: ['service_prices', '服务价格', ['key']],
  checkinRules: ['service_checkin_rules', '服务打卡规则', ['serviceType', 'eventType']],
  memberLevels: ['member_levels', '会员等级', ['name']],
  coupons: ['coupon_templates', '优惠券模板', []],
  petTitles: ['pet_titles', '宠物头衔', []],
  checkinMonths: ['checkin_month_configs', '月度签到配置', ['monthKey']],
  lotteries: ['lottery_activities', '抽奖活动', []],
  mallCategories: ['mall_categories', '商城分类', []],
  mallProducts: ['mall_products', '商城商品', []],
  questionnaires: ['questionnaires', '问卷定义', []]
}
const SPECIAL = { system: '系统设置', farm: '庄园植物配置', buildings: '庄园建筑与土地配置' }
const CATALOG_IDS = { farm: 'playground_farm_catalog_v1', buildings: 'playground_buildings_catalog_v1' }
const OMIT = /^(?:_openid|createdBy|createdByOpenid|updatedBy|reviewer|updatedAt|createdAt|publishedAt|closedAt|notificationSent|responseCount|validResponseCount|issuedCount|salesCount|revision)$/i
const SECRET = /secret|password|privatekey|apiv3key|accesstoken|refreshtoken|authorization|qwenapikey|juhetelecomkey|apikeyinput|keyconfigured|temptoken|sessionkey|platformpublickey/i
function canonical(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  return JSON.stringify(value)
}
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex')
const clone = value => JSON.parse(JSON.stringify(value))
function clean(value, depth = 0) {
  if (depth > 25) throw new Error('配置层级过深')
  if (value instanceof Date) return value.toISOString()
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('配置包含无效数字'); return value }
  if (Array.isArray(value)) return value.map(v => clean(v, depth + 1))
  if (!value || typeof value !== 'object') throw new Error('配置包含无效数据')
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || key.startsWith('$') || key.includes('.')) throw new Error('配置字段无效')
    if (SECRET.test(key) || OMIT.test(key) || item === undefined) continue
    result[key] = clean(item, depth + 1)
  }
  return result
}
function portableSystem(settings) {
  const value = clean(settings)
  delete value.payment
  if (value.staffSupplies) delete value.staffSupplies.transfer
  if (value.invitation) delete value.invitation.transfer
  if (value.logistics) { delete value.logistics.juheKey; delete value.logistics.juheKeyInput; delete value.logistics.key; delete value.logistics.appCode; delete value.logistics.customer; delete value.logistics.keyInput; delete value.logistics.appCodeInput }
  return value
}
function merge(base, incoming) {
  const value = base && typeof base === 'object' && !Array.isArray(base) ? clone(base) : {}
  for (const [key, item] of Object.entries(incoming)) {
    value[key] = item && typeof item === 'object' && !Array.isArray(item) ? merge(value[key], item) : clone(item)
  }
  return value
}
function validId(id) { return typeof id === 'string' && /^[^/.$\s]{1,128}$/.test(id) }
module.exports = function createMigration(context) {
  const { db, cloud, now, normalizeSystemSettings } = context
  function identity() {
    const wx = cloud.getWXContext ? cloud.getWXContext() : {}
    const envId = wx.ENV || process.env.TCB_ENV || process.env.WX_ENV_ID || process.env.SCF_NAMESPACE || ''
    const root = ASSET_ROOTS[envId]
    return { envId, appId: wx.APPID || '', storageRoot: root ? root.split('/packagePlayground/')[0] : '' }
  }
  async function rows(store, collection, where = {}) {
    const found = await readDocuments(store, db.command, collection, where, MAX_ROWS + 1)
    if (found.length > MAX_ROWS) throw new Error('配置数量超过单次迁移上限，请联系技术人员分批迁移')
    return found
  }
  async function state(store) {
    const result = {}
    for (const [key, [collection]] of Object.entries(SPECS)) result[key] = await rows(store, collection)
    result.systemRows = await rows(store, 'platform_configs', { key: 'system_settings' })
    if (result.systemRows.length > 1) throw new Error('系统设置有重复记录，请先修正')
    result.system = result.systemRows[0] || null
    result.world = await readOptionalDocument(store, 'pet_playground_plots', 'world_config_v2')
    result.farm = await readOptionalDocument(store, 'platform_configs', CATALOG_IDS.farm)
    result.buildings = await readOptionalDocument(store, 'platform_configs', CATALOG_IDS.buildings)
    return result
  }
  async function snapshot(store, current) {
    const sections = {}
    const settings = normalizeSystemSettings(current.system && current.system.value || {})
    if (current.world) settings.playground = require('./playground-world').dimensions(current.world)
    sections.system = [{ _id: 'system', value: portableSystem(settings) }]
    for (const key of Object.keys(SPECS)) sections[key] = current[key].map(row => clean(row))
    sections.prices = context.mergeServicePrices(current.prices, true).map(item => ({ ...clean(item), _id: item._id || 'default_' + item.key }))
    const serviceKeys = sections.prices.map(item => item.key)
    const rules = current.checkinRules.length ? current.checkinRules : context.defaultServiceCheckinRules
    sections.checkinRules = rules.filter(item => serviceKeys.includes(item.serviceType)).map(item => ({ ...clean(context.normalizeServiceCheckinRule(item, serviceKeys)), _id: item._id || 'default_' + item.serviceType + '_' + item.eventType }))
    sections.farm = [{ _id: CATALOG_IDS.farm, ...clean(current.farm || await require('./playground-farm-catalog').readCatalog(store)) }]
    const buildings = current.buildings || await require('./playground-buildings')({ ...context, db: store }).readCatalog()
    sections.buildings = [{ _id: CATALOG_IDS.buildings, ...clean(buildings) }]
    if (Object.values(sections).reduce((sum, list) => sum + list.length, 0) > MAX_ROWS) throw new Error('配置数量超过单次迁移上限（400 条），请联系技术人员迁移')
    const result = { format: FORMAT, version: VERSION, source: identity(), exportedAt: now(), sections }
    result.checksum = digest(sections)
    return result
  }
  function validate(input) {
    if (!input || Buffer.byteLength(JSON.stringify(input)) > MAX_BYTES) throw new Error('配置文件不能为空或超过 768KB')
    if (input.format !== FORMAT || input.version !== VERSION || !input.sections || !input.source || typeof input.source.envId !== 'string') throw new Error('配置文件格式或版本不支持')
    if (input.checksum !== digest(input.sections)) throw new Error('配置文件校验失败，请重新导出')
    const keys = [...Object.keys(SPECS), ...Object.keys(SPECIAL)]
    if (Object.keys(input.sections).length !== keys.length || Object.keys(input.sections).some(key => !keys.includes(key))) throw new Error('配置文件包含不支持的配置范围')
    let total = 0
    for (const key of keys) {
      const list = input.sections[key]
      if (!Array.isArray(list) || list.some(row => !row || !validId(row._id))) throw new Error('配置记录 ID 无效')
      if (new Set(list.map(row => row._id)).size !== list.length) throw new Error('配置文件存在重复记录 ID')
      total += list.length
    }
    if (total > MAX_ROWS) throw new Error('配置数量超过单次迁移上限（400 条），不会写入任何配置')
    for (const key of Object.keys(SPECIAL)) if (input.sections[key].length !== 1) throw new Error('基础配置缺失或重复')
    if (!input.sections.system[0].value || typeof input.sections.system[0].value !== 'object' || Array.isArray(input.sections.system[0].value) || input.sections.farm[0]._id !== CATALOG_IDS.farm || input.sections.buildings[0]._id !== CATALOG_IDS.buildings) throw new Error('基础配置记录无效')
    if (identity().appId && input.source.appId !== identity().appId) throw new Error('不支持跨小程序导入配置')
    return clean(input.sections)
  }
  function remap(value, source, idMap, files, field = '') {
    if (typeof value === 'string') {
      if (value.startsWith('cloud://')) {
        const match = value.match(/^cloud:\/\/([^/]+)\/(.+)$/)
        if (!match) throw new Error('云文件地址无效')
        const target = identity()
        let mapped = value
        if (source.envId !== target.envId) {
          if (!source.envId || !match[1].startsWith(source.envId + '.') || !target.storageRoot) throw new Error('存在无法转换的云文件环境，请先核对素材地址')
          mapped = target.storageRoot + '/' + match[2]
        }
        files.set(mapped, { source: value, target: mapped })
        return mapped
      }
      return /(?:id|ids)$/i.test(field) && idMap.has(value) ? idMap.get(value) : value
    }
    if (Array.isArray(value)) return value.map(item => remap(item, source, idMap, files, field))
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item, source, idMap, files, key)]))
    return value
  }
  function validateReferences(sections, current) {
    const available = key => new Set([...current[key], ...sections[key]].map(row => row._id))
    const targets = { categoryId: available('mallCategories'), templateId: available('coupons'), couponId: available('coupons'), couponTemplateId: available('coupons'), titleId: available('petTitles'), petTitleId: available('petTitles'), unlockLevelIds: available('memberLevels'), autoGrantLevelIds: available('memberLevels'), targetLevelIds: available('memberLevels') }
    function visit(value, key = '') {
      if (targets[key]) for (const id of Array.isArray(value) ? value : [value]) if (id && !targets[key].has(id)) throw new Error(`配置引用不存在：${key} / ${id}`)
      if (Array.isArray(value)) value.forEach(item => visit(item))
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k)
    }
    // subscription.templates are WeChat template IDs, not coupon references.
    for (const key of Object.keys(SPECS)) visit(sections[key])
    visit(sections.farm); visit(sections.buildings)
    const system = clone(sections.system[0].value)
    delete system.subscription
    visit(system)
  }
  function validateValues(sections, current) {
    const prices = [...current.prices, ...sections.prices]
    const serviceKeys = [...new Set([...context.defaultServicePrices, ...prices].map(row => row.key))]
    for (const row of sections.prices) {
      if (!row.key || !row.label || typeof row.price !== 'number' || row.price < 0) throw new Error('服务价格配置无效')
      Object.assign(row, context.normalizeServicePrice(row))
    }
    for (const row of sections.checkinRules) Object.assign(row, context.normalizeServiceCheckinRule(row, serviceKeys))
    for (const row of sections.memberLevels) if (!row.name || !Number.isFinite(row.minPoints) || row.minPoints < 0 || !Number.isFinite(row.pointMultiplier) || row.pointMultiplier < 1) throw new Error('会员等级配置无效')
    for (const row of sections.coupons) if (!row.name || !(row.discountAmount > 0) || !(row.minOrderAmount >= 0)) throw new Error('优惠券模板配置无效')
    for (const row of sections.petTitles) if (!row.name) throw new Error('宠物头衔名称不能为空')
    for (const row of sections.checkinMonths) {
      if (!/^\d{4}-\d{2}$/.test(row.monthKey || '') || !Array.isArray(row.days)) throw new Error('签到配置无效')
      const count = context.getMonthDays(row.monthKey)
      if (row.days.some(day => !Number.isInteger(day.day) || day.day < 1 || day.day > count)) throw new Error('签到日期无效')
    }
    for (const row of sections.mallProducts) {
      context.validateMallProductInput(row)
      if (!row.name || !row.coverFileId && !(row.imageFileIds || []).length) throw new Error('商城商品名称或图片缺失')
      Object.assign(row, context.normalizeMallProduct(row))
    }
    for (const row of sections.questionnaires) Object.assign(row, context.normalizeQuestionnairePayload(row))
    for (const row of sections.lotteries) {
      if (!row.name || !Array.isArray(row.prizes) || row.prizes.some(prize => !Number.isFinite(prize.probability) || prize.probability < 0 || !Number.isSafeInteger(prize.stockLeft) || prize.stockLeft < 0)) throw new Error('抽奖配置无效')
    }
    const farm = sections.farm[0], buildings = sections.buildings[0]
    if (!Array.isArray(farm.crops) || !Array.isArray(buildings.buildings) || !Array.isArray(buildings.plotSizes)) throw new Error('庄园素材配置无效')
    const allMaterials = [...farm.crops, ...buildings.buildings]
    if (allMaterials.some(item => !item.id || !item.name)) throw new Error('庄园素材编号或名称缺失')
    if (buildings.plotSizes.some(item => !Number.isFinite(item.size) || item.size < 1)) throw new Error('庄园土地规格无效')
  }
  function retainRuntime(key, incoming, existing) {
    const value = { ...incoming }
    if (key === 'coupons') value.issuedCount = Number(existing && existing.issuedCount || 0)
    if (key === 'questionnaires') {
      if (existing && existing.responseCount > 0 && digest(existing.questions || []) !== digest(value.questions || [])) throw new Error('已有答卷的问卷不能通过导入更换题目')
      value.responseCount = Number(existing && existing.responseCount || 0)
      value.validResponseCount = Number(existing && existing.validResponseCount || 0)
      value.notificationSent = !!(existing && existing.notificationSent)
      if (!existing) value.status = 'draft'
    }
    if (key === 'mallProducts') {
      value.salesCount = Number(existing && existing.salesCount || 0)
      if (existing) {
        if ((existing.skus || []).some(sku => !(value.skus || []).some(item => item.skuId === sku.skuId))) throw new Error('现有商品规格不能通过配置导入删除，请先核对商城商品')
        for (const field of ['stock', 'totalStock']) if (existing[field] !== undefined) value[field] = existing[field]
        value.skus = (value.skus || []).map(sku => {
          const previous = (existing.skus || []).find(item => item.skuId === sku.skuId) || (existing.specMode !== 'multi' && value.specMode !== 'multi' ? existing : null)
          return { ...sku, salesCount: Number(previous && previous.salesCount || 0), ...(previous ? { stock: previous.stock } : {}) }
        })
      } else if (value.skus) value.skus = value.skus.map(sku => ({ ...sku, salesCount: 0 }))
      return context.normalizeMallProduct(value)
    }
    if (key === 'lotteries' && existing && (existing.prizes || []).some(prize => !(value.prizes || []).some(item => item.id === prize.id))) throw new Error('现有抽奖奖项不能通过配置导入删除，请先核对奖项库存')
    if (key === 'lotteries') value.prizes = (value.prizes || []).map(prize => {
      const old = existing && (existing.prizes || []).find(item => item.id === prize.id)
      return old ? { ...prize, stockLeft: old.stockLeft } : prize
    })
    return value
  }
  async function plan(input, store, current) {
    const sections = validate(input)
    const idMap = new Map()
    for (const [key, [, , natural]] of Object.entries(SPECS)) {
      const used = new Set(), businessKeys = new Set()
      for (const row of sections[key]) {
        const businessKey = canonical(natural.map(field => row[field]))
        if (natural.length && businessKeys.has(businessKey)) throw new Error('配置文件存在重复业务记录：' + SPECS[key][1])
        businessKeys.add(businessKey)
        const candidates = current[key].filter(item => item._id === row._id || natural.length && natural.every(k => item[k] === row[k]))
        if (candidates.length > 1) throw new Error('目标配置存在重复，请先处理：' + SPECS[key][1])
        const target = candidates[0] && candidates[0]._id || row._id
        if (used.has(target)) throw new Error('配置文件存在重复业务记录：' + SPECS[key][1])
        used.add(target)
        if (target !== row._id) {
          if (idMap.has(row._id) && idMap.get(row._id) !== target) throw new Error('配置 ID 映射冲突')
          idMap.set(row._id, target)
        }
      }
    }
    const files = new Map()
    const mapped = remap(sections, input.source, idMap, files)
    validateValues(mapped, current)
    const desired = portableSystem(mapped.system[0].value)
    const previousSettings = current.system && current.system.value || {}
    const settings = normalizeSystemSettings(merge(previousSettings, desired), { includeSecrets: true, existingSettings: previousSettings, existingPayment: previousSettings.payment || {} })
    if (/prod/i.test(identity().envId)) settings.enableTestAddressMode = false
    const world = { ...(current.world || {}), ...settings.playground }
    if (world.width < Number(world.usedWidth || 0) || world.height < Number(world.usedHeight || 0)) throw new Error('导入地面范围小于正式环境已使用范围')
    validateReferences(mapped, current)
    const changes = []
    const summary = []
    for (const [key, [collection, label]] of Object.entries(SPECS)) {
      let added = 0, updated = 0, unchanged = 0
      for (const row of mapped[key]) {
        const existing = current[key].find(item => item._id === row._id)
        const { _id, ...payload } = retainRuntime(key, row, existing)
        if (existing && digest(clean(existing)) === digest(clean({ _id, ...payload }))) { unchanged++; continue }
        changes.push({ collection, id: _id, payload: { ...payload, ...Object.fromEntries(['createdBy', 'createdByOpenid', 'publishedAt', 'closedAt'].filter(field => existing && existing[field] !== undefined).map(field => [field, existing[field]])), ...(existing && existing.createdAt ? { createdAt: existing.createdAt } : { createdAt: now() }), updatedAt: now() } })
        existing ? updated++ : added++
      }
      summary.push({ key, label, added, updated, unchanged })
    }
    const systemId = current.system && current.system._id || 'system_settings_migrated'
    if (digest(previousSettings) !== digest(settings)) changes.push({ collection: 'platform_configs', id: systemId, payload: { key: 'system_settings', value: settings, updatedAt: now() } })
    if (digest(clean(current.world || {})) !== digest(clean(world))) {
      const { _id, ...payload } = world
      changes.push({ collection: 'pet_playground_plots', id: 'world_config_v2', payload })
    }
    for (const key of ['farm', 'buildings']) {
      const { _id, ...value } = mapped[key][0]
      if (digest(clean(current[key] || {})) !== digest(clean({ ...value, _id }))) changes.push({ collection: 'platform_configs', id: CATALOG_IDS[key], payload: { ...value, revision: Number(current[key] && current[key].revision || 0) + 1, updatedAt: now() } })
    }
    const token = digest({ snapshot: input, target: identity(), current })
    return { changes, summary, token, assets: [...files.values()], target: identity(), source: input.source }
  }
  async function exportConfig() {
    const current = await state(db)
    const result = await snapshot(db, current)
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new Error('配置超过 768KB，请联系技术人员迁移')
    return result
  }
  async function preview(input) {
    const result = await plan(input, db, await state(db))
    return { token: result.token, source: result.source, target: result.target, summary: result.summary,
      changedCount: result.changes.length, assets: result.assets, protected: ['支付与转账配置、API密钥保留目标值', '目标已有库存、销量、领券及问卷统计保留', '不删除目标环境独有配置', '新增问卷以草稿导入', '生产环境关闭测试地址模式', '文件地址转换不等于复制素材'] }
  }
  async function apply(admin, data) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(data.requestId || '')) throw new Error('导入请求标识无效')
    if (data.confirmEnvId !== identity().envId || !data.confirmEnvId) throw new Error('请确认当前目标环境后再导入')
    validate(data.snapshot)
    if (typeof db.createCollection === 'function') {
      try { await db.createCollection('config_migration_backups') }
      catch (error) { if (!/already exists|已存在|collection.*exists/i.test(error.message || error.errMsg || '')) throw error }
    }
    const id = 'migration_' + digest([admin.openid, data.requestId]).slice(0, 32)
    return transaction(db, async tx => {
      const previous = await readOptionalDocument(tx, 'config_migration_backups', id)
      if (previous) {
        if (previous.inputHash !== digest(data.snapshot)) throw new Error('导入请求标识已用于其他文件')
        return previous.result
      }
      const user = await readOptionalDocument(tx, 'users', admin._id)
      const policy = await readOptionalDocument(tx, 'admin_access_config', 'policy')
      if (!user || user.status !== 'active' || !(user.roles || []).includes('admin') || policy && policy.enabled && policy.ownerOpenid !== admin.openid) throw new Error('仅超级管理员可导入配置')
      const current = await state(tx)
      const result = await plan(data.snapshot, tx, current)
      if (result.token !== data.token) throw new Error('配置或文件已变化，请重新预览后导入')
      const backup = await snapshot(tx, current)
      if (Buffer.byteLength(JSON.stringify(backup)) > MAX_BYTES) throw new Error('目标配置备份超过 768KB，导入已取消')
      const completed = { backupId: id, changedCount: result.changes.length, importedAt: now(), targetEnv: identity().envId }
      // Backup, all configuration writes and the audit record commit together.
      await tx.collection('config_migration_backups').doc(id).set({ data: { snapshot: backup, inputHash: digest(data.snapshot), result: completed, createdAt: now(), createdBy: admin.openid } })
      for (const change of result.changes) await tx.collection(change.collection).doc(change.id).set({ data: change.payload })
      await tx.collection('admin_operation_logs').doc(id).set({ data: { adminUserId: admin._id, adminOpenid: admin.openid, targetType: 'config_migration', targetId: id, action: 'importConfiguration', detail: { sourceEnv: data.snapshot.source.envId, targetEnv: identity().envId, changedCount: result.changes.length }, createdAt: now() } })
      return completed
    })
  }
  async function backup(id) {
    if (!/^migration_[a-f0-9]{32}$/.test(id || '')) throw new Error('备份编号无效')
    const row = await readOptionalDocument(db, 'config_migration_backups', id)
    if (!row) throw new Error('备份不存在')
    return row.snapshot
  }
  return { exportConfig, preview, apply, backup }
}
