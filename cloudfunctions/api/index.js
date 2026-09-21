const cloud = require('wx-server-sdk')
const crypto = require('crypto')
const https = require('https')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

const collections = [
  'users', 'pets', 'home_security', 'staff_profiles', 'orders', 'payments', 'order_home_security', 'order_early_start_requests',
  'track_logs', 'checkin_logs', 'unlock_code_logs', 'order_incidents', 'incident_comments', 'incident_actions', 'admin_operation_logs', 'service_prices', 'service_checkin_rules', 'staff_identity_verifications',
  'sitter_favorites', 'service_reviews', 'user_addresses', 'order_timeline', 'platform_configs',
  'coupon_templates', 'user_coupons', 'payment_events', 'refunds', 'finance_logs',
  'staff_earnings', 'withdraw_requests', 'staff_schedule_exceptions',
  'subscription_consents', 'subscription_logs', 'home_security_notifications',
  'order_message_threads', 'order_messages', 'order_staff_message_threads', 'order_staff_messages',
  'member_levels', 'point_logs', 'lottery_activities', 'lottery_records',
  'pet_beauty_votes', 'pet_beauty_month_rankings', 'pet_beauty_month_locks',
  'pet_playgrounds', 'pet_homes', 'pet_playground_entities', 'pet_3d_models',
  'checkin_month_configs', 'user_checkins', 'retro_card_logs', 'reward_mails', 'user_invites', 'ai_logs',
  'user_feedback', 'staff_promotion_applications',
  'staff_deposits', 'staff_deposit_events', 'staff_supply_reimbursements',
  'mall_categories', 'mall_products', 'mall_carts', 'mall_orders'
]

const VISIT_FEE_SERVICE_KEY = 'visit_fee'
const RETIRED_SERVICE_KEYS = new Set(['extra_pet'])
const EXTRA_PET_RULES = new Set(['none', 'all', 'dog'])

const defaultServicePrices = [
  { key: VISIT_FEE_SERVICE_KEY, label: '上门费', price: 30, extraPetFee: 0, extraPetRule: 'none', showOnHome: false, enabled: true, sortOrder: 5, description: '每次上门服务固定收取，包含基础到店与履约保障', coverUrl: '' },
  { key: 'walk', label: '遛狗服务', price: 39, extraPetFee: 30, extraPetRule: 'dog', showOnHome: false, enabled: true, sortOrder: 10, description: '牵引遛狗、轨迹记录、回家安置', coverUrl: '' },
  { key: 'feed', label: '喂养服务', price: 29, extraPetFee: 0, extraPetRule: 'none', showOnHome: false, enabled: true, sortOrder: 20, description: '换粮换水、基础陪伴', coverUrl: '' },
  { key: 'litter', label: '清理宠物厕所', price: 29, extraPetFee: 0, extraPetRule: 'none', showOnHome: false, enabled: true, sortOrder: 30, description: '猫砂盆/宠物厕所基础清理', coverUrl: '' },
  { key: 'play', label: '陪伴玩耍', price: 39, extraPetFee: 15, extraPetRule: 'all', showOnHome: false, enabled: true, sortOrder: 40, description: '陪伴互动、安抚情绪', coverUrl: '' },
  { key: 'medicine', label: '喂药协助', price: 49, extraPetFee: 15, extraPetRule: 'all', showOnHome: false, enabled: true, sortOrder: 50, description: '按主人说明协助喂药', coverUrl: '' },
  { key: 'clean', label: '简单清洁', price: 39, extraPetFee: 0, extraPetRule: 'none', showOnHome: false, enabled: true, sortOrder: 60, description: '宠物活动区域简单整理', coverUrl: '' }
]

const defaultServiceCheckinRules = [
  { serviceType: 'walk', eventType: 'sanitization', required: true, sortOrder: 5 },
  { serviceType: 'walk', eventType: 'enter_door', required: true, sortOrder: 10 },
  { serviceType: 'walk', eventType: 'leash_on', required: true, sortOrder: 20 },
  { serviceType: 'walk', eventType: 'pet_status', required: true, sortOrder: 30 },
  { serviceType: 'walk', eventType: 'return_home', required: true, sortOrder: 40 },
  { serviceType: 'walk', eventType: 'leave_door', required: true, sortOrder: 50 },
  { serviceType: 'feed', eventType: 'sanitization', required: true, sortOrder: 5 },
  { serviceType: 'feed', eventType: 'enter_door', required: true, sortOrder: 10 },
  { serviceType: 'feed', eventType: 'feed', required: true, sortOrder: 20 },
  { serviceType: 'feed', eventType: 'water', required: true, sortOrder: 30 },
  { serviceType: 'feed', eventType: 'pet_status', required: true, sortOrder: 40 },
  { serviceType: 'feed', eventType: 'leave_door', required: true, sortOrder: 50 },
  { serviceType: 'litter', eventType: 'sanitization', required: true, sortOrder: 5 },
  { serviceType: 'litter', eventType: 'clean', required: true, sortOrder: 20 },
  { serviceType: 'play', eventType: 'sanitization', required: true, sortOrder: 5 },
  { serviceType: 'play', eventType: 'pet_status', required: true, sortOrder: 20 },
  { serviceType: 'medicine', eventType: 'sanitization', required: true, sortOrder: 5 },
  { serviceType: 'medicine', eventType: 'medicine', required: true, sortOrder: 20 },
  { serviceType: 'clean', eventType: 'sanitization', required: true, sortOrder: 5 },
  { serviceType: 'clean', eventType: 'clean', required: true, sortOrder: 20 }
]

const DEFAULT_STAFF_TRAINING_PASS_SCORE = 80
const STAFF_TRAINING_VIDEOS = [
  { key: 'platform_rules', title: '平台服务规范', durationText: '约 5 分钟', description: '学习接单、履约、禁止私单和服务边界。' },
  { key: 'home_service', title: '上门服务流程', durationText: '约 6 分钟', description: '了解出发、到达、服务中、离开和报告提交规范。' },
  { key: 'pet_safety', title: '宠物安全与异常处理', durationText: '约 8 分钟', description: '掌握牵引、喂食、清洁、异常上报和紧急处理。' }
]
const DEFAULT_STAFF_TRAINING_QUIZ = [
  { id: 'q1', type: 'single', question: '遛狗服务中是否必须全程牵引？', options: [{ value: 'A', label: '必须全程牵引' }, { value: 'B', label: '宠物很乖可以不牵' }, { value: 'C', label: '客户没要求就不用' }], answer: 'A' },
  { id: 'q2', type: 'single', question: '服务中发现宠物精神异常，应该怎么做？', options: [{ value: 'A', label: '结束后再说' }, { value: 'B', label: '立即联系客户并在平台记录' }, { value: 'C', label: '自行喂药处理' }], answer: 'B' },
  { id: 'q3', type: 'single', question: '是否可以绕过平台与客户私下交易？', options: [{ value: 'A', label: '可以' }, { value: 'B', label: '熟客可以' }, { value: 'C', label: '不可以' }], answer: 'C' },
  { id: 'q4', type: 'single', question: '服务报告应包含哪些内容？', options: [{ value: 'A', label: '图文反馈、宠物状态和服务结果' }, { value: 'B', label: '只写已完成' }, { value: 'C', label: '只上传一张图片' }], answer: 'A' },
  { id: 'q5', type: 'single', question: '是否可以带无关人员进入客户家中？', options: [{ value: 'A', label: '不可以' }, { value: 'B', label: '朋友可以' }, { value: 'C', label: '宠物喜欢就可以' }], answer: 'A' }
]
const STAFF_VIDEO_AUDIT_GUIDE = {
  wechatId: 'pet-service-admin',
  remarkTemplate: '宠托师审核 + 姓名 + 手机号',
  description: '请添加平台审核微信并按备注格式发送信息，管理员完成线上视频审核后会在后台更新结果。',
  requiredItemsNotice: '视频通话审核必备用品（须提前自备）：一次性手套、一次性口罩、一次性鞋套、安全宠物消毒用品。',
  strictWarning: '温馨提醒：平台对审核员有严格要求，存在不通过的风险。备齐物资为必备前提，但不代表必然通过；如因其他原因未正式通过认证，平台不予报销宠物用品。成为认证宠托师后可申请首次用品报销，每人仅限首次申请，后续用品自备且不报销。'
}
const DEFAULT_DISPOSABLE_SUPPLY_ITEMS = [
  { id: 'supply_gloves', name: '一次性手套', description: '佩戴防接触感染，足量自备', purchaseUrl: '', enabled: true },
  { id: 'supply_mask', name: '一次性口罩', description: '规范防护，入户全程佩戴', purchaseUrl: '', enabled: true },
  { id: 'supply_shoes', name: '一次性鞋套', description: '进门即穿戴，保护家庭卫生', purchaseUrl: '', enabled: true },
  { id: 'supply_disinfectant', name: '安全宠物消毒用品', description: '正规安全无毒，进门及工具消毒', purchaseUrl: '', enabled: true }
]
const QUIZ_OPTION_VALUES = ['A', 'B', 'C', 'D', 'E', 'F']

function normalizeTrainingVideos(videos = STAFF_TRAINING_VIDEOS) {
  const source = Array.isArray(videos) ? videos : []
  const normalized = source.map((item, index) => {
    const title = safeText(item.title).trim()
    const key = safeText(item.key).trim() || `video_${index + 1}`
    if (!title || !key) return null
    return {
      key,
      title,
      durationText: safeText(item.durationText).trim(),
      description: safeText(item.description).trim(),
      fileId: safeText(item.fileId).trim(),
      posterFileId: safeText(item.posterFileId).trim(),
      enabled: item.enabled !== false,
      sort: Number(item.sort) || (index + 1) * 10
    }
  }).filter(Boolean).sort((a, b) => a.sort - b.sort)
  return normalized.length ? normalized : STAFF_TRAINING_VIDEOS.map((item, index) => ({ ...item, fileId: '', posterFileId: '', enabled: true, sort: (index + 1) * 10 }))
}

function enabledTrainingVideos(training = {}) {
  return normalizeTrainingVideos(training.videos).filter((item) => item.enabled !== false)
}

function normalizeVideoAuditGuide(guide = {}) {
  const source = guide || {}
  return {
    wechatId: safeText(source.wechatId).trim() || STAFF_VIDEO_AUDIT_GUIDE.wechatId,
    remarkTemplate: safeText(source.remarkTemplate).trim() || STAFF_VIDEO_AUDIT_GUIDE.remarkTemplate,
    description: safeText(source.description).trim() || STAFF_VIDEO_AUDIT_GUIDE.description,
    requiredItemsNotice: safeText(source.requiredItemsNotice).trim() || STAFF_VIDEO_AUDIT_GUIDE.requiredItemsNotice,
    strictWarning: safeText(source.strictWarning).trim() || STAFF_VIDEO_AUDIT_GUIDE.strictWarning
  }
}

function normalizeStaffTrainingConfig(training = {}) {
  const passScore = Math.min(Math.max(Math.round(Number(training.passScore ?? DEFAULT_STAFF_TRAINING_PASS_SCORE)), 1), 100)
  const sourceQuiz = Array.isArray(training.quiz) ? training.quiz : []
  const quiz = sourceQuiz.map((item, index) => {
    const question = safeText(item.question).trim()
    const options = (Array.isArray(item.options) ? item.options : []).map((option, optionIndex) => ({
      value: QUIZ_OPTION_VALUES[optionIndex] || safeText(option.value).trim(),
      label: safeText(option.label).trim()
    })).filter((option) => option.value && option.label).slice(0, QUIZ_OPTION_VALUES.length)
    const answer = safeText(item.answer).trim()
    if (!question || options.length < 2 || !options.some((option) => option.value === answer)) return null
    return {
      id: safeText(item.id).trim() || `q${index + 1}`,
      type: 'single',
      question,
      options,
      answer
    }
  }).filter(Boolean)

  return {
    passScore,
    quiz: quiz.length ? quiz : DEFAULT_STAFF_TRAINING_QUIZ,
    videos: normalizeTrainingVideos(training.videos),
    videoAuditGuide: normalizeVideoAuditGuide(training.videoAuditGuide)
  }
}

function publicTrainingQuiz(quiz = []) {
  return quiz.map(({ answer, ...item }) => item)
}

function normalizeStaffDepositConfig(deposit = {}) {
  return {
    enabled: deposit.enabled === true && Number.isFinite(Number(deposit.amount)) && Number(deposit.amount) > 0,
    amount: Number.isFinite(Number(deposit.amount)) ? Math.max(Number(deposit.amount || 0), 0) : 0,
    rulesText: safeText(deposit.rulesText).trim() || '资料审核通过后需支付宠托师保证金；退出宠托师且无未结事项时可申请退还。',
    refundRulesText: safeText(deposit.refundRulesText).trim() || '退出宠托师时平台审核后按可退余额原路退回。',
    forfeitRulesText: safeText(deposit.forfeitRulesText).trim() || '如出现私单、严重服务违规、虚假打卡等不合规行为，平台可按规则扣除或没收保证金。'
  }
}

function normalizeStaffSuppliesItems(items = [], fallbackRequired = []) {
  if (Array.isArray(items) && items.length) {
    const list = items.map((item, index) => {
      if (typeof item === 'string') {
        const name = safeText(item).trim()
        if (!name) return null
        const defaultMatch = DEFAULT_DISPOSABLE_SUPPLY_ITEMS.find((d) => d.name === name)
        return {
          id: `supply_${index + 1}`,
          name,
          description: defaultMatch ? defaultMatch.description : '',
          purchaseUrl: '',
          enabled: true
        }
      }
      const name = safeText(item && item.name).trim()
      if (!name) return null
      return {
        id: safeText(item.id).trim() || `supply_${index + 1}`,
        name,
        description: safeText(item.description).trim(),
        purchaseUrl: safeText(item.purchaseUrl).trim(),
        enabled: item.enabled !== false
      }
    }).filter(Boolean)
    if (!list.some((item) => item.name.includes('鞋套'))) {
      list.splice(2, 0, { id: 'supply_shoes', name: '一次性鞋套', description: '进门即穿戴，保护家庭卫生', purchaseUrl: '', enabled: true })
    }
    return list
  }
  if (Array.isArray(fallbackRequired) && fallbackRequired.length) {
    const list = fallbackRequired.map((name, index) => {
      const cleanName = safeText(name).trim()
      if (!cleanName) return null
      const defaultMatch = DEFAULT_DISPOSABLE_SUPPLY_ITEMS.find((d) => d.name === cleanName)
      return {
        id: `supply_${index + 1}`,
        name: cleanName,
        description: defaultMatch ? defaultMatch.description : '',
        purchaseUrl: '',
        enabled: true
      }
    }).filter(Boolean)
    if (!list.some((item) => item.name.includes('鞋套'))) {
      list.splice(2, 0, { id: 'supply_shoes', name: '一次性鞋套', description: '进门即穿戴，保护家庭卫生', purchaseUrl: '', enabled: true })
    }
    return list
  }
  return DEFAULT_DISPOSABLE_SUPPLY_ITEMS.map((item, index) => ({
    id: `supply_${index + 1}`,
    ...item
  }))
}

function normalizeStaffSuppliesConfig(supplies = {}) {
  const items = normalizeStaffSuppliesItems(supplies.items, supplies.requiredItems)
  const requiredItems = items.filter((i) => i.enabled !== false).map((i) => i.name)
  return {
    reimbursementEnabled: supplies.reimbursementEnabled !== false,
    maxReimbursementAmount: Number.isFinite(Number(supplies.maxReimbursementAmount)) && Number(supplies.maxReimbursementAmount) > 0 ? Number(supplies.maxReimbursementAmount) : 200,
    transfer: {
      enabled: supplies.transfer?.enabled === true,
      sceneId: safeText(supplies.transfer?.sceneId).trim(),
      userRecvPerception: safeText(supplies.transfer?.userRecvPerception).trim(),
      sceneReportInfos: (Array.isArray(supplies.transfer?.sceneReportInfos) ? supplies.transfer.sceneReportInfos : []).map((item) => ({ info_type: safeText(item.info_type).trim(), info_content: safeText(item.info_content).trim() }))
    },
    items,
    requiredItems: requiredItems.length ? requiredItems : ['一次性手套', '一次性口罩', '一次性鞋套', '安全宠物消毒用品'],
    auditNotice: safeText(supplies.auditNotice).trim() || '线上视频审核会严格检查必备用品准备情况，用品齐全不代表一定通过；如因其他原因未正式通过，平台不提供报销。',
    serviceReminder: safeText(supplies.serviceReminder).trim() || '出发前请确认已携带一次性手套、一次性口罩、一次性鞋套和安全宠物消毒用品；开始服务后请先完成隔离病菌/消毒拍照打卡。'
  }
}

function ok(data) { return { ok: true, data } }

function inferErrorCode(message = '') {
  const text = String(message || '')
  if (text.includes('请先登录') || text.includes('账号不可用')) return 'AUTH_REQUIRED'
  if (text.includes('仅管理员') || text.includes('无权') || text.includes('不是该订单') || text.includes('仅订单员工') || text.includes('仅宠物主')) return 'FORBIDDEN'
  if (text.includes('状态不可') || text.includes('仅服务中') || text.includes('订单完成后') || text.includes('已被分配') || text.includes('已评价')) return 'INVALID_STATE'
  if (text.includes('请选择') || text.includes('请填写') || text.includes('请上传') || text.includes('格式无效') || text.includes('不能为空') || text.includes('不正确') || text.includes('无效')) return 'VALIDATION_ERROR'
  if (text.includes('不存在') || text.includes('未配置') || text.includes('不可用')) return 'NOT_FOUND'
  return 'UNKNOWN_ERROR'
}

function fail(message, code) { return { ok: false, code: code || inferErrorCode(message), message } }
function now() { return new Date() }
function nowText() { return new Date().toISOString() }
function beijingClockText(value = now()) {
  const source = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(source.getTime())) return ''
  const cst = new Date(source.getTime() + 8 * 60 * 60 * 1000)
  const hour = String(cst.getUTCHours()).padStart(2, '0')
  const minute = String(cst.getUTCMinutes()).padStart(2, '0')
  return `${hour}:${minute}`
}
// 返回 CST（UTC+8）当日零点的 Date 对象，用于"每日"类限制判断
function cstTodayStart() {
  const cstOffset = 8 * 60 * 60 * 1000
  const cstMs = Date.now() + cstOffset
  return new Date(Math.floor(cstMs / 86400000) * 86400000 - cstOffset)
}

function toCstParts(date = now()) {
  const source = date instanceof Date ? date : new Date(date)
  const cst = new Date(source.getTime() + 8 * 60 * 60 * 1000)
  const year = cst.getUTCFullYear()
  const month = String(cst.getUTCMonth() + 1).padStart(2, '0')
  const day = String(cst.getUTCDate()).padStart(2, '0')
  return {
    year,
    month,
    day,
    monthKey: `${year}-${month}`,
    dateKey: `${year}-${month}-${day}`,
    dayNumber: Number(day)
  }
}

function getMonthDays(monthKey) {
  const matched = String(monthKey || '').match(/^(\d{4})-(\d{2})$/)
  if (!matched) return 31
  return new Date(Number(matched[1]), Number(matched[2]), 0).getDate()
}

function defaultCheckinDays(monthKey) {
  const count = getMonthDays(monthKey)
  return Array.from({ length: count }, (_, index) => ({ day: index + 1, rewardType: 'points', points: 5, couponTemplateId: '', couponSnapshot: null, title: `第${index + 1}天奖励`, desc: '签到奖励' }))
}
function safeText(value) { return value === undefined || value === null ? '' : String(value) }
function normalizeMemberNameColor(value) {
  const color = safeText(value).trim()
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : ''
}
function normalizeMemberNameEffect(value) {
  const effect = safeText(value).trim()
  return ['none', 'gold_shine', 'silver_shine', 'bronze_shine', 'pink_dream', 'blue_diamond', 'emerald_glow', 'fire_glow', 'purple_neon', 'dark_gold', 'gradient_rainbow', '3d_emboss'].includes(effect) ? effect : 'none'
}
function normalizeMemberBadgeStyle(value) {
  const style = safeText(value).trim()
  return ['gold', 'silver', 'bronze', 'purple', 'pink', 'blue', 'green', 'red', 'dark', 'rainbow'].includes(style) ? style : 'gold'
}
function normalizeMemberBadgeTag(value) {
  return safeText(value).trim().slice(0, 8)
}
function isValidThemeKey(value) { return ['day', 'night'].includes(safeText(value).trim()) }
function normalizeThemeKey(value) {
  const key = safeText(value).trim()
  return isValidThemeKey(key) ? key : 'day'
}
function isValidFontKey(value) { return ['system', 'rounded', 'clean', 'serif', 'cute'].includes(safeText(value).trim()) }
function normalizeFontKey(value) {
  const key = safeText(value).trim()
  return isValidFontKey(key) ? key : 'system'
}
function safeNumber(value) {
  const normalized = String(value || 0).replace(/[^0-9.]/g, '')
  const number = Number(normalized || 0)
  return Number.isFinite(number) ? number : 0
}
function safeFileId(value) {
  const text = safeText(value)
  return text.startsWith('cloud://') ? text : ''
}

function parseDateValue(value) {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  const text = String(value)
  const direct = new Date(text)
  if (!Number.isNaN(direct.getTime())) return direct
  const normalized = new Date(text.replace(/-/g, '/'))
  return Number.isNaN(normalized.getTime()) ? null : normalized
}

function roleText(roles = []) {
  const labels = { client: '用户', staff: '宠托师', admin: '管理员' }
  return (Array.isArray(roles) ? roles : []).map((role) => labels[role] || role).join('、') || '用户'
}

function auditStatusText(status) {
  const labels = { approved: '已通过', pending: '待审核', rejected: '未通过', revoked: '已移除' }
  return labels[status] || '未知'
}

function staffLevelText(level) {
  const labels = { applicant: '申请人', intern: '实习宠托师', certified: '认证宠托师' }
  return labels[level] || labels.applicant
}

function onboardingStatusText(status) {
  const labels = { application_pending: '入驻审核中', training_pending: '待完成培训', quiz_passed: '答题已通过', videos_completed: '视频已完成', video_audit_pending: '视频审核中', intern: '实习中' }
  return labels[status] || labels.application_pending
}

function videoAuditStatusText(status) {
  const labels = { not_started: '未申请', pending: '待视频审核', approved: '已通过', rejected: '未通过' }
  return labels[status] || labels.not_started
}

function promotionStatusText(status) {
  const labels = { none: '未申请', pending: '转正审核中', approved: '已转正', rejected: '转正未通过' }
  return labels[status] || labels.none
}

function normalizeStaffWorkflow(profile = {}) {
  if (!profile) return null
  const approved = profile.auditStatus === 'approved'
  const legacyCertified = approved && !profile.staffLevel
  const staffLevel = legacyCertified ? 'certified' : (profile.staffLevel || 'applicant')
  let onboardingStatus = profile.onboardingStatus || 'application_pending'
  if (approved && staffLevel === 'applicant' && onboardingStatus === 'application_pending') onboardingStatus = 'training_pending'
  if (staffLevel === 'intern' && onboardingStatus !== 'video_audit_pending') onboardingStatus = 'intern'
  return {
    ...profile,
    staffLevel,
    staffLevelText: staffLevelText(staffLevel),
    onboardingStatus,
    onboardingStatusText: onboardingStatusText(onboardingStatus),
    depositStatus: profile.depositStatus || 'unpaid',
    supplyReimbursementStatus: profile.supplyReimbursementStatus || 'not_applied',
    videoAuditStatus: profile.videoAuditStatus || 'not_started',
    videoAuditStatusText: videoAuditStatusText(profile.videoAuditStatus || 'not_started'),
    promotionStatus: profile.promotionStatus || 'none',
    promotionStatusText: promotionStatusText(profile.promotionStatus || 'none'),
    internCompletedOrderCount: Number(profile.internCompletedOrderCount || 0)
  }
}

function staffDepositSatisfied(profile = {}, depositConfig = null) {
  if (depositConfig && depositConfig.enabled === true && Number(depositConfig.amount) > 0) {
    return profile.depositStatus === 'paid'
  }
  if (profile.depositRequired === true) {
    return profile.depositStatus === 'paid'
  }
  return (!profile.depositRequired || profile.depositStatus === 'paid')
}

function staffMoneyEligible(profile = {}, depositConfig = null) {
  if (['requested', 'approved', 'exited'].includes(profile.exitStatus)) return false
  return staffDepositSatisfied(profile, depositConfig)
}

function isCertifiedSitter(profile = {}, depositConfig = null) {
  const p = normalizeStaffWorkflow(profile)
  return Boolean(p && staffMoneyEligible(p, depositConfig) && p.auditStatus === 'approved' && p.staffLevel === 'certified')
}

function canTakeOrders(profile = {}, depositConfig = null) {
  const p = normalizeStaffWorkflow(profile)
  return Boolean(p && staffMoneyEligible(p, depositConfig) && p.auditStatus === 'approved' && ['intern', 'certified'].includes(p.staffLevel))
}

function validateStaffTakeOrderAbility(profile = {}, depositConfig = null) {
  const p = normalizeStaffWorkflow(profile)
  if (!p || p.auditStatus !== 'approved' || !['intern', 'certified'].includes(p.staffLevel)) {
    return { can: false, reason: 'training_pending', message: '完成培训和视频审核成为实习宠托师后方可接单' }
  }
  if (['requested', 'approved', 'exited'].includes(p.exitStatus)) {
    return { can: false, reason: 'exited', message: '当前宠托师账号已申请退出或已退出，无法接单' }
  }
  if (!staffDepositSatisfied(p, depositConfig)) {
    return { can: false, reason: 'deposit_unpaid', message: '未缴纳宠托师履约保证金，暂不可抢单或接单，请先缴纳保证金' }
  }
  return { can: true }
}

function isTrainingComplete(profile = {}, training = normalizeStaffTrainingConfig()) {
  const p = normalizeStaffWorkflow(profile)
  const progress = p.trainingVideoProgress || {}
  const videos = enabledTrainingVideos(training)
  const allVideosWatched = videos.length === 0 || videos.every((video) => progress[video.key] && progress[video.key].watched === true)
  return Boolean(p && p.quizPassedAt && allVideosWatched)
}

async function getStaffProfileByOpenid(openid) {
  const res = await db.collection('staff_profiles').where({ openid }).limit(1).get()
  return normalizeStaffWorkflow(res.data[0] || null)
}

async function getCompletedStaffOrders(staffOpenid, limit = 0) {
  const res = await db.collection('orders').where({ staffOpenid, status: 'completed' }).orderBy('completedAt', 'desc').get()
  const list = (res.data || []).filter((order) => !isAdminDeletedOrder(order))
  return limit > 0 ? list.slice(0, limit) : list
}

function safeUserSummary(user = {}, extra = {}) {
  const roles = Array.isArray(user.roles) ? user.roles : ['client']
  return {
    _id: user._id || '',
    openid: user.openid || '',
    nickname: user.nickname || '微信用户',
    avatarUrl: user.avatarUrl || '',
    phone: user.phone || '',
    roles,
    rolesText: roleText(roles),
    activeRole: user.activeRole || 'client',
    status: user.status || 'active',
    memberLevel: user.memberLevel || '',
    memberLevelName: user.memberLevelName || '普通会员',
    badgeTag: user.badgeTag || 'V1',
    badgeStyle: user.badgeStyle || 'gold',
    nameColor: user.nameColor || '',
    nameEffect: user.nameEffect || '',
    points: Number(user.points || 0),
    totalPoints: Number(user.totalPoints || 0),
    retroCardCount: Number(user.retroCardCount || 0),
    completedOrderCount: Number(user.completedOrderCount || 0),
    createdAt: user.createdAt || '',
    updatedAt: user.updatedAt || '',
    ...extra
  }
}

function isPaidOrder(order = {}) {
  return order.paymentStatus === 'paid' || ['paid', 'assigned', 'in_service', 'completed'].includes(order.status)
}

function buildMonthlyDashboard(orders = [], users = []) {
  const monthKey = toCstParts().monthKey
  const dayCount = getMonthDays(monthKey)
  const days = Array.from({ length: dayCount }, (_, index) => ({ day: index + 1, label: `${index + 1}日`, orders: 0, registrations: 0, revenue: 0 }))
  orders.forEach((order) => {
    const createdDate = parseDateValue(order.createdAt)
    if (createdDate) {
      const createdParts = toCstParts(createdDate)
      if (createdParts.monthKey === monthKey && days[createdParts.dayNumber - 1]) days[createdParts.dayNumber - 1].orders += 1
    }
    const paidDate = parseDateValue(order.paidAt || order.createdAt)
    if (!paidDate || !isPaidOrder(order)) return
    const paidParts = toCstParts(paidDate)
    if (paidParts.monthKey === monthKey && days[paidParts.dayNumber - 1]) days[paidParts.dayNumber - 1].revenue += Number(order.payAmount || 0)
  })
  users.forEach((user) => {
    const date = parseDateValue(user.createdAt)
    if (!date) return
    const parts = toCstParts(date)
    if (parts.monthKey === monthKey && days[parts.dayNumber - 1]) days[parts.dayNumber - 1].registrations += 1
  })
  const maxOrders = Math.max(...days.map((item) => item.orders), 1)
  const maxRegistrations = Math.max(...days.map((item) => item.registrations), 1)
  const maxRevenue = Math.max(...days.map((item) => item.revenue), 1)
  const revenueTotal = days.reduce((sum, item) => sum + item.revenue, 0)
  const paidOrders = orders.filter((order) => isPaidOrder(order)).filter((order) => {
    const paidDate = parseDateValue(order.paidAt || order.createdAt)
    return paidDate && toCstParts(paidDate).monthKey === monthKey
  })
  const withHeights = days.map((item) => ({
    ...item,
    revenueText: `¥${item.revenue}`,
    orderHeight: item.orders ? Math.max(Math.round((item.orders / maxOrders) * 100), 8) : 0,
    registrationHeight: item.registrations ? Math.max(Math.round((item.registrations / maxRegistrations) * 100), 8) : 0,
    revenueHeight: item.revenue ? Math.max(Math.round((item.revenue / maxRevenue) * 100), 8) : 0
  }))
  return {
    monthKey,
    days: withHeights,
    totals: {
      orders: days.reduce((sum, item) => sum + item.orders, 0),
      registrations: days.reduce((sum, item) => sum + item.registrations, 0),
      revenue: revenueTotal,
      paidOrders: paidOrders.length,
      averageOrderValue: paidOrders.length ? Math.round(revenueTotal / paidOrders.length) : 0
    },
    max: { orders: maxOrders, registrations: maxRegistrations, revenue: maxRevenue }
  }
}

function normalizeHomeHeroCarousel(carousel = {}) {
  const source = typeof carousel === 'object' && carousel !== null ? carousel : {}
  const rawItems = Array.isArray(source.items) ? source.items : []
  const items = rawItems
    .map((item, index) => {
      const type = item && item.type === 'video' ? 'video' : 'image'
      const fileId = safeText(item && item.fileId).trim()
      if (!fileId) return null
      return {
        id: safeText(item && item.id).trim() || `hero_${Date.now()}_${index}`,
        type,
        fileId,
        posterFileId: safeText(item && item.posterFileId).trim(),
        title: safeText(item && item.title).trim(),
        subtitle: safeText(item && item.subtitle).trim(),
        linkType: safeText(item && item.linkType).trim() || (item && item.linkUrl ? 'custom' : 'none'),
        linkUrl: safeText(item && (item.linkUrl || item.url || item.path)).trim(),
        linkTitle: safeText(item && item.linkTitle).trim(),
        enabled: item && item.enabled !== false,
        sort: safeNumber(item && item.sort) || (index + 1) * 10
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.sort - b.sort)

  const interval = safeNumber(source.rotateIntervalMs || source.interval)
  const rotateIntervalMs = interval >= 1000 ? Math.min(interval, 30000) : 5000

  return {
    enabled: source.enabled === true,
    autoRotate: source.autoRotate !== false,
    rotateIntervalMs,
    items
  }
}

const defaultHomeModules = {
  quickBooking: true,
  nearbySitters: true,
  repeatBooking: true,
  hotServices: true,
  newbieCoupon: true,
  featuredSitters: true,
  platformAssurance: true,
  historyStats: true,
  lottery: true,
  petBeautyActivity: true
}

function normalizeHomePageConfig(homePage = {}) {
  const modules = homePage.modules || {}
  return {
    ctaTitle: safeText(homePage.ctaTitle).trim() || '立即预约上门宠护',
    ctaSubtitle: safeText(homePage.ctaSubtitle).trim() || '填写宠物和服务时间，平台认证宠托师快速响应。',
    ctaText: safeText(homePage.ctaText).trim() || '立即预约',
    nearbyTitle: safeText(homePage.nearbyTitle).trim() || '附近宠托师',
    repeatTitle: safeText(homePage.repeatTitle).trim() || '一键复购',
    couponTitle: safeText(homePage.couponTitle).trim() || '新人优惠',
    assuranceTitle: safeText(homePage.assuranceTitle).trim() || '平台保障',
    modules: Object.keys(defaultHomeModules).reduce((result, key) => ({
      ...result,
      [key]: modules[key] !== false
    }), {})
  }
}

function pickPaymentSecret(payment, existingPayment, field, inputField) {
  const directValue = payment[field]
  const inputValue = inputField ? payment[inputField] : undefined
  if (inputValue !== undefined) {
    const normalized = safeText(inputValue).trim()
    return normalized || safeText(existingPayment[field]).trim()
  }
  if (directValue !== undefined) {
    const normalized = safeText(directValue).trim()
    return normalized || safeText(existingPayment[field]).trim()
  }
  return safeText(existingPayment[field]).trim()
}

function maskConfigured(value) {
  return safeText(value).trim() ? true : false
}

function normalizePaymentConfig(payment = {}, existingPayment = {}, includeSecrets = false) {
  const apiV3Key = pickPaymentSecret(payment, existingPayment, 'apiV3Key', 'apiV3KeyInput')
  const privateKey = pickPaymentSecret(payment, existingPayment, 'privateKey', 'privateKeyInput')
  const platformPublicKey = pickPaymentSecret(payment, existingPayment, 'platformPublicKey', 'platformPublicKeyInput')
  const certSerialNo = safeText(payment.certSerialNo ?? payment.merchantCertSerialNo ?? existingPayment.certSerialNo).trim()
  const rawMode = payment.mode ?? existingPayment.mode
  const normalized = {
    enabled: payment.enabled !== undefined ? payment.enabled !== false : existingPayment.enabled !== false,
    mode: rawMode === 'wechat' ? 'wechat' : 'mock',
    mchId: safeText(payment.mchId ?? existingPayment.mchId).trim(),
    appId: safeText(payment.appId ?? existingPayment.appId).trim(),
    notifyUrl: safeText(payment.notifyUrl ?? existingPayment.notifyUrl).trim(),
    certSerialNo,
    merchantCertSerialNo: certSerialNo,
    refundEnabled: payment.refundEnabled !== undefined ? payment.refundEnabled !== false : existingPayment.refundEnabled !== false,
    allowMockInProduction: payment.allowMockInProduction !== undefined ? payment.allowMockInProduction === true : existingPayment.allowMockInProduction === true,
    apiV3KeyConfigured: maskConfigured(apiV3Key || process.env.WECHAT_PAY_API_V3_KEY),
    privateKeyConfigured: maskConfigured(privateKey || process.env.WECHAT_PAY_PRIVATE_KEY),
    platformPublicKeyConfigured: maskConfigured(platformPublicKey || process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY)
  }
  if (includeSecrets) {
    normalized.apiV3Key = apiV3Key
    normalized.privateKey = privateKey
    normalized.platformPublicKey = platformPublicKey
  }
  return normalized
}

function normalizeSystemSettings(value = {}, options = {}) {
  const payment = value.payment || {}
  const existingPayment = options.existingPayment || {}
  const settlement = value.settlement || {}
  const subscription = value.subscription || {}
  const reliability = value.reliability || {}
  const includeSecrets = options.includeSecrets === true
  const existingSettings = options.existingSettings || options.previousValue || {}
  const rawQwenApiKey = value.qwenApiKeyInput !== undefined ? value.qwenApiKeyInput : value.qwenApiKey
  const qwenApiKey = (rawQwenApiKey !== undefined ? safeText(rawQwenApiKey).trim() : '') || safeText(existingSettings.qwenApiKey).trim()
  const qwenApiKeyConfigured = maskConfigured(qwenApiKey || process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY)

  const normalized = {
    enableTestAddressMode: value.enableTestAddressMode === true,
    enablePetBreedAi: value.enablePetBreedAi !== false,
    qwenApiKeyConfigured,
    qwenModel: safeText(value.qwenModel).trim() || 'qwen3.5-flash',
    staffTraining: normalizeStaffTrainingConfig(value.staffTraining),
    staffDeposit: normalizeStaffDepositConfig(value.staffDeposit),
    staffSupplies: normalizeStaffSuppliesConfig(value.staffSupplies),
    homeHeroCarousel: normalizeHomeHeroCarousel(value.homeHeroCarousel),
    homePage: normalizeHomePageConfig(value.homePage),
    payment: normalizePaymentConfig(payment, existingPayment, includeSecrets),
    settlement: {
      staffCommissionRate: Math.min(Math.max(Number(settlement.staffCommissionRate ?? 0.7), 0), 1),
      settlementDelayDays: Math.max(Math.round(Number(settlement.settlementDelayDays ?? 1)), 0),
      minWithdrawAmount: Math.max(Number(settlement.minWithdrawAmount ?? 10), 0),
      withdrawFeeRate: Math.min(Math.max(Number(settlement.withdrawFeeRate || 0), 0), 1)
    },
    subscription: {
      enabled: subscription.enabled === true,
      templates: {
        orderPaid: safeText(subscription.templates && subscription.templates.orderPaid).trim(),
        orderAssigned: safeText(subscription.templates && subscription.templates.orderAssigned).trim(),
        orderAccepted: safeText(subscription.templates && subscription.templates.orderAccepted).trim(),
        serviceStart: safeText(subscription.templates && subscription.templates.serviceStart).trim(),
        serviceFinish: safeText(subscription.templates && subscription.templates.serviceFinish).trim(),
        remoteUnlock: safeText(subscription.templates && subscription.templates.remoteUnlock).trim(),
        refundResult: safeText(subscription.templates && subscription.templates.refundResult).trim(),
        disputeUpdate: safeText(subscription.templates && subscription.templates.disputeUpdate).trim(),
        withdrawResult: safeText(subscription.templates && subscription.templates.withdrawResult).trim(),
        upcomingServiceReminder: safeText(subscription.templates && (subscription.templates.upcomingServiceReminder || subscription.templates.serviceReminder)).trim()
      }
    },
    reliability: {
      enableOfflineQueue: reliability.enableOfflineQueue !== false,
      maxTrackBatchSize: Math.min(Math.max(Math.round(Number(reliability.maxTrackBatchSize || 50)), 1), 200),
      maxRetryTimes: Math.min(Math.max(Math.round(Number(reliability.maxRetryTimes || 5)), 0), 20)
    },
    customerService: {
      phone: safeText((value.customerService || {}).phone).trim(),
      wechatId: safeText((value.customerService || {}).wechatId).trim(),
      workHours: safeText((value.customerService || {}).workHours).trim() || '每天 9:00-21:00',
      officialAccountName: safeText((value.customerService || {}).officialAccountName).trim()
    },
    checkinShare: {
      title: safeText((value.checkinShare || {}).title).trim() || '来签到领福利，补签卡也能拿',
      imageUrl: safeText((value.checkinShare || {}).imageUrl).trim()
    }
  }

  if (includeSecrets) {
    normalized.qwenApiKey = qwenApiKey
  }

  return normalized
}

function callQwenVisionApi(apiKey, model, base64Image) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: model || 'qwen3.5-flash',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`
              }
            },
            {
              type: 'text',
              text: '请分析并识别图片中的宠物类型和具体品种。如果是狗，species为"dog"；如果是猫，species为"cat"；如果是其他宠物（如兔子、仓鼠、蜥蜴等），species为"other"。只返回格式如 {"species":"dog","breed":"金毛寻回犬"} 的严格JSON，不要包含任何markdown、换行或额外字符。'
            }
          ]
        }
      ]
    })

    const options = {
      hostname: 'dashscope.aliyuncs.com',
      port: 443,
      path: '/compatible-mode/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
          if (!content) {
            return reject(new Error((json.error && json.error.message) || 'Qwen API 返回异常'))
          }
          const cleanText = String(content).replace(/```json/g, '').replace(/```/g, '').trim()
          const matched = cleanText.match(/\{[\s\S]*\}/)
          const parsed = JSON.parse(matched ? matched[0] : cleanText)
          resolve(parsed)
        } catch (err) {
          reject(new Error(`解析 AI 返回失败: ${data || err.message}`))
        }
      })
    })

    req.on('error', (err) => reject(err))
    req.setTimeout(20000, () => {
      req.destroy()
      reject(new Error('请求 AI 模型超时'))
    })
    req.write(payload)
    req.end()
  })
}

function callCloudbaseAiGateway(envId, modelName, imageUrl, promptText) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: modelName || 'qwen3.5-flash',
      messages: [
        {
          role: 'user',
          content: imageUrl ? [
            { type: 'image_url', image_url: { url: imageUrl } },
            { type: 'text', text: promptText }
          ] : promptText
        }
      ]
    })

    const targetEnv = envId || 'cloud1-5gnhqn4t0554c1d9'
    const options = {
      hostname: `${targetEnv}.api.tcloudbasegateway.com`,
      port: 443,
      path: '/v1/ai/cloudbase/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }

    const req = https.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const json = JSON.parse(data)
          const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content
          if (!content) {
            return reject(new Error((json.error && json.error.message) || json.message || 'AI 网关响应异常'))
          }
          resolve(content)
        } catch (err) {
          reject(new Error(`解析 AI 响应失败: ${data || err.message}`))
        }
      })
    })

    req.on('error', (err) => reject(err))
    req.setTimeout(25000, () => {
      req.destroy()
      reject(new Error('请求云开发 AI 网关超时'))
    })
    req.write(payload)
    req.end()
  })
}

function getCloudbaseAiGatewayEnvId() {
  return process.env.TCB_ENV || process.env.SCF_NAMESPACE || 'cloud1-5gnhqn4t0554c1d9'
}

function petSpeciesName(species) {
  return species === 'cat' ? '猫咪' : species === 'other' ? '其他' : '狗狗'
}

function normalizePetSpecies(value) {
  return ['dog', 'cat', 'other'].includes(value) ? value : ''
}

function inferPetSpecies(text) {
  const source = safeText(text)
  if (/猫|布偶|英短|美短|狸花|暹罗|波斯/.test(source)) return 'cat'
  if (/狗|犬|柯基|金毛|拉布拉多|泰迪|贵宾|柴犬|边牧|哈士奇|萨摩耶/.test(source)) return 'dog'
  if (/兔|仓鼠|豚鼠|鸟|鹦鹉|龟|乌龟|龙猫|刺猬/.test(source)) return 'other'
  return ''
}

function parsePetRecognitionText(rawAiContent) {
  const rawText = safeText(rawAiContent).replace(/```json/g, '').replace(/```/g, '').trim()
  if (!rawText) throw new Error('AI 服务未返回识别内容，请稍后重试')

  let species = ''
  let breed = ''
  const jsonMatch = rawText.match(/\{[\s\S]*?\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      species = normalizePetSpecies(safeText(parsed.species))
      breed = safeText(parsed.breed).trim()
    } catch (error) {
      throw new Error('AI 返回格式异常，请换一张清晰照片后重试')
    }
  }

  if (!species) species = inferPetSpecies(rawText)
  if (!species) throw new Error('AI 未能识别出宠物类型，请换一张清晰正脸或全身照片重试')

  const cleanAnalysisText = rawText.replace(/\{[\s\S]*?\}/g, '').trim() || rawText
  return {
    species,
    speciesName: petSpeciesName(species),
    breed,
    confidence: breed ? 0.98 : 0.7,
    aiResultText: cleanAnalysisText,
    fullAnalysis: cleanAnalysisText
  }
}

function getCloudbaseAiClient() {
  if (typeof cloud.ai === 'function') return { client: cloud.ai(), wrapData: false }
  if (cloud.extend && cloud.extend.AI && typeof cloud.extend.AI.createModel === 'function') return { client: cloud.extend.AI, wrapData: true }
  throw new Error('当前云函数 SDK 不支持 cloud.ai，请确认 wx-server-sdk 版本并使用“上传并部署：云端安装依赖”重新部署 api 云函数')
}

async function callCloudbaseExtendAi(modelNames, imageUrl, promptText) {
  let lastError = null
  const aiClient = getCloudbaseAiClient()
  const aiModel = aiClient.client.createModel('cloudbase')
  for (const modelName of modelNames) {
    try {
      console.log(`[云函数AI识图] 正在调用微信云开发 AI 服务: ${modelName}, imageUrl: ${imageUrl.slice(0, 50)}...`)
      const payload = {
        model: modelName,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: promptText },
              { type: 'image_url', image_url: { url: imageUrl } }
            ]
          }
        ]
      }
      const res = await aiModel.generateText(aiClient.wrapData ? { data: payload } : payload)
      const rawAiContent = res.text || res.content || (res.data && (res.data.text || res.data.content)) || (typeof res === 'string' ? res : '')
      if (rawAiContent) return { rawAiContent, modelName, source: 'cloudbase_extend_ai' }
      lastError = new Error('AI 服务返回空内容')
    } catch (error) {
      lastError = error
      console.warn(`[云函数AI识图] cloud.extend.AI (${modelName}) 调用失败:`, error.message || error)
    }
  }
  throw lastError || new Error('微信云开发 AI 服务未响应')
}

async function getSystemSettings(options = {}) {
  const res = await db.collection('platform_configs').where({ key: 'system_settings' }).limit(1).get()
  return normalizeSystemSettings(res.data[0] ? res.data[0].value : {}, options)
}

async function recordAiLog(openid, logData = {}) {
  try {
    await db.collection('ai_logs').add({
      data: {
        openid: openid || '',
        type: 'pet_breed_recognition',
        avatarFileId: logData.avatarFileId || '',
        modelName: logData.modelName || 'qwen3.5-flash',
        source: logData.source || 'cloudbase_ai',
        rawResponse: logData.rawResponse || '',
        species: logData.species || '',
        breed: logData.breed || '',
        aiMessage: logData.aiMessage || '',
        createdAt: now()
      }
    })
  } catch (err) {
    console.error('Failed to write ai_logs document:', err)
  }
}

async function saveSystemSettings(settings) {
  if (settings.staffDeposit) {
    const amount = Number(settings.staffDeposit.amount ?? 0)
    // 先验证基本条件，避免 amountYuanToFen 抛出通用错误
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error('【保证金设置】保证金金额必须是有效的非负数')
    }
    if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
      throw new Error('【保证金设置】保证金金额最多两位小数')
    }
    if (settings.staffDeposit.enabled === true && amount <= 0) {
      throw new Error('【保证金设置】启用保证金时金额必须大于0')
    }
    // 验证金额转换为分是否安全
    const amountFen = Math.round(amount * 100)
    if (!Number.isSafeInteger(amountFen)) {
      throw new Error('【保证金设置】金额过大，请输入合理的金额')
    }
  }
  const time = now()
  const existing = await db.collection('platform_configs').where({ key: 'system_settings' }).limit(1).get()
  const previousValue = existing.data[0] ? existing.data[0].value : {}
  const value = normalizeSystemSettings(settings, { includeSecrets: true, existingSettings: previousValue, existingPayment: previousValue.payment || {} })
  const payload = { key: 'system_settings', value, updatedAt: time }
  if (existing.data[0]) {
    await db.collection('platform_configs').doc(existing.data[0]._id).update({ data: payload })
    return { _id: existing.data[0]._id, ...payload }
  }
  const created = await db.collection('platform_configs').add({ data: { ...payload, createdAt: time } })
  return { _id: created._id, ...payload, createdAt: time }
}

function incUpdateValue(currentValue, delta) {
  if (db.command && typeof db.command.inc === 'function') return db.command.inc(delta)
  return Number(currentValue || 0) + Number(delta || 0)
}

async function getUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  const user = res.data[0]
  if (!user || user.status !== 'active') throw new Error('请先登录')
  return user
}

async function getOptionalUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  return res.data[0]
}

async function requireAdmin(openid) {
  const user = await getUser(openid)
  if (!Array.isArray(user.roles) || !user.roles.includes('admin')) throw new Error('仅管理员可操作')
  return user
}

function getKey() {
  const secret = process.env.HOME_SECURITY_KEY
  if (!secret) throw new Error('家庭安防加密密钥未配置')
  return crypto.createHash('sha256').update(secret).digest()
}

function encryptText(value) {
  if (!value) return { cipher: '', iv: '', tag: '' }
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
  return { cipher: encrypted.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') }
}

function decryptText(cipher, iv, tag) {
  if (!cipher || !iv || !tag) return ''
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(cipher, 'base64')), decipher.final()]).toString('utf8')
}

function mask(value) {
  if (!value) return ''
  return value.length <= 2 ? '**' : `${value.slice(0, 1)}***${value.slice(-1)}`
}

function splitServiceAreas(value) {
  return String(value || '')
    .split(/[、,，\s\n]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function maskStaffName(value) {
  const name = String(value || '').trim()
  if (!name) return '认证宠托师'
  return name.length <= 1 ? `${name}宠托师` : `${name.slice(0, 1)}* 宠托师`
}

function sitterDisplayName(profile) {
  const nickname = String(profile.nickname || '').trim()
  return nickname || maskStaffName(profile.realName)
}

const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

function normalizeWeeklySchedule(raw) {
  if (!raw || typeof raw !== 'object') return null
  const result = {}
  let hasAnySlot = false
  for (let day = 1; day <= 7; day += 1) {
    const key = String(day)
    const list = Array.isArray(raw[key]) ? raw[key] : []
    const normalizedList = list
      .map((slot) => ({
        start: Math.max(0, Math.min(23, Math.floor(Number(slot.start || 0)))),
        end: Math.max(1, Math.min(24, Math.floor(Number(slot.end || 0))))
      }))
      .filter((slot) => slot.end > slot.start)
      .sort((a, b) => a.start - b.start)

    result[key] = normalizedList
    if (normalizedList.length > 0) hasAnySlot = true
  }
  return hasAnySlot ? result : null
}

function formatWeeklyScheduleText(weeklySchedule) {
  const normalized = normalizeWeeklySchedule(weeklySchedule)
  if (!normalized) return '全天可预约'
  const items = []
  for (let day = 1; day <= 7; day += 1) {
    const slots = normalized[String(day)] || []
    if (slots.length > 0) {
      const slotText = slots.map((s) => `${String(s.start).padStart(2, '0')}:00-${String(s.end).padStart(2, '0')}:00`).join('、')
      items.push(`${WEEKDAY_NAMES[day]} ${slotText}`)
    }
  }
  return items.length > 0 ? items.join('；') : '暂未设置接单时间段'
}

function parseDateTimeParts(dateStr) {
  if (!dateStr) return null
  const text = String(dateStr).trim()
  const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{1,2})/)
  if (match) {
    const year = Number(match[1])
    const month = Number(match[2]) - 1
    const day = Number(match[3])
    const hour = Number(match[4])
    const minute = Number(match[5])

    // 修复：使用 UTC 正午时间来计算星期几，避免时区问题
    // 正午12:00不会因为时区调整而跨天
    const dateForDayOfWeek = new Date(Date.UTC(year, month, day, 12, 0))
    const jsDay = dateForDayOfWeek.getUTCDay()
    const dayOfWeek = jsDay === 0 ? 7 : jsDay

    // 将北京时间转为UTC时间（减去8小时）用于存储
    const dateObj = new Date(Date.UTC(year, month, day, hour - 8, minute))

    // 返回北京时间的 dayOfWeek, hour, minute，用于时间段判断
    return { dayOfWeek, hour, minute, day, dateObj }
  }
  const d = new Date(text.replace(/-/g, '/'))
  if (Number.isNaN(d.getTime())) return null
  // 修复：从UTC时间转换为北京时间
  const beijingTime = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  const year = beijingTime.getUTCFullYear()
  const month = beijingTime.getUTCMonth()
  const day = beijingTime.getUTCDate()
  const hour = beijingTime.getUTCHours()
  const minute = beijingTime.getUTCMinutes()

  // 使用 UTC 正午时间计算星期几
  const dateForDayOfWeek = new Date(Date.UTC(year, month, day, 12, 0))
  const jsDay = dateForDayOfWeek.getUTCDay()
  const dayOfWeek = jsDay === 0 ? 7 : jsDay

  // 构造UTC时间用于存储
  const dateObj = new Date(Date.UTC(year, month, day, hour - 8, minute))
  return { dayOfWeek, hour, minute, day, dateObj }
}

function validateSitterScheduleTime(weeklySchedule, startTimeStr, endTimeStr) {
  const normalized = normalizeWeeklySchedule(weeklySchedule)
  if (!normalized) return // 未配置按周时间段则不做时间段硬限制

  if (!startTimeStr || !endTimeStr) throw new Error('请选择服务时间')
  const startParts = parseDateTimeParts(startTimeStr)
  const endParts = parseDateTimeParts(endTimeStr)
  if (!startParts || !endParts || endParts.dateObj <= startParts.dateObj) {
    throw new Error('服务时间格式无效')
  }

  const durationHours = (endParts.dateObj.getTime() - startParts.dateObj.getTime()) / (3600 * 1000)

  if (startParts.dayOfWeek === endParts.dayOfWeek && durationHours <= 24) {
    const dayOfWeek = startParts.dayOfWeek
    const dayName = WEEKDAY_NAMES[dayOfWeek] || `周${dayOfWeek}`
    const startVal = startParts.hour + startParts.minute / 60
    const endVal = endParts.hour + endParts.minute / 60
    const slots = normalized[String(dayOfWeek)] || []
    if (!slots.length) {
      throw new Error(`宠托师在${dayName}未设置可接单时间段`)
    }
    const fitsInSlot = slots.some((slot) => startVal >= slot.start && endVal <= slot.end)
    if (!fitsInSlot) {
      const allowedText = slots.map((s) => `${String(s.start).padStart(2, '0')}:00-${String(s.end).padStart(2, '0')}:00`).join('、')
      throw new Error(`预约时间不在宠托师${dayName}的可接单时间段（${allowedText}）内`)
    }
    return
  }

  const startBeijingStr = formatDateTimeParts(startParts.dateObj)
  const endBeijingStr = formatDateTimeParts(endParts.dateObj)
  let currTime = startParts.dateObj.getTime()
  const endTime = endParts.dateObj.getTime()

  while (currTime < endTime) {
    const currBeijingStr = formatDateTimeParts(new Date(currTime))
    const currParts = parseDateTimeParts(currBeijingStr)
    const dayOfWeek = currParts.dayOfWeek
    const dayName = WEEKDAY_NAMES[dayOfWeek] || `周${dayOfWeek}`
    const slots = normalized[String(dayOfWeek)] || []

    if (!slots.length) {
      throw new Error(`宠托师在${dayName}未设置可接单时间段`)
    }

    const currDateStr = currBeijingStr.slice(0, 10)
    const endDateStr = endBeijingStr.slice(0, 10)
    const isEndDay = currDateStr === endDateStr

    const segmentStart = currParts.hour + currParts.minute / 60
    const segmentEnd = isEndDay ? (endParts.hour + endParts.minute / 60) : 24

    const fits = slots.some((slot) => segmentStart >= slot.start && segmentEnd <= slot.end)
    if (!fits) {
      const allowedText = slots.map((s) => `${String(s.start).padStart(2, '0')}:00-${String(s.end).padStart(2, '0')}:00`).join('、')
      throw new Error(`预约时间不在宠托师${dayName}的可接单时间段（${allowedText}）内`)
    }

    if (isEndDay) break
    const [cYear, cMonth, cDay] = currDateStr.split('-').map(Number)
    currTime = Date.UTC(cYear, cMonth - 1, cDay + 1, -8, 0)
  }
}

function formatDateKey(dateObj) {
  return `${dateObj.getUTCFullYear()}-${String(dateObj.getUTCMonth() + 1).padStart(2, '0')}-${String(dateObj.getUTCDate()).padStart(2, '0')}`
}

function getDateKeyFromTime(value) {
  const parts = parseDateTimeParts(value)
  return parts ? formatDateKey(parts.dateObj) : ''
}

function normalizeScheduleSlots(raw) {
  const list = Array.isArray(raw) ? raw : []
  return list
    .map((slot) => ({
      start: Math.max(0, Math.min(23, Math.floor(Number(slot.start || 0)))),
      end: Math.max(1, Math.min(24, Math.floor(Number(slot.end || 0))))
    }))
    .filter((slot) => slot.end > slot.start)
    .sort((a, b) => a.start - b.start)
}

function normalizeScheduleException(data = {}, profile = {}) {
  const dateKey = safeText(data.dateKey).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw new Error('请选择日期')
  const status = data.status === 'available' ? 'available' : 'unavailable'
  const slots = status === 'available' ? normalizeScheduleSlots(data.slots) : []
  if (status === 'available' && !slots.length) throw new Error('请设置可接单时间段')
  return {
    staffProfileId: profile._id || data.staffProfileId || '',
    staffOpenid: profile.openid || data.staffOpenid || '',
    dateKey,
    status,
    slots,
    remark: safeText(data.remark).trim().slice(0, 80)
  }
}

function validateSlotsForDate(slots, startTimeStr, endTimeStr, dateKey, emptyMessage) {
  const startParts = parseDateTimeParts(startTimeStr)
  const endParts = parseDateTimeParts(endTimeStr)
  if (!startParts || !endParts || endParts.dateObj <= startParts.dateObj) throw new Error('服务时间格式无效')
  const startKey = formatDateKey(startParts.dateObj)
  const endKey = formatDateKey(endParts.dateObj)
  if (startKey !== dateKey || endKey !== dateKey) throw new Error('跨日期服务暂不支持日期例外排班')
  if (!slots.length) throw new Error(emptyMessage)
  const startVal = startParts.hour + startParts.minute / 60
  const endVal = endParts.hour + endParts.minute / 60
  const fits = slots.some((slot) => startVal >= slot.start && endVal <= slot.end)
  if (!fits) {
    const allowedText = slots.map((s) => `${String(s.start).padStart(2, '0')}:00-${String(s.end).padStart(2, '0')}:00`).join('、')
    throw new Error(`预约时间不在宠托师当天可接单时间段（${allowedText}）内`)
  }
}

function isAdminDeletedOrder(order = {}) {
  return Boolean(order.adminDeletedAt)
}

function isOrderConflictCandidate(order = {}) {
  return !isAdminDeletedOrder(order) && ['paid', 'assigned', 'in_service'].includes(order.status) && order.status !== 'cancelled'
}

function timeRangesOverlap(startA, endA, startB, endB) {
  const aStart = toTimeValue(startA)
  const aEnd = toTimeValue(endA)
  const bStart = toTimeValue(startB)
  const bEnd = toTimeValue(endB)
  return aStart > 0 && aEnd > aStart && bStart > 0 && bEnd > bStart && aStart < bEnd && bStart < aEnd
}

function getOrderTimeRanges(order = {}) {
  const sessions = Array.isArray(order.serviceSessions) ? order.serviceSessions : []
  const ranges = sessions
    .map((session) => ({ startTime: session.startTime, endTime: session.endTime }))
    .filter((session) => session.startTime && session.endTime)
  if (ranges.length) return ranges
  return order.startTime && order.endTime ? [{ startTime: order.startTime, endTime: order.endTime }] : []
}

function orderTimeRangesOverlap(orderA = {}, orderB = {}) {
  return getOrderTimeRanges(orderA).some((rangeA) => getOrderTimeRanges(orderB).some((rangeB) => timeRangesOverlap(rangeA.startTime, rangeA.endTime, rangeB.startTime, rangeB.endTime)))
}

async function validateStaffScheduleOnly(profile, startTimeStr, endTimeStr) {
  if (!profile || !profile.openid) throw new Error('宠托师不可用')
  const dateKey = getDateKeyFromTime(startTimeStr)
  if (!dateKey) throw new Error('请选择服务时间')
  const exceptionRes = await db.collection('staff_schedule_exceptions').where({ staffOpenid: profile.openid, dateKey }).limit(1).get()
  const exception = exceptionRes.data[0]
  if (exception) {
    if (exception.status === 'unavailable') throw new Error('宠托师当天设置为休息，无法预约')
    validateSlotsForDate(normalizeScheduleSlots(exception.slots), startTimeStr, endTimeStr, dateKey, '宠托师当天未设置可接单时间段')
  } else {
    validateSitterScheduleTime(profile.weeklySchedule, startTimeStr, endTimeStr)
  }
}

async function validateStaffAvailability(profile, startTimeStr, endTimeStr, options = {}) {
  return validateStaffAvailabilityForSessions(profile, [{ startTime: startTimeStr, endTime: endTimeStr }], options)
}

async function validateStaffAvailabilityForSessions(profile, sessions = [], options = {}) {
  for (const session of sessions) {
    await validateStaffScheduleOnly(profile, session.startTime, session.endTime)
  }

  const orderRes = await db.collection('orders').where({ staffOpenid: profile.openid }).get()
  const candidate = { serviceSessions: sessions }
  const conflict = (orderRes.data || []).find((order) => {
    if (options.excludeOrderId && order._id === options.excludeOrderId) return false
    return isOrderConflictCandidate(order) && orderTimeRangesOverlap(candidate, order)
  })
  if (conflict) throw new Error('宠托师该时间段已有订单，无法重复预约')
}

function buildAcceptRiskNotice(warnings = []) {
  return {
    requiresConfirmation: warnings.length > 0,
    warnings,
    noticeTitle: '超出接单设置确认',
    noticeItems: [
      '接单后必须按订单约定时间准时出发并完成服务，不得因距离较远或非本人常规接单时间擅自迟到、爽约或降低服务质量。',
      '未按规定时间服务、未及时出发、无法按时到达或服务缺失，可能导致客户投诉、订单退款、差评、收益扣减或保证金/信用处罚。',
      '若服务过程中发生异常，应第一时间联系客户并在平台内留痕，必要时联系平台客服协助处理。',
      '继续接单即表示你已充分评估交通、时间、服务距离和自身安排，并承诺遵守平台履约规范。'
    ]
  }
}

async function checkAcceptOrderRisk(profile, order) {
  console.log('【调试】开始风险检测')
  console.log('【调试】宠托师信息:', {
    openid: profile.openid,
    serviceLatitude: profile.serviceLatitude,
    serviceLongitude: profile.serviceLongitude,
    serviceRadiusKm: profile.serviceRadiusKm,
    hasWeeklySchedule: !!profile.weeklySchedule,
    weeklySchedule: profile.weeklySchedule
  })
  console.log('【调试】订单信息:', {
    orderId: order._id,
    startTime: order.startTime,
    endTime: order.endTime,
    addressLatitude: order.addressLatitude,
    addressLongitude: order.addressLongitude
  })

  const warnings = []

  // 【修改】检查距离风险 - 这里是基于固定服务地址的距离，仅作为参考提示
  // 实际的强制限制已在acceptOrder中使用实时位置验证
  const radiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)
  const distanceKm = calcDistanceKm(profile.serviceLatitude, profile.serviceLongitude, order.addressLatitude, order.addressLongitude)
  console.log('【调试】距离检测:', { distanceKm, radiusKm, 超出: distanceKm !== null && distanceKm > radiusKm })
  if (distanceKm !== null && distanceKm > radiusKm) {
    warnings.push({
      type: 'range',
      title: '订单地址距离你的固定服务地址较远',
      detail: `订单距离你设置的固定服务地址约 ${formatDistance(distanceKm)}，已超出 ${radiusKm}km 接单范围。接单以当前位置为准，请确认能按时到达。`,
      distanceKm,
      radiusKm
    })
  }

  // 【修改】检查时间风险 - 改为仅警告，不阻止接单
  const sessions = getOrderTimeRanges(order)
  console.log('【调试】订单时间段:', sessions)
  const failedSessions = []
  const hasWeeklySchedule = normalizeWeeklySchedule(profile.weeklySchedule) !== null
  console.log('【调试】是否配置接单时间:', hasWeeklySchedule)

  for (const session of sessions) {
    try {
      await validateStaffScheduleOnly(profile, session.startTime, session.endTime)
      console.log('【调试】时间段验证通过:', session.startTime)
    } catch (error) {
      console.log('【调试】时间段验证失败:', session.startTime, error.message)
      failedSessions.push(`${session.startTime}：${error.message || '不在你设置的可接单时间段内'}`)
    }
  }

  if (failedSessions.length) {
    console.log('【调试】时间不匹配，添加风险警告，失败数量:', failedSessions.length)
    warnings.push({
      type: 'time',
      title: '订单时间不在你的接单时间内',
      detail: failedSessions.slice(0, 3).join('；') + (failedSessions.length > 3 ? `；另有 ${failedSessions.length - 3} 次` : '') + '。接单后请务必按时服务。'
    })
  }

  console.log('【调试】最终warnings数量:', warnings.length)
  console.log('【调试】warnings内容:', JSON.stringify(warnings, null, 2))

  const result = buildAcceptRiskNotice(warnings)
  console.log('【调试】风险通知结果:', JSON.stringify(result, null, 2))
  return result
}

async function buildStaffAvailability(profile, startDateKey = '', days = 14) {
  const baseParts = parseDateTimeParts(`${startDateKey || formatDateKey(now())} 00:00`)
  const base = baseParts ? baseParts.dateObj : now()
  const normalizedWeekly = normalizeWeeklySchedule(profile.weeklySchedule)
  const maxDays = Math.min(Math.max(Number(days || 14), 1), 31)
  const exceptions = (await db.collection('staff_schedule_exceptions').where({ staffOpenid: profile.openid }).get()).data || []
  const orders = (await db.collection('orders').where({ staffOpenid: profile.openid }).get()).data || []
  const availableOrders = orders.filter(isOrderConflictCandidate)
  const list = []
  for (let i = 0; i < maxDays; i += 1) {
    const date = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i, 0, 0))
    const dateKey = formatDateKey(date)
    const dayOfWeek = date.getUTCDay() === 0 ? 7 : date.getUTCDay()
    const exception = exceptions.find((item) => item.dateKey === dateKey)
    let source = 'weekly'
    let slots = normalizedWeekly ? (normalizedWeekly[String(dayOfWeek)] || []) : [{ start: 0, end: 24 }]
    let status = slots.length ? 'available' : 'unavailable'
    let remark = ''
    if (exception) {
      source = 'exception'
      status = exception.status === 'available' ? 'available' : 'unavailable'
      slots = status === 'available' ? normalizeScheduleSlots(exception.slots) : []
      remark = exception.remark || ''
    }
    const busyOrders = availableOrders
      .filter((order) => getDateKeyFromTime(order.startTime) === dateKey)
      .map((order) => ({ orderId: order._id, startTime: order.startTime, endTime: order.endTime, serviceSummary: order.serviceSummary || '' }))
    list.push({ dateKey, dayOfWeek, dayName: WEEKDAY_NAMES[dayOfWeek], source, status, slots, busyOrders, remark })
  }
  return list
}

function toTimeValue(value) {
  if (!value) return 0
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  const text = String(value).trim()
  if (/^\d{10,13}$/.test(text)) {
    const num = Number(text)
    return Number.isFinite(num) ? (text.length === 10 ? num * 1000 : num) : 0
  }
  const localMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/)
  if (localMatch) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = localMatch
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), Number(second))
  }
  let parsed = new Date(text).getTime()
  if (Number.isNaN(parsed)) {
    parsed = new Date(text.replace(/-/g, '/').replace('T', ' ')).getTime()
  }
  return Number.isNaN(parsed) ? 0 : parsed
}

function normalizeLockMethod(value) {
  const method = safeText(value).trim()
  const map = { handover: 'someone_home', password: 'one_time_code', other: 'someone_home' }
  const normalized = map[method] || method
  return ['someone_home', 'remote_unlock', 'one_time_code', 'key'].includes(normalized) ? normalized : 'someone_home'
}

function lockMethodText(method) {
  const textMap = { someone_home: '有人在家，敲门即可', remote_unlock: '上门后远程开门', one_time_code: '一次性密码', key: '钥匙/门禁卡', handover: '有人在家，敲门即可', password: '一次性密码' }
  return textMap[method] || textMap.someone_home
}

function isTimeRangeCovered(start, end, coverStart, coverEnd) {
  return toTimeValue(coverStart) <= toTimeValue(start) && toTimeValue(coverEnd) >= toTimeValue(end)
}

function normalizeHomeSecurityInput(data = {}) {
  const source = data.orderHomeSecurity || data.homeSecuritySnapshot || data.homeSecurity || {}
  const type = normalizeLockMethod(source.type || source.lockMethod || data.lockMethod)
  const entryNotes = safeText(source.entryNotes || data.entryNotes).trim()
  const base = { type, lockMethod: type, lockMethodText: lockMethodText(type), entryNotes, createdAt: now(), updatedAt: now() }

  if (type === 'someone_home') return base
  if (type === 'remote_unlock') {
    return { ...base, remoteUnlock: { lastRequestedAt: '', requestCount: 0, notifyChannels: ['wechat', 'admin_phone'], lastNotifyStatus: { wechat: '', admin_phone: '' } } }
  }
  if (type === 'one_time_code') {
    const doorLockCode = safeText(source.code || source.doorLockCode || data.doorLockCode).trim()
    const effectiveStart = source.effectiveStart || data.doorLockCodeStartTime
    const effectiveEnd = source.effectiveEnd || data.doorLockCodeEndTime
    if (!doorLockCode) throw new Error('请填写一次性开门密码')
    if (!effectiveStart || !effectiveEnd) throw new Error('请选择一次性密码有效时间')
    if (toTimeValue(effectiveEnd) <= toTimeValue(effectiveStart)) throw new Error('一次性密码结束时间必须晚于开始时间')
    const coversServiceTime = isTimeRangeCovered(data.startTime, data.endTime, effectiveStart, effectiveEnd)
    if (!coversServiceTime) throw new Error('一次性密码有效期需要覆盖完整服务时间')
    const encrypted = encryptText(doorLockCode)
    return { ...base, hasDoorLockCode: true, oneTimeCode: { cipher: encrypted.cipher, iv: encrypted.iv, tag: encrypted.tag, masked: mask(doorLockCode), effectiveStart, effectiveEnd, coversServiceTime }, doorLockCode }
  }
  if (type === 'key') {
    const location = safeText(source.location || data.keyLocation).trim()
    const imageFileIds = Array.isArray(source.imageFileIds) ? source.imageFileIds : (Array.isArray(data.keyImageFileIds) ? data.keyImageFileIds : [])
    if (!location) throw new Error('请填写钥匙放置位置')
    if (!imageFileIds.length) throw new Error('请上传钥匙放置位置图片')
    return { ...base, keyLocation: location, key: { location, imageFileIds, returnRequired: true, returnedAt: '', returnImageFileIds: [], returnNote: '' } }
  }
  throw new Error('请选择有效的入户方式')
}

async function getApprovedEarlyStart(orderId) {
  const res = await db.collection('order_early_start_requests').where({ orderId, status: 'approved' }).orderBy('approvedAt', 'desc').limit(1).get()
  return res.data[0] || null
}

async function getPendingEarlyStart(orderId) {
  const res = await db.collection('order_early_start_requests').where({ orderId, status: 'pending' }).orderBy('createdAt', 'desc').limit(1).get()
  return res.data[0] || null
}

async function getLatestEarlyStart(orderId) {
  const res = await db.collection('order_early_start_requests').where({ orderId }).orderBy('createdAt', 'desc').limit(1).get()
  return res.data[0] || null
}

function isBeforeServiceStart(order, current = now()) {
  const nextSession = getNextPendingServiceSession(order) || getActiveServiceSession(order)
  const start = toTimeValue((nextSession && nextSession.startTime) || order.startTime)
  return start > 0 && current.getTime() < start
}

async function canStartOrderService(order, current = now()) {
  if (!isBeforeServiceStart(order, current)) return true
  return Boolean(await getApprovedEarlyStart(order._id))
}

async function canStartOrderSession(order, session, current = now()) {
  const sessionStart = session && session.startTime ? session.startTime : order.startTime
  const start = toTimeValue(sessionStart)
  if (!start || current.getTime() >= start) return true
  return Boolean(await getApprovedEarlyStart(order._id))
}

function toEarlyStartView(request) {
  if (!request) return null
  return {
    _id: request._id,
    orderId: request.orderId,
    status: request.status,
    reason: request.reason || '',
    requestedAt: request.createdAt || '',
    approvedAt: request.approvedAt || '',
    rejectedAt: request.rejectedAt || '',
    clientRemark: request.clientRemark || ''
  }
}

function toPublicHomeSecuritySnapshot(security) {
  if (!security) return null
  const safe = { ...security, doorLockCode: undefined }
  if (safe.oneTimeCode) {
    safe.oneTimeCode = {
      masked: safe.oneTimeCode.masked || '',
      effectiveStart: safe.oneTimeCode.effectiveStart || '',
      effectiveEnd: safe.oneTimeCode.effectiveEnd || '',
      coversServiceTime: safe.oneTimeCode.coversServiceTime === true
    }
    safe.hasDoorLockCode = true
  }
  return safe
}

function toPublicOrderHomeSecurity(security) {
  if (!security) return null
  const type = security.type || security.lockMethod || 'someone_home'
  return toPublicHomeSecuritySnapshot({ ...security, type, lockMethod: type, lockMethodText: security.lockMethodText || lockMethodText(type) })
}

/**
 * 微信官方 UGC 内容安全检测：文本审核
 * @param {string} openid 用户 openid
 * @param {string} content 待检测文本内容
 * @param {object} options scene: 场景值 (1: 资料, 2: 评论, 3: 论坛, 4: 社交日志), label: 业务提示前缀
 */
async function checkTextSecurity(openid, content, options = {}) {
  const text = safeText(content).trim()
  if (!text) return { pass: true }

  if (!cloud.openapi || !cloud.openapi.security) {
    return { pass: true }
  }

  const scene = Number(options.scene) || 2
  const label = options.label || '提交内容'

  try {
    if (typeof cloud.openapi.security.msgSecCheck === 'function') {
      const res = await cloud.openapi.security.msgSecCheck({
        openid,
        scene,
        version: 2,
        content: text
      })
      if (res && res.result && (res.result.suggest === 'risky' || (res.result.suggest === 'review' && options.strict === true))) {
        throw new Error(`${label}包含敏感或不合规信息，请修改后重试`)
      }
      if (res && res.errCode === 87014) {
        throw new Error(`${label}包含敏感或不合规信息，请修改后重试`)
      }
      return { pass: true, result: res && res.result }
    }
  } catch (err) {
    const errMsg = (err && (err.message || err.errMsg)) || String(err)
    const isRisky = (err && err.errCode === 87014) || errMsg.includes('87014') || errMsg.includes('risky') || errMsg.includes('敏感') || errMsg.includes('不合规') || errMsg.includes('违规')
    if (isRisky) {
      throw new Error(`${label}包含敏感或不合规信息，请修改后重试`)
    }
    console.warn('[security.msgSecCheck] warning:', errMsg)
  }
  return { pass: true }
}

/**
 * 微信官方 UGC 内容安全检测：图片审核
 * @param {string} openid 用户 openid
 * @param {string} fileIdOrUrl 图片 fileID 或 HTTP URL
 * @param {object} options scene: 场景值, label: 业务提示前缀
 */
async function checkImageSecurity(openid, fileIdOrUrl, options = {}) {
  const media = safeText(fileIdOrUrl).trim()
  if (!media) return { pass: true }

  if (!cloud.openapi || !cloud.openapi.security) {
    return { pass: true }
  }

  const scene = Number(options.scene) || 1
  const label = options.label || '上传图片'

  try {
    // 1. 同步校验 imgSecCheck（优先检测 cloud:// 存储文件）
    if (typeof cloud.openapi.security.imgSecCheck === 'function' && typeof cloud.downloadFile === 'function') {
      if (media.startsWith('cloud://')) {
        const fileRes = await cloud.downloadFile({ fileID: media }).catch(() => null)
        if (fileRes && fileRes.fileContent) {
          const res = await cloud.openapi.security.imgSecCheck({
            media: {
              contentType: 'image/jpeg',
              value: fileRes.fileContent
            }
          })
          if (res && (res.errCode === 87014 || (res.result && res.result.suggest === 'risky'))) {
            throw new Error(`${label}包含违规敏感内容，请重新上传`)
          }
          return { pass: true }
        }
      }
    }

    // 2. 异步校验 mediaCheckAsync
    if (typeof cloud.openapi.security.mediaCheckAsync === 'function') {
      let mediaUrl = media
      if (media.startsWith('cloud://') && typeof cloud.getTempFileURL === 'function') {
        const tempRes = await cloud.getTempFileURL({ fileList: [media] }).catch(() => null)
        const item = tempRes && tempRes.fileList && tempRes.fileList[0]
        if (item && item.tempFileURL) mediaUrl = item.tempFileURL
      }

      if (mediaUrl.startsWith('http')) {
        const res = await cloud.openapi.security.mediaCheckAsync({
          mediaUrl,
          mediaType: 2,
          version: 2,
          scene,
          openid
        })
        if (res && res.errCode === 87014) {
          throw new Error(`${label}包含违规敏感内容，请重新上传`)
        }
        return { pass: true, traceId: res && res.traceId }
      }
    }
  } catch (err) {
    const errMsg = (err && (err.message || err.errMsg)) || String(err)
    const isRisky = (err && err.errCode === 87014) || errMsg.includes('87014') || errMsg.includes('risky') || errMsg.includes('敏感') || errMsg.includes('违规')
    if (isRisky) {
      throw new Error(`${label}包含违规敏感内容，请重新上传`)
    }
    console.warn('[security.mediaCheck] warning:', errMsg)
  }
  return { pass: true }
}

function maskOrderClientContact(order) {
  if (!order) return order
  const maskedPhone = mask(order.contactPhone || (order.clientSnapshot && (order.clientSnapshot.contactPhone || order.clientSnapshot.phone))) || '受隐私保护'
  const maskedSnapshot = order.clientSnapshot ? {
    ...order.clientSnapshot,
    phone: maskedPhone,
    phoneMasked: maskedPhone,
    contactPhone: maskedPhone
  } : null
  return {
    ...order,
    phone: maskedPhone,
    clientPhone: maskedPhone,
    contactPhone: maskedPhone,
    contactPhoneMasked: maskedPhone,
    clientSnapshot: maskedSnapshot
  }
}

function maskOrderForStaffPreview(order) {
  if (!order) return order
  const withMaskedContact = maskOrderClientContact(order)
  return {
    ...withMaskedContact,
    addressDetail: '接单后可见',
    doorplate: '接单后可见',
    orderHomeSecurity: null,
    homeSecuritySnapshot: null,
    hasDoorLockCode: false,
    lockMethod: 'hidden',
    lockMethodText: '接单后可见'
  }
}

function toPublicSitter(profile) {
  const normalized = normalizeStaffWorkflow(profile)
  const isIntern = normalized && normalized.staffLevel === 'intern'
  const staffLevel = (normalized && normalized.staffLevel) || 'certified'
  const staffLevelText = isIntern ? '实习宠托师' : '认证宠托师'
  const areaTags = splitServiceAreas(profile.serviceAreas)
  const radius = Math.max(Number(profile.serviceRadiusKm || 5), 1)
  const hasLoc = hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) && Boolean(profile.serviceAddress)
  const defaultTags = isIntern ? ['实习特惠', '平台审核', '可上门'] : ['已实名', '平台审核', '可上门']
  return {
    _id: profile._id,
    displayName: sitterDisplayName(profile),
    avatarUrl: safeFileId(profile.avatarUrl) || safeText(profile.avatarUrl),
    serviceCity: profile.serviceCity || '服务城市待完善',
    serviceAreas: profile.serviceAreas || '',
    serviceAddress: profile.serviceAddress || '',
    serviceLatitude: Number(profile.serviceLatitude || 0),
    serviceLongitude: Number(profile.serviceLongitude || 0),
    serviceRadiusKm: radius,
    hasServiceAddress: hasLoc,
    weeklySchedule: normalizeWeeklySchedule(profile.weeklySchedule),
    weeklyScheduleText: formatWeeklyScheduleText(profile.weeklySchedule),
    areaTags,
    publicTags: defaultTags,
    staffLevel,
    staffLevelText,
    isIntern,
    serviceSummary: areaTags.length ? `可服务：${areaTags.slice(0, 4).join('、')}` : '服务区域待完善',
    ratingAverage: Number(profile.ratingAverage || 0),
    reviewCount: Number(profile.reviewCount || 0),
    ratingUpdatedAt: profile.ratingUpdatedAt || '',
    isFeatured: profile.isFeatured === true,
    featuredAt: profile.featuredAt || '',
    createdAt: profile.createdAt || '',
    updatedAt: profile.updatedAt || profile.createdAt || ''
  }
}

async function withSitterUserProfile(profile) {
  const res = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
  const user = res.data[0] || {}
  return {
    ...profile,
    nickname: user.nickname || profile.nickname || '',
    avatarUrl: user.avatarUrl || profile.avatarUrl || ''
  }
}

function matchText(value, keyword) {
  return String(value || '').toLowerCase().includes(keyword)
}

function isPresetServiceKey(key) {
  return defaultServicePrices.some((item) => item.key === key)
}

function defaultExtraPetFeeForService(key) {
  if (key === 'walk') return 30
  if (key === 'play' || key === 'medicine') return 15
  return 0
}

function defaultExtraPetRuleForService(key) {
  if (key === 'walk') return 'dog'
  if (key === 'play' || key === 'medicine') return 'all'
  return 'none'
}

function normalizeExtraPetRule(value, key) {
  const rule = String(value || '').trim()
  if (EXTRA_PET_RULES.has(rule)) return rule
  return defaultExtraPetRuleForService(key)
}

function normalizeServiceCaseImageFileIds(value) {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value.map((item) => safeText(item).trim()).filter(Boolean))).slice(0, 9)
}

function normalizeServicePrice(item) {
  const key = String(item.key || '').trim()
  const preset = defaultServicePrices.find((presetItem) => presetItem.key === key)
  const extraPetRule = key === VISIT_FEE_SERVICE_KEY ? 'none' : normalizeExtraPetRule(item.extraPetRule, key)
  const enabled = item.enabled !== false
  const showOnHome = key !== VISIT_FEE_SERVICE_KEY && enabled && item.showOnHome === true
  const price = Math.max(Number(item.price || 0), 0)
  const extraPetFee = Math.max(Number(item.extraPetFee !== undefined ? item.extraPetFee : defaultExtraPetFeeForService(key)), 0)
  const extraHalfHourFeeValue = Number(item.extraHalfHourFee || 0)
  const extraHalfHourFee = Number.isFinite(extraHalfHourFeeValue) ? Math.max(extraHalfHourFeeValue, 0) : 0
  const internExtraHalfHourFeeValue = Number(item.internExtraHalfHourFee !== undefined ? item.internExtraHalfHourFee : extraHalfHourFee)
  const internExtraHalfHourFee = Number.isFinite(internExtraHalfHourFeeValue) ? Math.max(internExtraHalfHourFeeValue, 0) : extraHalfHourFee
  return {
    key,
    label: String(item.label || '').trim(),
    price,
    internPrice: Math.max(Number(item.internPrice !== undefined ? item.internPrice : price), 0),
    extraPetFee,
    internExtraPetFee: Math.max(Number(item.internExtraPetFee !== undefined ? item.internExtraPetFee : extraPetFee), 0),
    extraPetRule,
    extraHalfHourFee: ['walk', 'play'].includes(key) ? extraHalfHourFee : 0,
    internExtraHalfHourFee: ['walk', 'play'].includes(key) ? internExtraHalfHourFee : 0,
    showOnHome,
    enabled,
    sortOrder: Number(item.sortOrder || 0),
    description: safeText(item.description || '').trim(),
    detailDescription: safeText(item.detailDescription || '').trim(),
    caseImageFileIds: normalizeServiceCaseImageFileIds(item.caseImageFileIds),
    coverUrl: (typeof item.coverUrl === 'string' && !item.coverUrl.startsWith('/images/services/'))
      ? safeText(item.coverUrl).trim()
      : ((preset && typeof preset.coverUrl === 'string' && !preset.coverUrl.startsWith('/images/services/')) ? safeText(preset.coverUrl).trim() : ''),
    isPreset: Boolean(preset)
  }
}

async function listServicePrices(includeDisabled = false) {
  let configured = []
  try {
    const res = await db.collection('service_prices').orderBy('sortOrder', 'asc').get()
    configured = res.data || []
  } catch (error) {
    configured = []
  }
  const configuredMap = configured.reduce((map, item) => ({ ...map, [item.key]: item }), {})
  const merged = defaultServicePrices.map((item) => {
    const configuredItem = configuredMap[item.key] || {}
    const isLegacyCombinedService = ['walk', 'feed'].includes(item.key) && String(configuredItem.label || '').startsWith('上门')
    return normalizeServicePrice(isLegacyCombinedService ? { ...configuredItem, label: item.label, price: item.price, description: item.description } : { ...item, ...configuredItem })
  })
  configured.forEach((item) => {
    if (!defaultServicePrices.some((preset) => preset.key === item.key)) merged.push(normalizeServicePrice(item))
  })
  return merged
    .filter((item) => item.key && item.label && !RETIRED_SERVICE_KEYS.has(item.key) && (includeDisabled || item.enabled))
    .sort((a, b) => a.sortOrder - b.sortOrder)
}

const serviceIcons = { visit_fee: '🏠', walk: '🐶', feed: '🐱', litter: '🚽', play: '🧶', medicine: '💊', clean: '🧹' }

async function safeCollectionData(name, builder) {
  try {
    const query = builder ? builder(db.collection(name)) : db.collection(name)
    const res = await query.get()
    return res.data || []
  } catch (error) {
    return []
  }
}

async function safeCollectionCount(name, where = {}) {
  try {
    const res = await db.collection(name).where(where).count()
    return Number(res.total || 0)
  } catch (error) {
    return 0
  }
}

function formatHomeCount(count) {
  const value = Number(count || 0)
  if (value >= 10000) return `${(value / 10000).toFixed(1).replace(/\.0$/, '')}万`
  return String(value)
}

const ORDER_STATUS = {
  PENDING_PAY: 'pending_pay',
  PAID: 'paid',
  ASSIGNED: 'assigned',
  IN_SERVICE: 'in_service',
  DAY_COMPLETED: 'day_completed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
}

const ORDER_TRANSITIONS = {
  [ORDER_STATUS.PENDING_PAY]: [ORDER_STATUS.PAID, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.PAID]: [ORDER_STATUS.ASSIGNED, ORDER_STATUS.CANCELLED, ORDER_STATUS.EXPIRED],
  [ORDER_STATUS.ASSIGNED]: [ORDER_STATUS.IN_SERVICE, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.IN_SERVICE]: [ORDER_STATUS.DAY_COMPLETED, ORDER_STATUS.COMPLETED],
  [ORDER_STATUS.DAY_COMPLETED]: [ORDER_STATUS.IN_SERVICE, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.COMPLETED]: [],
  [ORDER_STATUS.CANCELLED]: [],
  [ORDER_STATUS.EXPIRED]: [ORDER_STATUS.CANCELLED]
}

function canTransitionOrder(fromStatus, toStatus) {
  return (ORDER_TRANSITIONS[fromStatus] || []).includes(toStatus)
}

function assertOrderTransition(fromStatus, toStatus, message) {
  if (!canTransitionOrder(fromStatus, toStatus)) throw new Error(message || '订单状态不可流转')
}

function orderStatusText(status) {
  const normalized = String(status || '').toLowerCase().trim()
  const map = {
    pending_pay: '待支付',
    unpaid: '待支付',
    paying: '支付中',
    paid: '待接单',
    assigned: '已接单',
    in_service: '服务中',
    day_completed: '当天已完成',
    completed: '已完成',
    cancelled: '已取消',
    expired: '已过期',
    refunding: '退款中',
    refunded: '已退款',
    refund_applied: '退款申请中',
    refund_pending: '待退款',
    partial_refunded: '部分退款',
    pending_ship: '待发货',
    shipped: '已发货',
    auto_completed: '已完成',
    closed: '已关闭',
    timeout_closed: '超时关闭'
  }
  return map[normalized] || '处理中'
}

function shouldExpireUnacceptedOrder(order = {}, time = now()) {
  const start = toTimeValue(order.startTime)
  return order.status === ORDER_STATUS.PAID && !safeText(order.staffOpenid).trim() && start > 0 && start <= time.getTime()
}

async function expireUnacceptedOrder(orderId, order, time = now()) {
  if (!shouldExpireUnacceptedOrder(order, time)) return order
  const isPaid = order.paymentStatus === 'paid' && Number(order.payAmount || 0) > 0
  const update = {
    status: ORDER_STATUS.EXPIRED,
    expiredAt: time,
    expireReason: '服务开始时间前无人接单',
    updatedAt: time
  }

  let refund = null
  if (isPaid) {
    refund = await createRefundForOrder(order, order.payAmount, '服务开始时间前无人接单，系统自动全额退款', 'system_expire', order.clientOpenid, makeIdempotencyKey('expire_refund', orderId, time.getTime()), { unreadForClient: false })
    update.paymentStatus = 'refunding'
    update.refundStatus = 'processing'
    update.refundNo = refund.refundNo
    update.refundAmount = Number(order.payAmount)
  }

  await db.collection('orders').doc(orderId).update({ data: update })
  const updatedOrder = { ...order, _id: orderId, ...update }
  await appendOrderTimeline(orderId, 'expired', '订单已过期', isPaid ? `服务开始时间前无人接单，已发起全额退款 ¥${order.payAmount}` : '服务开始时间前无人接单', 'system')
  await appendOrderClientMessage(updatedOrder, { eventType: 'expired', title: '订单已过期', detail: isPaid ? `服务开始时间前无人接单，已自动发起全额退款 ¥${order.payAmount}` : '服务开始时间前无人接单', actorRole: 'system' })
  return updatedOrder
}

async function expireDueUnacceptedOrders() {
  const res = await db.collection('orders').where({ status: ORDER_STATUS.PAID }).get()
  const time = now()
  await Promise.all((res.data || []).map((order) => expireUnacceptedOrder(order._id, order, time)))
}

async function cancelUnpaidOrders() {
  const res = await db.collection('orders').where({ status: ORDER_STATUS.PENDING_PAY }).get()
  const time = now()
  const timeoutMinutes = 30
  const timeoutMs = timeoutMinutes * 60 * 1000
  const cancelledOrders = []

  for (const order of res.data || []) {
    const createdAt = toTimeValue(order.createdAt)
    if (createdAt > 0 && time.getTime() - createdAt > timeoutMs) {
      const update = {
        status: 'cancelled',
        cancelReason: `超过${timeoutMinutes}分钟未支付，系统自动取消`,
        cancelledAt: time,
        updatedAt: time
      }
      await db.collection('orders').doc(order._id).update({ data: update })

      if (order.couponId) {
        await db.collection('user_coupons').doc(order.couponId).update({
          data: {
            status: 'available',
            lockedOrderId: '',
            lockedAt: '',
            unlockedAt: time,
            updatedAt: time
          }
        })
      }

      await appendOrderTimeline(order._id, 'cancelled', '订单已取消', update.cancelReason, 'system')
      cancelledOrders.push(order._id)
    }
  }

  return cancelledOrders
}

function checkinEventText(eventType) {
  return ({
    sanitization: '隔离病菌/消毒打卡',
    enter_door: '到达入户',
    leash_on: '牵引准备',
    feed: '喂食',
    water: '换水',
    pet_status: '宠物状态',
    return_home: '返家确认',
    leave_door: '离户检查',
    clean: '清洁',
    medicine: '喂药',
    video_checkin: '视频打卡',
    pet_beauty_photo: '宠物美照'
  })[eventType] || '服务打卡'
}

function publicOrderNo(order = {}) {
  const value = safeText(order.orderNo || order._id).trim()
  if (!value) return '近期订单'
  return `订单 ${value.slice(-6)}`
}

function shouldHidePublicCheckinPhotos(user = {}) {
  return user.hidePublicCheckinPhotos === true || (user.privacySettings && user.privacySettings.hidePublicCheckinPhotos === true)
}

function toHomeOrderActivity(order = {}, context = {}) {
  const review = context.review || null
  const checkins = Array.isArray(context.checkins) ? context.checkins : []
  const hideCheckinPhotos = context.hideCheckinPhotos === true
  const staffProfile = context.staffProfile || {}
  const clientSnapshot = order.clientSnapshot || {}
  const checkinPhotos = hideCheckinPhotos ? [] : checkins
    .map((item) => ({
      _id: item._id || `${order._id}_${item.eventType || 'checkin'}`,
      eventType: item.eventType || '',
      eventText: checkinEventText(item.eventType),
      mediaFileId: safeFileId(item.watermarkedMediaFileId || item.mediaFileId) || safeText(item.watermarkedMediaFileId || item.mediaFileId),
      createdAt: item.createdAt || item.recordedAt || ''
    }))
    .filter((item) => item.mediaFileId)
    .slice(0, 3)

  return {
    _id: order._id || '',
    orderTitle: publicOrderNo(order),
    serviceSummary: order.serviceSummary || order.serviceType || '上门宠护',
    petName: order.petName || '宠物',
    clientName: clientSnapshot.displayName || maskClientName(order.clientName || ''),
    staffName: sitterDisplayName(staffProfile) || order.staffName || '平台宠托师',
    staffProfileId: order.staffProfileId || order.requestedStaffProfileId || '',
    status: order.status || '',
    statusText: orderStatusText(order.status),
    startTime: order.startTime || '',
    completedAt: order.completedAt || order.updatedAt || order.createdAt || '',
    review: review ? {
      rating: Number(review.rating || 0),
      ratingText: `${Number(review.rating || 0)}.0`,
      content: safeText(review.content).trim(),
      tags: Array.isArray(review.tags) ? review.tags.slice(0, 4) : [],
      createdAt: review.createdAt || ''
    } : null,
    checkinCount: checkins.length,
    checkinSummary: checkins.slice(0, 4).map((item) => checkinEventText(item.eventType)).join(' · '),
    checkinPhotos,
    checkinPhotosHidden: hideCheckinPhotos
  }
}

async function getHomePageData(openid, data = {}) {
  const settings = await getSystemSettings()
  const loc = {
    latitude: Number(data.latitude || 0),
    longitude: Number(data.longitude || 0)
  }
  const hasLoc = hasCoordinate(loc.latitude, loc.longitude)
  const [servicePrices, staffProfiles, couponTemplates, orders, optionalUser, userCoupons, users] = await Promise.all([
    listServicePrices(false),
    safeCollectionData('staff_profiles', (col) => col.where({ auditStatus: 'approved' }).orderBy('updatedAt', 'desc')),
    safeCollectionData('coupon_templates', (col) => col.where({ enabled: true }).orderBy('sortOrder', 'asc')),
    safeCollectionData('orders', (col) => col.orderBy('createdAt', 'desc')),
    getOptionalUser(openid).catch(() => null),
    openid ? safeCollectionData('user_coupons', (col) => col.where({ openid })) : Promise.resolve([]),
    safeCollectionData('users')
  ])

  const sittersWithUser = await Promise.all(staffProfiles.filter((item) => canTakeOrders(item, settings.staffDeposit)).slice(0, 30).map(withSitterUserProfile))
  let featuredSitters = sittersWithUser.map((profile) => {
    const item = toPublicSitter(profile)
    if (hasLoc && hasCoordinate(profile.serviceLatitude, profile.serviceLongitude)) {
      const distanceKm = calcDistanceKm(loc.latitude, loc.longitude, profile.serviceLatitude, profile.serviceLongitude)
      return { ...item, distanceKm, distanceText: formatDistance(distanceKm) }
    }
    return item
  })
  featuredSitters.sort((a, b) => {
    const featuredDiff = Number(b.isFeatured === true) - Number(a.isFeatured === true)
    if (featuredDiff) return featuredDiff
    if (hasLoc) return (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999) || Number(b.ratingAverage || 0) - Number(a.ratingAverage || 0)
    return Number(b.ratingAverage || 0) - Number(a.ratingAverage || 0) || Number(b.reviewCount || 0) - Number(a.reviewCount || 0)
  })
  featuredSitters = featuredSitters.slice(0, 6)

  const userOrders = optionalUser ? orders.filter((order) => order.clientOpenid === openid) : []
  const repeatOrder = userOrders.find((order) => ['paid', 'assigned', 'in_service', 'completed'].includes(order.status)) || null
  const completedOrders = orders
    .filter((order) => order.status === 'completed')
    .sort((a, b) => toTimeValue(b.completedAt || b.updatedAt || b.createdAt) - toTimeValue(a.completedAt || a.updatedAt || a.createdAt))
    .slice(0, 6)
  const recentOrderIds = completedOrders.map((order) => order._id).filter(Boolean)
  const [homeReviews, homeCheckins] = await Promise.all([
    recentOrderIds.length ? safeCollectionData('service_reviews', (col) => col.where({ status: 'visible' })) : Promise.resolve([]),
    recentOrderIds.length ? safeCollectionData('checkin_logs') : Promise.resolve([])
  ])
  const reviewMap = homeReviews
    .filter((review) => recentOrderIds.includes(review.orderId))
    .reduce((map, review) => ({ ...map, [review.orderId]: review }), {})
  const checkinMap = homeCheckins
    .filter((checkin) => recentOrderIds.includes(checkin.orderId))
    .reduce((map, checkin) => ({ ...map, [checkin.orderId]: [...(map[checkin.orderId] || []), checkin] }), {})
  const staffProfileMap = staffProfiles.reduce((map, profile) => ({ ...map, [profile._id]: profile }), {})
  const userMap = users.reduce((map, user) => ({ ...map, [user.openid]: user }), {})
  const recentOrders = (await Promise.all(completedOrders.map(attachClientSnapshot)))
    .map((order) => toHomeOrderActivity(order, {
      review: reviewMap[order._id],
      checkins: (checkinMap[order._id] || []).sort((a, b) => toTimeValue(a.createdAt || a.recordedAt) - toTimeValue(b.createdAt || b.recordedAt)),
      staffProfile: staffProfileMap[order.staffProfileId || order.requestedStaffProfileId] || {},
      hideCheckinPhotos: shouldHidePublicCheckinPhotos(userMap[order.clientOpenid])
    }))

  const completedCount = orders.filter((order) => order.status === 'completed').length
  const reviewCount = await safeCollectionCount('service_reviews', { status: 'visible' })
  const newbieTemplates = couponTemplates.filter((coupon) => coupon.newbieOnly !== false)
  const newbieTemplateIds = new Set(newbieTemplates.map((coupon) => coupon._id).filter(Boolean))
  const claimedNewbieTemplateIds = new Set((userCoupons || [])
    .filter((coupon) => coupon.status !== 'void')
    .map((coupon) => coupon.templateId || (coupon.templateSnapshot && coupon.templateSnapshot.templateId))
    .filter(Boolean))
  const hasClaimedNewbieCoupon = Array.from(claimedNewbieTemplateIds).some((templateId) => newbieTemplateIds.has(templateId))
  const isNewUser = Boolean(optionalUser) && userOrders.length === 0
  const newbieCoupons = isNewUser && !hasClaimedNewbieCoupon ? newbieTemplates : []

  return {
    settings: {
      homeHeroCarousel: settings.homeHeroCarousel,
      homePage: settings.homePage
    },
    servicePrices: servicePrices.filter((item) => item.key !== VISIT_FEE_SERVICE_KEY && item.enabled !== false && item.showOnHome === true).slice(0, 6).map((item) => ({
      ...item,
      icon: serviceIcons[item.key] || '🐾',
      priceText: `¥${item.price}起`
    })),
    featuredSitters,
    coupons: newbieCoupons.slice(0, 3).map(formatHomeCoupon),
    repeatOrder: repeatOrder ? {
      _id: repeatOrder._id,
      serviceSummary: repeatOrder.serviceSummary || '上门宠护',
      petName: repeatOrder.petName || '宠物',
      startTime: repeatOrder.startTime || '',
      staffProfileId: repeatOrder.staffProfileId || repeatOrder.requestedStaffProfileId || ''
    } : null,
    recentOrders,
    statsData: {
      completedCount: formatHomeCount(completedCount),
      sitterCount: formatHomeCount(staffProfiles.length),
      ratingCount: formatHomeCount(reviewCount)
    },
    assuranceItems: [
      { title: '实名认证', desc: '宠托师资料审核后上岗', icon: '✅' },
      { title: '轨迹打卡', desc: '服务过程位置和照片可追踪', icon: '📍' },
      { title: '售后保障', desc: '异常投诉有平台工单跟进', icon: '🛡️' }
    ]
  }
}

function normalizeServiceTypes(data) {
  const raw = Array.isArray(data.serviceTypes) ? data.serviceTypes : [data.serviceType || 'walk']
  const unique = Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)))
  return unique.includes(VISIT_FEE_SERVICE_KEY) ? [VISIT_FEE_SERVICE_KEY, ...unique.filter((key) => key !== VISIT_FEE_SERVICE_KEY)] : unique
}

function getBusinessServiceTypes(serviceTypes) {
  return (serviceTypes || []).filter((key) => key !== VISIT_FEE_SERVICE_KEY)
}

function validateVisitFeeServices(serviceTypes) {
  if (serviceTypes.some((key) => RETIRED_SERVICE_KEYS.has(key))) throw new Error('该服务项目已下线')
  if (!serviceTypes.includes(VISIT_FEE_SERVICE_KEY)) throw new Error('请选择上门费')
  if (!getBusinessServiceTypes(serviceTypes).length) throw new Error('请选择至少一项照护服务')
}

function normalizePetIds(data = {}) {
  const raw = Array.isArray(data.petIds) && data.petIds.length ? data.petIds : [data.petId]
  return Array.from(new Set(raw.map((item) => String(item || '').trim()).filter(Boolean)))
}

async function getClientPetsByIds(openid, petIds) {
  if (!petIds.length) throw new Error('请选择宠物')
  const pets = await Promise.all(petIds.map(async (petId) => {
    const res = await db.collection('pets').doc(petId).get()
    if (!res.data || res.data.openid !== openid) throw new Error('宠物不存在')
    return { ...res.data, _id: res.data._id || petId }
  }))
  return pets
}

function createPetSnapshot(pet = {}) {
  return {
    name: pet.name || '',
    avatarFileId: pet.avatarFileId || '',
    species: pet.species || '',
    breed: pet.breed || '',
    gender: pet.gender || '',
    birthday: pet.birthday || '',
    weight: Number(pet.weight || 0),
    personality: pet.personality || '',
    favoriteFood: pet.favoriteFood || '',
    dislikes: pet.dislikes || '',
    healthNotes: pet.healthNotes || '',
    specialNotes: pet.specialNotes || '',
    exclusiveId: pet.exclusiveId || '',
    beautyTitle: pet.beautyTitle || null
  }
}

function normalizeBeautyPhoto(item = {}, index = 0) {
  const fileId = safeFileId(item.fileId || item.mediaFileId) || safeText(item.fileId || item.mediaFileId)
  if (!fileId) return null
  const time = item.createdAt || nowText()
  return {
    id: safeText(item.id).trim() || `bp_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`,
    fileId,
    source: ['pet_profile', 'service_checkin'].includes(item.source) ? item.source : 'pet_profile',
    orderId: safeText(item.orderId).trim(),
    checkinId: safeText(item.checkinId || item._id).trim(),
    createdAt: time,
    updatedAt: item.updatedAt || time
  }
}

function normalizeBeautyPhotos(input = [], fallbackAvatarFileId = '') {
  const source = Array.isArray(input) ? input : []
  const photos = source.map(normalizeBeautyPhoto).filter(Boolean)
  const seen = new Set()
  const unique = photos.filter((photo) => {
    if (seen.has(photo.fileId)) return false
    seen.add(photo.fileId)
    return true
  }).slice(0, 9)
  const avatarFileId = safeFileId(fallbackAvatarFileId) || safeText(fallbackAvatarFileId)
  if (!unique.length && avatarFileId) unique.push(normalizeBeautyPhoto({ fileId: avatarFileId, source: 'pet_profile' }, 0))
  if (!unique.length) throw new Error('请上传至少一张宠物美照')
  if (unique.length > 9) throw new Error('宠物美照最多上传9张')
  return unique
}

async function generatePetExclusiveId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let code = 'P'
    for (let i = 0; i < 6; i += 1) code += chars[Math.floor(Math.random() * chars.length)]
    const existing = await db.collection('pets').where({ exclusiveId: code }).limit(1).get()
    if (!existing.data || !existing.data[0]) return code
  }
  return `P${Date.now().toString(36).slice(-6).toUpperCase()}`
}

async function ensurePetExclusiveId(pet = {}) {
  if (pet.exclusiveId) return pet.exclusiveId
  const exclusiveId = await generatePetExclusiveId()
  if (pet._id) await db.collection('pets').doc(pet._id).update({ data: { exclusiveId, updatedAt: nowText() } })
  pet.exclusiveId = exclusiveId
  return exclusiveId
}

function formatPetAgeText(birthday) {
  const birth = parseDateValue(birthday)
  if (!birth) return '年龄未知'
  const today = toCstParts()
  const nowDate = new Date(`${today.monthKey}-${today.day}T00:00:00+08:00`)
  let months = (nowDate.getFullYear() - birth.getFullYear()) * 12 + nowDate.getMonth() - birth.getMonth()
  if (nowDate.getDate() < birth.getDate()) months -= 1
  if (months < 1) return '未满1个月'
  if (months < 12) return `${months}个月`
  const years = Math.floor(months / 12)
  const rest = months % 12
  return rest ? `${years}岁${rest}个月` : `${years}岁`
}

function petSpeciesText(species) {
  return ({ dog: '狗狗', cat: '猫咪', other: '异宠' })[species] || '宠物'
}

function toPetPublicBeautyView(pet = {}, voteCount = 0) {
  const beautyPhotos = Array.isArray(pet.beautyPhotos) ? pet.beautyPhotos : []
  return {
    petId: pet._id || pet.id || '',
    name: pet.name || '毛孩子',
    ageText: formatPetAgeText(pet.birthday),
    species: pet.species || '',
    speciesText: petSpeciesText(pet.species),
    avatarFileId: pet.avatarFileId || (beautyPhotos[0] && beautyPhotos[0].fileId) || '',
    beautyPhotos,
    beautyTitle: pet.beautyTitle || null,
    exclusiveId: pet.exclusiveId || '',
    voteCount: Number(voteCount || 0)
  }
}

function formatPetBeautyTitle(monthKey, rank) {
  const month = Number(String(monthKey || '').slice(5, 7)) || toCstParts().month
  return Number(rank) === 1 ? `${Number(month)}月最美爱宠` : `${Number(month)}月第${rank}爱宠`
}

function currentMonthStart(monthKey) {
  return new Date(`${normalizeMonthKey(monthKey)}-01T00:00:00+08:00`)
}

function nextMonthStart(monthKey) {
  const [year, month] = normalizeMonthKey(monthKey).split('-').map(Number)
  return new Date(year, month, 1, -8, 0, 0, 0)
}

async function countPetBeautyVotes(monthKey) {
  const start = currentMonthStart(monthKey)
  const end = nextMonthStart(monthKey)
  const res = await db.collection('pet_beauty_votes').where({ monthKey }).get()
  return (res.data || []).filter((vote) => {
    const created = parseDateValue(vote.createdAt)
    return !created || (created >= start && created < end)
  }).reduce((map, vote) => {
    if (!vote.petId) return map
    map[vote.petId] = (map[vote.petId] || 0) + 1
    return map
  }, {})
}

async function isPetBeautyMonthLocked(monthKey) {
  const locked = await db.collection('pet_beauty_month_locks').where({ monthKey, status: 'locked' }).limit(1).get()
  return Boolean(locked.data && locked.data[0])
}

async function settlePetBeautyMonthlyRanking(monthKey = toCstParts().monthKey, options = {}) {
  monthKey = normalizeMonthKey(monthKey)
  if (!options.force && await isPetBeautyMonthLocked(monthKey)) return { monthKey, locked: true, skipped: true }
  const voteMap = await countPetBeautyVotes(monthKey)
  const allPets = await getAllDocuments('pets', 'createdAt', 'desc')
  const ranked = allPets
    .filter((pet) => Array.isArray(pet.beautyPhotos) && pet.beautyPhotos.length)
    .map((pet) => ({ pet, voteCount: Number(voteMap[pet._id] || 0) }))
    .filter((item) => item.voteCount > 0)
    .sort((a, b) => b.voteCount - a.voteCount || String(a.pet.createdAt || '').localeCompare(String(b.pet.createdAt || '')))
    .slice(0, 100)
  const lockedAt = now()
  await Promise.all(ranked.map(async ({ pet, voteCount }, index) => {
    const rank = index + 1
    const exclusiveId = await ensurePetExclusiveId(pet)
    const title = formatPetBeautyTitle(monthKey, rank)
    const beautyTitle = { monthKey, rank, title, awardedAt: lockedAt }
    await db.collection('pet_beauty_month_rankings').add({ data: { monthKey, petId: pet._id, petExclusiveId: exclusiveId, rank, voteCount, locked: true, title, petSnapshot: toPetPublicBeautyView({ ...pet, exclusiveId, beautyTitle }, voteCount), lockedAt, createdAt: lockedAt, updatedAt: lockedAt } })
    await db.collection('pets').doc(pet._id).update({ data: { beautyTitle, updatedAt: nowText() } })
  }))
  await db.collection('pet_beauty_month_locks').add({ data: { monthKey, status: 'locked', topCount: ranked.length, lockedAt, source: options.source || 'manual', createdAt: lockedAt, updatedAt: lockedAt } })
  return { monthKey, locked: true, topCount: ranked.length }
}

function formatPetSummary(pets = []) {
  const names = pets.map((pet) => pet.name).filter(Boolean)
  if (names.length <= 2) return names.join('、') || '宠物'
  return `${names.slice(0, 2).join('、')}等${names.length}只`
}

function getWalkPrice(basePrice, weight) {
  if (basePrice !== 69) return basePrice
  if (weight > 25) return 119
  if (weight >= 10) return 89
  return 69
}

function normalizeCouponUsageScope(value) {
  return ['service', 'mall', 'all'].includes(value) ? value : 'service'
}

function couponUsageScopeText(scope) {
  return ({ service: '服务券', mall: '零售券', all: '通用券' })[scope] || '服务券'
}

function normalizeCouponSnapshot(coupon) {
  const snapshot = coupon.templateSnapshot || coupon
  const usageScope = normalizeCouponUsageScope(snapshot.usageScope || snapshot.businessType)
  return {
    templateId: coupon.templateId || coupon._id || '',
    name: safeText(snapshot.name).trim() || '优惠券',
    description: safeText(snapshot.description).trim(),
    type: snapshot.type === 'fixed' ? 'fixed' : 'fixed',
    usageScope,
    usageScopeText: couponUsageScopeText(usageScope),
    discountAmount: Math.max(Number(snapshot.discountAmount || 0), 0),
    minOrderAmount: Math.max(Number(snapshot.minOrderAmount || 0), 0),
    applicableServiceTypes: Array.isArray(snapshot.applicableServiceTypes) ? snapshot.applicableServiceTypes.map((item) => String(item || '').trim()).filter(Boolean) : [],
    validType: snapshot.validType === 'fixed_range' ? 'fixed_range' : 'relative_days',
    validDays: Math.max(Math.round(Number(snapshot.validDays || 30)), 1),
    validFromFixed: snapshot.validFromFixed || '',
    validToFixed: snapshot.validToFixed || '',
    displayTag: safeText(snapshot.displayTag).trim(),
    claimNotice: safeText(snapshot.claimNotice).trim(),
    useNotice: safeText(snapshot.useNotice).trim()
  }
}

function couponRuleText(snapshot) {
  const normalized = normalizeCouponSnapshot(snapshot)
  const minText = normalized.minOrderAmount > 0 ? `满${normalized.minOrderAmount}减${normalized.discountAmount}` : `立减${normalized.discountAmount}`
  const scopeText = couponUsageScopeText(normalized.usageScope)
  if (normalized.usageScope === 'service' && normalized.applicableServiceTypes.length) return `${scopeText}，${minText}，限指定服务`
  return `${scopeText}，${minText}`
}

function couponBusinessMatches(snapshot, pricing = {}) {
  const businessType = pricing.businessType === 'mall' || (Array.isArray(pricing.serviceTypes) && pricing.serviceTypes.includes('mall')) ? 'mall' : 'service'
  return snapshot.usageScope === 'all' || snapshot.usageScope === businessType
}

function couponDisplayStatus(coupon, time = now()) {
  if (coupon.status === 'used' || coupon.status === 'locked' || coupon.status === 'void') return coupon.status
  const validTo = new Date(coupon.validTo || 0).getTime()
  if (validTo && validTo < time.getTime()) return 'expired'
  return coupon.status || 'available'
}

function couponStatusText(status) {
  return ({ available: '可使用', locked: '已锁定', used: '已使用', expired: '已过期', void: '已作废' })[status] || '未知状态'
}

function formatUserCoupon(coupon, options = {}) {
  const snapshot = normalizeCouponSnapshot(coupon)
  const status = options.status || couponDisplayStatus(coupon)
  return {
    _id: coupon._id,
    templateId: coupon.templateId || snapshot.templateId,
    name: snapshot.name,
    description: snapshot.description,
    usageScope: snapshot.usageScope,
    usageScopeText: snapshot.usageScopeText,
    discountAmount: snapshot.discountAmount,
    minOrderAmount: snapshot.minOrderAmount,
    applicableServiceTypes: snapshot.applicableServiceTypes,
    validFrom: coupon.validFrom || '',
    validTo: coupon.validTo || '',
    status,
    statusText: couponStatusText(status),
    ruleText: couponRuleText(snapshot),
    applicable: options.applicable,
    reason: options.reason || '',
    payAmountAfterDiscount: options.payAmountAfterDiscount
  }
}

async function getAvailableUserCoupons(openid) {
  const res = await db.collection('user_coupons').where({ openid }).get()
  const time = now()
  return (res.data || [])
    .filter((coupon) => couponDisplayStatus(coupon, time) === 'available')
    .sort((a, b) => String(a.validTo || '').localeCompare(String(b.validTo || '')) || String(b.issuedAt || b.createdAt || '').localeCompare(String(a.issuedAt || a.createdAt || '')))
}

function evaluateCoupon(coupon, pricing, openid) {
  if (!coupon || coupon.openid !== openid) return { applicable: false, reason: '优惠券不存在' }
  const status = couponDisplayStatus(coupon)
  if (status !== 'available') return { applicable: false, reason: couponStatusText(status) }
  const snapshot = normalizeCouponSnapshot(coupon)
  if (!couponBusinessMatches(snapshot, pricing)) return { applicable: false, reason: snapshot.usageScope === 'mall' ? '仅限商城用品订单使用' : '仅限上门服务订单使用' }
  if (pricing.amount < snapshot.minOrderAmount) return { applicable: false, reason: `订单满 ¥${snapshot.minOrderAmount} 可用` }
  if (snapshot.usageScope !== 'mall' && snapshot.applicableServiceTypes.length && !pricing.serviceTypes.some((key) => snapshot.applicableServiceTypes.includes(key))) return { applicable: false, reason: '当前服务不可用' }
  const discountAmount = Math.min(snapshot.discountAmount, pricing.amount)
  if (discountAmount <= 0) return { applicable: false, reason: '优惠金额无效' }
  return {
    applicable: true,
    couponId: coupon._id,
    templateId: coupon.templateId || snapshot.templateId,
    name: snapshot.name,
    discountAmount,
    ruleText: couponRuleText(snapshot),
    snapshot
  }
}

function applyCouponToPricing(pricing, couponResult) {
  if (!couponResult || !couponResult.applicable) {
    return { ...pricing, discountAmount: 0, coupon: null, payAmount: pricing.amount, priceSnapshot: { ...pricing.priceSnapshot, originalAmount: pricing.amount, discountAmount: 0, payAmount: pricing.amount } }
  }
  const discountAmount = couponResult.discountAmount
  const payAmount = Math.max(pricing.amount - discountAmount, 0)
  const coupon = {
    couponId: couponResult.couponId,
    templateId: couponResult.templateId,
    name: couponResult.name,
    discountAmount,
    ruleText: couponResult.ruleText,
    snapshot: couponResult.snapshot
  }
  return {
    ...pricing,
    discountAmount,
    coupon,
    payAmount,
    priceItems: [...pricing.priceItems, { key: 'coupon', label: `优惠券：${coupon.name}`, price: -discountAmount }],
    priceSnapshot: { ...pricing.priceSnapshot, coupon, originalAmount: pricing.amount, discountAmount, payAmount }
  }
}

async function resolveStaffPriceLevel(data = {}) {
  if (data.publishMode !== 'direct') return 'certified'
  const staffProfileId = safeText(data.staffProfileId || data.requestedStaffProfileId).trim()
  if (!staffProfileId) return 'certified'
  const staffProfile = normalizeStaffWorkflow((await db.collection('staff_profiles').doc(staffProfileId).get()).data)
  return staffProfile && staffProfile.staffLevel === 'intern' ? 'intern' : 'certified'
}

const PET_TIMED_SERVICE_KEYS = ['walk', 'play']

function petSpecies(pet = {}) {
  return safeText(pet.species || pet.type || pet.petType).trim().toLowerCase()
}

function isDogPet(pet = {}) {
  const species = petSpecies(pet)
  if (!species) return true
  return species === 'dog' || species === 'dogs' || species === '狗' || species === '狗狗'
}

function timedServiceTargets(serviceKey, pets = []) {
  if (serviceKey === 'walk') return pets.filter(isDogPet)
  if (serviceKey === 'play') return pets
  return []
}

function formatMinutesText(minutes) {
  const value = Number(minutes || 0)
  if (value % 60 === 0) return `${value / 60}小时`
  if (value > 60) return `${Math.floor(value / 60)}小时${value % 60}分钟`
  return `${value}分钟`
}

function normalizePetServiceDurations(data = {}, pets = [], serviceTypes = [], catalogMap = {}, isInternPrice = false) {
  const selectedTimedKeys = PET_TIMED_SERVICE_KEYS.filter((key) => serviceTypes.includes(key))
  const raw = Array.isArray(data.petServiceDurations) ? data.petServiceDurations : []
  const hasExplicitConfig = raw.length > 0
  const petMap = pets.reduce((map, pet) => ({ ...map, [String(pet._id || '')]: pet }), {})
  const validKeys = new Set(selectedTimedKeys)
  const validPairs = new Set()
  selectedTimedKeys.forEach((serviceKey) => {
    const targets = timedServiceTargets(serviceKey, pets)
    if (serviceKey === 'walk' && !targets.length) throw new Error('遛狗服务仅支持狗狗，请先选择狗狗')
    targets.forEach((pet) => validPairs.add(`${serviceKey}:${pet._id}`))
  })

  const configured = {}
  if (hasExplicitConfig) {
    raw.forEach((item) => {
      const serviceKey = safeText(item.serviceKey || item.serviceType).trim()
      const petId = safeText(item.petId).trim()
      if (!validKeys.has(serviceKey)) throw new Error('服务时长配置不正确')
      if (!petMap[petId] || !validPairs.has(`${serviceKey}:${petId}`)) throw new Error('服务时长宠物不匹配')
      const key = `${serviceKey}:${petId}`
      if (configured[key]) throw new Error('服务时长配置重复')
      const durationMinutes = Number(item.durationMinutes)
      if (!Number.isFinite(durationMinutes) || durationMinutes < 30 || durationMinutes > 240 || durationMinutes % 30 !== 0) throw new Error('服务时长需为30-240分钟，且按30分钟递增')
      configured[key] = durationMinutes
    })
  }

  const totalTargetCount = selectedTimedKeys.reduce((sum, serviceKey) => sum + timedServiceTargets(serviceKey, pets).length, 0)
  const legacySingleDuration = Number(data.durationMinutes || 0)
  const legacyDefaultDuration = !hasExplicitConfig && totalTargetCount === 1 && Number.isFinite(legacySingleDuration) && legacySingleDuration >= 30 && legacySingleDuration <= 240 && legacySingleDuration % 30 === 0 ? legacySingleDuration : 30
  const durations = []
  selectedTimedKeys.forEach((serviceKey) => {
    const targets = timedServiceTargets(serviceKey, pets)
    targets.forEach((pet) => {
      const key = `${serviceKey}:${pet._id}`
      if (hasExplicitConfig && !configured[key]) throw new Error('请为每只宠物设置服务时长')
      const item = catalogMap[serviceKey] || {}
      const durationMinutes = configured[key] || legacyDefaultDuration
      const extraUnits = Math.max(durationMinutes / 30 - 1, 0)
      const unitPrice = isInternPrice ? Number(item.internExtraHalfHourFee || 0) : Number(item.extraHalfHourFee || 0)
      durations.push({
        serviceKey,
        serviceLabel: item.label || (serviceKey === 'walk' ? '遛狗' : '陪伴玩耍'),
        petId: pet._id,
        petName: pet.name || '宠物',
        durationMinutes,
        durationText: formatMinutesText(durationMinutes),
        extraUnits,
        unitPrice: Math.max(Number.isFinite(unitPrice) ? unitPrice : 0, 0),
        extraAmount: Math.round(extraUnits * Math.max(Number.isFinite(unitPrice) ? unitPrice : 0, 0) * 100) / 100
      })
    })
  })
  const totalTimedMinutes = durations.reduce((sum, item) => sum + item.durationMinutes, 0)
  return { durations, totalTimedMinutes }
}

async function calcOrderPricing(data, pet, options = {}) {
  const serviceTypes = normalizeServiceTypes(data)
  if (!serviceTypes.length) throw new Error('请选择服务项目')
  validateVisitFeeServices(serviceTypes)
  const pets = Array.isArray(pet) ? pet : (pet ? [pet] : [])
  const primaryPet = pets[0] || null
  const petCount = pets.length || normalizePetIds(data).length
  const dogCount = pets.filter(isDogPet).length
  const staffPriceLevel = await resolveStaffPriceLevel(data)
  const isInternPrice = staffPriceLevel === 'intern'
  const catalog = await listServicePrices(false)
  const catalogMap = catalog.reduce((map, item) => ({ ...map, [item.key]: item }), {})
  const weight = Number((primaryPet && primaryPet.weight) || data.weight || 0)
  const petDurationResult = normalizePetServiceDurations(data, pets, serviceTypes, catalogMap, isInternPrice)
  const durationMinutes = petDurationResult.totalTimedMinutes || Number(data.durationMinutes || 60)
  if (!Number.isFinite(durationMinutes) || durationMinutes < 30 || durationMinutes > 240) throw new Error('服务时长不正确')
  const sessions = data.startTime ? buildOrderSessions({ ...data, durationMinutes, endTime: addMinutesToDateTimeText(data.startTime, durationMinutes) || data.endTime }) : [{ index: 1, startTime: data.startTime || '', endTime: data.endTime || '' }]
  const sessionCount = sessions.length
  const unitBasePriceItems = serviceTypes.map((key) => {
    const item = catalogMap[key]
    if (!item) throw new Error('服务项目不可用')
    const unitBasePrice = isInternPrice ? item.internPrice : item.price
    const basePrice = key === 'walk' ? getWalkPrice(unitBasePrice, weight) : unitBasePrice
    const price = Math.round(basePrice * 100) / 100
    return { key, label: item.label, price }
  })
  const unitExtraPetItems = getBusinessServiceTypes(serviceTypes).map((key) => {
    const item = catalogMap[key]
    if (!item) return null
    const extraPetFee = isInternPrice ? item.internExtraPetFee : item.extraPetFee
    if (item.extraPetRule === 'none' || !Number(extraPetFee || 0)) return null
    const extraCount = item.extraPetRule === 'dog' ? Math.max(dogCount - 1, 0) : Math.max(petCount - 1, 0)
    if (!extraCount) return null
    const price = Math.round(extraCount * Number(extraPetFee || 0))
    return {
      key: `${key}_extra_pet`,
      serviceKey: key,
      label: `${item.label} · 额外${item.extraPetRule === 'dog' ? '狗狗' : '宠物'} x${extraCount}`,
      price,
      quantity: extraCount,
      unitPrice: Number(extraPetFee || 0),
      type: 'extra_pet_fee',
      extraPetRule: item.extraPetRule
    }
  }).filter(Boolean)
  const unitTimedExtraItems = petDurationResult.durations
    .filter((item) => item.extraUnits > 0 && item.extraAmount > 0)
    .map((item) => ({
      key: `${item.serviceKey}_${item.petId}_time_extra`,
      serviceKey: item.serviceKey,
      petId: item.petId,
      petName: item.petName,
      label: `${item.serviceLabel} · ${item.petName}续时 ${item.extraUnits}×30分钟`,
      price: item.extraAmount,
      quantity: item.extraUnits,
      unitPrice: item.unitPrice,
      durationMinutes: item.durationMinutes,
      type: 'pet_time_extra_fee'
    }))
  const unitPriceItems = [...unitBasePriceItems, ...unitExtraPetItems, ...unitTimedExtraItems]
  const priceItems = sessionCount > 1
    ? unitPriceItems.map((item) => ({ ...item, unitPrice: item.price, price: Math.round(item.price * sessionCount * 100) / 100, label: `${item.label} × ${sessionCount}次` }))
    : unitPriceItems
  const amount = Math.round(priceItems.reduce((sum, item) => sum + Math.round(item.price * 100), 0)) / 100
  const serviceLabels = unitBasePriceItems.map((item) => item.label)
  const businessServiceTypes = getBusinessServiceTypes(serviceTypes)
  const basePricing = {
    amount,
    payAmount: amount,
    discountAmount: 0,
    coupon: null,
    currency: 'CNY',
    serviceTypes,
    businessServiceTypes,
    primaryServiceType: businessServiceTypes[0],
    serviceLabels,
    serviceSummary: serviceLabels.join('、'),
    durationMinutes,
    petServiceDurations: petDurationResult.durations,
    sessionCount,
    sessions,
    orderType: sessionCount > 1 ? 'multi_day' : 'single',
    priceItems,
    priceSnapshot: { services: priceItems, unitServices: unitPriceItems, extraPetItems: unitExtraPetItems, timedExtraItems: unitTimedExtraItems, petServiceDurations: petDurationResult.durations, durationMinutes, sessionCount, sessions, weight, petCount, dogCount, staffPriceLevel, staffLevelText: isInternPrice ? '实习宠托师' : '认证宠托师', originalAmount: amount, discountAmount: 0, payAmount: amount }
  }
  const openid = options.openid || ''
  if (!openid) return basePricing
  if (data.couponId) {
    const coupon = (await db.collection('user_coupons').doc(data.couponId).get()).data
    const result = evaluateCoupon(coupon, basePricing, openid)
    if (!result.applicable) throw new Error(result.reason)
    return applyCouponToPricing(basePricing, result)
  }
  if (data.autoApplyCoupon === true) {
    const coupons = await getAvailableUserCoupons(openid)
    const best = coupons
      .map((coupon) => evaluateCoupon(coupon, basePricing, openid))
      .filter((item) => item.applicable)
      .sort((a, b) => b.discountAmount - a.discountAmount)[0]
    return applyCouponToPricing(basePricing, best)
  }
  return basePricing
}

const CHECKIN_EVENT_TYPES = new Set(['sanitization', 'enter_door', 'leash_on', 'feed', 'water', 'pet_status', 'return_home', 'leave_door', 'clean', 'medicine', 'video_checkin', 'pet_beauty_photo'])

function requiredCheckins(serviceType, serviceTypes) {
  const types = Array.isArray(serviceTypes) && serviceTypes.length ? serviceTypes : [serviceType]
  const events = new Set(['enter_door', 'pet_status', 'leave_door'])
  if (types.includes('walk')) {
    events.add('leash_on')
    events.add('return_home')
  }
  if (types.includes('feed')) {
    events.add('feed')
    events.add('water')
  }
  if (types.includes('litter') || types.includes('clean')) events.add('clean')
  if (types.includes('medicine')) events.add('medicine')
  return Array.from(events)
}

function requiresSanitization(order) {
  return (order.requiredCheckins || []).includes('sanitization') ||
    (order.checkinRequirements || []).some((item) => item.eventType === 'sanitization' && item.required)
}

function sanitizationDateKey(value) {
  return formatDateKey(new Date(toTimeValue(value) + 8 * 60 * 60 * 1000))
}

function isValidSanitization(item, order, current = now()) {
  const timestamp = toTimeValue(item.serverTime)
  return item.eventType === 'sanitization' && hasCheckinPhoto(item) &&
    item.orderId === order._id && item.staffOpenid === order.staffOpenid &&
    item.sanitizationVersion === 1 && item.preStart === true && !item.isBackfilled &&
    hasCoordinate(item.latitude, item.longitude) && timestamp > 0 && timestamp <= toTimeValue(current) &&
    sanitizationDateKey(item.serverTime) === sanitizationDateKey(current)
}

async function validateSanitizationMedia(fileId, orderId, staffOpenid) {
  if (!safeFileId(fileId)) {
    throw new Error('请现场拍照并上传本订单的消毒照片')
  }
  if (typeof cloud.downloadFile === 'function') {
    try {
      const res = await cloud.downloadFile({ fileID: fileId })
      const buffer = res && res.fileContent
      if (Buffer.isBuffer(buffer)) {
        const image = buffer.length >= 12 && buffer.length <= 10 * 1024 * 1024 && (
          (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
          buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP')
        )
        if (!image) throw new Error('消毒打卡必须上传有效图片（不超过10MB）')
      }
    } catch (error) {
      if (error && error.message && error.message.includes('10MB')) throw error
    }
  }
}

async function requireSanitizationEvidence(order, current = now()) {
  if (!requiresSanitization(order)) return
  const res = await db.collection('checkin_logs').where({ orderId: order._id, eventType: 'sanitization' }).get()
  const candidates = (res.data || []).filter((item) => isValidSanitization(item, order, current))
  for (const item of candidates) {
    try {
      await validateSanitizationMedia(item.mediaFileId, order._id, order.staffOpenid)
      return
    } catch (error) {}
  }
  throw new Error('请先完成本次服务开始前的消毒拍照打卡（须为当天有效照片）')
}

function normalizeServiceCheckinRule(rule = {}, validServiceKeys = defaultServicePrices.map((item) => item.key)) {
  const serviceType = safeText(rule.serviceType).trim()
  const eventType = safeText(rule.eventType).trim()
  if (!serviceType || !validServiceKeys.includes(serviceType)) throw new Error('服务类型无效')
  if (!CHECKIN_EVENT_TYPES.has(eventType)) throw new Error('打卡类型无效')
  return {
    serviceType,
    eventType,
    label: safeText(rule.label).trim() || checkinEventText(eventType),
    required: rule.required !== false,
    enabled: rule.enabled !== false,
    sortOrder: Number(rule.sortOrder || 100),
    description: safeText(rule.description).trim()
  }
}

async function listServiceCheckinRules() {
  const res = await db.collection('service_checkin_rules').orderBy('sortOrder', 'asc').get()
  const rules = res.data && res.data.length ? res.data : defaultServiceCheckinRules
  const validServiceKeys = (await listServicePrices(true)).map((item) => item.key)
  return rules
    .filter((rule) => validServiceKeys.includes(safeText(rule.serviceType).trim()))
    .map((rule) => normalizeServiceCheckinRule(rule, validServiceKeys))
    .sort((a, b) => String(a.serviceType).localeCompare(String(b.serviceType)) || Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
}

async function resolveCheckinRequirements(serviceTypes) {
  const types = Array.isArray(serviceTypes) && serviceTypes.length ? serviceTypes : []
  const rules = await listServiceCheckinRules()
  const map = {}
  rules.filter((rule) => rule.enabled !== false && types.includes(rule.serviceType)).forEach((rule) => {
    const existing = map[rule.eventType]
    map[rule.eventType] = {
      eventType: rule.eventType,
      label: rule.label || checkinEventText(rule.eventType),
      required: Boolean(rule.required || (existing && existing.required)),
      serviceTypes: Array.from(new Set([...(existing ? existing.serviceTypes : []), rule.serviceType])),
      sortOrder: existing ? Math.min(Number(existing.sortOrder || 100), Number(rule.sortOrder || 100)) : Number(rule.sortOrder || 100),
      completed: false
    }
  })
  // Global requirement is snapshotted on new orders, independent of custom rules.
  map.sanitization = {
    eventType: 'sanitization', label: checkinEventText('sanitization'), required: true,
    serviceTypes: types, sortOrder: 5, completed: false, enforcementVersion: 1, beforeStart: true
  }
  if (types.length) {
    map.pet_beauty_photo = map.pet_beauty_photo || {
      eventType: 'pet_beauty_photo',
      label: checkinEventText('pet_beauty_photo'),
      required: false,
      serviceTypes: types,
      sortOrder: 999,
      completed: false,
      optional: true
    }
  }
  return Object.values(map).sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0))
}

function validateOrderTime(data) {
  const sessions = buildOrderSessions(data)
  sessions.forEach((session) => {
    const start = toTimeValue(session.startTime)
    const end = toTimeValue(session.endTime)
    if (!start || !end || end <= start) throw new Error('服务时间不正确')
    if (start < Date.now()) throw new Error('服务开始时间不能早于当前时间')
  })
}

function formatDateTimeParts(dateObj) {
  // 修复：dateObj 存储的是UTC时间（已减去8小时），需要加回8小时得到北京时间
  const beijingTime = new Date(dateObj.getTime() + 8 * 60 * 60 * 1000)
  return `${beijingTime.getUTCFullYear()}-${String(beijingTime.getUTCMonth() + 1).padStart(2, '0')}-${String(beijingTime.getUTCDate()).padStart(2, '0')} ${String(beijingTime.getUTCHours()).padStart(2, '0')}:${String(beijingTime.getUTCMinutes()).padStart(2, '0')}`
}

function formatDateTime(val) {
  const ts = toTimeValue(val)
  if (!ts) return ''
  return formatDateTimeParts(new Date(ts))
}

function addMinutesToDateTimeText(startTime, durationMinutes) {
  const parts = parseDateTimeParts(startTime)
  if (!parts) return ''
  return formatDateTimeParts(new Date(parts.dateObj.getTime() + Number(durationMinutes || 0) * 60000))
}

function buildOrderSessions(data = {}) {
  if (!data.startTime || !data.endTime) throw new Error('请选择服务时间')
  const startParts = parseDateTimeParts(data.startTime)
  const endParts = parseDateTimeParts(data.endTime)
  if (!startParts || !endParts || endParts.dateObj <= startParts.dateObj) throw new Error('服务时间不正确')
  const orderType = data.orderType === 'multi_day' || data.serviceFrequency === 'multi_day' || (data.endDate && data.endDate > String(data.startTime || '').slice(0, 10)) ? 'multi_day' : 'single'
  const durationMinutes = Math.max(Math.floor(Number(data.durationMinutes || ((endParts.dateObj.getTime() - startParts.dateObj.getTime()) / 60000))), 1)
  if (orderType !== 'multi_day') return [{ index: 1, date: formatDateKey(startParts.dateObj), startTime: data.startTime, endTime: addMinutesToDateTimeText(data.startTime, durationMinutes) || data.endTime, status: 'pending' }]

  const endDateText = safeText(data.endDate || data.serviceEndDate).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDateText)) throw new Error('请选择连续服务结束日期')
  const [endYear, endMonth, endDay] = endDateText.split('-').map(Number)
  const [startYear, startMonth, startDay] = String(data.startTime).slice(0, 10).split('-').map(Number)
  const startDayTime = new Date(Date.UTC(startYear, startMonth - 1, startDay)).getTime()
  const endDayTime = new Date(Date.UTC(endYear, endMonth - 1, endDay)).getTime()
  if (endDayTime < startDayTime) throw new Error('连续服务结束日期不能早于开始日期')
  const sessions = []
  const utcHour = startParts.hour - 8
  const utcMinute = startParts.minute
  let current = new Date(Date.UTC(startYear, startMonth - 1, startDay, utcHour, utcMinute))
  const finalDay = new Date(Date.UTC(endYear, endMonth - 1, endDay, utcHour, utcMinute))
  while (current <= finalDay) {
    if (sessions.length >= 31) throw new Error('连续服务最多支持31天')
    const end = new Date(current.getTime() + durationMinutes * 60000)
    sessions.push({ index: sessions.length + 1, date: formatDateKey(current), startTime: formatDateTimeParts(current), endTime: formatDateTimeParts(end), status: 'pending' })
    current = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate() + 1, utcHour, utcMinute))
  }
  return sessions
}

function normalizeServiceSessions(order = {}) {
  const source = Array.isArray(order.serviceSessions) && order.serviceSessions.length
    ? order.serviceSessions
    : (order.startTime && order.endTime ? [{ index: 1, date: String(order.startTime).slice(0, 10), startTime: order.startTime, endTime: order.endTime }] : [])
  return source.map((session, index) => ({
    ...session,
    index: Number(session.index || index + 1),
    date: session.date || String(session.startTime || '').slice(0, 10),
    status: session.status || (Number(order.lastCompletedSessionIndex || 0) >= Number(session.index || index + 1) ? 'completed' : 'pending')
  }))
}

function beijingDateKey(value = now()) {
  return formatDateKey(new Date(toTimeValue(value) + 8 * 60 * 60 * 1000))
}

function getActiveServiceSession(order = {}) {
  const activeIndex = Number(order.activeSessionIndex || 0)
  return normalizeServiceSessions(order).find((session) => session.status === 'in_service' || (activeIndex && Number(session.index) === activeIndex)) || null
}

function getTodayServiceSession(order = {}, current = now()) {
  const today = beijingDateKey(current)
  return normalizeServiceSessions(order).find((session) => session.date === today && session.status !== 'completed') || null
}

function getNextPendingServiceSession(order = {}, current = now()) {
  return getTodayServiceSession(order, current) || normalizeServiceSessions(order).find((session) => session.status !== 'completed') || null
}

function markServiceSession(sessions, targetIndex, patch) {
  return normalizeServiceSessions({ serviceSessions: sessions }).map((session) => Number(session.index) === Number(targetIndex) ? { ...session, ...patch } : session)
}

function isFinalServiceSession(order = {}, session = {}) {
  const sessions = normalizeServiceSessions(order)
  return sessions.filter((item) => Number(item.index) !== Number(session.index)).every((item) => item.status === 'completed')
}

async function findActiveStaffService(staffOpenid, excludeOrderId = '') {
  if (!staffOpenid) return null
  const res = await db.collection('orders').where({ staffOpenid, status: ORDER_STATUS.IN_SERVICE }).limit(10).get()
  return (res.data || []).find((order) => !excludeOrderId || order._id !== excludeOrderId) || null
}

function hasCoordinate(latitude, longitude) {
  const lat = Number(latitude)
  const lng = Number(longitude)
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && lat !== 0 && lng !== 0
}

function isActiveCheckin(item = {}) {
  return !item.deletedAt
}

function hasCheckinPhoto(item = {}) {
  return isActiveCheckin(item) && Boolean(item.mediaFileId)
}

function toCheckinPhotoView(item = {}) {
  return {
    _id: item._id || '',
    eventType: item.eventType || '',
    mediaFileId: item.mediaFileId || '',
    remark: item.remark || '',
    recordedAt: item.recordedAt || item.createdAt || item.serverTime || '',
    createdAt: item.createdAt || '',
    latitude: item.latitude,
    longitude: item.longitude
  }
}

function groupCheckinsByEventType(checkins = []) {
  return checkins.filter(hasCheckinPhoto).reduce((map, item) => {
    const eventType = item.eventType || ''
    if (!eventType) return map
    if (!map[eventType]) map[eventType] = { count: 0, photos: [] }
    map[eventType].count += 1
    map[eventType].photos.push(toCheckinPhotoView(item))
    return map
  }, {})
}

function calcDistanceKm(lat1, lng1, lat2, lng2) {
  if (!hasCoordinate(lat1, lng1) || !hasCoordinate(lat2, lng2)) return null
  const R = 6371 // 地球平均半径 (公里)
  const toRad = (value) => (Number(value) * Math.PI) / 180
  const radLat1 = toRad(lat1)
  const radLat2 = toRad(lat2)
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)

  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(radLat1) * Math.cos(radLat2) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function formatDistance(distanceKm) {
  if (distanceKm === null) return '未定位'
  return distanceKm < 1 ? `${Math.round(distanceKm * 1000)}m` : `${distanceKm.toFixed(2)}km`
}

// 【新增】计算订单的宠托师收益
async function calculateStaffEarningForOrder(order) {
  if (!order || !order.payAmount) return { earningAmount: 0, commissionRate: 0.7 }
  const settings = await getSystemSettings()
  const rate = Number(settings.settlement.staffCommissionRate || 0.7)
  const grossAmount = Number(order.payAmount || 0)
  const earningAmount = Math.round(grossAmount * rate * 100) / 100
  return { earningAmount, commissionRate: rate }
}

function normalizeCityName(city) {
  return String(city || '').trim().replace(/^(.*省|.*自治区)/, '').replace(/(市|特别行政区|地区|盟|自治州)$/, '')
}

function extractCityFromText(text) {
  const value = String(text || '')
  const directCity = value.match(/(北京市|上海市|天津市|重庆市|香港特别行政区|澳门特别行政区)/)
  if (directCity) return directCity[1]
  const city = value.match(/(?:.*省|.*自治区)?([^省自治区特别行政区]{2,20}市|[^省自治区特别行政区]{2,20}自治州|[^省自治区特别行政区]{2,20}地区|[^省自治区特别行政区]{2,20}盟)/)
  return city ? city[1] : ''
}

function orderMatchesCity(order, selectedCity) {
  const filterCity = normalizeCityName(selectedCity)
  if (!filterCity) return true
  const orderCity = normalizeCityName(order.city || extractCityFromText(`${order.serviceAddress || ''}${order.addressDetail || ''}`))
  if (!orderCity) return true
  return orderCity.includes(filterCity) || filterCity.includes(orderCity)
}

function validateDirectStaffServiceRange(staffProfile, data = {}, options = {}) {
  if (!staffProfile) throw new Error('指定宠托师不存在')
  const sitterLat = Number(staffProfile.serviceLatitude || 0)
  const sitterLng = Number(staffProfile.serviceLongitude || 0)
  const sitterAddress = String(staffProfile.serviceAddress || '').trim()
  const radiusKm = Math.max(Number(staffProfile.serviceRadiusKm || 5), 1)

  const hasSitterCoord = hasCoordinate(sitterLat, sitterLng)
  const orderLat = Number(data.addressLatitude !== undefined ? data.addressLatitude : (data.latitude || 0))
  const orderLng = Number(data.addressLongitude !== undefined ? data.addressLongitude : (data.longitude || 0))
  const hasOrderCoord = hasCoordinate(orderLat, orderLng)
  const orderAddress = String(data.serviceAddress || '').trim()

  // 1. 城市一致性校验（若双方城市均可识别出）
  const sitterCity = normalizeCityName(staffProfile.serviceCity || extractCityFromText(sitterAddress))
  const orderAddressFull = `${data.city || ''}${orderAddress}${data.addressDetail || ''}`
  const orderCity = normalizeCityName(data.city || extractCityFromText(orderAddressFull))
  if (sitterCity && orderCity && !sitterCity.includes(orderCity) && !orderCity.includes(sitterCity)) {
    throw new Error(`订单服务地址所在城市（${orderCity}）与宠托师服务城市（${sitterCity}）不一致，超出服务范围`)
  }

  // 2. 宠托师配置了服务定位时：
  if (hasSitterCoord) {
    if (!hasOrderCoord) {
      if (!options.isQuote) {
        throw new Error('指定宠托师预约需选择包含精确定位的服务地址')
      }
    } else {
      const dist = calcDistanceKm(orderLat, orderLng, sitterLat, sitterLng)
      if (dist !== null && dist > radiusKm) {
        const distText = `约 ${formatDistance(dist)}`
        throw new Error(`订单服务地址距离宠托师常驻服务地址${sitterAddress ? `（${sitterAddress}）` : ''}${distText}，超出宠托师设定的接单范围（${radiusKm}公里内），无法预约`)
      }
      return { dist, radiusKm, sitterAddress, sitterLat, sitterLng }
    }
  }

  let dist = null
  if (hasSitterCoord && hasOrderCoord) {
    dist = calcDistanceKm(orderLat, orderLng, sitterLat, sitterLng)
  }
  return { dist, radiusKm, sitterAddress, sitterLat, sitterLng }
}

function normalizeBenefits(value) {
  if (Array.isArray(value)) return value.map((item) => safeText(item).trim()).filter(Boolean)
  return safeText(value).split(/[\n,，；;]+/).map((item) => item.trim()).filter(Boolean)
}

function calcMemberLevel(totalPoints, levels) {
  if (!Array.isArray(levels) || !levels.length) return { memberLevel: '', memberLevelName: '普通会员', badgeTag: 'V1', nameColor: '', nameEffect: '', badgeStyle: 'gold', pointMultiplier: 1, description: '', benefits: [] }
  const sorted = levels.slice().sort((a, b) => Number(b.minPoints || 0) - Number(a.minPoints || 0))
  const matched = sorted.find((level) => totalPoints >= Number(level.minPoints || 0))
  if (!matched) return { memberLevel: '', memberLevelName: '普通会员', badgeTag: 'V1', nameColor: '', nameEffect: '', badgeStyle: 'gold', pointMultiplier: 1, description: '', benefits: [] }
  const idx = levels.findIndex((l) => l._id === matched._id)
  return {
    memberLevel: matched._id,
    memberLevelName: matched.name,
    badgeTag: normalizeMemberBadgeTag(matched.badgeTag) || `V${idx >= 0 ? idx + 1 : 1}`,
    nameColor: normalizeMemberNameColor(matched.nameColor),
    nameEffect: normalizeMemberNameEffect(matched.nameEffect),
    badgeStyle: normalizeMemberBadgeStyle(matched.badgeStyle),
    pointMultiplier: Math.max(Number(matched.pointMultiplier || 1), 1),
    description: safeText(matched.description).trim(),
    benefits: normalizeBenefits(matched.benefits)
  }
}

function resolveUserMemberLevel(user = {}, levels = []) {
  if (!Array.isArray(levels) || !levels.length) {
    return {
      memberLevel: safeText(user.memberLevel),
      memberLevelName: safeText(user.memberLevelName).trim() || '普通会员',
      badgeTag: normalizeMemberBadgeTag(user.badgeTag) || 'V1',
      nameColor: normalizeMemberNameColor(user.nameColor),
      nameEffect: normalizeMemberNameEffect(user.nameEffect),
      badgeStyle: normalizeMemberBadgeStyle(user.badgeStyle),
      pointMultiplier: 1,
      description: safeText(user.description).trim(),
      benefits: normalizeBenefits(user.benefits)
    }
  }

  // 1. 优先按 user.memberLevel 匹配已有的等级ID
  let matched = user.memberLevel ? levels.find((l) => l._id === user.memberLevel) : null

  // 2. 如果没匹配到，按 user.memberLevelName 匹配等级名称
  if (!matched && user.memberLevelName) {
    matched = levels.find((l) => safeText(l.name).trim() === safeText(user.memberLevelName).trim())
  }

  // 3. 如果没匹配到，按累计积分或当前积分计算最高达标等级
  if (!matched && (user.totalPoints !== undefined || user.points !== undefined)) {
    const pointsToUse = Number(user.totalPoints !== undefined ? user.totalPoints : user.points) || 0
    const sorted = levels.slice().sort((a, b) => Number(b.minPoints || 0) - Number(a.minPoints || 0))
    matched = sorted.find((l) => pointsToUse >= Number(l.minPoints || 0))
  }

  if (matched) {
    const idx = levels.findIndex((l) => l._id === matched._id)
    return {
      memberLevel: matched._id,
      memberLevelName: matched.name,
      badgeTag: normalizeMemberBadgeTag(user.badgeTag) || normalizeMemberBadgeTag(matched.badgeTag) || `V${idx >= 0 ? idx + 1 : 1}`,
      nameColor: normalizeMemberNameColor(user.nameColor) || normalizeMemberNameColor(matched.nameColor),
      nameEffect: (user.nameEffect && normalizeMemberNameEffect(user.nameEffect) !== 'none') ? normalizeMemberNameEffect(user.nameEffect) : normalizeMemberNameEffect(matched.nameEffect),
      badgeStyle: normalizeMemberBadgeStyle(user.badgeStyle) || normalizeMemberBadgeStyle(matched.badgeStyle),
      pointMultiplier: Math.max(Number(matched.pointMultiplier || 1), 1),
      description: safeText(matched.description).trim() || safeText(user.description).trim(),
      benefits: normalizeBenefits(matched.benefits)
    }
  }

  const baselineLevel = levels.length ? levels[0] : null
  return {
    memberLevel: '',
    memberLevelName: safeText(user.memberLevelName).trim() || (baselineLevel ? baselineLevel.name : '普通会员'),
    badgeTag: normalizeMemberBadgeTag(user.badgeTag) || (baselineLevel ? normalizeMemberBadgeTag(baselineLevel.badgeTag) : 'V1'),
    nameColor: normalizeMemberNameColor(user.nameColor) || (baselineLevel ? normalizeMemberNameColor(baselineLevel.nameColor) : ''),
    nameEffect: (user.nameEffect && normalizeMemberNameEffect(user.nameEffect) !== 'none') ? normalizeMemberNameEffect(user.nameEffect) : (baselineLevel ? normalizeMemberNameEffect(baselineLevel.nameEffect) : 'none'),
    badgeStyle: normalizeMemberBadgeStyle(user.badgeStyle) || (baselineLevel ? normalizeMemberBadgeStyle(baselineLevel.badgeStyle) : 'gold'),
    pointMultiplier: 1,
    description: '',
    benefits: []
  }
}

async function enrichUserMemberLevel(user, levelsCache = null) {
  if (!user) return user
  try {
    const levels = levelsCache || await getMemberLevels()
    const levelInfo = resolveUserMemberLevel(user, levels)
    return {
      ...user,
      memberLevel: levelInfo.memberLevel,
      memberLevelName: levelInfo.memberLevelName,
      badgeTag: levelInfo.badgeTag,
      badgeStyle: levelInfo.badgeStyle,
      nameColor: levelInfo.nameColor,
      nameEffect: levelInfo.nameEffect,
      pointMultiplier: levelInfo.pointMultiplier
    }
  } catch (e) {
    return user
  }
}

async function getMemberLevels() {
  const levelsRes = await db.collection('member_levels').orderBy('minPoints', 'asc').get()
  return levelsRes.data || []
}

function normalizeTargetLevelIds(targetLevelIds) {
  return Array.from(new Set((Array.isArray(targetLevelIds) ? targetLevelIds : []).map((item) => safeText(item).trim()).filter(Boolean)))
}

async function resolveTargetLevels(targetLevelIds) {
  const ids = normalizeTargetLevelIds(targetLevelIds)
  const levels = await getMemberLevels()
  const levelMap = new Map(levels.map((level) => [level._id, level]))
  return ids.map((id) => levelMap.get(id)).filter(Boolean)
}

async function syncUsersMemberLevelName(levelId, levelName) {
  const usersRes = await db.collection('users').where({ memberLevel: levelId }).get()
  const users = usersRes.data || []
  const time = now()
  for (const user of users) {
    await db.collection('users').doc(user._id).update({ data: { memberLevelName: levelName || '普通会员', updatedAt: time } })
  }
}

async function recalcUsersForDeletedLevel(levelId) {
  const usersRes = await db.collection('users').where({ memberLevel: levelId }).get()
  const users = usersRes.data || []
  if (!users.length) return
  const levels = await getMemberLevels()
  const time = now()
  for (const user of users) {
    const levelInfo = calcMemberLevel(Number(user.totalPoints || 0), levels)
    await db.collection('users').doc(user._id).update({
      data: {
        memberLevel: levelInfo.memberLevel,
        memberLevelName: levelInfo.memberLevelName,
        updatedAt: time
      }
    })
  }
}

function createInviteCode(user) {
  return `INV${safeText((user && (user._id || user.openid)) || '').replace(/[^a-zA-Z0-9]/g, '').slice(-8).toUpperCase() || Date.now()}`
}

function normalizeMonthKey(monthKey) {
  const text = safeText(monthKey).trim()
  return /^\d{4}-\d{2}$/.test(text) ? text : toCstParts().monthKey
}

async function resolveInviter(data = {}) {
  const inviterOpenid = safeText(data.inviterOpenid).trim()
  if (inviterOpenid) {
    const inviter = await getOptionalUser(inviterOpenid)
    return inviter || null
  }
  const inviteCode = safeText(data.inviteCode).trim().toUpperCase()
  if (!inviteCode) return null
  const inviterRes = await db.collection('users').where({ inviteCode }).limit(1).get()
  return inviterRes.data[0] || null
}

async function bindInviteRelation(user, data = {}) {
  if (!user || !user._id) return user
  const time = now()
  let currentUser = user
  if (!safeText(user.inviteCode).trim()) {
    const inviteCode = createInviteCode(user)
    await db.collection('users').doc(user._id).update({ data: { inviteCode, updatedAt: time } })
    currentUser = { ...currentUser, inviteCode, updatedAt: time }
  }
  const inviter = await resolveInviter(data)
  if (!inviter || inviter.openid === currentUser.openid) return currentUser
  const existing = (await db.collection('user_invites').where({ invitedOpenid: currentUser.openid }).limit(1).get()).data[0]
  if (existing) return { ...currentUser, inviterOpenid: existing.inviterOpenid || currentUser.inviterOpenid || '' }
  await db.collection('user_invites').add({
    data: {
      inviterUserId: inviter._id,
      inviterOpenid: inviter.openid,
      invitedUserId: currentUser._id,
      invitedOpenid: currentUser.openid,
      rewarded: true,
      rewardType: 'retro_card',
      rewardCount: 1,
      createdAt: time,
      updatedAt: time
    }
  })
  await db.collection('users').doc(currentUser._id).update({ data: { inviterOpenid: inviter.openid, updatedAt: time } })
  await grantRetroCards(inviter.openid, inviter._id, 1, 'invite_first_login', currentUser.openid, '邀请新用户首登奖励补签卡 +1')
  return { ...currentUser, inviterOpenid: inviter.openid, updatedAt: time }
}

function getCouponValidRange(template, time = now()) {
  const snapshot = normalizeCouponSnapshot(template)
  if (snapshot.validType === 'fixed_range' && snapshot.validFromFixed && snapshot.validToFixed) {
    return {
      validFrom: new Date(`${snapshot.validFromFixed} 00:00:00`),
      validTo: new Date(`${snapshot.validToFixed} 23:59:59`)
    }
  }
  return {
    validFrom: time,
    validTo: new Date(time.getTime() + Number(snapshot.validDays || 30) * 86400000)
  }
}

async function getRewardMailRetroCardGrant(openid, sourceId) {
  const log = (await db.collection('retro_card_logs').where({ openid, sourceType: 'reward_mail', sourceId }).limit(1).get()).data[0]
  if (!log) return null
  return { balance: Number(log.balance || 0), delta: Number(log.delta || 0) }
}

async function resetRewardClaimResultField(mailId) {
  const command = db.command || {}
  if (typeof command.remove === 'function') {
    await db.collection('reward_mails').doc(mailId).update({ data: { rewardClaimResult: command.remove() } })
    return
  }
  if (typeof command.set === 'function') {
    await db.collection('reward_mails').doc(mailId).update({ data: { rewardClaimResult: command.set({}) } })
    return
  }
  await db.collection('reward_mails').doc(mailId).update({ data: { rewardClaimResult: {} } })
}

async function grantRetroCards(openid, userId, delta, sourceType, sourceId, reason) {
  const userRes = await db.collection('users').where({ openid }).limit(1).get()
  const user = userRes.data[0]
  if (!user) return { balance: 0 }
  const amount = Number(delta || 0)
  if (!amount) return { balance: Number(user.retroCardCount || 0) }
  const time = now()
  const command = db.command || {}
  const hasAtomicInc = typeof command.inc === 'function'
  const currentBalance = Number(user.retroCardCount || 0)

  if (amount < 0 && hasAtomicInc && typeof command.gte === 'function') {
    const updated = await db.collection('users').where({ openid, retroCardCount: command.gte(Math.abs(amount)) }).update({
      data: { retroCardCount: command.inc(amount), updatedAt: time }
    })
    if (!updated.stats || Number(updated.stats.updated || 0) <= 0) throw new Error('补签卡不足')
  } else {
    if (amount < 0 && currentBalance < Math.abs(amount)) throw new Error('补签卡不足')
    const nextBalance = Math.max(currentBalance + amount, 0)
    await db.collection('users').doc(user._id).update({
      data: { retroCardCount: hasAtomicInc ? command.inc(amount) : nextBalance, updatedAt: time }
    })
  }

  const latest = (await db.collection('users').doc(user._id).get()).data || {}
  const balance = Number(latest.retroCardCount || 0)
  await db.collection('retro_card_logs').add({
    data: { userId: userId || user._id, openid, delta: amount, balance, sourceType: sourceType || '', sourceId: sourceId || '', reason: reason || '', createdAt: time }
  })
  return { balance }
}

function formatHomeCoupon(coupon) {
  return {
    _id: coupon._id,
    name: coupon.name || '新人优惠券',
    discountAmount: Number(coupon.discountAmount || 0),
    minOrderAmount: Number(coupon.minOrderAmount || 0),
    displayTag: coupon.displayTag || '新人专享',
    claimNotice: coupon.claimNotice || '',
    ruleText: coupon.minOrderAmount > 0 ? `满${coupon.minOrderAmount}减${coupon.discountAmount}` : `立减${coupon.discountAmount}`
  }
}

async function issueCouponToTargetUser(template, targetUser, adminMeta = {}) {
  if (!template || template.enabled === false) throw new Error('优惠券模板不可用')
  const templateId = template._id || template.templateId
  const existing = (await db.collection('user_coupons').where({ openid: targetUser.openid, templateId }).get()).data || []
  const activeCount = existing.filter((coupon) => coupon.status !== 'void').length
  if (activeCount >= Number(template.perUserLimit || 1)) throw new Error('该用户已达到领取上限')
  if (Number(template.totalIssueLimit || 0) > 0 && Number(template.issuedCount || 0) >= Number(template.totalIssueLimit || 0)) throw new Error('优惠券已达到发放上限')
  const time = now()
  const validRange = getCouponValidRange(template, time)
  const snapshot = normalizeCouponSnapshot(template)
  const created = await db.collection('user_coupons').add({
    data: {
      templateId,
      templateSnapshot: snapshot,
      userId: targetUser._id,
      openid: targetUser.openid,
      status: 'available',
      validFrom: validRange.validFrom,
      validTo: validRange.validTo,
      lockedOrderId: '',
      lockedAt: null,
      usedOrderId: '',
      usedAt: null,
      issuedByAdminUserId: adminMeta.adminUserId || '',
      issuedByAdminOpenid: adminMeta.adminOpenid || '',
      issuedAt: time,
      createdAt: time,
      updatedAt: time
    }
  })
  await db.collection('coupon_templates').doc(templateId).update({ data: { issuedCount: incUpdateValue(template.issuedCount, 1), updatedAt: time } })
  template.issuedCount = Number(template.issuedCount || 0) + 1
  return { _id: created._id, templateSnapshot: snapshot, validFrom: validRange.validFrom, validTo: validRange.validTo }
}

async function getMonthConfig(monthKey) {
  const configRes = await db.collection('checkin_month_configs').where({ monthKey }).limit(1).get()
  return configRes.data[0] || null
}

async function ensureMonthConfig(monthKey) {
  const existing = await getMonthConfig(monthKey)
  if (existing) return existing
  const time = now()
  const created = await db.collection('checkin_month_configs').add({ data: { monthKey, days: defaultCheckinDays(monthKey), status: 'draft', createdAt: time, updatedAt: time } })
  return { _id: created._id, monthKey, days: defaultCheckinDays(monthKey), status: 'draft', createdAt: time, updatedAt: time }
}

function normalizeCheckinReward(dayConfig, day) {
  const rewardType = ['points', 'coupon', 'none'].includes(dayConfig && dayConfig.rewardType) ? dayConfig.rewardType : 'points'
  return {
    day,
    rewardType,
    points: Math.max(Math.round(Number((dayConfig && dayConfig.points) || 0)), 0),
    couponTemplateId: safeText(dayConfig && dayConfig.couponTemplateId).trim(),
    couponSnapshot: dayConfig && dayConfig.couponSnapshot ? dayConfig.couponSnapshot : null,
    title: safeText(dayConfig && dayConfig.title).trim() || `第${day}天奖励`,
    desc: safeText(dayConfig && dayConfig.desc).trim()
  }
}

async function claimCheckinReward(user, reward, dateInfo, checkinType) {
  const rewardSnapshot = { ...reward }
  let pointsDelta = 0
  let couponId = ''
  if (reward.rewardType === 'points' && reward.points > 0) {
    const result = await addPoints(user.openid, user._id, reward.points, 'checkin_daily', dateInfo.dateKey, `签到奖励 +${reward.points} 积分`, { applyMultiplier: true, baseDelta: reward.points })
    pointsDelta = result.delta
    rewardSnapshot.finalPoints = result.delta
    rewardSnapshot.multiplier = result.multiplier
  }
  if (reward.rewardType === 'coupon' && reward.couponTemplateId) {
    const template = (await db.collection('coupon_templates').doc(reward.couponTemplateId).get()).data
    const issued = await issueCouponToTargetUser(template, user)
    couponId = issued._id
    rewardSnapshot.couponSnapshot = issued.templateSnapshot
  }
  return { rewardSnapshot, pointsDelta, couponId, checkinType }
}

async function buildMonthCalendar(openid, monthKey) {
  const user = await getUser(openid)
  const config = await ensureMonthConfig(monthKey)
  const checkinsRes = await db.collection('user_checkins').where({ openid, monthKey }).get()
  const checkinMap = (checkinsRes.data || []).reduce((map, item) => ({ ...map, [item.day]: item }), {})
  const todayInfo = toCstParts()
  const days = defaultCheckinDays(monthKey).map((fallback) => {
    const reward = normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === fallback.day) || fallback, fallback.day)
    const checkin = checkinMap[fallback.day]
    const isPast = monthKey < todayInfo.monthKey || (monthKey === todayInfo.monthKey && fallback.day < todayInfo.dayNumber)
    const isToday = monthKey === todayInfo.monthKey && fallback.day === todayInfo.dayNumber
    return {
      ...reward,
      checked: Boolean(checkin),
      checkinType: checkin ? checkin.checkinType : '',
      rewardSnapshot: checkin ? (checkin.rewardSnapshot || reward) : reward,
      canCheckin: isToday && !checkin,
      canRetro: isPast && !checkin && Number(user.retroCardCount || 0) > 0,
      rewardStatus: checkin ? 'claimed' : (isToday ? 'today' : (isPast ? 'missed' : 'future'))
    }
  })
  const settings = await getSystemSettings()
  return {
    monthKey,
    retroCardCount: Number(user.retroCardCount || 0),
    points: Number(user.points || 0),
    memberLevelName: user.memberLevelName || '普通会员',
    days,
    shareTitle: (settings.checkinShare && settings.checkinShare.title) || '来签到领福利，补签卡也能拿',
    shareImageUrl: (settings.checkinShare && settings.checkinShare.imageUrl) || ''
  }
}

function rewardMailStatusText(mail) {
  if (mail.claimedAt) return '已领取'
  if (mail.readAt) return '待领取'
  return '未读'
}

function formatRewardMail(mail) {
  const reward = mail.reward || {}
  return {
    _id: mail._id,
    title: safeText(mail.title).trim() || '奖励到账提醒',
    content: safeText(mail.content).trim(),
    targetLevels: Array.isArray(mail.targetLevels) ? mail.targetLevels : [],
    rewardType: reward.type || 'points',
    reward,
    readAt: mail.readAt || null,
    claimedAt: mail.claimedAt || null,
    createdAt: mail.createdAt,
    updatedAt: mail.updatedAt,
    unread: !mail.readAt,
    claimable: !mail.claimedAt,
    statusText: rewardMailStatusText(mail)
  }
}

async function addPoints(openid, userId, delta, sourceType, sourceId, reason, options = {}) {
  const userRes = await db.collection('users').where({ openid }).limit(1).get()
  const user = userRes.data[0]
  if (!user) return { delta: 0, multiplier: 1, balance: 0 }
  const baseDelta = Number(options.baseDelta !== undefined ? options.baseDelta : delta)
  const currentPoints = Number(user.points || 0)
  const currentTotal = Number(user.totalPoints || 0)
  const currentLevels = await getMemberLevels()
  const currentLevelInfo = calcMemberLevel(currentTotal, currentLevels)
  const multiplier = options.applyMultiplier && baseDelta > 0 ? Math.max(Number(currentLevelInfo.pointMultiplier || 1), 1) : 1
  const finalDelta = baseDelta > 0 ? Math.max(Math.round(baseDelta * multiplier), 1) : Number(delta || 0)
  const newPoints = Math.max(currentPoints + finalDelta, 0)
  const newTotal = finalDelta > 0 ? currentTotal + finalDelta : currentTotal
  const levelInfo = calcMemberLevel(newTotal, currentLevels)
  const time = now()
  await db.collection('point_logs').add({
    data: { userId: user._id, openid, delta: finalDelta, baseDelta, multiplier, balance: newPoints, reason: reason || '', sourceType: sourceType || '', sourceId: sourceId || '', createdAt: time }
  })
  await db.collection('users').doc(user._id).update({
    data: {
      points: newPoints,
      totalPoints: newTotal,
      memberLevel: levelInfo.memberLevel,
      memberLevelName: levelInfo.memberLevelName,
      badgeTag: levelInfo.badgeTag,
      badgeStyle: levelInfo.badgeStyle,
      nameColor: levelInfo.nameColor,
      nameEffect: levelInfo.nameEffect,
      updatedAt: time
    }
  })
  return { delta: finalDelta, multiplier, balance: newPoints, totalPoints: newTotal, memberLevelName: levelInfo.memberLevelName, badgeTag: levelInfo.badgeTag, badgeStyle: levelInfo.badgeStyle, nameColor: levelInfo.nameColor, nameEffect: levelInfo.nameEffect }
}

async function logAdmin(admin, targetType, targetId, action, detail) {
  await db.collection('admin_operation_logs').add({
    data: { adminUserId: admin._id, adminOpenid: admin.openid, targetType, targetId, action, detail: detail || {}, createdAt: now() }
  })
}

async function updateOrderWhenStatus(orderId, expectedStatus, data, message, extraWhere = {}) {
  const updated = await db.collection('orders').where({ _id: orderId, status: expectedStatus, ...extraWhere }).update({ data })
  if (!updated.stats || !updated.stats.updated) throw new Error(message)
  return updated
}

async function removeByQuery(collectionName, where) {
  const res = await db.collection(collectionName).where(where).get()
  const list = res.data || []
  await Promise.all(list.map((item) => db.collection(collectionName).doc(item._id).remove()))
  return list.length
}

async function removeAllByQuery(collectionName, where, filter) {
  let total = 0
  while (true) {
    const res = await db.collection(collectionName).where(where).limit(100).get()
    const list = filter ? (res.data || []).filter(filter) : (res.data || [])
    if (!list.length) break
    await Promise.all(list.map((item) => db.collection(collectionName).doc(item._id).remove()))
    total += list.length
    if ((res.data || []).length < 100) break
  }
  return total
}

async function countByQuery(collectionName, where) {
  const res = await db.collection(collectionName).where(where).count()
  return Number(res.total || 0)
}

async function getUserManageStats(user) {
  const openid = user.openid
  const [pets, addresses, coupons, checkins, pointLogs, rewardMails, clientOrders, staffOrders, favorites, homeSecurity, retroLogs, invitesOut, invitesIn, staffProfiles] = await Promise.all([
    countByQuery('pets', { openid }),
    countByQuery('user_addresses', { openid }),
    countByQuery('user_coupons', { openid }),
    countByQuery('user_checkins', { openid }),
    countByQuery('point_logs', { openid }),
    countByQuery('reward_mails', { openid }),
    countByQuery('orders', { clientOpenid: openid }),
    countByQuery('orders', { staffOpenid: openid }),
    countByQuery('sitter_favorites', { openid }),
    countByQuery('home_security', { openid }),
    countByQuery('retro_card_logs', { openid }),
    countByQuery('user_invites', { inviterOpenid: openid }),
    countByQuery('user_invites', { invitedOpenid: openid }),
    countByQuery('staff_profiles', { openid })
  ])
  return { pets, addresses, coupons, checkins, pointLogs, rewardMails, clientOrders, staffOrders, favorites, homeSecurity, retroLogs, invitesOut, invitesIn, staffProfiles }
}

function normalizeEditableRoles(roles) {
  const allowed = ['client', 'staff', 'admin']
  const next = Array.isArray(roles) ? roles.filter((role) => allowed.includes(role)) : ['client']
  return Array.from(new Set(next.length ? next : ['client']))
}

async function assertAdminRoleChangeAllowed(target, roles, currentOpenid) {
  const hadAdmin = Array.isArray(target.roles) && target.roles.includes('admin')
  const hasAdmin = roles.includes('admin')
  if (target.openid === currentOpenid && hadAdmin !== hasAdmin) throw new Error('不能修改自己的管理员权限')
  if (hadAdmin && !hasAdmin) {
    const usersRes = await db.collection('users').get()
    const admins = (usersRes.data || []).filter((user) => user.status !== 'deleted' && Array.isArray(user.roles) && user.roles.includes('admin'))
    if (admins.length <= 1) throw new Error('至少保留一个管理员')
  }
}

async function assertUserDeleteAllowed(target, currentOpenid, message = '不能删除自己的账号') {
  if (target.openid === currentOpenid) throw new Error(message)
  const targetRoles = Array.isArray(target.roles) ? target.roles : []
  if (targetRoles.includes('admin')) {
    const usersRes = await db.collection('users').get()
    const admins = (usersRes.data || []).filter((user) => user.status !== 'deleted' && Array.isArray(user.roles) && user.roles.includes('admin'))
    if (admins.length <= 1) throw new Error('至少保留一个管理员')
  }
}

async function updateByQuery(collectionName, where, buildUpdate) {
  const res = await db.collection(collectionName).where(where).get()
  const list = res.data || []
  await Promise.all(list.map((item) => db.collection(collectionName).doc(item._id).update({ data: typeof buildUpdate === 'function' ? buildUpdate(item) : buildUpdate })))
  return list.length
}

async function cleanupUserPersonalData(targetOpenid) {
  const cleanup = {}
  const openidWhere = { openid: targetOpenid }
  for (const name of ['pets', 'user_addresses', 'home_security', 'sitter_favorites', 'user_coupons', 'reward_mails', 'user_checkins', 'retro_card_logs', 'point_logs', 'lottery_records']) {
    cleanup[name] = await removeByQuery(name, openidWhere)
  }
  cleanup.userInvitesAsInviter = await removeByQuery('user_invites', { inviterOpenid: targetOpenid })
  cleanup.userInvitesAsInvited = await removeByQuery('user_invites', { invitedOpenid: targetOpenid })
  const staffProfiles = (await db.collection('staff_profiles').where({ openid: targetOpenid }).get()).data || []
  await Promise.all(staffProfiles.map((profile) => db.collection('staff_profiles').doc(profile._id).update({ data: { auditStatus: 'rejected', auditRemark: '用户已删除', isFeatured: false, featuredAt: '', featuredByOpenid: '', updatedAt: now() } })))
  cleanup.staffProfilesMarkedDeleted = staffProfiles.length
  const reviews = (await db.collection('service_reviews').where({ clientOpenid: targetOpenid }).get()).data || []
  await Promise.all(reviews.map((review) => db.collection('service_reviews').doc(review._id).update({ data: { clientName: '已删除用户', updatedAt: now() } })))
  cleanup.reviewsAnonymized = reviews.length
  return cleanup
}

async function detachUserFromHistoricalRecords(targetOpenid, deletedAt) {
  const cleanup = {}
  cleanup.ordersAsClient = await updateByQuery('orders', { clientOpenid: targetOpenid }, { deletedClientOpenid: targetOpenid, clientOpenid: '', clientUserId: '', clientDeletedAt: deletedAt, updatedAt: deletedAt })
  cleanup.ordersAsStaff = await updateByQuery('orders', { staffOpenid: targetOpenid }, { deletedStaffOpenid: targetOpenid, staffOpenid: '', staffUserId: '', staffDeletedAt: deletedAt, updatedAt: deletedAt })
  cleanup.ordersAsRequestedStaff = await updateByQuery('orders', { requestedStaffOpenid: targetOpenid }, { deletedRequestedStaffOpenid: targetOpenid, requestedStaffOpenid: '', updatedAt: deletedAt })
  cleanup.incidentsAsClient = await updateByQuery('order_incidents', { clientOpenid: targetOpenid }, { deletedClientOpenid: targetOpenid, clientOpenid: '', updatedAt: deletedAt })
  cleanup.incidentsAsStaff = await updateByQuery('order_incidents', { staffOpenid: targetOpenid }, { deletedStaffOpenid: targetOpenid, staffOpenid: '', updatedAt: deletedAt })
  cleanup.reviewsAsClient = await updateByQuery('service_reviews', { clientOpenid: targetOpenid }, { deletedClientOpenid: targetOpenid, clientOpenid: '', clientUserId: '', clientName: '已删除用户', updatedAt: deletedAt })
  cleanup.reviewsAsStaff = await updateByQuery('service_reviews', { staffOpenid: targetOpenid }, { deletedStaffOpenid: targetOpenid, staffOpenid: '', staffUserId: '', updatedAt: deletedAt })
  cleanup.checkinLogsAsStaff = await updateByQuery('checkin_logs', { staffOpenid: targetOpenid }, { deletedStaffOpenid: targetOpenid, staffOpenid: '', staffUserId: '', updatedAt: deletedAt })
  cleanup.trackLogsAsStaff = await updateByQuery('track_logs', { staffOpenid: targetOpenid }, { deletedStaffOpenid: targetOpenid, staffOpenid: '', staffUserId: '', updatedAt: deletedAt })
  cleanup.unlockLogsAsStaff = await updateByQuery('unlock_code_logs', { staffOpenid: targetOpenid }, { deletedStaffOpenid: targetOpenid, staffOpenid: '', staffUserId: '', updatedAt: deletedAt })
  return cleanup
}

function parseOpenidList(value) {
  if (Array.isArray(value)) return value.map((item) => safeText(item).trim()).filter(Boolean)
  return safeText(value).split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean)
}

async function resolveRewardMailTargets(data = {}) {
  const targetType = safeText(data.targetType).trim() || 'openid_list'
  const usersRes = await db.collection('users').where({ status: 'active' }).get()
  const users = usersRes.data || []
  if (targetType === 'all_active') return { targetType, users }
  if (targetType === 'role') {
    const role = safeText(data.role).trim()
    if (!['client', 'staff', 'admin'].includes(role)) throw new Error('请选择有效角色')
    return { targetType, role, users: users.filter((user) => Array.isArray(user.roles) && user.roles.includes(role)) }
  }
  if (targetType === 'member_level') {
    const targetLevelIds = normalizeTargetLevelIds(data.targetLevelIds)
    if (!targetLevelIds.length) throw new Error('请选择至少一个会员段位')
    const targetLevels = await resolveTargetLevels(targetLevelIds)
    if (!targetLevels.length) throw new Error('所选会员段位不存在')
    return { targetType, targetLevelIds, targetLevelNamesSnapshot: targetLevels.map((level) => level.name), users: users.filter((user) => targetLevelIds.includes(user.memberLevel || '')) }
  }
  const openids = Array.from(new Set(parseOpenidList(data.openids)))
  if (!openids.length) throw new Error('请输入至少一个用户 openid')
  return { targetType: 'openid_list', openids, users: users.filter((user) => openids.includes(user.openid)) }
}

async function getOrderForAccess(openid, orderId) {
  const user = await getUser(openid)
  const res = await db.collection('orders').doc(orderId).get()
  let order = res.data ? { ...res.data, _id: orderId } : null
  if (!order || (isAdminDeletedOrder(order) && !user.roles.includes('admin'))) throw new Error('订单不存在')
  order = await expireUnacceptedOrder(orderId, order)
  const canPreviewForStaff = user.roles.includes('staff') && order.status === ORDER_STATUS.PAID && (isOpenOrder(order) || order.requestedStaffOpenid === openid)
  const allowed = order.clientOpenid === openid || order.staffOpenid === openid || order.requestedStaffOpenid === openid || user.roles.includes('admin') || canPreviewForStaff
  if (!allowed) throw new Error('无权访问订单')
  return { user, order }
}

async function requireClientOrder(openid, orderId, message = '无权操作该订单') {
  const { user, order } = await getOrderForAccess(openid, orderId)
  if (order.clientOpenid !== openid) throw new Error(message)
  return { user, order }
}

async function requireStaffOrder(openid, orderId, message = '仅订单员工可操作') {
  const { user, order } = await getOrderForAccess(openid, orderId)
  if (!user.roles.includes('staff') || order.staffOpenid !== openid) throw new Error(message)
  return { user, order }
}

async function attachPetSnapshot(order) {
  let snapshot = order.petSnapshot || null
  if (order.petId) {
    try {
      const pet = (await db.collection('pets').doc(order.petId).get()).data
      if (pet) {
        const latest = createPetSnapshot({ ...pet, name: pet.name || order.petName || '' })
        snapshot = snapshot ? { ...snapshot, ...latest, avatarFileId: pet.avatarFileId || snapshot.avatarFileId || '', beautyTitle: pet.beautyTitle || snapshot.beautyTitle || null } : latest
      }
    } catch (error) {}
  }
  return {
    ...order,
    petSnapshot: snapshot
  }
}

async function getRequestedStaff(data) {
  const publishMode = data.publishMode === 'direct' ? 'direct' : 'open'
  if (publishMode === 'open') {
    return {
      publishMode,
      requestedStaffProfileId: '',
      requestedStaffUserId: '',
      requestedStaffOpenid: '',
      requestedStaffName: '',
      requestedStaffSnapshot: null
    }
  }
  const staffProfileId = data.staffProfileId || data.requestedStaffProfileId
  if (!staffProfileId) throw new Error('请选择指定宠托师')
  const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
  const profile = normalizeStaffWorkflow(profileRes.data)
  const settings = await getSystemSettings()
  const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
  if (!ability.can) {
    if (ability.reason === 'deposit_unpaid') {
      throw new Error('指定宠托师尚未缴纳履约保证金，暂不可指定接单')
    }
    throw new Error('指定宠托师未审核通过')
  }
  const userRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
  const staffUser = userRes.data[0]
  if (!staffUser) throw new Error('指定宠托师账号不存在')
  const publicSitter = toPublicSitter(await withSitterUserProfile(profile))
  return {
    publishMode,
    requestedStaffProfileId: profile._id,
    requestedStaffUserId: staffUser._id,
    requestedStaffOpenid: profile.openid,
    requestedStaffName: publicSitter.displayName,
    requestedStaffSnapshot: {
      profileId: profile._id,
      displayName: publicSitter.displayName,
      serviceCity: publicSitter.serviceCity,
      serviceAreas: publicSitter.serviceAreas
    }
  }
}

function isOpenOrder(order) {
  return !order.staffOpenid && (!order.publishMode || order.publishMode === 'open') && !order.requestedStaffOpenid
}

function maskClientName(value) {
  const name = String(value || '').trim()
  if (!name) return '宠物主'
  return name.length <= 1 ? `${name}用户` : `${name.slice(0, 1)}* 用户`
}

function createClientSnapshot(user = {}, levels = []) {
  const nickname = safeText(user.nickname).trim()
  const levelInfo = resolveUserMemberLevel(user, levels)
  return {
    userId: safeText(user._id),
    nickname,
    displayName: maskClientName(nickname),
    avatarUrl: safeFileId(user.avatarUrl) || safeText(user.avatarUrl),
    phoneMasked: mask(safeText(user.phone).trim()),
    memberLevel: levelInfo.memberLevel,
    memberLevelName: levelInfo.memberLevelName,
    badgeTag: levelInfo.badgeTag,
    badgeStyle: levelInfo.badgeStyle,
    nameColor: levelInfo.nameColor,
    nameEffect: levelInfo.nameEffect
  }
}

async function syncClientOrderPhone(openid, phone) {
  const cleanPhone = safeText(phone).trim()
  const ordersRes = await db.collection('orders').where({ clientOpenid: openid }).get()
  const time = now()
  await Promise.all((ordersRes.data || []).map((order) => db.collection('orders').doc(order._id).update({
    data: {
      contactPhone: cleanPhone,
      clientSnapshot: {
        ...(order.clientSnapshot || {}),
        phoneMasked: mask(cleanPhone)
      },
      updatedAt: time
    }
  })))
}

async function getAdminClientContact(order) {
  if (!order.clientOpenid) return { phone: safeText(order.contactPhone).trim(), displayName: '', openid: '' }
  const userRes = await db.collection('users').where({ openid: order.clientOpenid }).limit(1).get()
  const user = userRes.data[0] || {}
  return {
    phone: safeText(user.phone || order.contactPhone).trim(),
    displayName: safeText(user.nickname).trim() || maskClientName(order.clientName || ''),
    openid: safeText(order.clientOpenid)
  }
}

async function getAdminStaffContact(order) {
  const staffOpenid = safeText(order.staffOpenid || order.requestedStaffOpenid).trim()
  const staffProfileId = safeText(order.staffProfileId || order.requestedStaffProfileId).trim()
  let profile = null
  if (staffProfileId) {
    try {
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
      profile = profileRes.data || null
    } catch (error) {}
  }
  if (!profile && staffOpenid) {
    const profileRes = await db.collection('staff_profiles').where({ openid: staffOpenid }).limit(1).get()
    profile = profileRes.data[0] || null
  }
  let user = null
  const openidForUser = staffOpenid || safeText(profile && profile.openid).trim()
  if (openidForUser) {
    const userRes = await db.collection('users').where({ openid: openidForUser }).limit(1).get()
    user = userRes.data[0] || null
  }
  return {
    phone: safeText((profile && profile.phone) || (user && user.phone)).trim(),
    displayName: sitterDisplayName({ ...(profile || {}), nickname: user && user.nickname }) || safeText(order.staffName || order.requestedStaffName).trim(),
    openid: openidForUser,
    staffProfileId: staffProfileId || safeText(profile && profile._id).trim()
  }
}

async function attachClientSnapshot(order, levelsCache = null, userCache = null) {
  if (!order || !order.clientOpenid) return order
  try {
    const hasMapCache = userCache && typeof userCache.get === 'function'
    let user = hasMapCache ? userCache.get(order.clientOpenid) : null
    if (!user) {
      const userRes = await db.collection('users').where({ openid: order.clientOpenid }).limit(1).get()
      user = userRes.data[0]
      if (user && hasMapCache) userCache.set(order.clientOpenid, user)
    }
    if (!user) return order
    const levels = (Array.isArray(levelsCache) && levelsCache.length) ? levelsCache : await getMemberLevels()
    const latestSnapshot = createClientSnapshot(user, levels)
    return {
      ...order,
      clientSnapshot: {
        ...(order.clientSnapshot || {}),
        ...latestSnapshot,
        displayName: (order.clientSnapshot && order.clientSnapshot.displayName) || latestSnapshot.displayName,
        avatarUrl: (order.clientSnapshot && order.clientSnapshot.avatarUrl) || latestSnapshot.avatarUrl,
        memberLevel: latestSnapshot.memberLevel,
        memberLevelName: latestSnapshot.memberLevelName,
        badgeTag: latestSnapshot.badgeTag,
        badgeStyle: latestSnapshot.badgeStyle,
        nameColor: latestSnapshot.nameColor,
        nameEffect: latestSnapshot.nameEffect
      }
    }
  } catch (error) {
    return order
  }
}

async function attachOrderDisplayData(order, levelsCache = null, userCache = null) {
  const safeLevels = (Array.isArray(levelsCache) && levelsCache.length) ? levelsCache : null
  const safeUserCache = (userCache && typeof userCache.get === 'function') ? userCache : null
  const withPet = await attachPetSnapshot({ ...order, serviceSessions: normalizeServiceSessions(order) })
  return attachClientSnapshot(withPet, safeLevels, safeUserCache)
}

function isOrderOverdue(order, currentTime = now()) {
  if (!order) return false
  if (order.isStartOverdue || order.isFinishOverdue || order.finishOverdueIncidentCreated) return true
  const currentTs = toTimeValue(currentTime)
  if (!currentTs) return false

  if (order.status === ORDER_STATUS.ASSIGNED || order.status === ORDER_STATUS.DAY_COMPLETED) {
    const activeSession = getActiveServiceSession(order) || getNextPendingServiceSession(order) || (Array.isArray(order.serviceSessions) && order.serviceSessions[0])
    const sessionStartTime = toTimeValue((activeSession && activeSession.startTime) || order.startTime)
    if (sessionStartTime && currentTs - sessionStartTime >= 15 * 60 * 1000) {
      return true
    }
  } else if (order.status === ORDER_STATUS.IN_SERVICE) {
    const activeSession = getActiveServiceSession(order) || (Array.isArray(order.serviceSessions) && order.serviceSessions[0])
    const sessionStartedAt = toTimeValue(order.currentSessionStartedAt || (activeSession && activeSession.startedAt) || order.startedAt)
    const sessionEndTime = toTimeValue((activeSession && activeSession.endTime) || order.endTime)
    const durationMs = (Math.max(Number(order.durationMinutes || 60), 30)) * 60 * 1000
    const estimatedEndTime = sessionEndTime || (sessionStartedAt ? sessionStartedAt + durationMs : 0)
    if (estimatedEndTime && currentTs - estimatedEndTime >= 15 * 60 * 1000) {
      return true
    }
  }
  return false
}

async function attachAdminOrderContactData(order) {
  const displayOrder = await attachOrderDisplayData(order)
  const isOverdue = isOrderOverdue(order)
  return {
    ...displayOrder,
    autoCompleted: order.autoCompleted === true,
    isOverdue,
    isStartOverdue: order.isStartOverdue === true,
    isFinishOverdue: order.isFinishOverdue === true,
    clientContact: await getAdminClientContact(order),
    staffContact: await getAdminStaffContact(order)
  }
}

async function appendOrderTimeline(orderId, type, title, detail, actorRole) {
  await db.collection('order_timeline').add({
    data: { orderId, type, title, detail: detail || '', actorRole: actorRole || '', createdAt: now() }
  })
}

function isMallOrder(order = {}) {
  return order.orderType === 'mall' || (Array.isArray(order.items) && order.items.some((item) => item && item.productId)) || !!order.shippingAddress
}

function buildMallOrderTitle(order = {}) {
  const firstItem = Array.isArray(order.items) ? order.items[0] : null
  const itemName = firstItem && safeText(firstItem.name).trim()
  const count = Array.isArray(order.items) ? order.items.length : 0
  if (itemName && count > 1) return `${itemName}等${count}件商品`
  return itemName || '商城订单'
}

function buildOrderMessageTitle(order = {}) {
  if (isMallOrder(order)) return buildMallOrderTitle(order)
  return order.serviceSummary || (order.petName ? `${order.petName}的订单` : '订单消息')
}

async function getOrCreateOrderMessageThread(order = {}) {
  const orderId = order._id || order.orderId || ''
  const clientOpenid = safeText(order.clientOpenid).trim()
  if (!orderId || !clientOpenid) return null
  const existing = await db.collection('order_message_threads').where({ orderId, clientOpenid }).limit(1).get()
  if (existing.data[0]) return existing.data[0]
  const time = now()
  const thread = {
    orderId,
    orderNo: order.orderNo || '',
    clientOpenid,
    clientUserId: order.clientUserId || '',
    threadType: 'order',
    orderTitle: buildOrderMessageTitle(order),
    petName: order.petName || '',
    serviceSummary: order.serviceSummary || '',
    orderStatus: order.status || '',
    lastMessageTitle: '',
    lastMessageDetail: '',
    lastMessageAt: time,
    lastMessageType: '',
    unreadCount: 0,
    readAt: null,
    createdAt: time,
    updatedAt: time
  }
  const created = await db.collection('order_message_threads').add({ data: thread })
  return { _id: created._id, ...thread }
}

async function appendOrderClientMessage(order = {}, event = {}) {
  const orderId = order._id || event.orderId || ''
  const clientOpenid = safeText(order.clientOpenid).trim()
  if (!orderId || !clientOpenid) return null
  const eventType = safeText(event.eventType).trim()
  const title = safeText(event.title).trim()
  if (!eventType || !title) return null
  const detail = safeText(event.detail).trim()
  const idempotencyKey = safeText(event.idempotencyKey).trim() || makeIdempotencyKey('order_message', orderId, eventType, title, detail)
  const existingMessage = await db.collection('order_messages').where({ idempotencyKey }).limit(1).get()
  if (existingMessage.data[0]) return existingMessage.data[0]
  const thread = await getOrCreateOrderMessageThread({ ...order, _id: orderId })
  if (!thread || !thread._id) return null
  const time = event.createdAt || now()
  const actorRole = event.actorRole || ''
  const forceUnreadTypes = new Set(['paid', 'expired', 'refund_processing', 'refund_result', 'assigned', 'started', 'completed', 'early_start_requested', 'remote_unlock_requested'])
  const unreadForClient = event.unreadForClient !== undefined ? event.unreadForClient === true : (actorRole !== 'client' || forceUnreadTypes.has(eventType))
  const message = {
    threadId: thread._id,
    orderId,
    orderNo: order.orderNo || thread.orderNo || '',
    clientOpenid,
    clientUserId: order.clientUserId || thread.clientUserId || '',
    messageType: 'order_status',
    eventType,
    title,
    detail,
    actorRole,
    unreadForClient,
    idempotencyKey,
    createdAt: time
  }
  const created = await db.collection('order_messages').add({ data: message })
  const unreadCount = unreadForClient ? Number(thread.unreadCount || 0) + 1 : Number(thread.unreadCount || 0)
  await db.collection('order_message_threads').doc(thread._id).update({
    data: {
      orderNo: message.orderNo,
      orderTitle: buildOrderMessageTitle(order),
      petName: order.petName || thread.petName || '',
      serviceSummary: order.serviceSummary || thread.serviceSummary || '',
      orderStatus: order.status || thread.orderStatus || '',
      lastMessageId: created._id,
      lastMessageType: eventType,
      lastMessageTitle: title,
      lastMessageDetail: detail,
      lastMessageAt: time,
      lastActorRole: actorRole,
      unreadCount,
      hiddenForClient: false,
      updatedAt: time
    }
  })
  return { _id: created._id, ...message }
}

async function getOrCreateOrderStaffMessageThread(order = {}) {
  const orderId = order._id || order.orderId || ''
  const staffOpenid = safeText(order.staffOpenid).trim()
  if (!orderId || !staffOpenid) return null
  const existing = await db.collection('order_staff_message_threads').where({ orderId, staffOpenid }).limit(1).get()
  if (existing.data[0]) return existing.data[0]
  const time = now()
  const thread = {
    orderId,
    orderNo: order.orderNo || '',
    staffOpenid,
    staffUserId: order.staffUserId || '',
    recipientRole: 'staff',
    recipientOpenid: staffOpenid,
    threadType: 'order',
    orderTitle: buildOrderMessageTitle(order),
    petName: order.petName || '',
    serviceSummary: order.serviceSummary || '',
    orderStatus: order.status || '',
    lastMessageTitle: '',
    lastMessageDetail: '',
    lastMessageAt: time,
    lastMessageType: '',
    unreadCount: 0,
    readAt: null,
    createdAt: time,
    updatedAt: time
  }
  const created = await db.collection('order_staff_message_threads').add({ data: thread })
  return { _id: created._id, ...thread }
}

async function appendOrderStaffMessage(order = {}, event = {}) {
  const orderId = order._id || event.orderId || ''
  const staffOpenid = safeText(order.staffOpenid).trim()
  if (!orderId || !staffOpenid) return null
  const eventType = safeText(event.eventType).trim()
  const title = safeText(event.title).trim()
  if (!eventType || !title) return null
  const detail = safeText(event.detail).trim()
  const idempotencyKey = safeText(event.idempotencyKey).trim() || makeIdempotencyKey('order_staff_message', orderId, eventType, title, detail)
  const existingMessage = await db.collection('order_staff_messages').where({ idempotencyKey }).limit(1).get()
  if (existingMessage.data[0]) return existingMessage.data[0]
  const thread = await getOrCreateOrderStaffMessageThread({ ...order, _id: orderId })
  if (!thread || !thread._id) return null
  const time = event.createdAt || now()
  const actorRole = event.actorRole || ''
  const unreadForStaff = event.unreadForStaff !== undefined ? event.unreadForStaff === true : true
  const message = {
    threadId: thread._id,
    orderId,
    orderNo: order.orderNo || thread.orderNo || '',
    staffOpenid,
    staffUserId: order.staffUserId || thread.staffUserId || '',
    recipientRole: 'staff',
    recipientOpenid: staffOpenid,
    messageType: 'order_status',
    eventType,
    title,
    detail,
    actorRole,
    unreadForStaff,
    idempotencyKey,
    createdAt: time
  }
  const created = await db.collection('order_staff_messages').add({ data: message })
  const unreadCount = unreadForStaff ? Number(thread.unreadCount || 0) + 1 : Number(thread.unreadCount || 0)
  await db.collection('order_staff_message_threads').doc(thread._id).update({
    data: {
      orderNo: message.orderNo,
      orderTitle: buildOrderMessageTitle(order),
      petName: order.petName || thread.petName || '',
      serviceSummary: order.serviceSummary || thread.serviceSummary || '',
      orderStatus: order.status || thread.orderStatus || '',
      lastMessageId: created._id,
      lastMessageType: eventType,
      lastMessageTitle: title,
      lastMessageDetail: detail,
      lastMessageAt: time,
      lastActorRole: actorRole,
      unreadCount,
      hiddenForStaff: false,
      updatedAt: time
    }
  })
  return { _id: created._id, ...message }
}

function makeIdempotencyKey(...parts) {
  return parts.map((part) => safeText(part).trim()).filter(Boolean).join(':')
}

function getClientRequestId(data = {}) {
  return safeText(data.clientRequestId || data.idempotencyKey).trim()
}

async function findByClientRequestId(collectionName, scope) {
  const clientRequestId = safeText(scope.clientRequestId).trim()
  if (!clientRequestId) return null
  const where = { clientRequestId }
  if (scope.openid) where.openid = scope.openid
  if (scope.orderId) where.orderId = scope.orderId
  if (scope.staffOpenid) where.staffOpenid = scope.staffOpenid
  const res = await db.collection(collectionName).where(where).limit(1).get()
  return res.data[0] || null
}

async function appendPaymentEvent(eventType, payload = {}) {
  await db.collection('payment_events').add({
    data: {
      eventType,
      orderId: payload.orderId || '',
      paymentNo: payload.paymentNo || '',
      refundNo: payload.refundNo || '',
      status: payload.status || '',
      detail: payload.detail || {},
      raw: payload.raw || {},
      createdAt: now()
    }
  })
}

async function appendFinanceLog(action, payload = {}) {
  await db.collection('finance_logs').add({
    data: {
      action,
      targetType: payload.targetType || '',
      targetId: payload.targetId || '',
      orderId: payload.orderId || '',
      staffOpenid: payload.staffOpenid || '',
      amountDelta: Number(payload.amountDelta || 0),
      detail: payload.detail || {},
      createdAt: now()
    }
  })
}

function buildSubscriptionPage(order = {}, role = 'client') {
  const orderId = order && order._id || ''
  if (!orderId) return role === 'staff' ? 'pages/staff/home/index' : 'pages/client/home/index'
  if (role === 'staff') {
    return `pages/staff/orders/service/index?id=${orderId}`
  }
  return isMallOrder(order) ? `pages/client/mall/orders/detail/index?id=${orderId}` : `pages/client/orders/detail/index?id=${orderId}`
}

function getClockText(value) {
  const text = safeText(value).trim()
  const matched = text.match(/(?:^|\s|T)(\d{1,2}:\d{2})/)
  if (matched) return matched[1]
  return beijingClockText(value)
}

function buildSubscriptionData(templateKey, order = {}, detail = {}) {
  const serviceName = isMallOrder(order) ? buildMallOrderTitle(order) : (order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养') || '宠护服务')
  const orderNo = order.orderNo || order._id || ''
  const statusText = safeText(detail.statusText || templateKey)
  if (templateKey === 'orderAccepted') {
    return {
      character_string1: { value: safeText(orderNo).slice(0, 32) },
      thing2: { value: safeText(detail.orderDemand || serviceName).slice(0, 20) },
      name3: { value: safeText(detail.staffName || order.staffName || order.requestedStaffName || '宠托师').slice(0, 10) },
      thing4: { value: safeText(detail.serviceArea || order.serviceAddress || '服务地址').slice(0, 20) },
      time17: { value: safeText(detail.serviceTime || getClockText(order.startTime) || beijingClockText()).slice(0, 20) }
    }
  }
  if (templateKey === 'remoteUnlock') {
    return {
      thing1: { value: safeText(detail.deviceName || '入户门锁').slice(0, 20) },
      character_string2: { value: safeText(orderNo).slice(0, 32) },
      time3: { value: safeText(detail.requestTime || nowText()).slice(0, 20) }
    }
  }
  if (templateKey === 'upcomingServiceReminder') {
    return {
      thing9: { value: safeText(detail.tip || '订单即将开始，请前往服务').slice(0, 20) },
      thing4: { value: '即将开始' },
      character_string5: { value: safeText(orderNo).slice(0, 32) },
      thing10: { value: safeText(serviceName).slice(0, 20) },
      date3: { value: safeText(detail.startTimeText || order.startTime || nowText()).slice(0, 20) }
    }
  }
  return {
    thing9: { value: safeText(detail.tip || '订单状态已更新').slice(0, 20) },
    thing4: { value: statusText.slice(0, 20) },
    character_string5: { value: safeText(orderNo).slice(0, 32) },
    thing10: { value: safeText(serviceName).slice(0, 20) },
    date3: { value: safeText(order.startTime || nowText()).slice(0, 20) }
  }
}

async function recordSubscriptionLog(log) {
  await db.collection('subscription_logs').add({
    data: {
      openid: log.openid || '',
      templateKey: log.templateKey || '',
      templateId: log.templateId || '',
      orderId: log.orderId || '',
      status: log.status || 'skipped',
      page: log.page || '',
      data: log.data || {},
      error: log.error || '',
      createdAt: now()
    }
  })
}

async function sendSubscribeMessage(openid, templateKey, page, messageData = {}, orderId = '') {
  if (!openid || !templateKey) return { status: 'skipped', error: 'missing_recipient_or_template_key' }
  try {
    const settings = await getSystemSettings()
    let templateId = settings.subscription.templates[templateKey] || ''
    if (!templateId && templateKey === 'upcomingServiceReminder') {
      templateId = settings.subscription.templates.serviceStart || ''
    }
    console.log('[subscription] send prepare', { openid, templateKey, templateId, enabled: settings.subscription.enabled, orderId, page, data: messageData })
    if (!settings.subscription.enabled || !templateId) {
      const result = { status: 'skipped', error: !settings.subscription.enabled ? 'subscription_disabled' : 'template_not_configured', templateKey, templateId }
      console.log('[subscription] send skipped', { openid, templateKey, templateId, orderId, result })
      await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, status: result.status, error: result.error })
      return result
    }
    if (!cloud.openapi || !cloud.openapi.subscribeMessage || typeof cloud.openapi.subscribeMessage.send !== 'function') {
      const result = { status: 'skipped', error: 'openapi_unavailable', templateKey, templateId }
      console.log('[subscription] send skipped', { openid, templateKey, templateId, orderId, result })
      await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, status: result.status, error: result.error })
      return result
    }
    await cloud.openapi.subscribeMessage.send({ touser: openid, templateId, page, data: messageData })
    console.log('[subscription] send success', { openid, templateKey, templateId, orderId })
    await recordSubscriptionLog({ openid, templateKey, templateId, orderId, page, data: messageData, status: 'sent' })
    return { status: 'sent', error: '', templateKey, templateId }
  } catch (error) {
    const message = error && (error.message || error.errMsg) || String(error)
    console.error('[subscription] send failed', { openid, templateKey, orderId, error: message })
    await recordSubscriptionLog({ openid, templateKey, orderId, page, data: messageData, status: 'failed', error: message })
    return { status: 'failed', error: message, templateKey }
  }
}

function notifyOrder(openid, templateKey, order, detail = {}, role = '') {
  const targetRole = role || (order && order.staffOpenid && openid === order.staffOpenid ? 'staff' : 'client')
  return sendSubscribeMessage(openid, templateKey, buildSubscriptionPage(order, targetRole), buildSubscriptionData(templateKey, order, detail), order && order._id)
}

function notifyOrderAccepted(order, staffName = '') {
  const detail = {
    staffName: staffName || order.staffName || order.requestedStaffName || '宠托师',
    orderDemand: order.serviceSummary || '宠护服务',
    serviceArea: order.serviceAddress || order.city || '服务地址',
    serviceTime: getClockText(order.startTime)
  }
  console.log('[orderAccepted] prepare notify', {
    orderId: order && order._id,
    orderNo: order && order.orderNo,
    clientOpenid: order && order.clientOpenid,
    templateKey: 'orderAccepted',
    detail
  })
  return notifyOrder(order.clientOpenid, 'orderAccepted', order, detail)
    .then((result) => {
      console.log('[orderAccepted] notify result', {
        orderId: order && order._id,
        orderNo: order && order.orderNo,
        result
      })
      return result
    })
    .catch((error) => {
      console.error('[orderAccepted] notify error', {
        orderId: order && order._id,
        orderNo: order && order.orderNo,
        message: error && (error.message || error.errMsg) || String(error)
      })
      throw error
    })
}

async function sendUpcomingServiceRemindersToStaff(currentTime = now()) {
  const currentTs = toTimeValue(currentTime)
  if (!currentTs) return []
  const [assignedRes, dayCompletedRes] = await Promise.all([
    db.collection('orders').where({ status: ORDER_STATUS.ASSIGNED }).get(),
    db.collection('orders').where({ status: ORDER_STATUS.DAY_COMPLETED }).get()
  ])
  const candidates = [...(assignedRes.data || []), ...(dayCompletedRes.data || [])]
  const remindedOrders = []

  for (const order of candidates) {
    if (!order.staffOpenid) continue
    const activeSession = getActiveServiceSession(order)
    const nextSession = getNextPendingServiceSession(order)
    const targetSession = activeSession || nextSession || (Array.isArray(order.serviceSessions) && order.serviceSessions[0]) || { index: 1, startTime: order.startTime }
    const sessionIndex = Number(targetSession.index || 1)
    const sessionStartTime = toTimeValue((targetSession && targetSession.startTime) || order.startTime)
    if (!sessionStartTime) continue

    const diff = sessionStartTime - currentTs
    // 任务开始前 1 小时内（0 <= diff <= 3600000），或到达开始时间但在30分钟内尚未开始（-1800000 <= diff <= 0）
    if (diff > 60 * 60 * 1000 || diff < -30 * 60 * 1000) continue

    const remindedSessions = Array.isArray(order.staffUpcomingRemindedSessions) ? order.staffUpcomingRemindedSessions : []
    if (remindedSessions.includes(sessionIndex)) continue
    if (order.staffUpcomingRemindedAt && sessionIndex === 1 && toTimeValue(order.staffUpcomingRemindedAt) >= sessionStartTime - 2 * 3600 * 1000) {
      continue
    }

    const serviceName = order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养') || '宠护服务'
    const address = order.serviceAddress || order.city || '服务地址'
    const timeText = (targetSession && targetSession.startTime) || order.startTime || formatDateTime(sessionStartTime)

    // 发送订阅消息（指定角色为 staff，跳转服务执行页面）
    const notifyRes = await notifyOrder(order.staffOpenid, 'upcomingServiceReminder', order, {
      statusText: '即将开始',
      tip: '订单即将开始，请前往服务',
      startTimeText: timeText,
      serviceAddress: address
    }, 'staff')

    // 写入宠托师站内消息
    const messageDetail = `您的订单（${serviceName}）约定于 ${timeText} 开始，距当前已不足 1 小时。请提前规划行程并前往服务地点：${address}。到达后请按要求完成打卡。`
    await appendOrderStaffMessage(order, {
      eventType: 'upcoming_service_reminder',
      title: '订单即将开始，请前往服务',
      detail: messageDetail,
      actorRole: 'system',
      idempotencyKey: makeIdempotencyKey('order_staff_message', order._id, 'upcoming_service_reminder', String(sessionIndex))
    })

    // 写入订单时间线
    await appendOrderTimeline(order._id, 'upcoming_service_reminder', '即将开始服务提醒已发送', `第${sessionIndex}天服务即将在 1 小时内开始，系统已提醒宠托师前往服务。`, 'system')

    // 更新订单防重字段
    const newRemindedSessions = Array.from(new Set([...remindedSessions, sessionIndex]))
    const time = currentTime instanceof Date ? currentTime : new Date(currentTime)
    await db.collection('orders').doc(order._id).update({
      data: {
        staffUpcomingRemindedSessions: newRemindedSessions,
        staffUpcomingRemindedAt: time,
        updatedAt: time
      }
    })

    remindedOrders.push({
      orderId: order._id,
      sessionIndex,
      staffOpenid: order.staffOpenid,
      notifyResult: notifyRes
    })
  }

  return remindedOrders
}

function calculateAvailableAt(completedAt, delayDays) {
  const base = parseDateValue(completedAt) || now()
  return new Date(base.getTime() + Math.max(Number(delayDays || 0), 0) * 86400000)
}

async function ensureStaffEarning(order, completedAt = now()) {
  if (!order || !order._id || !order.staffOpenid) return null
  const existing = await db.collection('staff_earnings').where({ orderId: order._id }).limit(1).get()
  if (existing.data[0]) return existing.data[0]
  const settings = await getSystemSettings()
  const rate = Number(settings.settlement.staffCommissionRate || 0.7)
  const grossAmount = Number(order.payAmount || 0)
  const earningAmount = Math.round(grossAmount * rate * 100) / 100
  const time = now()
  const earning = {
    orderId: order._id,
    orderNo: order.orderNo || '',
    staffOpenid: order.staffOpenid || '',
    staffUserId: order.staffUserId || '',
    staffProfileId: order.staffProfileId || '',
    clientOpenid: order.clientOpenid || '',
    grossAmount,
    commissionRate: rate,
    amount: earningAmount,
    status: settings.settlement.settlementDelayDays > 0 ? 'pending' : 'available',
    availableAt: calculateAvailableAt(completedAt, settings.settlement.settlementDelayDays),
    withdrawRequestId: '',
    frozenReason: '',
    createdAt: time,
    updatedAt: time
  }
  const created = await db.collection('staff_earnings').add({ data: earning })
  await appendFinanceLog('staff_earning_created', { targetType: 'staff_earning', targetId: created._id, orderId: order._id, staffOpenid: order.staffOpenid, amountDelta: earningAmount, detail: { commissionRate: rate } })
  return { _id: created._id, ...earning }
}

async function refreshStaffEarnings(openid = '') {
  const query = openid ? { staffOpenid: openid, status: 'pending' } : { status: 'pending' }
  const res = await db.collection('staff_earnings').where(query).get()
  const time = now()
  for (const earning of res.data || []) {
    const availableAt = parseDateValue(earning.availableAt)
    if (availableAt && availableAt.getTime() <= time.getTime()) {
      await db.collection('staff_earnings').doc(earning._id).update({ data: { status: 'available', updatedAt: time } })
      earning.status = 'available'
    }
  }
}

function summarizeStaffEarnings(earnings = []) {
  return earnings.reduce((summary, earning) => {
    const amount = Number(earning.amount || 0)
    summary.total += amount
    if (earning.status === 'pending') summary.pending += amount
    if (earning.status === 'available') summary.available += amount
    if (earning.status === 'withdrawing') summary.withdrawing += amount
    if (earning.status === 'withdrawn') summary.withdrawn += amount
    if (earning.status === 'frozen') summary.frozen += amount
    return summary
  }, { total: 0, pending: 0, available: 0, withdrawing: 0, withdrawn: 0, frozen: 0 })
}

async function evaluateCheckinCompletion(order, sessionStartedAt) {
  try {
    await requireSanitizationEvidence(order, sessionStartedAt)
  } catch (error) {
    return { isComplete: false, missing: ['隔离病菌/消毒打卡'] }
  }

  const checkins = await db.collection('checkin_logs').where({ orderId: order._id }).get()
  const eventSet = (checkins.data || []).filter((item) => {
    if (!hasCheckinPhoto(item)) return false
    if (item.eventType === 'sanitization') return isValidSanitization(item, order, sessionStartedAt)
    return !sessionStartedAt || toTimeValue(item.recordedAt || item.serverTime || item.createdAt) >= (sessionStartedAt - 60000)
  }).reduce((map, item) => ({ ...map, [item.eventType]: true }), {})

  const requirements = Array.isArray(order.checkinRequirements) && order.checkinRequirements.length
    ? order.checkinRequirements
    : (order.requiredCheckins || []).map((eventType) => ({ eventType, label: checkinEventText(eventType), required: true }))
  const missing = requirements.filter((item) => item.required && !eventSet[item.eventType]).map((item) => item.label || checkinEventText(item.eventType))

  const security = order.orderHomeSecurity || order.homeSecuritySnapshot || {}
  if (security.type === 'key' && security.key && security.key.returnRequired && !security.key.returnedAt) {
    missing.push('放回钥匙打卡')
  }

  return {
    isComplete: missing.length === 0,
    missing
  }
}

async function completeOrderService(order, activeSession, time = now(), options = {}) {
  const isAuto = options.isAuto === true
  const actor = options.actor || (isAuto ? 'system' : 'staff')
  const completedSessions = markServiceSession(normalizeServiceSessions(order), activeSession.index, { status: 'completed', finishedAt: time })
  const finalSession = isFinalServiceSession({ ...order, serviceSessions: completedSessions }, activeSession)
  const orderId = order._id

  if (!finalSession) {
    const dayUpdateData = {
      status: ORDER_STATUS.DAY_COMPLETED,
      serviceSessions: completedSessions,
      activeSessionIndex: 0,
      activeSessionDate: '',
      currentSessionStartedAt: '',
      lastCompletedSessionIndex: activeSession.index,
      updatedAt: time
    }
    if (isAuto) dayUpdateData.autoCompleted = true
    await updateOrderWhenStatus(orderId, ORDER_STATUS.IN_SERVICE, dayUpdateData, '订单状态不可完成当天服务')
    const dayCompletedOrder = { ...order, _id: orderId, status: ORDER_STATUS.DAY_COMPLETED, serviceSessions: completedSessions, autoCompleted: isAuto, updatedAt: time }
    await appendOrderTimeline(orderId, isAuto ? 'system_auto_day_completed' : 'day_completed', isAuto ? `系统自动完成第${activeSession.index}天服务` : `第${activeSession.index}天服务已完成`, isAuto ? '检测到打卡凭证齐全且已超时，系统已自动完成今日服务。' : '', actor)
    await appendOrderClientMessage(dayCompletedOrder, {
      eventType: 'day_completed',
      title: `第${activeSession.index}天服务已完成`,
      detail: isAuto ? '今日服务打卡已齐全，系统已确认今日服务完成。' : '今日服务已完成，下一次服务需重新开始履约。',
      actorRole: actor
    })
    if (isAuto && order.staffOpenid) {
      await appendOrderStaffMessage(dayCompletedOrder, {
        eventType: 'system_auto_day_completed',
        title: '今日服务已自动完成',
        detail: `检测到您的第${activeSession.index}天服务打卡已齐全，由于未手动结束，系统已自动帮您确认今日服务完成。`,
        actorRole: 'system',
        idempotencyKey: makeIdempotencyKey('order_staff_message', orderId, 'system_auto_day_completed', String(activeSession.index || 1))
      })
    }
    await notifyOrder(order.clientOpenid, 'serviceFinish', order, { statusText: '当天已完成', tip: isAuto ? '今日服务打卡齐全，系统已确认完成' : '今日服务已完成' }, 'client')
    return { id: orderId, status: ORDER_STATUS.DAY_COMPLETED, activeSessionIndex: 0, autoCompleted: isAuto }
  }

  const updateData = {
    status: ORDER_STATUS.COMPLETED,
    serviceSessions: completedSessions,
    activeSessionIndex: 0,
    activeSessionDate: '',
    currentSessionStartedAt: '',
    lastCompletedSessionIndex: activeSession.index,
    completedAt: time,
    updatedAt: time
  }
  if (isAuto) updateData.autoCompleted = true

  await updateOrderWhenStatus(orderId, ORDER_STATUS.IN_SERVICE, updateData, '订单状态不可完成')
  const completedOrder = { ...order, _id: orderId, status: ORDER_STATUS.COMPLETED, serviceSessions: completedSessions, completedAt: time, updatedAt: time }

  const timelineTitle = isAuto ? '系统智能完成服务' : '服务已完成'
  const timelineDesc = isAuto ? '检测到宠托师已完成全套离户打卡凭证，因超时未手动结束，系统已自动帮宠托师确认完成服务并结算。' : ''
  await appendOrderTimeline(orderId, isAuto ? 'system_auto_completed' : 'completed', timelineTitle, timelineDesc, actor)

  await appendOrderClientMessage(completedOrder, {
    eventType: 'completed',
    title: '服务已完成',
    detail: '服务已完成，可查看服务报告或评价',
    actorRole: actor
  })
  if (isAuto && order.staffOpenid) {
    const serviceName = order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养') || '宠护服务'
    await appendOrderStaffMessage(completedOrder, {
      eventType: 'system_auto_completed',
      title: '系统已自动完成服务并结算',
      detail: `检测到您的订单（${serviceName}）打卡凭证已齐全，由于超时未手动点击结束，系统已自动帮您完成服务并结算收益。下次服务请注意及时点击【完成服务】。`,
      actorRole: 'system',
      idempotencyKey: makeIdempotencyKey('order_staff_message', orderId, 'system_auto_completed')
    })
    await notifyOrder(order.staffOpenid, 'serviceFinish', order, { statusText: '已自动结算完成', tip: '订单已自动完成，收益已结算' }, 'staff')
  }
  await notifyOrder(order.clientOpenid, 'serviceFinish', order, { statusText: '已完成', tip: isAuto ? '服务打卡齐全，系统已确认完成，可查看服务报告' : '服务已完成，可查看服务报告' }, 'client')

  await ensureStaffEarning({ ...order, _id: orderId }, time)
  const pointsDelta = Math.max(Math.floor(Number(order.payAmount || 0) / 10), 1)
  await addPoints(order.clientOpenid, order.clientUserId, pointsDelta, 'order_complete', orderId, `完成订单 +${pointsDelta} 积分`, { applyMultiplier: true, baseDelta: pointsDelta })
  const clientUser = await getUser(order.clientOpenid)
  const completedOrderCount = Number(clientUser.completedOrderCount || 0) + 1
  await db.collection('users').doc(clientUser._id).update({ data: { completedOrderCount, updatedAt: time } })
  if (order.staffProfileId) {
    try {
      const staffProfile = normalizeStaffWorkflow((await db.collection('staff_profiles').doc(order.staffProfileId).get()).data)
      if (staffProfile && staffProfile.staffLevel === 'intern') {
        const internOrders = await getCompletedStaffOrders(order.staffOpenid || '')
        await db.collection('staff_profiles').doc(staffProfile._id).update({ data: { internCompletedOrderCount: internOrders.length, updatedAt: time } })
      }
    } catch (error) {}
  }
  if (completedOrderCount % 3 === 0) {
    await grantRetroCards(order.clientOpenid, clientUser._id, 1, 'order_complete_milestone', orderId, '完成 3 次订单奖励补签卡 +1')
  }
  return { id: orderId, status: ORDER_STATUS.COMPLETED, completedOrderCount, autoCompleted: isAuto }
}

async function processOverdueUnstartedOrders(currentTime = now()) {
  const currentTs = toTimeValue(currentTime)
  if (!currentTs) return []
  const [assignedRes, dayCompletedRes] = await Promise.all([
    db.collection('orders').where({ status: ORDER_STATUS.ASSIGNED }).get(),
    db.collection('orders').where({ status: ORDER_STATUS.DAY_COMPLETED }).get()
  ])
  const candidates = [...(assignedRes.data || []), ...(dayCompletedRes.data || [])]
  const processed = []

  for (const order of candidates) {
    if (!order.staffOpenid) continue
    const activeSession = getActiveServiceSession(order)
    const nextSession = getNextPendingServiceSession(order)
    const targetSession = activeSession || nextSession || (Array.isArray(order.serviceSessions) && order.serviceSessions[0]) || { index: 1, startTime: order.startTime }
    const sessionIndex = Number(targetSession.index || 1)
    const sessionStartTime = toTimeValue((targetSession && targetSession.startTime) || order.startTime)
    if (!sessionStartTime) continue

    const overdueMs = currentTs - sessionStartTime
    if (overdueMs < 15 * 60 * 1000) continue

    const serviceName = order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养') || '宠护服务'
    const timeText = (targetSession && targetSession.startTime) || order.startTime || formatDateTime(sessionStartTime)
    const remindedSessions = Array.isArray(order.staffOverdueStartRemindedSessions) ? order.staffOverdueStartRemindedSessions : []
    const clientAlertedSessions = Array.isArray(order.clientOverdueStartAlertedSessions) ? order.clientOverdueStartAlertedSessions : []
    const updates = {}

    // 阶段 1：超时 15 分钟未开始 -> 催促宠托师尽快履约
    if (overdueMs >= 15 * 60 * 1000 && !remindedSessions.includes(sessionIndex)) {
      await notifyOrder(order.staffOpenid, 'serviceStart', order, {
        statusText: '服务已超时未开始',
        tip: `约定于 ${timeText} 开始，已超时 15 分钟，请尽快打卡开始`
      }, 'staff')

      await appendOrderStaffMessage(order, {
        eventType: 'overdue_unstarted_warning',
        title: '服务已超时未开始提醒',
        detail: `您的订单（${serviceName}）约定于 ${timeText} 开始，现已超时超过 15 分钟尚未开始服务。请尽快到达服务地点并打卡开始，以免产生爽约客诉或违约处罚。`,
        actorRole: 'system',
        idempotencyKey: makeIdempotencyKey('order_staff_message', order._id, 'overdue_unstarted_warning', String(sessionIndex))
      })

      await appendOrderTimeline(order._id, 'overdue_unstarted_warning', '服务超时未开始催促', `第${sessionIndex}天服务已超时 15 分钟尚未开始，系统已提醒催促宠托师尽快到场履约。`, 'system')

      updates.staffOverdueStartRemindedSessions = [...remindedSessions, sessionIndex]
    }

    // 阶段 2：超时 30 分钟未开始 -> 提醒宠物主并标记异常预警
    if (overdueMs >= 30 * 60 * 1000 && !clientAlertedSessions.includes(sessionIndex)) {
      await notifyOrder(order.clientOpenid, 'serviceStart', order, {
        statusText: '服务未按时开始',
        tip: '宠托师尚未开始服务，平台已介入催促跟进'
      }, 'client')

      await appendOrderClientMessage(order, {
        eventType: 'overdue_unstarted_client_notice',
        title: '服务未按时开始提醒',
        detail: `您预约于 ${timeText} 的服务（${serviceName}）已超时 30 分钟尚未开始。系统已多次催促宠托师，您可在订单页面联系宠托师或在线客服协助处理。`,
        actorRole: 'system',
        unreadForClient: true
      })

      await appendOrderTimeline(order._id, 'overdue_unstarted_alert', '服务严重超时异常预警', `服务已超时 30 分钟仍未开始，系统已提醒宠物主并触发异常跟进。`, 'system')

      updates.clientOverdueStartAlertedSessions = [...clientAlertedSessions, sessionIndex]
      updates.isStartOverdue = true
    }

    if (Object.keys(updates).length > 0) {
      const time = currentTime instanceof Date ? currentTime : new Date(currentTime)
      updates.updatedAt = time
      await db.collection('orders').doc(order._id).update({ data: updates })
      processed.push({ orderId: order._id, sessionIndex, updates })
    }
  }

  return processed
}

async function processOverdueUnfinishedOrders(currentTime = now()) {
  const currentTs = toTimeValue(currentTime)
  if (!currentTs) return []
  const res = await db.collection('orders').where({ status: ORDER_STATUS.IN_SERVICE }).get()
  const orders = res.data || []
  const processed = []

  for (const order of orders) {
    const activeSession = getActiveServiceSession(order) || normalizeServiceSessions(order)[0] || { index: 1 }
    const sessionStartedAt = toTimeValue(order.currentSessionStartedAt || (activeSession && activeSession.startedAt) || order.startedAt)
    const sessionEndTime = toTimeValue((activeSession && activeSession.endTime) || order.endTime)
    const durationMs = (Math.max(Number(order.durationMinutes || 60), 30)) * 60 * 1000
    const estimatedEndTime = sessionEndTime || (sessionStartedAt ? sessionStartedAt + durationMs : 0)
    if (!estimatedEndTime) continue

    const overdueMs = currentTs - estimatedEndTime
    if (overdueMs < 15 * 60 * 1000) continue

    const serviceName = order.serviceSummary || (order.serviceType === 'walk' ? '上门遛狗' : '上门喂养') || '宠护服务'
    const checkinResult = await evaluateCheckinCompletion({ ...order, _id: order._id }, sessionStartedAt || currentTs)

    // 情况 1：打卡凭证齐全，超时 30 分钟未结束 -> 智能自动完成服务并结算
    if (overdueMs >= 30 * 60 * 1000 && checkinResult.isComplete && !order.autoCompleted) {
      const time = currentTime instanceof Date ? currentTime : new Date(currentTime)
      const completeRes = await completeOrderService({ ...order, _id: order._id }, activeSession, time, { isAuto: true, actor: 'system' })
      processed.push({ orderId: order._id, type: 'auto_completed', result: completeRes })
      continue
    }

    // 情况 2：严重超时 60 分钟且打卡缺失 -> 自动创建异常工单介入跟进
    if (overdueMs >= 60 * 60 * 1000 && !checkinResult.isComplete && !order.finishOverdueIncidentCreated) {
      const time = currentTime instanceof Date ? currentTime : new Date(currentTime)
      await appendOrderTimeline(order._id, 'finish_overdue_incident', '服务严重超时未结束告警', `服务已超时 60 分钟且打卡凭证缺失（${checkinResult.missing.join('、')}），系统已转平台客服紧急跟进。`, 'system')
      await appendOrderClientMessage(order, {
        eventType: 'service_finish_overdue_notice',
        title: '服务进行中超时提醒',
        detail: `您的订单（${serviceName}）已超出预计服务时间，平台客服已介入跟进宠托师现场服务进展，确保宠物与家庭安全。`,
        actorRole: 'system',
        unreadForClient: true
      })

      if (order.staffOpenid) {
        await appendOrderStaffMessage(order, {
          eventType: 'finish_overdue_incident',
          title: '服务严重超时警报',
          detail: `您的订单（${serviceName}）已超出预计结束时间 60 分钟以上，且仍缺少打卡凭证（${checkinResult.missing.join('、')}）。平台已生成客服异常工单跟进，请立即核实打卡或联系客服！`,
          actorRole: 'system',
          idempotencyKey: makeIdempotencyKey('order_staff_message', order._id, 'finish_overdue_incident', String(activeSession.index || 1))
        })
      }

      await db.collection('order_incidents').add({
        data: {
          orderId: order._id,
          orderNo: order.orderNo || '',
          clientOpenid: order.clientOpenid,
          staffOpenid: order.staffOpenid,
          type: 'service_finish_overdue',
          title: '服务严重超时未结束且缺少打卡',
          detail: `订单已超出预计结束时间 60 分钟以上，仍缺少必要打卡：${checkinResult.missing.join('、')}，请平台客服紧急联系宠托师与客户核实情况。`,
          status: 'open',
          createdAt: time,
          updatedAt: time
        }
      })

      await db.collection('orders').doc(order._id).update({
        data: {
          finishOverdueIncidentCreated: true,
          overdueFinishReminded: true,
          overdueFinishRemindedAt: time,
          isFinishOverdue: true,
          updatedAt: time
        }
      })
      processed.push({ orderId: order._id, type: 'incident_created' })
      continue
    }

    // 情况 3：超时 15 分钟未结束 -> 发送催促提醒
    if (overdueMs >= 15 * 60 * 1000 && !order.overdueFinishReminded) {
      const time = currentTime instanceof Date ? currentTime : new Date(currentTime)
      if (checkinResult.isComplete) {
        await appendOrderStaffMessage(order, {
          eventType: 'overdue_finish_reminder',
          title: '请及时确认完成服务',
          detail: `您的订单（${serviceName}）已超出约定服务时间，检测到打卡凭证已齐全。请及时在服务页点击【完成服务】进行结算。若超出 30 分钟仍未操作，系统将自动帮您结算完成。`,
          actorRole: 'system',
          idempotencyKey: makeIdempotencyKey('order_staff_message', order._id, 'overdue_finish_reminder', String(activeSession.index || 1))
        })
        await notifyOrder(order.staffOpenid, 'serviceFinish', order, {
          statusText: '请及时完成服务',
          tip: '订单打卡已齐全，请及时点击完成服务进行结算'
        }, 'staff')
      } else {
        await appendOrderStaffMessage(order, {
          eventType: 'overdue_finish_reminder',
          title: '服务超时未结束提醒',
          detail: `您的订单（${serviceName}）已超出预计服务时间，且尚缺少打卡凭证（${checkinResult.missing.join('、')}）。请确认服务进度并及时补全打卡与点击完成服务。`,
          actorRole: 'system',
          idempotencyKey: makeIdempotencyKey('order_staff_message', order._id, 'overdue_finish_reminder', String(activeSession.index || 1))
        })
      }

      await appendOrderTimeline(order._id, 'overdue_finish_reminder', '服务超时未结束催促', checkinResult.isComplete ? '打卡已齐全，系统已提醒宠托师尽快点击完成服务。' : `服务已超时，尚缺少打卡（${checkinResult.missing.join('、')}），已提醒宠托师。`, 'system')

      await db.collection('orders').doc(order._id).update({
        data: {
          overdueFinishReminded: true,
          overdueFinishRemindedAt: time,
          updatedAt: time
        }
      })
      processed.push({ orderId: order._id, type: 'reminded', checkinComplete: checkinResult.isComplete })
      continue
    }
  }

  return processed
}

function buildDateRange(data = {}) {
  const startText = safeText(data.startDate).trim()
  const endText = safeText(data.endDate).trim()
  const start = startText ? parseDateValue(`${startText} 00:00:00`) : null
  const end = endText ? parseDateValue(`${endText} 23:59:59`) : null
  return { start, end, startDate: startText, endDate: endText }
}

async function getAllDocuments(collectionName, orderByField = 'createdAt', orderDirection = 'desc') {
  const limit = 100
  let allData = []
  let hasMore = true
  let lastDoc = null

  while (hasMore) {
    let query = db.collection(collectionName)
    if (orderByField) {
      query = query.orderBy(orderByField, orderDirection)
    }
    query = query.limit(limit)
    if (lastDoc) {
      query = query.startAfter(lastDoc[orderByField])
    }

    const res = await query.get()
    const data = res.data || []
    allData = allData.concat(data)

    if (data.length < limit) {
      hasMore = false
    } else {
      lastDoc = data[data.length - 1]
    }
  }

  return allData
}

function inDateRange(item, range, fields = ['createdAt']) {
  if (!range.start && !range.end) return true
  const date = fields.map((field) => parseDateValue(item[field])).find(Boolean)
  if (!date) return false
  if (range.start && date < range.start) return false
  if (range.end && date > range.end) return false
  return true
}

function sumAmount(list = [], field = 'amount') {
  return Math.round(list.reduce((sum, item) => sum + Number(item[field] || 0), 0) * 100) / 100
}

function statusCount(list = []) {
  return list.reduce((acc, item) => {
    const status = item.status || 'unknown'
    acc[status] = (acc[status] || 0) + 1
    return acc
  }, {})
}

function limitList(list = [], size = 50) {
  const pageSize = Math.min(Math.max(Number(size || 50), 1), 100)
  return list.slice(0, pageSize)
}

function paginateList(list = [], data = {}) {
  const page = Math.max(Number(data.page || 1), 1)
  const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 100)
  const total = list.length
  const start = (page - 1) * pageSize
  return {
    list: list.slice(start, start + pageSize),
    total,
    page,
    pageSize,
    hasMore: start + pageSize < total
  }
}

function messageTimeValue(thread = {}) {
  const source = thread.lastMessageAt || thread.updatedAt || thread.createdAt
  const time = source instanceof Date ? source.getTime() : new Date(source || 0).getTime()
  return Number.isFinite(time) ? time : 0
}

function sortMessageThreads(list = []) {
  return list.slice().sort((a, b) => {
    const unreadDiff = (Number(b.unreadCount || 0) > 0) - (Number(a.unreadCount || 0) > 0)
    if (unreadDiff !== 0) return unreadDiff
    return messageTimeValue(b) - messageTimeValue(a)
  })
}

function buildFinanceDashboardData({ orders = [], payments = [], refunds = [], earnings = [], withdraws = [], logs = [] }, range) {
  const paidOrders = orders.filter((order) => isPaidOrder(order) && inDateRange(order, range, ['paidAt', 'createdAt']))
  const paidPayments = payments.filter((payment) => payment.status === 'paid' && inDateRange(payment, range, ['paidAt', 'updatedAt', 'createdAt']))
  const refundList = refunds.filter((refund) => inDateRange(refund, range, ['createdAt', 'updatedAt']))
  const earningList = earnings.filter((earning) => inDateRange(earning, range, ['createdAt', 'completedAt']))
  const withdrawList = withdraws.filter((withdraw) => inDateRange(withdraw, range, ['createdAt', 'paidAt']))
  const logList = logs.filter((log) => inDateRange(log, range, ['createdAt']))
  const gmv = sumAmount(paidOrders, 'payAmount')
  const received = paidPayments.length ? sumAmount(paidPayments, 'amount') : gmv
  const refundAmount = sumAmount(refundList, 'amount')
  const staffEarningAmount = sumAmount(earningList, 'amount')
  return {
    range: { startDate: range.startDate, endDate: range.endDate },
    metrics: {
      gmv,
      received,
      refundAmount,
      netRevenue: Math.round((received - refundAmount) * 100) / 100,
      staffEarningAmount,
      platformGrossProfit: Math.round((received - refundAmount - staffEarningAmount) * 100) / 100,
      pendingWithdrawAmount: sumAmount(withdrawList.filter((item) => item.status === 'pending'), 'amount'),
      withdrawingAmount: sumAmount(withdrawList.filter((item) => item.status === 'approved'), 'amount'),
      paidWithdrawAmount: sumAmount(withdrawList.filter((item) => item.status === 'paid'), 'amount')
    },
    counts: {
      paidOrders: paidOrders.length,
      payments: paidPayments.length,
      refunds: refundList.length,
      earnings: earningList.length,
      withdraws: withdrawList.length,
      logs: logList.length,
      withdrawStatus: statusCount(withdrawList),
      earningStatus: statusCount(earningList),
      refundStatus: statusCount(refundList)
    },
    recentLogs: limitList(logList.sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt)), 10)
  }
}

function normalizeIncidentStatus(value, fallback = 'open') {
  const status = safeText(value).trim()
  const allowed = ['open', 'triaging', 'waiting_client', 'waiting_staff', 'processing', 'refund_pending', 'resolved', 'rejected', 'closed']
  return allowed.includes(status) ? status : fallback
}

function normalizeIncidentType(value, fallback = 'complaint') {
  const type = safeText(value).trim()
  return ['sos', 'complaint', 'service_issue', 'refund_dispute', 'safety'].includes(type) ? type : fallback
}

async function recordIncidentAction(incidentId, action, actorRole, actorOpenid, detail = {}) {
  const time = now()
  await db.collection('incident_actions').add({ data: { incidentId, action, actorRole, actorOpenid, detail, createdAt: time } })
}

async function getIncidentForAccess(openid, incidentId) {
  const user = await getUser(openid)
  const incident = (await db.collection('order_incidents').doc(incidentId).get()).data
  if (!incident) throw new Error('纠纷不存在')
  if (user.roles.includes('admin') || incident.clientOpenid === openid || incident.staffOpenid === openid) return { user, incident }
  throw new Error('无权访问纠纷')
}

async function appendIncidentComment(incidentId, actorRole, actorOpenid, content, mediaFileIds = []) {
  const text = safeText(content).trim()
  const files = Array.isArray(mediaFileIds) ? mediaFileIds.filter(Boolean).slice(0, 9) : []
  if (!text && !files.length) throw new Error('请填写留言或上传证据')
  if (text) {
    await checkTextSecurity(actorOpenid, text, { scene: 2, label: '留言内容' })
  }
  const time = now()
  const comment = { incidentId, actorRole, actorOpenid, content: text, mediaFileIds: files, createdAt: time }
  const created = await db.collection('incident_comments').add({ data: comment })
  return { _id: created._id, ...comment }
}

async function freezeOrderEarnings(orderId, incidentId, time = now()) {
  const res = await db.collection('staff_earnings').where({ orderId }).get()
  const frozen = []
  for (const earning of res.data || []) {
    if (!['pending', 'available'].includes(earning.status)) continue
    await db.collection('staff_earnings').doc(earning._id).update({ data: { status: 'frozen', frozenIncidentId: incidentId, frozenFromStatus: earning.status, updatedAt: time } })
    frozen.push(earning._id)
  }
  if (frozen.length) await appendFinanceLog('staff_earning_frozen', { targetType: 'incident', targetId: incidentId, amountDelta: 0, detail: { orderId, earningIds: frozen } })
  return frozen
}

function releasedEarningStatus(earning, time = now()) {
  if (earning.frozenFromStatus && earning.frozenFromStatus !== 'frozen') return earning.frozenFromStatus
  const availableAt = parseDateValue(earning.availableAt)
  return availableAt && availableAt.getTime() > time.getTime() ? 'pending' : 'available'
}

async function finalizeIncidentEarnings(incident, decision, deductAmount = 0, remark = '') {
  const earningIds = Array.isArray(incident.frozenEarningIds) ? incident.frozenEarningIds : []
  if (!earningIds.length) return { decision: '', earningIds: [], deductedAmount: 0 }
  const time = now()
  const normalizedDecision = ['release', 'deduct', 'keep_frozen'].includes(decision) ? decision : ''
  if (!normalizedDecision) return { decision: '', earningIds, deductedAmount: 0 }

  let remainingDeduct = normalizedDecision === 'deduct' ? Math.max(Number(deductAmount || 0), 0) : 0
  const frozenEarnings = []
  for (const id of earningIds) {
    try {
      const earning = (await db.collection('staff_earnings').doc(id).get()).data
      if (earning && earning.status === 'frozen') frozenEarnings.push(earning)
    } catch (error) {}
  }
  if (normalizedDecision === 'deduct' && remainingDeduct <= 0) remainingDeduct = frozenEarnings.reduce((sum, earning) => sum + Number(earning.amount || 0), 0)

  const updated = []
  let deductedAmount = 0
  for (const earning of frozenEarnings) {
    const amount = Number(earning.amount || 0)
    let update = { updatedAt: time }
    if (normalizedDecision === 'release') {
      update = { ...update, status: releasedEarningStatus(earning, time), frozenIncidentId: '', frozenFromStatus: '', frozenResolvedAt: time, frozenResolveRemark: remark }
    } else if (normalizedDecision === 'keep_frozen') {
      update = { ...update, frozenResolveRemark: remark }
    } else {
      const currentDeduct = Math.min(amount, remainingDeduct)
      remainingDeduct = Math.max(remainingDeduct - currentDeduct, 0)
      deductedAmount += currentDeduct
      const leftAmount = Math.round((amount - currentDeduct) * 100) / 100
      update = {
        ...update,
        amount: leftAmount,
        deductedAmount: Math.round((Number(earning.deductedAmount || 0) + currentDeduct) * 100) / 100,
        status: leftAmount > 0 ? releasedEarningStatus(earning, time) : 'deducted',
        frozenIncidentId: '',
        frozenFromStatus: '',
        frozenResolvedAt: time,
        frozenResolveRemark: remark
      }
    }
    await db.collection('staff_earnings').doc(earning._id).update({ data: update })
    updated.push(earning._id)
  }
  deductedAmount = Math.round(deductedAmount * 100) / 100
  await appendFinanceLog(`staff_earning_${normalizedDecision}`, { targetType: 'incident', targetId: incident._id, orderId: incident.orderId, amountDelta: normalizedDecision === 'deduct' ? -deductedAmount : 0, detail: { earningIds: updated, deductedAmount, remark } })
  return { decision: normalizedDecision, earningIds: updated, deductedAmount }
}

async function saveUserAddress(openid, user, data) {
  if (!data.serviceAddress) throw new Error('请选择服务地址')
  if (!data.addressDetail) throw new Error('请填写详细地址')
  if (!data.doorplate) throw new Error('请填写门牌号或入户说明')
  const time = now()
  const existingAddresses = await db.collection('user_addresses').where({ openid }).get()
  const isNewAddress = !data.id
  const shouldBeDefault = data.isDefault === true || (isNewAddress && existingAddresses.data.length === 0)
  const payload = {
    userId: user._id,
    openid,
    label: data.label || '常用地址',
    contactName: data.contactName || '',
    contactPhone: data.contactPhone || '',
    serviceAddress: data.serviceAddress || '',
    addressDetail: data.addressDetail || '',
    doorplate: data.doorplate || '',
    latitude: Number(data.latitude || data.addressLatitude || 0),
    longitude: Number(data.longitude || data.addressLongitude || 0),
    isDefault: shouldBeDefault,
    updatedAt: time
  }
  if (payload.isDefault) {
    await Promise.all(existingAddresses.data.map((item) => db.collection('user_addresses').doc(item._id).update({ data: { isDefault: false, updatedAt: time } })))
  }
  if (data.id) {
    const existing = await db.collection('user_addresses').doc(data.id).get()
    if (existing.data.openid !== openid) throw new Error('无权操作地址')
    await db.collection('user_addresses').doc(data.id).update({ data: payload })
    return { _id: data.id, ...existing.data, ...payload }
  }
  const created = await db.collection('user_addresses').add({ data: { ...payload, createdAt: time } })
  return { _id: created._id, ...payload, createdAt: time }
}

async function getReviewStats(staffProfileId) {
  const res = await db.collection('service_reviews').where({ staffProfileId, status: 'visible' }).get()
  const reviews = res.data || []
  const reviewCount = reviews.length
  const ratingAverage = reviewCount ? Number((reviews.reduce((sum, item) => sum + Number(item.rating || 0), 0) / reviewCount).toFixed(1)) : 0
  const recentReviews = reviews
    .slice()
    .sort((a, b) => toTimeValue(b.createdAt) - toTimeValue(a.createdAt))
    .slice(0, 5)
    .map((item) => ({
      _id: item._id,
      rating: item.rating,
      tags: item.tags || [],
      content: item.content || '',
      clientName: maskClientName(item.clientName),
      clientAvatarUrl: safeFileId(item.clientAvatarUrl) || safeText(item.clientAvatarUrl),
      memberLevelName: safeText(item.memberLevelName).trim() || '普通会员',
      badgeTag: safeText(item.badgeTag).trim() || 'V1',
      badgeStyle: safeText(item.badgeStyle).trim() || 'gold',
      nameColor: safeText(item.nameColor).trim(),
      nameEffect: safeText(item.nameEffect).trim(),
      createdAt: item.createdAt
    }))
  return { ratingAverage, reviewCount, recentReviews }
}

async function updateStaffRatingStats(staffProfileId, time = now()) {
  if (!staffProfileId) return { ratingAverage: 0, reviewCount: 0 }
  const stats = await getReviewStats(staffProfileId)
  await db.collection('staff_profiles').doc(staffProfileId).update({
    data: {
      ratingAverage: stats.ratingAverage,
      reviewCount: stats.reviewCount,
      ratingUpdatedAt: time,
      updatedAt: time
    }
  })
  return stats
}

async function isFavoriteSitter(openid, staffProfileId) {
  const res = await db.collection('sitter_favorites').where({ openid, staffProfileId }).limit(1).get()
  return Boolean(res.data[0])
}

async function toPublicSitterDetail(openid, profile) {
  const base = toPublicSitter(profile)
  const reviewStats = await getReviewStats(profile._id)
  return {
    ...base,
    level: profile.level || (base.isIntern ? 'intern' : 'normal'),
    levelName: profile.levelName || base.staffLevelText,
    serviceRadiusKm: base.serviceRadiusKm,
    publicTags: Array.isArray(profile.publicTags) && profile.publicTags.length ? profile.publicTags : base.publicTags,
    favorite: openid ? await isFavoriteSitter(openid, profile._id) : false,
    ...reviewStats
  }
}

function getCancelQuoteForOrder(order) {
  if (order.status === 'pending_pay') return { canCancel: true, refundAmount: 0, refundStatus: 'not_required', ruleText: '待支付订单可直接取消' }
  if (order.status === 'paid') return { canCancel: true, refundAmount: Number(order.payAmount || 0), refundStatus: 'processing', ruleText: '已支付未接单订单可全额退款' }
  if (order.status === 'expired') return { canCancel: true, refundAmount: Number(order.payAmount || 0), refundStatus: 'processing', ruleText: '过期未接单订单可全额退款' }
  if (order.status === 'assigned') {
    const start = new Date(String(order.startTime || '').replace(/-/g, '/')).getTime()
    const hoursBeforeStart = start ? (start - now().getTime()) / 36e5 : 0

    // 【新增】指定订单免责取消机制
    // 如果是指定订单（direct模式），检查是否在免责取消时间窗口内（接单后2小时）
    const isDirectOrder = order.publishMode === 'direct' || order.assignmentSource === 'direct_accept'
    if (isDirectOrder && order.assignedAt) {
      const hoursAfterAccept = (now().getTime() - new Date(order.assignedAt).getTime()) / 36e5
      const freeGracePeriodHours = 2 // 免责取消时间窗口：2小时

      if (hoursAfterAccept <= freeGracePeriodHours) {
        // 在免责时间窗口内，指定订单可免费取消
        return {
          canCancel: true,
          refundAmount: Number(order.payAmount || 0),
          refundStatus: 'processing',
          ruleText: `指定订单接单后${freeGracePeriodHours}小时内可免责取消并全额退款`,
          isFreeGracePeriod: true
        }
      }
    }

    // 普通取消规则
    const rate = hoursBeforeStart >= 24 ? 1 : 0.8
    return {
      canCancel: true,
      refundAmount: Math.round(Number(order.payAmount || 0) * rate),
      refundStatus: 'processing',
      ruleText: hoursBeforeStart >= 24 ? '距服务开始超过24小时，可全额退款' : '距服务开始不足24小时，可退80%',
      needsNegotiation: isDirectOrder && hoursBeforeStart < 24 // 指定订单超时取消需要协商
    }
  }
  return { canCancel: false, refundAmount: 0, refundStatus: 'pending_manual', ruleText: '服务中或已完成订单需申请平台介入' }
}

function createPaymentNo() {
  return `P${Date.now()}${Math.floor(Math.random() * 1000)}`
}

function createRefundNo() {
  return `R${Date.now()}${Math.floor(Math.random() * 1000)}`
}

function normalizePem(value) {
  return safeText(value).trim().replace(/\\n/g, '\n')
}

function randomNonce(length = 32) {
  return crypto.randomBytes(length).toString('hex').slice(0, length)
}

function amountYuanToFen(amount) {
  const normalized = Math.round(Number(amount || 0) * 100)
  if (!Number.isFinite(normalized) || normalized <= 0) throw new Error('支付金额不正确')
  return normalized
}

function isProductionPaymentEnv() {
  return process.env.NODE_ENV === 'production' || process.env.PAYMENT_ENV === 'production'
}

function assertPaymentModeAllowed(payment) {
  if (isProductionPaymentEnv() && payment.mode === 'mock') throw new Error('正式环境禁止使用模拟支付')
}

function getWechatPayConfig(settings) {
  const payment = settings.payment || {}
  const config = {
    appId: safeText(process.env.WECHAT_PAY_APP_ID || payment.appId).trim(),
    mchId: safeText(process.env.WECHAT_PAY_MCH_ID || payment.mchId).trim(),
    notifyUrl: safeText(process.env.WECHAT_PAY_NOTIFY_URL || payment.notifyUrl).trim(),
    certSerialNo: safeText(process.env.WECHAT_PAY_CERT_SERIAL_NO || payment.certSerialNo || payment.merchantCertSerialNo).trim(),
    apiV3Key: safeText(process.env.WECHAT_PAY_API_V3_KEY || payment.apiV3Key).trim(),
    privateKey: normalizePem(process.env.WECHAT_PAY_PRIVATE_KEY || payment.privateKey),
    platformPublicKey: normalizePem(process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY || payment.platformPublicKey),
    refundEnabled: payment.refundEnabled !== false
  }
  if (!config.appId || !config.mchId || !config.notifyUrl || !config.certSerialNo || !config.apiV3Key || !config.privateKey) throw new Error('微信支付配置未完成')
  if (!/^https:\/\//i.test(config.notifyUrl)) throw new Error('微信支付回调地址必须是 HTTPS')
  return config
}

function sanitizeWechatPayload(payload = {}) {
  const clone = JSON.parse(JSON.stringify(payload || {}))
  delete clone.apiV3Key
  delete clone.privateKey
  delete clone.privateKeyInput
  delete clone.platformPublicKey
  delete clone.platformPublicKeyInput
  if (clone.payer && clone.payer.openid) clone.payer = { openid: 'configured' }
  if (clone.resource && clone.resource.ciphertext) clone.resource = { ...clone.resource, ciphertext: '[encrypted]' }
  return clone
}

function wechatPayRequest(method, path, body, config) {
  if (!isProductionPaymentEnv() && process.env.WECHAT_PAY_MOCK_PREPAY_ID && path.includes('/v3/pay/transactions/jsapi')) return Promise.resolve({ prepay_id: process.env.WECHAT_PAY_MOCK_PREPAY_ID })
  if (!isProductionPaymentEnv() && process.env.WECHAT_PAY_MOCK_REFUND_ID && path.includes('/v3/refund/domestic/refunds')) return Promise.resolve({ refund_id: process.env.WECHAT_PAY_MOCK_REFUND_ID, status: process.env.WECHAT_PAY_MOCK_REFUND_STATUS || 'PROCESSING' })

  return new Promise((resolve, reject) => {
    const bodyText = body ? JSON.stringify(body) : ''
    const timestamp = String(Math.floor(Date.now() / 1000))
    const nonce = randomNonce()
    const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyText}\n`
    const signature = crypto.createSign('RSA-SHA256').update(message).sign(config.privateKey, 'base64')
    const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.certSerialNo}"`
    const req = https.request({
      hostname: 'api.mch.weixin.qq.com',
      port: 443,
      path,
      method,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyText)
      }
    }, (res) => {
      let raw = ''
      res.on('data', (chunk) => { raw += chunk })
      res.on('end', () => {
        let json = {}
        try { json = raw ? JSON.parse(raw) : {} } catch (error) { return reject(new Error('微信支付响应解析失败')) }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json)
        reject(new Error(json.message || json.code || '微信支付请求失败'))
      })
    })
    req.on('error', reject)
    if (bodyText) req.write(bodyText)
    req.end()
  })
}

function buildMiniProgramPayParams(prepayId, config) {
  const timeStamp = String(Math.floor(Date.now() / 1000))
  const nonceStr = randomNonce()
  const pkg = `prepay_id=${prepayId}`
  const message = `${config.appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`
  const paySign = crypto.createSign('RSA-SHA256').update(message).sign(config.privateKey, 'base64')
  return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign }
}

function getHeader(headers = {}, name) {
  const foundKey = Object.keys(headers || {}).find((key) => key.toLowerCase() === name.toLowerCase())
  return foundKey ? headers[foundKey] : ''
}

function verifyWechatPayCallback(headers, rawBody, config) {
  if (process.env.WECHAT_PAY_SKIP_VERIFY === 'true') {
    if (isProductionPaymentEnv()) throw new Error('正式环境禁止跳过微信支付验签')
    return true
  }
  if (!config.platformPublicKey) throw new Error('微信支付平台公钥未配置')
  const timestamp = getHeader(headers, 'wechatpay-timestamp')
  const nonce = getHeader(headers, 'wechatpay-nonce')
  const signature = getHeader(headers, 'wechatpay-signature')
  if (!timestamp || !nonce || !signature) throw new Error('微信支付回调签名头缺失')
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300) throw new Error('微信支付回调已过期')
  const message = `${timestamp}\n${nonce}\n${rawBody}\n`
  const ok = crypto.createVerify('RSA-SHA256').update(message).verify(config.platformPublicKey, signature, 'base64')
  if (!ok) throw new Error('微信支付回调验签失败')
  return true
}

function decryptWechatPayResource(resource = {}, apiV3Key = '') {
  if (!isProductionPaymentEnv() && process.env.WECHAT_PAY_MOCK_CALLBACK_RESOURCE) return JSON.parse(process.env.WECHAT_PAY_MOCK_CALLBACK_RESOURCE)
  const ciphertext = Buffer.from(resource.ciphertext || '', 'base64')
  if (ciphertext.length <= 16) throw new Error('微信支付回调密文无效')
  const authTag = ciphertext.slice(ciphertext.length - 16)
  const encrypted = ciphertext.slice(0, ciphertext.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), resource.nonce || '')
  decipher.setAuthTag(authTag)
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'))
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
  return JSON.parse(decrypted)
}

function mapWechatTradeState(state) {
  if (state === 'SUCCESS') return 'success'
  if (state === 'CLOSED' || state === 'REVOKED' || state === 'PAYERROR') return 'failed'
  return 'pending'
}

function mapWechatRefundStatus(status) {
  if (status === 'SUCCESS') return 'success'
  if (status === 'ABNORMAL' || status === 'CLOSED') return 'failed'
  return 'processing'
}

function validatePaymentCallbackPayload(payload, order, payment, config) {
  if (safeText(payload.mchid).trim() !== config.mchId) throw new Error('微信支付商户号不匹配')
  if (safeText(payload.appid).trim() !== config.appId) throw new Error('微信支付 AppID 不匹配')
  if (safeText(payload.out_trade_no).trim() !== payment.paymentNo) throw new Error('微信支付单号不匹配')
  if (payload.trade_state === 'SUCCESS' && !payload.transaction_id) throw new Error('微信交易号缺失')
  const paidFen = Number(payload.amount && payload.amount.total)
  if (paidFen !== amountYuanToFen(order.payAmount)) throw new Error('微信支付金额不匹配')
}

async function getDocOrNull(collectionName, id) {
  if (!id) return null
  try {
    const res = await db.collection(collectionName).doc(id).get()
    return res.data ? { _id: id, ...res.data } : null
  } catch (error) {
    return null
  }
}

function createMallOrderNo() {
  return `M${Date.now()}${Math.floor(Math.random() * 1000)}`
}

function normalizeMallCategory(category = {}) {
  return {
    _id: category._id || '',
    name: safeText(category.name).trim(),
    icon: safeText(category.icon).trim(),
    enabled: category.enabled !== false,
    sortOrder: Number(category.sortOrder || 0),
    createdAt: category.createdAt || null,
    updatedAt: category.updatedAt || null
  }
}

function createMallSkuId(index = 0) {
  return `sku_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 7)}`
}

function normalizeMallSpecGroups(groups = []) {
  const merged = new Map()
  ;(Array.isArray(groups) ? groups : []).forEach((group) => {
    const name = safeText(group && group.name).trim()
    const values = group && Array.isArray(group.values) ? group.values.map((item) => safeText(item).trim()).filter(Boolean) : []
    if (!name || !values.length) return
    merged.set(name, Array.from(new Set((merged.get(name) || []).concat(values))))
  })
  return Array.from(merged, ([name, values]) => ({ name, values }))
}

// Validate new input before historical normalization can discard invalid data.
function validateMallProductInput(data) {
  const validateNumbers = (item) => {
    for (const field of ['price', 'originalPrice', 'stock']) {
      const raw = item[field] == null && field === 'originalPrice' ? 0 : item[field]
      const value = Number(raw)
      if (!['number', 'string'].includes(typeof raw) || String(raw).trim() === '' || !Number.isFinite(value) || value < 0 || (field === 'price' && value <= 0) || (field === 'stock' && !Number.isSafeInteger(value)) || (field !== 'stock' && Math.abs(value * 100 - Math.round(value * 100)) > 1e-7)) {
        throw new Error(field === 'stock' ? '库存必须为非负整数' : (field === 'price' ? '售价必须大于0' : '金额必须为非负数且最多两位小数'))
      }
    }
  }
  if (data.specMode !== 'multi') { validateNumbers(data); return }
  const groups = data.specGroups
  if (!Array.isArray(groups) || !groups.length || groups.length > 3) throw new Error('请填写1至3个属性')
  const names = new Set()
  groups.forEach((group) => {
    const name = safeText(group && group.name).trim()
    if (!name || names.has(name)) throw new Error('属性名称不能为空或重复')
    names.add(name)
    if (!Array.isArray(group.values) || !group.values.length || group.values.length > 20) throw new Error('每个属性须有1至20个值')
    const values = group.values.map((value) => safeText(value).trim())
    if (values.some((value) => !value) || new Set(values).size !== values.length) throw new Error('属性值不能为空或重复')
  })
  if (!Array.isArray(data.skus) || !data.skus.length || data.skus.length > 80) throw new Error('请同步1至80个SKU')
  const ids = new Set()
  const combinations = new Set()
  data.skus.forEach((sku) => {
    const id = safeText(sku.skuId).trim()
    if (!id || ids.has(id)) throw new Error('SKU ID不能为空或重复')
    ids.add(id)
    const specs = sku.specs
    if (!specs || Array.isArray(specs) || Object.keys(specs).length !== groups.length || groups.some((group) => {
      const name = safeText(group.name).trim()
      return !Object.prototype.hasOwnProperty.call(specs, name) || !group.values.map((value) => safeText(value).trim()).includes(safeText(specs[name]).trim())
    })) throw new Error('属性与SKU不一致，请重新同步SKU')
    const key = JSON.stringify(Array.from(names).sort().map((name) => [name, safeText(specs[name]).trim()]))
    if (combinations.has(key)) throw new Error('SKU组合不能重复')
    combinations.add(key)
    validateNumbers(sku)
  })
}

function normalizeMallSku(raw = {}, index = 0, specGroups = []) {
  const specs = raw.specs && typeof raw.specs === 'object' ? raw.specs : {}
  const normalizedSpecs = {}
  specGroups.forEach((group) => {
    const value = safeText(specs[group.name]).trim()
    if (value) normalizedSpecs[group.name] = value
  })
  const specText = safeText(raw.specText).trim() || Object.values(normalizedSpecs).join(' / ') || '默认规格'
  return {
    skuId: safeText(raw.skuId || raw.id).trim() || (index === 0 ? 'default' : createMallSkuId(index)),
    specs: normalizedSpecs,
    specText,
    price: Math.max(Number(raw.price || 0), 0),
    originalPrice: Math.max(Number(raw.originalPrice || 0), 0),
    stock: Math.max(Math.floor(Number(raw.stock || 0)), 0),
    salesCount: Math.max(Math.floor(Number(raw.salesCount || 0)), 0),
    imageFileId: safeFileId(raw.imageFileId) || safeText(raw.imageFileId).trim(),
    status: raw.status === 'off_sale' ? 'off_sale' : 'on_sale'
  }
}

function normalizeMallSkus(product = {}, specGroups = []) {
  const rawSkus = Array.isArray(product.skus) ? product.skus : []
  const sourceSkus = product.specMode === 'multi' ? rawSkus : [{ skuId: rawSkus.length === 1 ? rawSkus[0].skuId || 'default' : 'default', specs: {}, specText: product.specText || '默认规格', price: product.price, originalPrice: product.originalPrice, stock: product.stock, salesCount: product.salesCount, status: rawSkus.length === 1 ? rawSkus[0].status : 'on_sale' }]
  return sourceSkus.map((sku, index) => normalizeMallSku(sku, index, specGroups))
}

function deriveMallProductFields(product = {}) {
  const skus = normalizeMallSkus(product, product.specGroups || [])
  const activeSkus = skus.filter((sku) => sku.status !== 'off_sale')
  const priceSkus = activeSkus.length ? activeSkus : skus
  const prices = priceSkus.map((sku) => Number(sku.price || 0)).filter((price) => Number.isFinite(price) && price >= 0)
  const minPrice = prices.length ? Math.min(...prices) : Math.max(Number(product.price || 0), 0)
  const maxPrice = prices.length ? Math.max(...prices) : minPrice
  const totalStock = activeSkus.reduce((sum, sku) => sum + Number(sku.stock || 0), 0)
  const salesCount = skus.reduce((sum, sku) => sum + Number(sku.salesCount || 0), 0) || Math.max(Math.floor(Number(product.salesCount || 0)), 0)
  const firstSku = priceSkus[0] || skus[0] || {}
  return { skus, minPrice, maxPrice, totalStock, price: minPrice, originalPrice: Number(firstSku.originalPrice == null ? product.originalPrice || 0 : firstSku.originalPrice), stock: totalStock, salesCount, specText: firstSku.specText || product.specText || '默认规格' }
}

function normalizeMallProduct(product = {}) {
  const specGroups = normalizeMallSpecGroups(product.specGroups)
  const specMode = product.specMode === 'multi' && specGroups.length ? 'multi' : 'single'
  const imageFileIds = Array.isArray(product.imageFileIds) ? product.imageFileIds.map((item) => safeFileId(item) || safeText(item).trim()).filter(Boolean).slice(0, 9) : []
  const base = {
    _id: product._id || '',
    categoryId: safeText(product.categoryId).trim(),
    name: safeText(product.name).trim(),
    subtitle: safeText(product.subtitle).trim(),
    coverFileId: safeFileId(product.coverFileId) || safeText(product.coverFileId).trim(),
    imageFileIds,
    specMode,
    specGroups: specMode === 'multi' ? specGroups : [],
    status: product.status === 'off_sale' ? 'off_sale' : 'on_sale',
    description: safeText(product.description).trim(),
    sortOrder: Number(product.sortOrder || 0),
    createdAt: product.createdAt || null,
    updatedAt: product.updatedAt || null
  }
  const derived = deriveMallProductFields({ ...product, specGroups: base.specGroups })
  return { ...base, ...derived }
}

function getProductSkus(product = {}) {
  return normalizeMallProduct(product).skus
}

function getSkuById(product = {}, skuId = '') {
  const skus = getProductSkus(product)
  const targetSkuId = safeText(skuId).trim()
  const sku = targetSkuId ? skus.find((item) => item.skuId === targetSkuId) : (product.specMode !== 'multi' ? skus[0] : null)
  if (!sku) return null
  if (product.specMode === 'multi') {
    const groups = normalizeMallSpecGroups(product.specGroups)
    if (!groups.length || groups.some((group) => !group.values.includes(sku.specs[group.name]))) return null
    if (skus.filter((item) => item.skuId === sku.skuId).length !== 1) return null
  }
  return sku
}

function formatMallPrice(product = {}) {
  const minPrice = Number(product.minPrice || product.price || 0)
  const maxPrice = Number(product.maxPrice || minPrice)
  return minPrice === maxPrice ? `¥${minPrice}` : `¥${minPrice}-${maxPrice}`
}

function publicMallProduct(product = {}) {
  const p = normalizeMallProduct(product)
  const selectedSku = p.skus.find((sku) => sku.status !== 'off_sale' && sku.stock > 0) || p.skus[0] || null
  return {
    ...p,
    skuCount: p.skus.length,
    hasSku: p.skus.length > 1 || p.specMode === 'multi',
    selectedSkuId: selectedSku ? selectedSku.skuId : '',
    soldOut: p.stock <= 0,
    displayPrice: formatMallPrice(p),
    priceText: formatMallPrice(p),
    imageFileIds: p.imageFileIds.length ? p.imageFileIds : (p.coverFileId ? [p.coverFileId] : [])
  }
}

function mallOrderStatusText(status) {
  const labels = { pending_pay: '待付款', pending_ship: '待发货', shipped: '已发货', completed: '已完成', cancelled: '已取消', refund_applied: '售后中', refunded: '已退款' }
  return labels[status] || '未知'
}

function normalizeShippingAddress(data = {}) {
  const contactName = safeText(data.contactName || data.name || data.receiverName).trim()
  const contactPhone = safeText(data.contactPhone || data.phone || data.receiverPhone).trim()
  const serviceAddress = safeText(data.serviceAddress || data.address || data.addressName).trim()
  const addressDetail = safeText(data.addressDetail || data.detail).trim()
  const doorplate = safeText(data.doorplate).trim()
  if (!contactName) throw new Error('请填写收货人')
  if (!contactPhone) throw new Error('请填写收货手机号')
  if (!serviceAddress) throw new Error('请选择收货地址')
  if (!addressDetail) throw new Error('请填写详细地址')
  return { contactName, contactPhone, serviceAddress, addressDetail, doorplate, fullAddress: [serviceAddress, addressDetail, doorplate].filter(Boolean).join(' ') }
}

function buildMallCartItem(product, sku, quantity, data = {}) {
  const time = now()
  return {
    productId: product._id,
    skuId: sku.skuId,
    quantity: Math.min(Math.max(Math.floor(Number(quantity || 1)), 1), 99),
    selected: data.selected !== false,
    snapshot: { name: product.name, coverFileId: sku.imageFileId || product.coverFileId || '', specText: sku.specText || '', price: Number(sku.price || 0), originalPrice: Number(sku.originalPrice || 0), specs: sku.specs || {}, imageFileId: sku.imageFileId || '' },
    updatedAt: data.updatedAt || time
  }
}

function isSameMallCartItem(a = {}, b = {}) {
  return a.productId === b.productId && safeText(a.skuId || 'default').trim() === safeText(b.skuId || 'default').trim()
}

async function loadMallCart(openid) {
  const res = await db.collection('mall_carts').where({ openid }).limit(1).get()
  return res.data[0] || null
}

async function saveMallCart(openid, items = []) {
  const time = now()
  const normalizedItems = items.filter((item) => item && item.productId && Number(item.quantity || 0) > 0).map((item) => ({ productId: item.productId, skuId: safeText(item.skuId || 'default').trim() || 'default', quantity: Math.min(Math.max(Math.floor(Number(item.quantity || 1)), 1), 99), selected: item.selected !== false, snapshot: item.snapshot || null, updatedAt: item.updatedAt || time }))
  const existing = await loadMallCart(openid)
  if (existing) {
    await db.collection('mall_carts').doc(existing._id).update({ data: { items: normalizedItems, updatedAt: time } })
    return { ...existing, items: normalizedItems, updatedAt: time }
  }
  const created = await db.collection('mall_carts').add({ data: { openid, items: normalizedItems, updatedAt: time } })
  return { _id: created._id, openid, items: normalizedItems, updatedAt: time }
}

async function formatMallCart(openid) {
  const cart = await loadMallCart(openid)
  const items = cart && Array.isArray(cart.items) ? cart.items : []
  const products = []
  for (const item of items) {
    const product = await getDocOrNull('mall_products', item.productId)
    const p = product ? publicMallProduct(product) : null
    const sku = product ? getSkuById(product, item.skuId) : null
    if (!sku) {
      products.push({ ...item, product: p || item.snapshot || {}, snapshot: item.snapshot || {}, invalid: true, soldOut: true, subtotal: 0 })
      continue
    }
    const invalid = p.status !== 'on_sale' || sku.status === 'off_sale'
    const soldOut = Number(sku.stock || 0) <= 0
    const quantity = Number(item.quantity || 0)
    const snapshot = item.snapshot || { name: p.name, coverFileId: sku.imageFileId || p.coverFileId || '', specText: sku.specText || '', price: Number(sku.price || 0), originalPrice: Number(sku.originalPrice || 0), specs: sku.specs || {}, imageFileId: sku.imageFileId || '' }
    products.push({ ...item, skuId: sku.skuId, sku, specText: sku.specText, specs: sku.specs || {}, price: Number(sku.price || 0), snapshot, product: p, invalid, soldOut, subtotal: Math.round(Number(sku.price || 0) * quantity * 100) / 100 })
  }
  const selectedItems = products.filter((item) => item.selected !== false && !item.invalid && !item.soldOut)
  const totalAmount = Math.round(selectedItems.reduce((sum, item) => sum + item.subtotal, 0) * 100) / 100
  return { items: products, selectedCount: selectedItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0), totalAmount }
}

function calcMallPricing(items, couponResult) {
  const totalProductAmount = Math.round(items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0) * 100) / 100
  const shippingFee = totalProductAmount >= 99 || totalProductAmount <= 0 ? 0 : 8
  const amount = Math.round((totalProductAmount + shippingFee) * 100) / 100
  const basePricing = { businessType: 'mall', amount, payAmount: amount, totalProductAmount, shippingFee, discountAmount: 0, currency: 'CNY', serviceTypes: ['mall'], priceItems: [{ key: 'mall_goods', label: '商品金额', price: totalProductAmount }, { key: 'shipping_fee', label: '运费', price: shippingFee }], priceSnapshot: { originalAmount: amount, totalProductAmount, shippingFee, discountAmount: 0, payAmount: amount } }
  return couponResult ? applyCouponToPricing(basePricing, couponResult) : basePricing
}

async function getPayableOrder(orderId) {
  const serviceOrder = await getDocOrNull('orders', orderId)
  if (serviceOrder) return { order: serviceOrder, collectionName: 'orders', orderType: 'service' }
  const mallOrder = await getDocOrNull('mall_orders', orderId)
  if (mallOrder) return { order: mallOrder, collectionName: 'mall_orders', orderType: 'mall' }
  return { order: null, collectionName: '', orderType: '' }
}

async function requireClientPayableOrder(openid, orderId, message = '无权操作该订单') {
  const user = await getUser(openid)
  const resolved = await getPayableOrder(orderId)
  if (!resolved.order || resolved.order.clientOpenid !== openid) throw new Error(message)
  return { user, ...resolved }
}

function buildMallOrderItemSnapshot(product, sku, quantity) {
  return { productId: product._id, skuId: sku.skuId, name: product.name, coverFileId: sku.imageFileId || product.coverFileId || '', price: Number(sku.price || 0), quantity, specText: sku.specText || '', specs: sku.specs || {}, skuSnapshot: { skuId: sku.skuId, specs: sku.specs || {}, specText: sku.specText || '', price: Number(sku.price || 0), originalPrice: Number(sku.originalPrice || 0), imageFileId: sku.imageFileId || '' } }
}

async function deductMallProductStock(item, time) {
  const quantity = Number(item.quantity || 0)
  const product = await getDocOrNull('mall_products', item.productId)
  if (!product || product.status !== 'on_sale') throw new Error(`商品已下架：${item.name}`)
  const normalized = normalizeMallProduct(product)
  const selected = getSkuById(normalized, item.skuId)
  const skus = normalized.skus.map((sku) => ({ ...sku, specs: { ...(sku.specs || {}) } }))
  const index = selected ? skus.findIndex((sku) => sku.skuId === selected.skuId) : -1
  const sku = skus[index]
  if (!sku || sku.status === 'off_sale') throw new Error(`商品已下架：${item.name}`)
  if (Number(sku.stock || 0) < quantity) throw new Error(`商品库存不足：${item.name}`)
  skus[index] = { ...sku, stock: Number(sku.stock || 0) - quantity, salesCount: Number(sku.salesCount || 0) + quantity }
  const singleFields = normalized.specMode === 'single' ? { stock: skus[index].stock, salesCount: skus[index].salesCount } : {}
  const nextProduct = normalizeMallProduct({ ...normalized, ...singleFields, skus, updatedAt: time })
  await db.collection('mall_products').doc(item.productId).update({ data: { skus: nextProduct.skus, price: nextProduct.price, originalPrice: nextProduct.originalPrice, stock: nextProduct.stock, totalStock: nextProduct.totalStock, minPrice: nextProduct.minPrice, maxPrice: nextProduct.maxPrice, salesCount: nextProduct.salesCount, specText: nextProduct.specText, updatedAt: time } })
}

async function markMallOrderPaid(orderId, order, paymentPayload = {}) {
  if (order.paymentStatus === 'paid') return { orderId, status: 'paid' }
  if (order.status !== 'pending_pay' && order.paymentStatus !== 'paying') throw new Error('订单状态不可支付')
  const time = now()
  for (const item of (order.items || [])) {
    const product = await getDocOrNull('mall_products', item.productId)
    if (!product || product.status !== 'on_sale') throw new Error(`商品已下架：${item.name}`)
    const sku = getSkuById(product, item.skuId)
    if (!sku || sku.status === 'off_sale') throw new Error(`商品已下架：${item.name}`)
    if (Number(sku.stock || 0) < Number(item.quantity || 0)) throw new Error(`商品库存不足：${item.name}`)
  }
  for (const item of (order.items || [])) await deductMallProductStock(item, time)
  const paymentNo = paymentPayload.paymentNo || createPaymentNo()
  const update = { paymentStatus: 'paid', status: 'pending_ship', paymentNo, wxTransactionId: paymentPayload.wxTransactionId || '', paidAt: time, updatedAt: time }
  await db.collection('mall_orders').doc(orderId).update({ data: update })
  if (order.couponId) await db.collection('user_coupons').doc(order.couponId).update({ data: { status: 'used', usedOrderId: orderId, usedAt: time, updatedAt: time } })
  const existing = await db.collection('payments').where({ orderId, paymentNo }).limit(1).get()
  if (existing.data[0]) await db.collection('payments').doc(existing.data[0]._id).update({ data: { status: 'success', channel: paymentPayload.channel || existing.data[0].channel || 'mock', wxTransactionId: update.wxTransactionId, rawCallback: paymentPayload.rawCallback || {}, paidAt: time, updatedAt: time } })
  else await db.collection('payments').add({ data: { orderId, orderNo: order.orderNo || '', openid: order.clientOpenid || '', paymentNo, prepayId: paymentPayload.prepayId || '', wxTransactionId: update.wxTransactionId, amount: Number(order.payAmount || 0), currency: 'CNY', status: 'success', channel: paymentPayload.channel || 'mock', idempotencyKey: makeIdempotencyKey('payment', orderId, paymentNo), rawCallback: paymentPayload.rawCallback || {}, paidAt: time, createdAt: time, updatedAt: time } })
  await appendPaymentEvent('paid', { orderId, paymentNo, status: 'success', detail: { amount: Number(order.payAmount || 0), channel: paymentPayload.channel || 'mock', orderType: 'mall' }, raw: paymentPayload.rawCallback || {} })
  await appendFinanceLog('mall_order_paid', { targetType: 'mall_order', targetId: orderId, orderId, amountDelta: Number(order.payAmount || 0), detail: { paymentNo } })
  return { orderId, status: 'paid', paymentNo }
}

async function ensurePaymentRecord(order, openid, channel = 'mock', clientRequestId = '') {
  if (clientRequestId) {
    const existingByRequest = await findByClientRequestId('payments', { orderId: order._id, openid, clientRequestId })
    if (existingByRequest) return existingByRequest
  }
  const existing = await db.collection('payments').where({ orderId: order._id, status: 'pending' }).limit(1).get()
  if (existing.data[0]) return existing.data[0]
  const time = now()
  const paymentNo = createPaymentNo()
  const payment = {
    orderId: order._id,
    orderNo: order.orderNo || '',
    openid,
    paymentNo,
    prepayId: '',
    wxTransactionId: '',
    amount: Number(order.payAmount || 0),
    currency: 'CNY',
    status: 'pending',
    channel,
    clientRequestId,
    idempotencyKey: clientRequestId || makeIdempotencyKey('payment', order._id, paymentNo),
    rawRequest: {},
    rawCallback: {},
    createdAt: time,
    updatedAt: time
  }
  const created = await db.collection('payments').add({ data: payment })
  await appendPaymentEvent('create', { orderId: order._id, paymentNo, status: 'pending', detail: { channel, amount: payment.amount } })
  return { _id: created._id, ...payment }
}

async function markOrderPaid(orderId, paymentPayload = {}) {
  const resolved = await getPayableOrder(orderId)
  const order = resolved.order
  if (!order) throw new Error('订单不存在')
  if (resolved.orderType === 'mall') return markMallOrderPaid(orderId, order, paymentPayload)
  if (order.paymentStatus === 'paid') return { orderId, status: 'paid' }
  assertOrderTransition(order.status, ORDER_STATUS.PAID, '订单状态不可支付')
  const time = now()
  const paymentNo = paymentPayload.paymentNo || createPaymentNo()
  const paymentUpdate = {
    paymentStatus: 'paid',
    status: 'paid',
    paymentNo,
    wxTransactionId: paymentPayload.wxTransactionId || '',
    paidAt: time,
    updatedAt: time
  }
  const existing = await db.collection('payments').where({ orderId, paymentNo }).limit(1).get()
  if (existing.data[0]) {
    await db.collection('payments').doc(existing.data[0]._id).update({
      data: {
        status: 'success',
        channel: paymentPayload.channel || existing.data[0].channel || 'mock',
        wxTransactionId: paymentUpdate.wxTransactionId,
        rawCallback: paymentPayload.rawCallback || {},
        paidAt: time,
        updatedAt: time
      }
    })
  } else {
    await db.collection('payments').add({
      data: {
        orderId,
        orderNo: order.orderNo || '',
        openid: order.clientOpenid || '',
        paymentNo,
        prepayId: paymentPayload.prepayId || '',
        wxTransactionId: paymentUpdate.wxTransactionId,
        amount: Number(order.payAmount || 0),
        currency: 'CNY',
        status: 'success',
        channel: paymentPayload.channel || 'mock',
        idempotencyKey: makeIdempotencyKey('payment', orderId, paymentNo),
        rawCallback: paymentPayload.rawCallback || {},
        paidAt: time,
        createdAt: time,
        updatedAt: time
      }
    })
  }
  await updateOrderWhenStatus(orderId, order.status, paymentUpdate, '订单状态不可支付')
  if (order.couponId) await db.collection('user_coupons').doc(order.couponId).update({ data: { status: 'used', usedOrderId: orderId, usedAt: time, updatedAt: time } })
  await appendPaymentEvent('paid', { orderId, paymentNo, status: 'success', detail: { amount: Number(order.payAmount || 0), channel: paymentPayload.channel || 'mock' }, raw: paymentPayload.rawCallback || {} })
  await appendFinanceLog('order_paid', { targetType: 'order', targetId: orderId, orderId, amountDelta: Number(order.payAmount || 0), detail: { paymentNo } })
  const paidOrder = { ...order, _id: orderId, ...paymentUpdate }
  await appendOrderTimeline(orderId, 'paid', '订单已支付', `支付金额 ¥${order.payAmount}`, 'client')
  await appendOrderClientMessage(paidOrder, { eventType: 'paid', title: '订单已支付', detail: `支付金额 ¥${order.payAmount}`, actorRole: 'system', unreadForClient: true })
  await notifyOrder(order.clientOpenid, 'orderPaid', { ...order, _id: orderId }, { amount: Number(order.payAmount || 0), statusText: '已支付' })
  if (paidOrder.publishMode === 'direct' && paidOrder.requestedStaffOpenid) {
    const notifyResult = await notifyOrderAccepted(paidOrder, paidOrder.requestedStaffName)
    await db.collection('orders').doc(orderId).update({ data: { acceptedNotifyStatus: notifyResult && notifyResult.status || 'skipped', acceptedNotifyError: notifyResult && notifyResult.error || '', updatedAt: time } })
  }
  return { orderId, status: 'paid', paymentNo }
}

async function markStaffDepositPaid(depositId, paymentPayload = {}) {
  const deposit = (await db.collection('staff_deposits').doc(depositId).get()).data
  if (!deposit) throw new Error('保证金记录不存在')
  if (deposit.status === 'paid') return { depositId, status: 'paid' }
  const time = now()
  const paymentNo = paymentPayload.paymentNo || createPaymentNo()
  const amount = Number(deposit.amount || 0)
  await db.collection('staff_deposits').doc(depositId).update({
    data: {
      paidAmount: amount,
      availableRefundAmount: amount,
      status: 'paid',
      statusText: '已缴纳',
      paymentNo,
      wxTransactionId: paymentPayload.wxTransactionId || '',
      paidAt: time,
      updatedAt: time
    }
  })
  const profileRes = await db.collection('staff_profiles').where({ openid: deposit.staffOpenid }).limit(1).get()
  if (profileRes.data && profileRes.data[0]) {
    await db.collection('staff_profiles').doc(profileRes.data[0]._id).update({
      data: {
        depositStatus: 'paid',
        depositRequired: true,
        updatedAt: time
      }
    })
  }
  await db.collection('staff_deposit_events').add({
    data: {
      depositId,
      staffOpenid: deposit.staffOpenid,
      staffUserId: deposit.staffUserId,
      type: 'pay',
      amount,
      reason: '缴纳宠托师入驻保证金',
      operatorOpenid: deposit.staffOpenid,
      operatorRole: 'staff',
      createdAt: time
    }
  })
  await appendFinanceLog('deposit_paid', {
    targetType: 'staff_deposit',
    targetId: depositId,
    staffOpenid: deposit.staffOpenid,
    amountDelta: amount,
    detail: { amount, paymentNo, channel: paymentPayload.channel || 'mock' }
  })
  const existingPayment = (await db.collection('payments').where({ orderId: depositId, targetType: 'staff_deposit' }).limit(1).get()).data[0]
  if (existingPayment) {
    await db.collection('payments').doc(existingPayment._id).update({
      data: {
        status: 'success',
        channel: paymentPayload.channel || existingPayment.channel || 'mock',
        wxTransactionId: paymentPayload.wxTransactionId || existingPayment.wxTransactionId || '',
        rawCallback: paymentPayload.rawCallback || {},
        paidAt: time,
        updatedAt: time
      }
    })
  }
  return { depositId, status: 'paid', paymentNo }
}

async function createRefundForOrder(order, refundAmount, reason, source, operatorOpenid, clientRequestId = '', options = {}) {
  if (clientRequestId) {
    const existingByRequest = await findByClientRequestId('refunds', { orderId: order._id, openid: order.clientOpenid || '', clientRequestId })
    if (existingByRequest) return existingByRequest
  }
  const existing = await db.collection('refunds').where({ orderId: order._id, status: 'processing' }).limit(1).get()
  if (existing.data[0]) return existing.data[0]
  const time = now()
  const refundNo = createRefundNo()
  const refund = {
    orderId: order._id,
    orderNo: order.orderNo || '',
    paymentNo: order.paymentNo || '',
    wxTransactionId: order.wxTransactionId || '',
    refundNo,
    wxRefundId: '',
    openid: order.clientOpenid || '',
    amount: Number(order.payAmount || 0),
    refundAmount: Number(refundAmount || 0),
    reason: reason || '',
    status: 'processing',
    source: source || 'client_cancel',
    operatorOpenid: operatorOpenid || '',
    clientRequestId,
    idempotencyKey: clientRequestId || makeIdempotencyKey('refund', order._id, refundNo),
    rawRequest: {},
    rawCallback: {},
    requestedAt: time,
    createdAt: time,
    updatedAt: time
  }
  const created = await db.collection('refunds').add({ data: refund })
  const createdRefund = { _id: created._id, ...refund }
  await appendPaymentEvent('refund_create', { orderId: order._id, refundNo, status: 'processing', detail: { refundAmount: refund.refundAmount, source } })

  const settings = await getSystemSettings({ includeSecrets: true })
  assertPaymentModeAllowed(settings.payment)
  if (settings.payment.mode === 'wechat' && settings.payment.refundEnabled !== false && (order.paymentNo || order.wxTransactionId)) {
    try {
      const config = getWechatPayConfig(settings)
      const requestBody = {
        out_trade_no: order.paymentNo || undefined,
        transaction_id: order.wxTransactionId || undefined,
        out_refund_no: refundNo,
        reason: safeText(reason).trim() || '订单退款',
        amount: { refund: amountYuanToFen(refund.refundAmount), total: amountYuanToFen(order.payAmount), currency: 'CNY' }
      }
      if (!requestBody.transaction_id) delete requestBody.transaction_id
      if (requestBody.transaction_id) delete requestBody.out_trade_no
      const response = await wechatPayRequest('POST', '/v3/refund/domestic/refunds', requestBody, config)
      const refundStatus = mapWechatRefundStatus(response.status)
      const update = { wxRefundId: response.refund_id || '', status: refundStatus, rawRequest: sanitizeWechatPayload(requestBody), rawResponse: sanitizeWechatPayload(response), updatedAt: now() }
      await db.collection('refunds').doc(created._id).update({ data: update })
      await appendPaymentEvent('refund_request', { orderId: order._id, refundNo, status: refundStatus, detail: { wxRefundId: update.wxRefundId, refundAmount: refund.refundAmount } })
      Object.assign(createdRefund, update)
    } catch (error) {
      await db.collection('refunds').doc(created._id).update({ data: { status: 'failed', rawResponse: { message: error.message }, updatedAt: now() } })
      await appendPaymentEvent('refund_failed', { orderId: order._id, refundNo, status: 'failed', detail: { message: error.message } })
      throw new Error(`微信退款发起失败：${error.message}`)
    }
  }

  await appendOrderClientMessage(order, { eventType: createdRefund.status === 'success' ? 'refund_result' : 'refund_processing', title: createdRefund.status === 'success' ? '退款已完成' : '退款处理中', detail: `退款金额 ¥${refund.refundAmount}`, actorRole: 'system', unreadForClient: options.unreadForClient !== undefined ? options.unreadForClient === true : true })
  await notifyOrder(order.clientOpenid, 'refundResult', order, { amount: refund.refundAmount, statusText: createdRefund.status === 'success' ? '已退款' : '退款中' })
  return createdRefund
}

function playgroundPosition(index, radius = 6) {
  const angle = (index / 8) * Math.PI * 2
  const zRadius = radius * 0.72
  return {
    x: Number((Math.cos(angle) * radius).toFixed(2)),
    y: 0,
    z: Number((Math.sin(angle) * zRadius).toFixed(2))
  }
}

function playgroundHomeStyle(species, index) {
  const catStyles = ['cream', 'pink', 'forest', 'blue']
  const dogStyles = ['wood', 'blue', 'cream', 'forest']
  const list = species === 'cat' ? catStyles : dogStyles
  return list[index % list.length]
}

async function getOrCreateClientPlayground(openid) {
  const res = await db.collection('pet_playgrounds').where({ ownerOpenid: openid }).limit(1).get()
  if (res.data && res.data[0]) return res.data[0]
  const time = nowText()
  const playground = {
    ownerOpenid: openid,
    name: '我的宠物乐园',
    theme: 'sunny_garden',
    level: 1,
    maxVisiblePets: 8,
    camera: { x: 0, y: 8, z: 12, targetX: 0, targetY: 0, targetZ: 0 },
    unlockedAreas: ['main_garden'],
    createdAt: time,
    updatedAt: time
  }
  const created = await db.collection('pet_playgrounds').add({ data: playground })
  return { _id: created._id, ...playground }
}

async function getOrCreatePetHome(openid, playgroundId, pet, index) {
  const res = await db.collection('pet_homes').where({ ownerOpenid: openid, petId: pet._id }).limit(1).get()
  if (res.data && res.data[0]) return res.data[0]
  const species = pet.species === 'cat' ? 'cat' : 'dog'
  const position = playgroundPosition(index, 8.2)
  const time = nowText()
  const home = {
    ownerOpenid: openid,
    playgroundId,
    petId: pet._id,
    species,
    homeType: species === 'cat' ? 'cat_nest' : 'dog_house',
    name: `${safeText(pet.name) || '宠物'}的小窝`,
    position,
    rotation: { x: 0, y: 0, z: 0 },
    scale: 1,
    style: playgroundHomeStyle(species, index),
    createdAt: time,
    updatedAt: time
  }
  const created = await db.collection('pet_homes').add({ data: home })
  return { _id: created._id, ...home }
}

async function getOrCreatePlaygroundEntity(openid, playgroundId, pet, home, index) {
  const res = await db.collection('pet_playground_entities').where({ ownerOpenid: openid, petId: pet._id }).limit(1).get()
  if (res.data && res.data[0]) return res.data[0]
  const position = playgroundPosition(index, 5.2)
  const species = pet.species === 'cat' ? 'cat' : 'dog'
  const time = nowText()
  const entity = {
    ownerOpenid: openid,
    playgroundId,
    petId: pet._id,
    species,
    activeModelType: 'default',
    activeModelId: '',
    activeModelUrl: '',
    homeId: home._id,
    position,
    rotation: { x: 0, y: 0, z: 0 },
    scale: species === 'cat' ? 0.85 : 1,
    currentAction: 'idle',
    mood: 'happy',
    equippedClothesId: '',
    equippedOutfitModelId: '',
    lastActionAt: time,
    nextActionAt: time,
    createdAt: time,
    updatedAt: time
  }
  const created = await db.collection('pet_playground_entities').add({ data: entity })
  return { _id: created._id, ...entity }
}

const handlers = {
  async system(openid, action, data) {
    if (action === 'getSettings') return getSystemSettings()
    if (action === 'getHomePageData') return getHomePageData(openid, data)
    if (action === 'recordSubscriptionConsent') {
      await getUser(openid)
      const templateKeys = Array.isArray(data.templateKeys) ? data.templateKeys : []
      const results = data.results || {}
      const time = now()
      const records = templateKeys.map((templateKey) => ({
        openid,
        templateKey,
        templateId: safeText(data.templateIds && data.templateIds[templateKey]).trim(),
        status: safeText(results[templateKey] || results[data.templateIds && data.templateIds[templateKey]] || 'unknown'),
        scene: safeText(data.scene).trim(),
        createdAt: time,
        updatedAt: time
      }))
      for (const record of records) {
        await db.collection('subscription_consents').add({ data: record })
      }
      return { count: records.length }
    }
    if (action === 'getCustomerServiceInfo') {
      const settings = await getSystemSettings()
      return settings.customerService || {}
    }
    if (action === 'checkTextSecurity') {
      return checkTextSecurity(openid, data.content, data.options || {})
    }
    if (action === 'checkImageSecurity') {
      return checkImageSecurity(openid, data.fileId || data.mediaUrl, data.options || {})
    }
    if (action === 'submitFeedback') {
      const user = await getUser(openid)
      const content = safeText(data.content).trim()
      const category = safeText(data.category).trim() || 'general'
      const contactInfo = safeText(data.contactInfo).trim()
      if (!content) throw new Error('请输入反馈内容')
      if (content.length > 2000) throw new Error('反馈内容不超过 2000 字')
      await checkTextSecurity(openid, content, { scene: 2, label: '反馈内容' })
      const time = now()
      const feedback = {
        openid,
        userId: user._id,
        nickname: user.nickname || '',
        phone: user.phone || '',
        category,
        content,
        contactInfo,
        mediaFileIds: Array.isArray(data.mediaFileIds) ? data.mediaFileIds.slice(0, 9).map(safeFileId).filter(Boolean) : [],
        status: 'pending',
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('user_feedback').add({ data: feedback })
      return { _id: created._id }
    }
    throw new Error('未知 system 操作')
  },

  async auth(openid, action, data) {
    if (action === 'login') {
      let user = await getOptionalUser(openid)
      const time = now()
      if (!user) {
        const userData = {
          openid,
          phone: '',
          nickname: '微信用户',
          avatarUrl: '',
          roles: ['client'],
          activeRole: 'client',
          status: 'active',
          themeKey: normalizeThemeKey(data.themeKey),
          fontKey: normalizeFontKey(data.fontKey),
          preferences: { themeKey: normalizeThemeKey(data.themeKey), fontKey: normalizeFontKey(data.fontKey) },
          retroCardCount: 0,
          completedOrderCount: 0,
          inviterOpenid: '',
          inviteCode: '',
          createdAt: time,
          updatedAt: time
        }
        const created = await db.collection('users').add({ data: userData })
        user = { _id: created._id, ...userData }
      }
      if (user.status !== 'active') throw new Error('账号不可用')
      user = await bindInviteRelation(user, data)
      return enrichUserMemberLevel(user)
    }

    if (action === 'loginByPhoneCode') {
      const code = safeText(data.code).trim()
      if (!code) throw new Error('未获取到手机号授权码')
      let phone = ''
      const settings = await getSystemSettings().catch(() => ({}))
      const isMockCode = code.includes('mock') || code === 'the code is a mock one' || code.startsWith('mock_')

      if (isMockCode || settings.enableTestAddressMode) {
        phone = '13800138000'
      } else {
        try {
          const phoneResult = await cloud.openapi.phonenumber.getPhoneNumber({ code })
          const phoneInfo = (phoneResult && (phoneResult.phoneInfo || phoneResult.phone_info)) || {}
          phone = safeText(phoneInfo.phoneNumber || phoneInfo.purePhoneNumber || phoneInfo.phone_number || phoneInfo.pure_phone_number).trim()
        } catch (error) {
          const message = error.message || error.errMsg || JSON.stringify(error)
          if (message.includes('40029') || message.includes('mock') || message.includes('invalid code') || message.includes('47001')) {
            phone = '13800138000'
          } else {
            throw new Error(`调用微信手机号接口失败：${message}`)
          }
        }
      }

      if (!phone) throw new Error('手机号授权获取失败')
      let user = await getOptionalUser(openid)
      const time = now()
      if (!user) {
        const userData = {
          openid,
          phone,
          nickname: '微信用户',
          avatarUrl: '',
          roles: ['client'],
          activeRole: 'client',
          status: 'active',
          themeKey: normalizeThemeKey(data.themeKey),
          fontKey: normalizeFontKey(data.fontKey),
          preferences: { themeKey: normalizeThemeKey(data.themeKey), fontKey: normalizeFontKey(data.fontKey) },
          retroCardCount: 0,
          completedOrderCount: 0,
          inviterOpenid: '',
          inviteCode: '',
          createdAt: time,
          updatedAt: time
        }
        const created = await db.collection('users').add({ data: userData })
        user = { _id: created._id, ...userData }
      } else {
        if (user.status !== 'active') throw new Error('账号不可用')
        await db.collection('users').doc(user._id).update({ data: { phone, updatedAt: time } })
        user = { ...user, phone, updatedAt: time }
      }
      user = await bindInviteRelation(user, data)
      return enrichUserMemberLevel(user)
    }

    if (action === 'me') {
      const user = await getUser(openid)
      return enrichUserMemberLevel(user)
    }

    if (action === 'dailyCheckin') {
      const user = await getUser(openid)
      const todayInfo = toCstParts()
      const existing = (await db.collection('user_checkins').where({ openid, dateKey: todayInfo.dateKey }).limit(1).get()).data[0]
      if (existing) {
        return { checkedIn: true, points: Number(user.points || 0), retroCardCount: Number(user.retroCardCount || 0) }
      }
      const config = await ensureMonthConfig(todayInfo.monthKey)
      const reward = normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === todayInfo.dayNumber) || {}, todayInfo.dayNumber)
      const claimed = await claimCheckinReward(user, reward, todayInfo, 'normal')
      const time = now()
      await db.collection('user_checkins').add({
        data: {
          userId: user._id,
          openid,
          monthKey: todayInfo.monthKey,
          dateKey: todayInfo.dateKey,
          day: todayInfo.dayNumber,
          checkinType: 'normal',
          usedRetroCard: false,
          rewardSnapshot: claimed.rewardSnapshot,
          pointsDelta: claimed.pointsDelta,
          couponId: claimed.couponId || '',
          createdAt: time,
          updatedAt: time
        }
      })
      const updated = await getUser(openid)
      return {
        checkedIn: false,
        points: Number(updated.points || 0),
        retroCardCount: Number(updated.retroCardCount || 0),
        delta: claimed.pointsDelta,
        rewardSnapshot: claimed.rewardSnapshot
      }
    }

    if (action === 'updateProfile') {
      const user = await getUser(openid)
      const oldPhone = safeText(user.phone).trim()
      const nickname = safeText(data.nickname).trim()
      if (!nickname) throw new Error('昵称不能为空')
      if (nickname !== user.nickname) {
        await checkTextSecurity(openid, nickname, { scene: 1, label: '用户昵称' })
      }
      const avatarUrl = safeFileId(data.avatarUrl) || safeText(data.avatarUrl)
      if (avatarUrl && avatarUrl !== user.avatarUrl) {
        await checkImageSecurity(openid, avatarUrl, { scene: 1, label: '用户头像' })
      }
      const payload = {
        nickname,
        avatarUrl,
        phone: data.phone !== undefined ? safeText(data.phone).trim() : oldPhone,
        updatedAt: now()
      }
      await db.collection('users').doc(user._id).update({ data: payload })
      if (payload.phone !== oldPhone) await syncClientOrderPhone(openid, payload.phone)
      return { ...user, ...payload }
    }

    if (action === 'updateTheme') {
      const user = await getUser(openid)
      if (!isValidThemeKey(data.themeKey)) throw new Error('主题无效')
      const themeKey = normalizeThemeKey(data.themeKey)
      const preferences = {
        ...(user.preferences || {}),
        themeKey
      }
      const payload = { themeKey, preferences, updatedAt: now() }
      await db.collection('users').doc(user._id).update({ data: payload })
      return { ...user, ...payload }
    }

    if (action === 'updateFont') {
      const user = await getUser(openid)
      if (!isValidFontKey(data.fontKey)) throw new Error('字体无效')
      const fontKey = normalizeFontKey(data.fontKey)
      const preferences = {
        ...(user.preferences || {}),
        fontKey
      }
      const payload = { fontKey, preferences, updatedAt: now() }
      await db.collection('users').doc(user._id).update({ data: payload })
      return { ...user, ...payload }
    }

    if (action === 'updatePrivacySettings') {
      const user = await getUser(openid)
      const privacySettings = {
        ...(user.privacySettings || {}),
        hidePublicCheckinPhotos: data.hidePublicCheckinPhotos === true
      }
      const payload = {
        privacySettings,
        hidePublicCheckinPhotos: privacySettings.hidePublicCheckinPhotos,
        updatedAt: now()
      }
      await db.collection('users').doc(user._id).update({ data: payload })
      return { ...user, ...payload }
    }

    if (action === 'bindPhone') {
      const user = await getUser(openid)
      const oldPhone = safeText(user.phone).trim()
      const phone = String(data.phone || '').trim()
      if (!phone) throw new Error('手机号不能为空')
      await db.collection('users').doc(user._id).update({ data: { phone, updatedAt: now() } })
      if (phone !== oldPhone) await syncClientOrderPhone(openid, phone)
      return { ...user, phone }
    }

    if (action === 'switchRole') {
      const user = await getUser(openid)
      if (!Array.isArray(user.roles) || !user.roles.includes(data.role)) throw new Error('当前账号无此角色权限')
      await db.collection('users').doc(user._id).update({ data: { activeRole: data.role, updatedAt: now() } })
      return { ...user, activeRole: data.role }
    }

    throw new Error('未知 auth 操作')
  },

  async playground(openid, action, data) {
    await getUser(openid)
    if (action === 'getOverview') {
      const playground = await getOrCreateClientPlayground(openid)
      const petRes = await db.collection('pets').where({ openid }).orderBy('createdAt', 'desc').get()
      const pets = (petRes.data || []).filter((pet) => !pet.deletedAt && ['cat', 'dog'].includes(pet.species || 'dog')).slice(0, Number(playground.maxVisiblePets || 8))
      const homes = []
      const entities = []
      for (let index = 0; index < pets.length; index += 1) {
        const pet = pets[index]
        const home = await getOrCreatePetHome(openid, playground._id, pet, index)
        const entity = await getOrCreatePlaygroundEntity(openid, playground._id, pet, home, index)
        homes.push(home)
        entities.push(entity)
      }
      return {
        playground,
        pets: pets.map((pet) => ({
          _id: pet._id,
          name: safeText(pet.name),
          species: pet.species === 'cat' ? 'cat' : 'dog',
          breed: safeText(pet.breed),
          avatarFileId: safeText(pet.avatarFileId),
          personality: safeText(pet.personality),
          gender: safeText(pet.gender)
        })),
        homes,
        entities,
        defaults: {
          theme: playground.theme || 'sunny_garden',
          maxVisiblePets: Number(playground.maxVisiblePets || 8)
        }
      }
    }
    throw new Error('未知 playground 操作')
  },

  async pet(openid, action, data) {
    const user = await getUser(openid)
    if (action === 'listPets') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const species = safeText(data.species).trim()
      const res = await db.collection('pets').where({ openid }).orderBy('createdAt', 'desc').get()
      const list = await Promise.all((res.data || [])
        .filter((pet) => !species || pet.species === species)
        .filter((pet) => !keyword || [pet.name, pet.breed, pet.personality, pet.specialNotes, pet.healthNotes, pet.exclusiveId].some((value) => safeText(value).toLowerCase().includes(keyword)))
        .map(async (pet) => {
          const exclusiveId = await ensurePetExclusiveId(pet)
          const beautyPhotos = Array.isArray(pet.beautyPhotos) && pet.beautyPhotos.length ? pet.beautyPhotos : normalizeBeautyPhotos([], pet.avatarFileId)
          return { ...pet, exclusiveId, beautyPhotos }
        }))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'getPet') {
      const res = await db.collection('pets').doc(data.id).get()
      if (res.data.openid !== openid) throw new Error('无权访问')
      const exclusiveId = await ensurePetExclusiveId(res.data)
      const beautyPhotos = Array.isArray(res.data.beautyPhotos) && res.data.beautyPhotos.length ? res.data.beautyPhotos : normalizeBeautyPhotos([], res.data.avatarFileId)
      return { ...res.data, exclusiveId, beautyPhotos }
    }
    if (action === 'recognizePetBreed') {
      const settings = await getSystemSettings()
      if (settings.enablePetBreedAi === false) throw new Error('AI 识别功能已关闭')
      const avatarFileId = safeText(data.avatarFileId || data.photoFileId)
      let imageUrl = safeText(data.imageUrl).trim()
      const imageBase64 = safeText(data.imageBase64).trim()
      let imageSource = imageUrl ? 'imageUrl' : ''

      if (!avatarFileId && !imageUrl && !imageBase64) throw new Error('请先上传宠物照片再进行AI识别')

      if (!imageUrl && avatarFileId && avatarFileId.startsWith('cloud://')) {
        try {
          if (typeof cloud.getTempFileURL !== 'function') throw new Error('当前云函数 SDK 不支持 getTempFileURL')
          const fileRes = await cloud.getTempFileURL({ fileList: [avatarFileId] })
          const fileItem = fileRes && fileRes.fileList && fileRes.fileList[0]
          imageUrl = safeText(fileItem && fileItem.tempFileURL).trim()
          if (imageUrl) imageSource = 'avatarFileId'
        } catch (error) {
          console.error('[云函数AI识图] getTempFileURL 失败:', error.message || error)
        }
      }

      if (!imageUrl && imageBase64) {
        imageUrl = imageBase64.startsWith('data:image/') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`
        imageSource = 'imageBase64'
      }

      if (!imageUrl) throw new Error('照片链接生成失败，请重新上传照片后再试')

      const requestedModel = safeText(data.model).trim() || 'qwen3.5-flash'
      const modelsToTry = Array.from(new Set([requestedModel, 'qwen3.5-flash', 'qwen3.5-plus', 'glm-4v-flash', 'glm-4v-plus', 'glm-5v-turbo']))
      const promptText = '请详细描述并识别照片中的宠物：包括宠物类型（狗狗/猫咪/异宠）、判断出的具体品种名称，以及外貌毛色形态特征。字数在120字以内。最后单独一行返回格式如 {"species":"dog","breed":"柯基"} 的严格JSON，其中 species 只能是 dog、cat、other。'

      let aiResponse = null
      let extendAiError = null
      try {
        aiResponse = await callCloudbaseExtendAi(modelsToTry, imageUrl, promptText)
      } catch (error) {
        extendAiError = error
        console.warn('[云函数AI识图] cloud.extend.AI 全部失败，尝试 AI 网关:', error.message || error)
      }

      if (!aiResponse) {
        const reason = extendAiError && extendAiError.message ? extendAiError.message : '模型无响应'
        throw new Error(`AI 识别服务暂不可用，请检查云开发 AI 服务配置或重新部署 api 云函数：${reason}`)
      }

      const parsedResult = parsePetRecognitionText(aiResponse.rawAiContent)
      const aiMessage = `微信云开发 AI (${aiResponse.modelName}) 识别分析完成`
      await recordAiLog(openid, {
        avatarFileId,
        modelName: aiResponse.modelName,
        source: aiResponse.source,
        rawResponse: aiResponse.rawAiContent,
        species: parsedResult.species,
        breed: parsedResult.breed,
        aiMessage: parsedResult.aiResultText
      })

      return {
        ...parsedResult,
        aiMessage,
        modelName: aiResponse.modelName,
        source: aiResponse.source,
        imageSource
      }
    }
    if (action === 'createPet') {
      if (!data.name) throw new Error('宠物名称不能为空')
      if (!safeFileId(data.avatarFileId) && !safeText(data.avatarFileId)) throw new Error('请上传至少一张宠物照片')
      const petText = [data.name, data.breed, data.personality, data.specialNotes, data.favoriteFood, data.dislikes, data.healthNotes, data.aiGreeting, data.aiPersona].filter(Boolean).join(' ')
      if (petText) {
        await checkTextSecurity(openid, petText, { scene: 1, label: '宠物资料' })
      }
      if (data.avatarFileId) {
        await checkImageSecurity(openid, data.avatarFileId, { scene: 1, label: '宠物头像' })
      }
      const time = nowText()
      const beautyPhotos = normalizeBeautyPhotos(data.beautyPhotos, data.avatarFileId)
      const avatarFileId = safeFileId(data.avatarFileId) || safeText(data.avatarFileId) || beautyPhotos[0].fileId
      const pet = {
        userId: safeText(user._id),
        openid: safeText(openid),
        exclusiveId: await generatePetExclusiveId(),
        name: safeText(data.name),
        avatarFileId,
        beautyPhotos,
        beautyTitle: data.beautyTitle || null,
        species: safeText(data.species || 'dog'),
        breed: safeText(data.breed),
        gender: safeText(data.gender),
        birthday: safeText(data.birthday),
        weight: safeNumber(data.weight),
        personality: safeText(data.personality),
        favoriteFood: safeText(data.favoriteFood),
        dislikes: safeText(data.dislikes),
        healthNotes: safeText(data.healthNotes),
        aiInteractionEnabled: data.aiInteractionEnabled === true,
        aiPersona: safeText(data.aiPersona),
        aiGreeting: safeText(data.aiGreeting),
        specialNotes: safeText(data.specialNotes),
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('pets').add({ data: pet })
      return { _id: created._id, ...pet }
    }
    if (action === 'updatePet') {
      const existing = await db.collection('pets').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权访问')
      if (!safeFileId(data.avatarFileId) && !safeText(data.avatarFileId)) throw new Error('请上传至少一张宠物照片')
      const petText = [data.name, data.breed, data.personality, data.specialNotes, data.favoriteFood, data.dislikes, data.healthNotes, data.aiGreeting, data.aiPersona].filter(Boolean).join(' ')
      if (petText) {
        await checkTextSecurity(openid, petText, { scene: 1, label: '宠物资料' })
      }
      if (data.avatarFileId && data.avatarFileId !== existing.data.avatarFileId) {
        await checkImageSecurity(openid, data.avatarFileId, { scene: 1, label: '宠物头像' })
      }
      const exclusiveId = existing.data.exclusiveId || await generatePetExclusiveId()
      const beautyPhotos = normalizeBeautyPhotos(data.beautyPhotos, data.avatarFileId)
      const existingPhotos = Array.isArray(existing.data.beautyPhotos) && existing.data.beautyPhotos.length ? existing.data.beautyPhotos : normalizeBeautyPhotos([], existing.data.avatarFileId)
      const nextFileIds = new Set(beautyPhotos.map((photo) => photo.fileId))
      const hasDeletedPhoto = existingPhotos.some((photo) => !nextFileIds.has(photo.fileId))
      if (hasDeletedPhoto && toCstParts().dayNumber !== 1) throw new Error('每月1日才可以删除宠物美照')
      const avatarFileId = safeFileId(data.avatarFileId) || safeText(data.avatarFileId) || beautyPhotos[0].fileId
      await db.collection('pets').doc(data.id).update({ data: {
        name: safeText(data.name),
        exclusiveId,
        avatarFileId,
        beautyPhotos,
        species: safeText(data.species || 'dog'),
        breed: safeText(data.breed),
        gender: safeText(data.gender),
        birthday: safeText(data.birthday),
        weight: safeNumber(data.weight),
        personality: safeText(data.personality),
        favoriteFood: safeText(data.favoriteFood),
        dislikes: safeText(data.dislikes),
        healthNotes: safeText(data.healthNotes),
        aiInteractionEnabled: data.aiInteractionEnabled === true,
        aiPersona: safeText(data.aiPersona),
        aiGreeting: safeText(data.aiGreeting),
        specialNotes: safeText(data.specialNotes),
        updatedAt: nowText()
      } })
      return { id: data.id, exclusiveId, beautyPhotos, avatarFileId }
    }
    if (action === 'deletePet') {
      const existing = await db.collection('pets').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权访问')
      await db.collection('pets').doc(data.id).remove()
      return { id: data.id }
    }
    throw new Error('未知 pet 操作')
  },

  async petBeauty(openid, action, data) {
    const today = toCstParts()
    const monthKey = normalizeMonthKey(data.monthKey || today.monthKey)

    async function getPublicPetsWithVotes() {
      const voteMap = await countPetBeautyVotes(monthKey)
      const petsRes = await db.collection('pets').get()
      const pets = await Promise.all((petsRes.data || [])
        .filter((pet) => !pet.deletedAt && Array.isArray(pet.beautyPhotos) && pet.beautyPhotos.length)
        .map(async (pet) => {
          const exclusiveId = await ensurePetExclusiveId(pet)
          return toPetPublicBeautyView({ ...pet, exclusiveId }, voteMap[pet._id] || 0)
        }))
      return pets.sort((a, b) => Number(b.voteCount || 0) - Number(a.voteCount || 0) || String(a.petId).localeCompare(String(b.petId)))
    }

    async function todayVoteState() {
      if (!openid) return { hasVotedToday: false }
      const voted = await db.collection('pet_beauty_votes').where({ openid, dateKey: today.dateKey }).limit(1).get()
      return { hasVotedToday: Boolean(voted.data && voted.data[0]), votedPetId: voted.data && voted.data[0] ? voted.data[0].petId : '' }
    }

    if (action === 'listHistoryMonths') {
      const locksRes = await db.collection('pet_beauty_month_locks').where({ status: 'locked' }).orderBy('monthKey', 'desc').get()
      const months = (locksRes.data || []).map((item) => item.monthKey).filter(Boolean)
      return { months }
    }

    if (action === 'getActivityHome') {
      const [pets, voteState, locked] = await Promise.all([getPublicPetsWithVotes(), todayVoteState(), isPetBeautyMonthLocked(monthKey)])
      return { monthKey, locked, ...voteState, candidates: pets.slice(0, 12), ranking: pets.slice(0, 10) }
    }

    if (action === 'listCandidates') {
      const species = safeText(data.species).trim()
      const pets = (await getPublicPetsWithVotes()).filter((pet) => !species || pet.species === species)
      return paginateList(pets, data)
    }

    if (action === 'listRanking') {
      const keyword = safeText(data.keyword).trim().toUpperCase()
      const historyMonthKey = safeText(data.historyMonthKey).trim()
      if (historyMonthKey && historyMonthKey !== monthKey) {
        const histRes = await db.collection('pet_beauty_month_rankings').where({ monthKey: historyMonthKey, locked: true }).orderBy('rank', 'asc').get()
        const histList = (histRes.data || [])
          .filter((item) => !keyword || safeText(item.petExclusiveId).toUpperCase().includes(keyword) || safeText(item.petSnapshot && item.petSnapshot.name).toUpperCase().includes(keyword))
          .map((item) => ({ petId: item.petId, name: item.petSnapshot && item.petSnapshot.name || '', ageText: item.petSnapshot && item.petSnapshot.ageText || '', species: item.petSnapshot && item.petSnapshot.species || '', speciesText: petSpeciesText(item.petSnapshot && item.petSnapshot.species), exclusiveId: item.petExclusiveId || '', voteCount: item.voteCount || 0, rank: item.rank, beautyTitle: { monthKey: item.monthKey, rank: item.rank, title: item.title } }))
        return { ...paginateList(histList, data), monthKey: historyMonthKey, locked: true, isHistory: true }
      }
      const pets = (await getPublicPetsWithVotes())
        .filter((pet) => !keyword || safeText(pet.exclusiveId).toUpperCase().includes(keyword) || safeText(pet.name).toUpperCase().includes(keyword))
        .map((pet, index) => ({ ...pet, rank: index + 1 }))
      return paginateList(pets, data)
    }

    if (action === 'vote') {
      const user = await getUser(openid)
      if (await isPetBeautyMonthLocked(monthKey)) throw new Error('本月排行榜已锁定')
      const todayVote = await db.collection('pet_beauty_votes').where({ openid, dateKey: today.dateKey }).limit(1).get()
      if (todayVote.data && todayVote.data[0]) throw new Error('今天已经投过票了')
      const petId = safeText(data.petId).trim()
      if (!petId) throw new Error('请选择要投票的宠物')
      const pet = (await db.collection('pets').doc(petId).get()).data
      if (!pet || pet.deletedAt) throw new Error('宠物不存在')
      if (!Array.isArray(pet.beautyPhotos) || !pet.beautyPhotos.length) throw new Error('该宠物还没有美照')
      const exclusiveId = await ensurePetExclusiveId({ ...pet, _id: petId })
      const time = now()
      await db.collection('pet_beauty_votes').add({ data: { openid, userId: user._id, petId, petExclusiveId: exclusiveId, monthKey, dateKey: today.dateKey, createdAt: time } })
      const voteMap = await countPetBeautyVotes(monthKey)
      return { petId, monthKey, dateKey: today.dateKey, hasVotedToday: true, voteCount: Number(voteMap[petId] || 0) }
    }

    if (action === 'importFromServiceCheckins') {
      const petId = safeText(data.petId).trim()
      const orderId = safeText(data.orderId).trim()
      const checkinIds = Array.isArray(data.checkinIds) ? data.checkinIds.map((id) => safeText(id).trim()).filter(Boolean) : []
      if (!petId || !orderId || !checkinIds.length) throw new Error('请选择要导入的美照')
      const { order } = await requireClientOrder(openid, orderId, '仅宠物主可导入美照')
      const orderPetIds = Array.isArray(order.petIds) && order.petIds.length ? order.petIds : [order.petId].filter(Boolean)
      if (!orderPetIds.includes(petId)) throw new Error('该宠物不属于此订单')
      const pet = (await db.collection('pets').doc(petId).get()).data
      if (!pet || pet.openid !== openid) throw new Error('宠物不存在')
      const currentPhotos = Array.isArray(pet.beautyPhotos) && pet.beautyPhotos.length ? pet.beautyPhotos : normalizeBeautyPhotos([], pet.avatarFileId)
      const checkins = await Promise.all(checkinIds.map(async (id) => ({ ...(await db.collection('checkin_logs').doc(id).get()).data, _id: id })))
      const imported = checkins
        .filter((item) => item.orderId === orderId && item.eventType === 'pet_beauty_photo' && !item.deletedAt && item.mediaFileId)
        .map((item, index) => normalizeBeautyPhoto({ fileId: item.mediaFileId, source: 'service_checkin', orderId, checkinId: item._id, createdAt: item.recordedAt || item.createdAt }, index))
        .filter(Boolean)
      const seen = new Set(currentPhotos.map((photo) => photo.fileId))
      const maxAllowed = Math.max(0, 9 - currentPhotos.length)
      if (maxAllowed <= 0) throw new Error('宠物美照已满9张，请先在每月1日删除后再导入')
      const allowedAdditions = additions.slice(0, maxAllowed)
      for (const item of allowedAdditions) {
        if (item.fileId) {
          await checkImageSecurity(openid, item.fileId, { scene: 3, label: '美照' })
        }
      }
      const beautyPhotos = currentPhotos.concat(allowedAdditions)
      await db.collection('pets').doc(petId).update({ data: { beautyPhotos, avatarFileId: pet.avatarFileId || beautyPhotos[0].fileId, updatedAt: nowText() } })
      return { petId, importedCount: allowedAdditions.length, beautyPhotos }
    }

    if (action === 'deleteBeautyPhoto') {
      const todayInfo = toCstParts()
      if (todayInfo.dayNumber !== 1) throw new Error('每月1日才可以删除宠物美照')
      const petId = safeText(data.petId).trim()
      const photoId = safeText(data.photoId).trim()
      const fileId = safeText(data.fileId).trim()
      const pet = (await db.collection('pets').doc(petId).get()).data
      if (!pet || pet.openid !== openid) throw new Error('宠物不存在')
      const currentPhotos = Array.isArray(pet.beautyPhotos) ? pet.beautyPhotos : []
      const beautyPhotos = currentPhotos.filter((photo) => (photoId && photo.id !== photoId) || (fileId && photo.fileId !== fileId))
      if (beautyPhotos.length === currentPhotos.length) throw new Error('美照不存在')
      if (!beautyPhotos.length) throw new Error('至少保留一张宠物美照')
      const avatarFileId = beautyPhotos.some((photo) => photo.fileId === pet.avatarFileId) ? pet.avatarFileId : beautyPhotos[0].fileId
      await db.collection('pets').doc(petId).update({ data: { beautyPhotos, avatarFileId, updatedAt: nowText() } })
      return { petId, beautyPhotos, avatarFileId }
    }

    if (action === 'settleMonthlyRanking') {
      await requireAdmin(openid)
      return settlePetBeautyMonthlyRanking(monthKey, { force: data.force === true, source: 'admin_repair' })
    }

    throw new Error('未知 petBeauty 操作')
  },

  async client(openid, action, data) {
    const user = await getUser(openid)

    if (action === 'listAddresses') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const res = await db.collection('user_addresses').where({ openid }).orderBy('updatedAt', 'desc').get()
      const list = (res.data || []).filter((address) => !keyword || [address.label, address.serviceAddress, address.addressDetail, address.doorplate].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }

    if (action === 'saveAddress') {
      return saveUserAddress(openid, user, data)
    }

    if (action === 'deleteAddress') {
      const existing = await db.collection('user_addresses').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权操作地址')
      await db.collection('user_addresses').doc(data.id).remove()
      return { id: data.id }
    }

    if (action === 'setDefaultAddress') {
      const existing = await db.collection('user_addresses').doc(data.id).get()
      if (existing.data.openid !== openid) throw new Error('无权操作地址')
      const time = now()
      const addresses = await db.collection('user_addresses').where({ openid }).get()
      await Promise.all(addresses.data.map((item) => db.collection('user_addresses').doc(item._id).update({ data: { isDefault: item._id === data.id, updatedAt: time } })))
      return { id: data.id }
    }

    throw new Error('未知 client 操作')
  },

  async homeSecurity(openid, action, data) {
    if (action === 'saveHomeSecurity') {
      const user = await getUser(openid)
      const encrypted = encryptText(data.doorLockCode || '')
      const payload = { userId: user._id, openid, doorLockCodeCipher: encrypted.cipher, doorLockCodeIv: encrypted.iv, doorLockCodeTag: encrypted.tag, keyLocation: data.keyLocation || '', entryNotes: data.entryNotes || '', cameraLocations: data.cameraLocations || '', forbiddenAreas: data.forbiddenAreas || '', emergencyContactName: data.emergencyContactName || '', emergencyContactPhone: data.emergencyContactPhone || '', updatedAt: now() }
      const existing = await db.collection('home_security').where({ openid }).limit(1).get()
      if (existing.data[0]) {
        await db.collection('home_security').doc(existing.data[0]._id).update({ data: payload })
        return { _id: existing.data[0]._id, ...payload, doorLockCodeMasked: mask(data.doorLockCode || '') }
      }
      const created = await db.collection('home_security').add({ data: payload })
      return { _id: created._id, ...payload, doorLockCodeMasked: mask(data.doorLockCode || '') }
    }

    if (action === 'getMaskedHomeSecurity') {
      await getUser(openid)
      const res = await db.collection('home_security').where({ openid }).limit(1).get()
      const record = res.data[0]
      if (!record) return null
      const plain = decryptText(record.doorLockCodeCipher, record.doorLockCodeIv, record.doorLockCodeTag)
      return { ...record, doorLockCodeCipher: undefined, doorLockCodeIv: undefined, doorLockCodeTag: undefined, doorLockCodeMasked: mask(plain) }
    }

    if (action === 'listHomeSecurityHistory') {
      await getUser(openid)
      const res = await db.collection('orders').where({ clientOpenid: openid }).orderBy('createdAt', 'desc').get()
      return (res.data || [])
        .filter((order) => !isAdminDeletedOrder(order))
        .map((order) => {
          const security = toPublicOrderHomeSecurity(order.orderHomeSecurity || order.homeSecuritySnapshot)
          if (!security) return null
          return { orderId: order._id, orderNo: order.orderNo || '', serviceTime: `${order.startTime || ''} - ${order.endTime || ''}`, serviceAddress: order.serviceAddress || '', orderHomeSecurity: security, createdAt: order.createdAt || '' }
        })
        .filter(Boolean)
        .slice(0, Math.min(Number(data.limit || 30), 50))
    }

    if (action === 'getUnlockCode') {
      const user = await getUser(openid)
      const orderRes = await db.collection('orders').doc(data.orderId).get()
      const order = orderRes.data
      let result = 'forbidden'
      let reason = ''
      try {
        if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
        if (order.staffOpenid !== openid) throw new Error('不是该订单绑定员工')
        if (!['assigned', 'in_service', 'day_completed'].includes(order.status)) throw new Error('订单状态不允许查看')
        const current = now().getTime()
        const approvedEarlyStart = await getApprovedEarlyStart(data.orderId)
        const regularStart = toTimeValue(order.startTime)
        const start = approvedEarlyStart ? toTimeValue(approvedEarlyStart.approvedAt || approvedEarlyStart.createdAt) : regularStart
        const end = toTimeValue(order.endTime)
        if ((start && current < start) || (end && current > end)) throw new Error('不在服务解锁时间窗口')
        let security = (await db.collection('order_home_security').where({ orderId: data.orderId }).limit(1).get()).data[0]
        if (!security) security = order.orderHomeSecurity || order.homeSecuritySnapshot
        if (!security || security.type !== 'one_time_code' || !security.oneTimeCode) throw new Error('该订单未设置一次性密码')
        const effectiveStart = toTimeValue(security.oneTimeCode.effectiveStart)
        const effectiveEnd = toTimeValue(security.oneTimeCode.effectiveEnd)
        if (current < effectiveStart) throw new Error('一次性密码尚未生效，请提醒用户重新设置或等待生效')
        if (current > effectiveEnd) throw new Error('一次性密码已过期，请提醒用户重新设置')
        result = 'success'
        reason = 'ok'
        return { lockMethod: security.type, lockMethodText: security.lockMethodText || lockMethodText(security.type), doorLockCode: decryptText(security.oneTimeCode.cipher, security.oneTimeCode.iv, security.oneTimeCode.tag), effectiveStart: security.oneTimeCode.effectiveStart, effectiveEnd: security.oneTimeCode.effectiveEnd, entryNotes: security.entryNotes || '' }
      } catch (error) {
        reason = error.message
        throw error
      } finally {
        await db.collection('unlock_code_logs').add({ data: { orderId: data.orderId, staffUserId: user._id, staffOpenid: openid, result, reason, createdAt: now() } })
      }
    }

    if (action === 'requestRemoteUnlock') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可请求开门')
      const order = (await db.collection('orders').doc(data.orderId).get()).data
      if (order.staffOpenid !== openid) throw new Error('不是该订单绑定员工')
      if (!['assigned', 'in_service', 'day_completed'].includes(order.status)) throw new Error('订单状态不允许请求开门')
      const security = order.orderHomeSecurity || order.homeSecuritySnapshot || {}
      if (security.type !== 'remote_unlock') throw new Error('该订单不是远程开门方式')
      const remoteUnlock = security.remoteUnlock || { requestCount: 0, notifyChannels: ['wechat', 'admin_phone'], lastNotifyStatus: {} }
      const time = now()
      if (remoteUnlock.lastRequestedAt && time.getTime() - toTimeValue(remoteUnlock.lastRequestedAt) < 2 * 60 * 1000) throw new Error('开门请求发送过于频繁，请稍后再试')
      const settings = await getSystemSettings()
      const customerServiceSnapshot = settings.customerService || {}
      const updatedSecurity = { ...security, remoteUnlock: { ...remoteUnlock, lastRequestedAt: time.toISOString(), requestCount: Number(remoteUnlock.requestCount || 0) + 1, notifyChannels: ['wechat', 'admin_phone'], lastNotifyStatus: { wechat: 'pending', admin_phone: 'available' }, customerServiceSnapshot }, updatedAt: time }
      await db.collection('orders').doc(data.orderId).update({ data: { orderHomeSecurity: updatedSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(updatedSecurity), updatedAt: time } })
      const securityRes = await db.collection('order_home_security').where({ orderId: data.orderId }).limit(1).get()
      if (securityRes.data[0]) await db.collection('order_home_security').doc(securityRes.data[0]._id).update({ data: { ...updatedSecurity, updatedAt: time } })
      const notification = await db.collection('home_security_notifications').add({ data: { orderId: data.orderId, type: 'remote_unlock', clientOpenid: order.clientOpenid, staffOpenid: openid, channels: ['wechat', 'admin_phone'], status: { wechat: 'pending', admin_phone: 'available' }, customerServiceSnapshot, createdAt: time } })
      const updatedOrder = { ...order, _id: data.orderId, orderHomeSecurity: updatedSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(updatedSecurity), updatedAt: time }
      await appendOrderClientMessage(updatedOrder, { eventType: 'remote_unlock_requested', title: '宠托师请求远程开门', detail: '宠托师已到达服务地点，请及时远程开门。', actorRole: 'staff', idempotencyKey: makeIdempotencyKey('order_message', data.orderId, 'remote_unlock_requested', notification._id || time.toISOString()) })
      const notifyResult = await notifyOrder(order.clientOpenid, 'remoteUnlock', updatedOrder, { deviceName: '宠托师请求远程开门', requestTime: beijingClockText(time) })
      const finalSecurity = { ...updatedSecurity, remoteUnlock: { ...updatedSecurity.remoteUnlock, lastNotifyStatus: { wechat: notifyResult && notifyResult.status || 'skipped', admin_phone: 'available' }, lastNotifyError: notifyResult && notifyResult.error || '' } }
      await db.collection('orders').doc(data.orderId).update({ data: { orderHomeSecurity: finalSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(finalSecurity), updatedAt: time } })
      if (securityRes.data[0]) await db.collection('order_home_security').doc(securityRes.data[0]._id).update({ data: { ...finalSecurity, updatedAt: time } })
      await db.collection('home_security_notifications').doc(notification._id).update({ data: { status: finalSecurity.remoteUnlock.lastNotifyStatus, error: finalSecurity.remoteUnlock.lastNotifyError, updatedAt: time } })
      await appendOrderStaffMessage({ ...updatedOrder, orderHomeSecurity: finalSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(finalSecurity) }, { eventType: 'remote_unlock_reminder_sent', title: '已提醒宠物主远程开门', detail: '开门提醒已发送给宠物主，请等待对方处理。', actorRole: 'system', idempotencyKey: makeIdempotencyKey('order_staff_message', data.orderId, 'remote_unlock_reminder_sent', notification._id || time.toISOString()) })
      return toPublicOrderHomeSecurity(finalSecurity)
    }

    if (action === 'updateOrderOneTimeCode') {
      await getUser(openid)
      const order = (await db.collection('orders').doc(data.orderId).get()).data
      if (order.clientOpenid !== openid) throw new Error('无权修改该订单')
      if (!['pending_pay', 'paid', 'assigned', 'in_service'].includes(order.status)) throw new Error('当前订单状态不可修改密码')
      const code = safeText(data.code).trim()
      if (!code) throw new Error('请填写一次性开门密码')
      if (!data.effectiveStart || !data.effectiveEnd) throw new Error('请选择一次性密码有效时间')
      if (toTimeValue(data.effectiveEnd) <= toTimeValue(data.effectiveStart)) throw new Error('一次性密码结束时间必须晚于开始时间')
      const encrypted = encryptText(code)
      const time = now()
      const security = { ...(order.orderHomeSecurity || {}), type: 'one_time_code', lockMethod: 'one_time_code', lockMethodText: lockMethodText('one_time_code'), entryNotes: data.entryNotes || (order.orderHomeSecurity && order.orderHomeSecurity.entryNotes) || '', hasDoorLockCode: true, oneTimeCode: { cipher: encrypted.cipher, iv: encrypted.iv, tag: encrypted.tag, masked: mask(code), effectiveStart: data.effectiveStart, effectiveEnd: data.effectiveEnd, coversServiceTime: isTimeRangeCovered(order.startTime, order.endTime, data.effectiveStart, data.effectiveEnd) }, updatedAt: time }
      await db.collection('orders').doc(data.orderId).update({ data: { orderHomeSecurity: security, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(security), updatedAt: time } })
      const securityRes = await db.collection('order_home_security').where({ orderId: data.orderId }).limit(1).get()
      if (securityRes.data[0]) await db.collection('order_home_security').doc(securityRes.data[0]._id).update({ data: { ...security, updatedAt: time } })
      await appendOrderStaffMessage({ ...order, _id: data.orderId, orderHomeSecurity: security, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(security), updatedAt: time }, { eventType: 'one_time_code_updated', title: '一次性密码已更新', detail: '宠物主已重新填写一次性门锁密码，请在服务时间内查看。', actorRole: 'client', idempotencyKey: makeIdempotencyKey('order_staff_message', data.orderId, 'one_time_code_updated', time.toISOString()) })
      return toPublicOrderHomeSecurity(security)
    }

    if (action === 'recordKeyReturned') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可操作')
      const order = (await db.collection('orders').doc(data.orderId).get()).data
      if (order.staffOpenid !== openid) throw new Error('不是该订单绑定员工')
      const security = order.orderHomeSecurity || order.homeSecuritySnapshot || {}
      if (security.type !== 'key' || !security.key) throw new Error('该订单不是钥匙入户方式')
      const imageFileIds = Array.isArray(data.imageFileIds) ? data.imageFileIds : []
      if (!imageFileIds.length) throw new Error('请上传放回钥匙位置图片')
      const time = now()
      const updatedSecurity = { ...security, key: { ...security.key, returnedAt: time.toISOString(), returnImageFileIds: imageFileIds, returnNote: data.note || '' }, updatedAt: time }
      await db.collection('orders').doc(data.orderId).update({ data: { orderHomeSecurity: updatedSecurity, homeSecuritySnapshot: toPublicHomeSecuritySnapshot(updatedSecurity), updatedAt: time } })
      const securityRes = await db.collection('order_home_security').where({ orderId: data.orderId }).limit(1).get()
      if (securityRes.data[0]) await db.collection('order_home_security').doc(securityRes.data[0]._id).update({ data: { ...updatedSecurity, updatedAt: time } })
      return toPublicOrderHomeSecurity(updatedSecurity)
    }
    throw new Error('未知 homeSecurity 操作')
  },

  async order(openid, action, data) {
    if (action === 'listServiceOptions') {
      await getUser(openid)
      return listServicePrices(false)
    }

    if (action === 'quoteOrder') {
      await getUser(openid)
      let pets = []
      const petIds = normalizePetIds(data)
      if (petIds.length) pets = await getClientPetsByIds(openid, petIds)
      const pricing = await calcOrderPricing(data, pets, { openid })
      if (data.startTime || data.endTime) validateOrderTime({ ...data, durationMinutes: pricing.durationMinutes, endTime: pricing.sessions[pricing.sessions.length - 1].endTime })
      const publishMode = data.publishMode === 'direct' ? 'direct' : 'open'
      const staffProfileId = data.staffProfileId || data.requestedStaffProfileId
      if (publishMode === 'direct' && staffProfileId) {
        const staffProfileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
        const staffProfile = staffProfileRes.data
        validateDirectStaffServiceRange(staffProfile, data, { isQuote: true })
        if (data.startTime && data.endTime) {
          await validateStaffAvailabilityForSessions(staffProfile, pricing.sessions)
        }
      }
      return pricing
    }

    if (action === 'createOrder') {
      const user = await getUser(openid)
      const clientRequestId = getClientRequestId(data)
      if (clientRequestId) {
        const existingOrder = (await db.collection('orders').where({ clientOpenid: openid, clientRequestId }).limit(1).get()).data[0]
        if (existingOrder) return { ...existingOrder, orderHomeSecurity: toPublicOrderHomeSecurity(existingOrder.orderHomeSecurity || existingOrder.homeSecuritySnapshot), savedAddress: null }
      }
      if (!safeText(user.phone).trim()) throw new Error('请先绑定手机号')
      const petIds = normalizePetIds(data)
      if (!petIds.length) throw new Error('请选择宠物')
      if (!data.serviceAddress) throw new Error('请选择服务地址')
      if (!data.addressDetail) throw new Error('请填写详细地址')
      if (!data.doorplate) throw new Error('请填写门牌号或入户说明')
      const pets = await getClientPetsByIds(openid, petIds)
      const pricing = await calcOrderPricing(data, pets, { openid })
      validateOrderTime({ ...data, durationMinutes: pricing.durationMinutes, endTime: pricing.sessions[pricing.sessions.length - 1].endTime })
      const serviceSessions = pricing.sessions
      const primaryPet = pets[0]
      const petSnapshots = pets.map(createPetSnapshot)
      const petNames = pets.map((pet) => pet.name || '宠物')
      const petSummary = formatPetSummary(pets)
      const requestedStaff = await getRequestedStaff(data)
      let directDistanceKm = null
      if (requestedStaff && requestedStaff.requestedStaffProfileId) {
        const staffProfileRes = await db.collection('staff_profiles').doc(requestedStaff.requestedStaffProfileId).get()
        const staffProfile = staffProfileRes.data
        const rangeCheck = validateDirectStaffServiceRange(staffProfile, data, { isQuote: false })
        directDistanceKm = rangeCheck.dist
        await validateStaffAvailabilityForSessions(staffProfile, serviceSessions)
      }
      const time = now()
      const homeSecurity = normalizeHomeSecurityInput({ ...data, startTime: serviceSessions[0].startTime, endTime: serviceSessions[serviceSessions.length - 1].endTime })
      const checkinRequirements = await resolveCheckinRequirements(pricing.serviceTypes)
      const memberLevels = await getMemberLevels()
      const order = { orderNo: `O${Date.now()}${Math.floor(Math.random() * 1000)}`, clientRequestId, idempotencyKey: clientRequestId || '', clientUserId: user._id, clientOpenid: openid, clientSnapshot: createClientSnapshot(user, memberLevels), contactPhone: safeText(user.phone).trim(), staffUserId: '', staffOpenid: '', staffProfileId: '', ...requestedStaff, distanceFromSitterKm: directDistanceKm, assignmentSource: '', sourceOrderId: data.sourceOrderId || '', petId: primaryPet._id || petIds[0], petIds, petName: petSummary, petNames, petSnapshot: petSnapshots[0], petSnapshots, petSummary, serviceType: pricing.primaryServiceType || pricing.businessServiceTypes[0], serviceTypes: pricing.serviceTypes, serviceLabels: pricing.serviceLabels, serviceSummary: pricing.serviceSummary, city: data.city || '', serviceAddress: data.serviceAddress || '', addressDetail: data.addressDetail || '', doorplate: data.doorplate || '', addressLatitude: Number(data.addressLatitude || 0), addressLongitude: Number(data.addressLongitude || 0), orderType: pricing.orderType, serviceStartDate: serviceSessions[0].date, serviceEndDate: serviceSessions[serviceSessions.length - 1].date, sessionCount: serviceSessions.length, serviceSessions, startTime: serviceSessions[0].startTime, endTime: serviceSessions[serviceSessions.length - 1].endTime, durationMinutes: pricing.durationMinutes, petServiceDurations: pricing.petServiceDurations, amount: pricing.amount, discountAmount: pricing.discountAmount || 0, payAmount: pricing.payAmount, couponId: pricing.coupon ? pricing.coupon.couponId : '', couponTemplateId: pricing.coupon ? pricing.coupon.templateId : '', couponName: pricing.coupon ? pricing.coupon.name : '', couponSnapshot: pricing.coupon ? pricing.coupon.snapshot : null, priceSnapshot: pricing.priceSnapshot, paymentStatus: 'unpaid', status: 'pending_pay', checkinRequirements, requiredCheckins: checkinRequirements.filter((item) => item.required).map((item) => item.eventType), optionalCheckins: checkinRequirements.filter((item) => !item.required).map((item) => item.eventType), homeSecuritySnapshot: toPublicHomeSecuritySnapshot(homeSecurity), orderHomeSecurity: homeSecurity, lockMethod: homeSecurity.lockMethod, hasDoorLockCode: homeSecurity.hasDoorLockCode, insurancePolicyNo: '', cancelReason: '', refundStatus: '', refundAmount: 0, createdAt: time, updatedAt: time }
      let savedAddress = null
      if (data.saveAddress === true) {
        savedAddress = await saveUserAddress(openid, user, {
          label: data.addressLabel || '预约地址',
          serviceAddress: data.serviceAddress,
          addressDetail: data.addressDetail,
          doorplate: data.doorplate,
          latitude: data.addressLatitude,
          longitude: data.addressLongitude,
          isDefault: true
        })
      }
      const created = await db.collection('orders').add({ data: order })
      const { doorLockCode, ...securityRecord } = homeSecurity
      await db.collection('order_home_security').add({
        data: {
          orderId: created._id,
          clientOpenid: openid,
          ...securityRecord,
          createdAt: time,
          updatedAt: time
        }
      })
      if (order.couponId) {
        await db.collection('user_coupons').doc(order.couponId).update({ data: { status: 'locked', lockedOrderId: created._id, lockedAt: time, updatedAt: time } })
      }
      const createdOrder = { _id: created._id, ...order }
      await appendOrderTimeline(created._id, 'created', '订单已创建', order.serviceSummary, 'client')
      await appendOrderClientMessage(createdOrder, { eventType: 'created', title: '订单已创建', detail: order.serviceSummary, actorRole: 'client', unreadForClient: false })
      if (order.couponId) {
        await appendOrderTimeline(created._id, 'coupon_locked', '已使用优惠券', `优惠 ¥${order.discountAmount}`, 'client')
        await appendOrderClientMessage(createdOrder, { eventType: 'coupon_locked', title: '已使用优惠券', detail: `优惠 ¥${order.discountAmount}`, actorRole: 'client', unreadForClient: false })
      }
      return { ...createdOrder, orderHomeSecurity: toPublicOrderHomeSecurity(homeSecurity), savedAddress }
    }

    if (action === 'listOrders') {
      const user = await getUser(openid)
      await expireDueUnacceptedOrders()
      const role = data.role || user.activeRole || 'client'
      const where = role === 'staff' ? { staffOpenid: openid } : { clientOpenid: openid }
      const res = await db.collection('orders').where(where).orderBy('createdAt', 'desc').get()
      let list = (res.data || []).filter((order) => !isAdminDeletedOrder(order))
      list.sort((a, b) => {
        const bTime = toTimeValue(b.createdAt || b.startTime)
        const aTime = toTimeValue(a.createdAt || a.startTime)
        return bTime - aTime
      })
      if (data.status && data.status !== 'all') list = list.filter((order) => order.status === data.status)
      if (data.statusGroup === 'waiting_service') list = list.filter((order) => ['assigned', 'in_service', 'day_completed'].includes(order.status))
      const orderKeyword = safeText(data.orderKeyword || data.keyword || data.orderNo).trim().toLowerCase()
      if (orderKeyword) {
        list = list.filter((order) => [
          order._id,
          order.orderNo,
          order.petName,
          order.serviceSummary,
          order.serviceAddress,
          order.staffName,
          order.requestedStaffName
        ].some((val) => safeText(val).toLowerCase().includes(orderKeyword)))
      }
      const startDate = safeText(data.startDate).trim()
      const endDate = safeText(data.endDate).trim()
      if (startDate) {
        list = list.filter((order) => {
          const start = String(order.serviceStartDate || order.startTime || order.createdAt || '').slice(0, 10)
          const end = String(order.serviceEndDate || order.endTime || start).slice(0, 10)
          return end >= startDate
        })
      }
      if (endDate) {
        list = list.filter((order) => {
          const start = String(order.serviceStartDate || order.startTime || order.createdAt || '').slice(0, 10)
          return start <= endDate
        })
      }
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      const levels = await getMemberLevels()
      const userCache = new Map()
      const isStaffOnly = role === 'staff' && !user.roles.includes('admin')
      if (wantsPage) {
        const page = paginateList(list, data)
        const enrichedList = await Promise.all(page.list.map((order) => attachOrderDisplayData(order, levels, userCache)))
        return { ...page, list: isStaffOnly ? enrichedList.map(maskOrderClientContact) : enrichedList }
      }
      const enrichedList = await Promise.all(list.map((order) => attachOrderDisplayData(order, levels, userCache)))
      return isStaffOnly ? enrichedList.map(maskOrderClientContact) : enrichedList
    }

    if (action === 'getOrderDetail') {
      const orderId = data.id || data.orderId
      const { user, order } = await getOrderForAccess(openid, orderId)
      const levels = await getMemberLevels()
      const displayOrder = await attachOrderDisplayData(order, levels)
      const [earlyStart, securityRes, checkinsRes, tracksRes] = await Promise.all([
        getPendingEarlyStart(orderId).then((pending) => pending || getApprovedEarlyStart(orderId) || getLatestEarlyStart(orderId)),
        db.collection('order_home_security').where({ orderId }).limit(1).get(),
        db.collection('checkin_logs').where({ orderId }).get(),
        db.collection('track_logs').where({ orderId }).get()
      ])
      const activeSession = getActiveServiceSession(order)
      const sessionStartedAt = toTimeValue(order.currentSessionStartedAt || (activeSession && activeSession.startedAt) || order.startedAt)
      const checkinGroups = groupCheckinsByEventType((checkinsRes.data || []).filter((item) => {
        if (item.eventType === 'sanitization') return isValidSanitization(item, order, order.currentSessionStartedAt || (activeSession && activeSession.startedAt) || order.startedAt || now())
        if (order.status !== ORDER_STATUS.IN_SERVICE || !sessionStartedAt) return isActiveCheckin(item)
        return isActiveCheckin(item) && toTimeValue(item.recordedAt || item.serverTime || item.createdAt) >= (sessionStartedAt - 60000)
      }))
      const baseCheckinRequirements = Array.isArray(displayOrder.checkinRequirements) && displayOrder.checkinRequirements.length
        ? displayOrder.checkinRequirements
        : (Array.isArray(displayOrder.requiredCheckins) ? displayOrder.requiredCheckins : requiredCheckins(displayOrder.serviceType, displayOrder.serviceTypes)).map((eventType, index) => ({ eventType, label: checkinEventText(eventType), required: true, serviceTypes: displayOrder.serviceTypes || [displayOrder.serviceType], sortOrder: (index + 1) * 10 }))
      const checkinRequirements = baseCheckinRequirements.some((item) => item.eventType === 'pet_beauty_photo')
        ? baseCheckinRequirements
        : baseCheckinRequirements.concat([{ eventType: 'pet_beauty_photo', label: checkinEventText('pet_beauty_photo'), required: false, optional: true, serviceTypes: displayOrder.serviceTypes || [displayOrder.serviceType], sortOrder: 999 }])
      const orderSecurity = securityRes.data[0] || displayOrder.orderHomeSecurity || displayOrder.homeSecuritySnapshot
      const enrichedRequirements = checkinRequirements.map((item) => {
        const group = checkinGroups[item.eventType] || { count: 0, photos: [] }
        return { ...item, completed: group.count > 0, photoCount: group.count, photos: group.photos }
      })
      const resultOrder = { ...displayOrder, trackCount: (tracksRes.data || []).length, checkinPhotoCount: Object.values(checkinGroups).reduce((sum, group) => sum + group.count, 0), checkinRequirements: enrichedRequirements, earlyStartRequest: toEarlyStartView(earlyStart), orderHomeSecurity: toPublicOrderHomeSecurity(orderSecurity) }
      const requestedRole = safeText(data.role).trim()
      const isStaffView = requestedRole === 'staff' || user.activeRole === 'staff' || (order.clientOpenid !== openid && user.roles.includes('staff'))
      const isStaffPreview = isStaffView && (order.status === ORDER_STATUS.PAID || order.staffOpenid !== openid)
      if (isStaffPreview) return maskOrderForStaffPreview(resultOrder)
      if (isStaffView || (!user.roles.includes('admin') && order.clientOpenid !== openid)) return maskOrderClientContact(resultOrder)
      return resultOrder
    }

    if (action === 'prepareRebook') {
      const { order } = await requireClientOrder(openid, data.orderId, '无权再次预约')
      let publishMode = order.publishMode === 'direct' ? 'direct' : 'open'
      let staffProfileId = order.requestedStaffProfileId || order.staffProfileId || ''
      if (publishMode === 'direct' && staffProfileId) {
        try {
          const settings = await getSystemSettings().catch(() => ({}))
          const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
          if (!profileRes.data || !canTakeOrders(profileRes.data, settings.staffDeposit)) {
            publishMode = 'open'
            staffProfileId = ''
          }
        } catch (error) {
          publishMode = 'open'
          staffProfileId = ''
        }
      }
      return {
        sourceOrderId: order._id,
        petId: order.petId,
        petIds: Array.isArray(order.petIds) && order.petIds.length ? order.petIds : [order.petId].filter(Boolean),
        serviceType: order.serviceType,
        serviceTypes: order.serviceTypes || [order.serviceType],
        serviceAddress: order.serviceAddress || '',
        addressDetail: order.addressDetail || '',
        doorplate: order.doorplate || '',
        addressLatitude: Number(order.addressLatitude || 0),
        addressLongitude: Number(order.addressLongitude || 0),
        durationMinutes: Number(order.durationMinutes || 60),
        petServiceDurations: Array.isArray(order.petServiceDurations) ? order.petServiceDurations : (order.priceSnapshot && Array.isArray(order.priceSnapshot.petServiceDurations) ? order.priceSnapshot.petServiceDurations : []),
        publishMode,
        staffProfileId
      }
    }

    if (action === 'getOrderTimeline') {
      await getOrderForAccess(openid, data.orderId)
      const res = await db.collection('order_timeline').where({ orderId: data.orderId }).orderBy('createdAt', 'asc').get()
      return res.data
    }

    if (action === 'getOrderReview') {
      await getOrderForAccess(openid, data.orderId)
      const res = await db.collection('service_reviews').where({ orderId: data.orderId, status: 'visible' }).limit(1).get()
      return res.data[0] || null
    }

    if (action === 'createReview') {
      const { user, order } = await requireClientOrder(openid, data.orderId, '仅宠物主可评价')
      if (order.status !== 'completed') throw new Error('订单完成后才可评价')
      const existing = await db.collection('service_reviews').where({ orderId: data.orderId }).limit(1).get()
      if (existing.data[0]) throw new Error('该订单已评价')
      const rating = Math.min(Math.max(Number(data.rating || 5), 1), 5)
      const tags = Array.isArray(data.tags) ? data.tags.slice(0, 8) : []
      const content = String(data.content || '').trim()
      const reviewText = [content, ...tags].filter(Boolean).join(' ')
      if (reviewText) {
        await checkTextSecurity(openid, reviewText, { scene: 2, label: '评价内容' })
      }
      const time = now()
      const enrichedUser = await enrichUserMemberLevel(user)
      const review = {
        orderId: data.orderId,
        clientUserId: user._id,
        clientOpenid: openid,
        clientName: user.nickname || '',
        clientAvatarUrl: user.avatarUrl || '',
        memberLevelName: enrichedUser.memberLevelName || '普通会员',
        badgeTag: enrichedUser.badgeTag || 'V1',
        badgeStyle: enrichedUser.badgeStyle || 'gold',
        nameColor: enrichedUser.nameColor || '',
        nameEffect: enrichedUser.nameEffect || '',
        staffUserId: order.staffUserId || '',
        staffOpenid: order.staffOpenid || '',
        staffProfileId: order.staffProfileId || '',
        rating,
        tags,
        content,
        status: 'visible',
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('service_reviews').add({ data: review })
      await db.collection('orders').doc(data.orderId).update({ data: { reviewedAt: time, updatedAt: time } })
      await updateStaffRatingStats(order.staffProfileId, time)
      await appendOrderTimeline(data.orderId, 'reviewed', '宠物主已评价', `${rating}星评价`, 'client')
      await addPoints(openid, user._id, 10, 'order_review', data.orderId, '评价订单 +10 积分', { applyMultiplier: true, baseDelta: 10 })
      return { _id: created._id, ...review }
    }

    if (action === 'getCancelQuote') {
      const { order } = await requireClientOrder(openid, data.orderId, '无权取消订单')
      return getCancelQuoteForOrder(order)
    }

    if (action === 'cancelOrder') {
      const clientRequestId = getClientRequestId(data)
      const { order } = await requireClientOrder(openid, data.orderId, '无权取消订单')
      if (order.status === 'cancelled') return { orderId: data.orderId, status: 'cancelled', refundStatus: order.refundStatus || '', refundAmount: Number(order.refundAmount || 0), refundNo: order.refundNo || '' }
      assertOrderTransition(order.status, ORDER_STATUS.CANCELLED, '订单状态不可取消')
      const quote = getCancelQuoteForOrder(order)
      if (!quote.canCancel) throw new Error(quote.ruleText)
      const time = now()
      const update = { status: 'cancelled', cancelReason: data.reason || '', refundStatus: quote.refundStatus, refundAmount: quote.refundAmount, canceledAt: time, updatedAt: time }
      let refund = null
      if (order.paymentStatus === 'paid' && quote.refundAmount > 0) {
        refund = await createRefundForOrder(order, quote.refundAmount, data.reason || '宠物主取消', 'client_cancel', openid, clientRequestId)
        update.paymentStatus = 'refunding'
        update.refundNo = refund.refundNo
      }
      await updateOrderWhenStatus(data.orderId, order.status, update, '订单状态不可取消')
      if (order.paymentStatus !== 'paid' && order.couponId) {
        const coupon = (await db.collection('user_coupons').doc(order.couponId).get()).data
        if (coupon && coupon.status === 'locked' && coupon.lockedOrderId === data.orderId) {
          await db.collection('user_coupons').doc(order.couponId).update({ data: { status: 'available', lockedOrderId: '', lockedAt: null, updatedAt: time } })
        }
      }
      const cancelledOrder = { ...order, _id: data.orderId, ...update }
      await appendOrderTimeline(data.orderId, 'cancelled', '订单已取消', `${quote.ruleText}，预计退款 ¥${quote.refundAmount}`, 'client')
      await appendOrderClientMessage(cancelledOrder, { eventType: 'cancelled', title: '订单已取消', detail: `${quote.ruleText}，预计退款 ¥${quote.refundAmount}`, actorRole: 'client', unreadForClient: false })
      if (refund) await appendOrderTimeline(data.orderId, 'refund_processing', '退款处理中', `退款金额 ¥${quote.refundAmount}`, 'system')
      return { orderId: data.orderId, status: 'cancelled', refundStatus: quote.refundStatus, refundAmount: quote.refundAmount, refundNo: refund ? refund.refundNo : '' }
    }

    if (action === 'requestEarlyStart') {
      const { user, order } = await requireStaffOrder(openid, data.id || data.orderId, '不是该订单员工')
      if (!['assigned', 'in_service', 'day_completed'].includes(order.status)) throw new Error('当前订单不可申请提前开始')
      if (!isBeforeServiceStart(order)) throw new Error('已到预约时间，无需申请提前开始')
      const existing = await getPendingEarlyStart(order._id)
      if (existing) return toEarlyStartView(existing)
      const time = now()
      const request = {
        orderId: order._id,
        orderNo: order.orderNo || '',
        clientOpenid: order.clientOpenid,
        staffOpenid: openid,
        staffUserId: user._id,
        status: 'pending',
        reason: safeText(data.reason).trim() || '宠护师已到达，申请提前开始服务',
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('order_early_start_requests').add({ data: request })
      await appendOrderTimeline(order._id, 'early_start_requested', '宠护师申请提前开始', request.reason, 'staff')
      await appendOrderClientMessage(order, { eventType: 'early_start_requested', title: '宠护师申请提前开始', detail: request.reason, actorRole: 'staff' })
      await notifyOrder(order.clientOpenid, 'serviceStart', order, {
        statusText: '待确认提前开始',
        tip: '宠护师已到达，申请提前开始服务，请点击确认'
      }, 'client')
      return toEarlyStartView({ _id: created._id, ...request })
    }

    if (action === 'approveEarlyStart' || action === 'rejectEarlyStart') {
      const { order } = await requireClientOrder(openid, data.id || data.orderId, '仅宠物主可处理提前开始申请')
      const request = await getPendingEarlyStart(order._id)
      if (!request) throw new Error('暂无待处理的提前开始申请')
      const approved = action === 'approveEarlyStart'
      const time = now()
      const update = { status: approved ? 'approved' : 'rejected', clientRemark: safeText(data.remark).trim(), updatedAt: time }
      if (approved) update.approvedAt = time
      else update.rejectedAt = time
      await db.collection('order_early_start_requests').doc(request._id).update({ data: update })
      await appendOrderTimeline(order._id, approved ? 'early_start_approved' : 'early_start_rejected', approved ? '宠物主已同意提前开始' : '宠物主已拒绝提前开始', update.clientRemark, 'client')
      await appendOrderStaffMessage(order, {
        eventType: approved ? 'early_start_approved' : 'early_start_rejected',
        title: approved ? '宠物主已同意提前开始' : '宠物主已拒绝提前开始',
        detail: approved ? '宠物主已同意提前开始服务，现在可以开始服务。' : '宠物主已拒绝提前开始服务，请按预约时间开始。',
        actorRole: 'client',
        idempotencyKey: makeIdempotencyKey('order_staff_message', order._id, approved ? 'early_start_approved' : 'early_start_rejected', request._id)
      })
      await notifyOrder(order.staffOpenid, 'serviceStart', order, {
        statusText: approved ? '已同意提前开始' : '已拒绝提前开始',
        tip: approved ? '宠物主已同意提前开始服务，可以开始服务' : '宠物主已拒绝提前开始服务，请按原约定时间开始'
      }, 'staff')
      return toEarlyStartView({ ...request, ...update })
    }

    if (action === 'getEarlyStartStatus') {
      await getOrderForAccess(openid, data.id || data.orderId)
      const request = await getPendingEarlyStart(data.id || data.orderId) || await getApprovedEarlyStart(data.id || data.orderId) || await getLatestEarlyStart(data.id || data.orderId)
      return toEarlyStartView(request)
    }

    if (action === 'getActiveService') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) return null
      const active = await findActiveStaffService(openid)
      if (!active) return null
      return {
        orderId: active._id,
        orderNo: active.orderNo || '',
        petName: active.petName || '',
        serviceSummary: active.serviceSummary || '',
        currentSessionStartedAt: active.currentSessionStartedAt || active.startedAt || '',
        activeSessionIndex: active.activeSessionIndex || 1,
        sessionCount: active.sessionCount || normalizeServiceSessions(active).length || 1
      }
    }

    if (action === 'checkServiceTimeReadyForCheckin') {
      const { order } = await requireStaffOrder(openid, data.id || data.orderId, '不是该订单员工')
      if (![ORDER_STATUS.ASSIGNED, ORDER_STATUS.DAY_COMPLETED].includes(order.status)) throw new Error('当前订单状态不可进行服务前打卡')
      const time = now()
      const session = getNextPendingServiceSession({ ...order, _id: data.id || data.orderId }, time)
      if (!session) throw new Error('暂无可开始的当天服务任务')
      if (!(await canStartOrderSession({ ...order, _id: data.id || data.orderId }, session, time))) throw new Error('服务时间未到，可申请提前开始')
      return { canStart: true, session }
    }

    if (action === 'checkStartServiceReadiness') {
      const { order } = await requireStaffOrder(openid, data.id, '不是该订单员工')
      const time = now()
      const readiness = {
        canStart: true,
        issues: [],
        order: { id: data.id, status: order.status }
      }

      // 检查订单状态
      if (order.status === 'in_service') {
        readiness.canStart = false
        readiness.issues.push({ type: 'already_started', message: '服务已开始' })
        return readiness
      }

      if (![ORDER_STATUS.ASSIGNED, ORDER_STATUS.DAY_COMPLETED].includes(order.status)) {
        readiness.canStart = false
        readiness.issues.push({ type: 'wrong_status', message: '订单状态不可开始' })
        return readiness
      }

      const activeConflict = await findActiveStaffService(openid, data.id)
      if (activeConflict) {
        readiness.canStart = false
        readiness.issues.push({ type: 'active_service_conflict', message: '当前已有订单正在服务中，请先完成该订单后再开始新的服务', orderId: activeConflict._id, orderNo: activeConflict.orderNo || '', petName: activeConflict.petName || '' })
        return readiness
      }

      const currentSession = getNextPendingServiceSession({ ...order, _id: data.id }, time)
      if (!currentSession) {
        readiness.canStart = false
        readiness.issues.push({ type: 'no_session', message: '暂无可开始的当天服务任务' })
        return readiness
      }

      // 检查服务时间
      if (!(await canStartOrderSession({ ...order, _id: data.id }, currentSession, time))) {
        readiness.canStart = false
        readiness.issues.push({ type: 'time_not_ready', message: '服务时间未到，可申请提前开始' })
      }

      // 检查位置
      const currentLat = Number(data.currentLatitude)
      const currentLng = Number(data.currentLongitude)
      if (!hasCoordinate(currentLat, currentLng)) {
        readiness.canStart = false
        readiness.issues.push({ type: 'no_location', message: '请允许获取当前位置' })
      } else {
        const orderLat = Number(order.serviceLatitude || order.addressLatitude || 0)
        const orderLng = Number(order.serviceLongitude || order.addressLongitude || 0)
        if (hasCoordinate(orderLat, orderLng)) {
          const distanceToService = calcDistanceKm(currentLat, currentLng, orderLat, orderLng)
          const maxStartDistanceKm = 0.5
          if (distanceToService !== null && distanceToService > maxStartDistanceKm) {
            readiness.canStart = false
            readiness.issues.push({
              type: 'too_far',
              message: `请到达服务地址附近再开始服务（当前距离约 ${formatDistance(distanceToService)}）`,
              distance: distanceToService
            })
          }
        }
      }

      // 检查消毒打卡
      if (requiresSanitization(order)) {
        try {
          await requireSanitizationEvidence({ ...order, _id: data.id }, time)
        } catch (error) {
          readiness.canStart = false
          readiness.issues.push({
            type: 'missing_sanitization',
            message: error.message || '请先完成消毒拍照打卡'
          })
        }
      }

      return readiness
    }

    if (action === 'startService') {
      const { order } = await requireStaffOrder(openid, data.id, '不是该订单员工')
      if (order.status === 'in_service') return { id: data.id, status: order.status }
      assertOrderTransition(order.status, ORDER_STATUS.IN_SERVICE, '订单状态不可开始')
      const time = now()
      const activeConflict = await findActiveStaffService(openid, data.id)
      if (activeConflict) throw new Error(`当前已有订单正在服务中，请先完成${activeConflict.petName ? activeConflict.petName + '的' : ''}订单后再开始新的服务`)
      const currentSession = getNextPendingServiceSession({ ...order, _id: data.id }, time)
      if (!currentSession) throw new Error('暂无可开始的当天服务任务')
      if (!(await canStartOrderSession({ ...order, _id: data.id }, currentSession, time))) throw new Error('服务时间未到，可申请提前开始')

      await requireSanitizationEvidence({ ...order, _id: data.id }, time)

      const currentLat = Number(data.currentLatitude)
      const currentLng = Number(data.currentLongitude)
      const orderLat = Number(order.serviceLatitude || order.addressLatitude || 0)
      const orderLng = Number(order.serviceLongitude || order.addressLongitude || 0)
      let distanceToService = 0
      if (hasCoordinate(currentLat, currentLng) && hasCoordinate(orderLat, orderLng)) {
        distanceToService = calcDistanceKm(currentLat, currentLng, orderLat, orderLng)
        const maxStartDistanceKm = 0.5 // 500米
        if (distanceToService !== null && distanceToService > maxStartDistanceKm) {
          throw new Error(`请到达服务地址附近再开始服务（当前距离约 ${formatDistance(distanceToService)}）`)
        }
      }

      const serviceSessions = markServiceSession(normalizeServiceSessions(order), currentSession.index, { status: 'in_service', startedAt: time, finishedAt: '' })
      const startServiceUpdate = {
        status: ORDER_STATUS.IN_SERVICE,
        startedAt: order.startedAt || time,
        currentSessionStartedAt: time,
        activeSessionIndex: currentSession.index,
        activeSessionDate: currentSession.date,
        serviceSessions,
        updatedAt: time
      }
      if (hasCoordinate(currentLat, currentLng)) {
        startServiceUpdate.startLocationLatitude = currentLat
        startServiceUpdate.startLocationLongitude = currentLng
      }
      if (distanceToService !== null && !isNaN(distanceToService)) {
        startServiceUpdate.startDistanceKm = distanceToService
      }

      await updateOrderWhenStatus(data.id, order.status, startServiceUpdate, '订单状态不可开始服务')
      const startedOrder = { ...order, _id: data.id, status: ORDER_STATUS.IN_SERVICE, currentSessionStartedAt: time, serviceSessions, updatedAt: time }
      await appendOrderTimeline(data.id, 'started', currentSession.index > 1 ? `第${currentSession.index}天服务已开始` : '服务已开始', '', 'staff')
      await appendOrderClientMessage(startedOrder, { eventType: 'started', title: currentSession.index > 1 ? `第${currentSession.index}天服务已开始` : '服务已开始', detail: '宠护师已开始服务', actorRole: 'staff' })
      await notifyOrder(order.clientOpenid, 'serviceStart', order, { statusText: '服务中' })
      return { id: data.id, status: ORDER_STATUS.IN_SERVICE, activeSessionIndex: currentSession.index, currentSessionStartedAt: time }
    }

    if (action === 'finishService') {
      const { order } = await requireStaffOrder(openid, data.id, '不是该订单员工')
      if (order.status === 'completed') return { id: data.id, completedOrderCount: Number((await getUser(order.clientOpenid)).completedOrderCount || 0) }
      assertOrderTransition(order.status, ORDER_STATUS.COMPLETED, '订单状态不可完成')
      const activeSession = getActiveServiceSession(order) || getTodayServiceSession(order, order.currentSessionStartedAt || order.startedAt || now()) || normalizeServiceSessions(order)[0] || { index: 1, date: beijingDateKey(order.startedAt || now()), startedAt: order.currentSessionStartedAt || order.startedAt || '' }
      const sessionStartedAt = toTimeValue(order.currentSessionStartedAt || (activeSession && activeSession.startedAt) || order.startedAt)
      const checkinResult = await evaluateCheckinCompletion({ ...order, _id: data.id }, sessionStartedAt)
      if (!checkinResult.isComplete) {
        throw new Error(`缺少必打卡照片：${checkinResult.missing.join('、')}`)
      }
      return completeOrderService({ ...order, _id: data.id }, activeSession, now(), { isAuto: false, actor: 'staff' })
    }

    if (action === 'checkOverdueOrders') {
      const unstarted = await processOverdueUnstartedOrders()
      const unfinished = await processOverdueUnfinishedOrders()
      return { unstartedCount: unstarted.length, unfinishedCount: unfinished.length, unstarted, unfinished }
    }

    if (action === 'getServiceReport') {
      const order = (await getOrderForAccess(openid, data.id)).order
      const tracks = await db.collection('track_logs').where({ orderId: data.id }).orderBy('recordedAt', 'asc').get()
      const checkins = await db.collection('checkin_logs').where({ orderId: data.id }).orderBy('createdAt', 'asc').get()
      return { order, tracks: tracks.data, checkins: (checkins.data || []).filter(isActiveCheckin) }
    }
    if (action === 'listPublicCompletedOrders') {
      const serviceType = safeText(data.serviceType).trim()
      const ordersRes = await db.collection('orders').where({ status: ORDER_STATUS.COMPLETED }).orderBy('completedAt', 'desc').get()
      let orders = (ordersRes.data || []).filter((order) => !isAdminDeletedOrder(order))
      if (serviceType) orders = orders.filter((order) => order.serviceType === serviceType || (Array.isArray(order.serviceTypes) && order.serviceTypes.includes(serviceType)))
      const wantsPage = data.page !== undefined
      const pageData = wantsPage ? paginateList(orders, data) : { list: orders.slice(0, Math.min(Math.max(Math.round(Number(data.pageSize || 20)), 1), 50)) }
      const orderIds = pageData.list.map((order) => order._id).filter(Boolean)
      const [reviews, checkins, staffProfiles, users] = await Promise.all([
        orderIds.length ? safeCollectionData('service_reviews', (col) => col.where({ status: 'visible' })) : Promise.resolve([]),
        orderIds.length ? safeCollectionData('checkin_logs') : Promise.resolve([]),
        safeCollectionData('staff_profiles'),
        safeCollectionData('users')
      ])
      const reviewMap = reviews
        .filter((review) => orderIds.includes(review.orderId))
        .reduce((map, review) => ({ ...map, [review.orderId]: review }), {})
      const checkinMap = checkins
        .filter((checkin) => orderIds.includes(checkin.orderId))
        .reduce((map, checkin) => ({ ...map, [checkin.orderId]: [...(map[checkin.orderId] || []), checkin] }), {})
      const staffProfileMap = staffProfiles.reduce((map, profile) => ({ ...map, [profile._id]: profile }), {})
      const userMap = users.reduce((map, user) => ({ ...map, [user.openid]: user }), {})
      const list = await Promise.all(pageData.list.map(async (order) => {
        const displayOrder = await attachClientSnapshot(order)
        return toHomeOrderActivity(displayOrder, {
          review: reviewMap[order._id] || null,
          checkins: (checkinMap[order._id] || []).filter(isActiveCheckin).sort((a, b) => toTimeValue(a.createdAt || a.recordedAt) - toTimeValue(b.createdAt || b.recordedAt)),
          staffProfile: staffProfileMap[order.staffProfileId || order.requestedStaffProfileId] || {},
          hideCheckinPhotos: shouldHidePublicCheckinPhotos(userMap[order.clientOpenid])
        })
      }))
      return wantsPage ? { ...pageData, list } : list
    }
    if (action === 'getPublicCompletedOrderDetail') {
      const orderId = safeText(data.id || data.orderId).trim()
      const order = (await db.collection('orders').doc(orderId).get()).data
      if (!order || order.status !== ORDER_STATUS.COMPLETED) throw new Error('订单不可查看')
      const [reviewRes, checkinsRes, clientRes] = await Promise.all([
        db.collection('service_reviews').where({ orderId, status: 'visible' }).limit(1).get(),
        db.collection('checkin_logs').where({ orderId }).orderBy('createdAt', 'asc').get(),
        order.clientOpenid ? db.collection('users').where({ openid: order.clientOpenid }).limit(1).get() : Promise.resolve({ data: [] })
      ])
      const staffProfileId = order.staffProfileId || order.requestedStaffProfileId || ''
      let staffProfile = {}
      if (staffProfileId) {
        staffProfile = (await db.collection('staff_profiles').doc(staffProfileId).get()).data || {}
      }
      const displayOrder = await attachClientSnapshot(order)
      return toHomeOrderActivity(displayOrder, {
        review: reviewRes.data[0] || null,
        checkins: (checkinsRes.data || []).filter(isActiveCheckin),
        staffProfile,
        hideCheckinPhotos: shouldHidePublicCheckinPhotos(clientRes.data[0])
      })
    }
    throw new Error('未知 order 操作')
  },

  async coupon(openid, action, data) {
    if (action === 'listMyCoupons') {
      await getUser(openid)
      const res = await db.collection('user_coupons').where({ openid }).get()
      const statusFilter = data.status || 'available'
      return (res.data || [])
        .map((coupon) => formatUserCoupon(coupon))
        .filter((coupon) => statusFilter === 'all' || coupon.status === statusFilter)
        .sort((a, b) => String(a.validTo || '').localeCompare(String(b.validTo || '')))
    }

    if (action === 'listMallCoupons') {
      await getUser(openid)
      const coupons = (await db.collection('user_coupons').where({ openid }).get()).data || []
      const pricing = calcMallPricing(Array.isArray(data.items) ? data.items : [])
      return coupons
        .filter((coupon) => ['mall', 'all'].includes(normalizeCouponSnapshot(coupon).usageScope))
        .map((coupon) => {
          const result = evaluateCoupon(coupon, pricing, openid)
          return formatUserCoupon(coupon, {
            status: couponDisplayStatus(coupon),
            applicable: result.applicable,
            reason: result.reason || '',
            payAmountAfterDiscount: result.applicable ? Math.max(pricing.amount - result.discountAmount, 0) : pricing.amount
          })
        })
        .sort((a, b) => Number(b.applicable) - Number(a.applicable) || String(a.validTo || '').localeCompare(String(b.validTo || '')))
    }

    if (action === 'claimNewbieCoupon') {
      const user = await getUser(openid)
      const templateId = safeText(data.templateId).trim()
      if (!templateId) throw new Error('请选择新人优惠券')
      const template = (await db.collection('coupon_templates').doc(templateId).get()).data
      if (!template || template.enabled === false || template.newbieOnly !== true) throw new Error('新人优惠券不可领取')
      const issued = await issueCouponToTargetUser(template, user)
      return { _id: issued._id, templateId, status: 'available', templateSnapshot: issued.templateSnapshot, validFrom: issued.validFrom, validTo: issued.validTo }
    }

    if (action === 'listApplicableCoupons') {
      await getUser(openid)
      let pets = []
      const petIds = normalizePetIds(data)
      if (petIds.length) pets = await getClientPetsByIds(openid, petIds)
      const pricing = await calcOrderPricing({ ...data, couponId: '', autoApplyCoupon: false }, pets, { openid })
      const coupons = (await db.collection('user_coupons').where({ openid }).get()).data || []
      return coupons
        .filter((coupon) => ['service', 'all'].includes(normalizeCouponSnapshot(coupon).usageScope))
        .map((coupon) => {
          const result = evaluateCoupon(coupon, pricing, openid)
          return formatUserCoupon(coupon, {
            status: couponDisplayStatus(coupon),
            applicable: result.applicable,
            reason: result.reason || '',
            payAmountAfterDiscount: result.applicable ? Math.max(pricing.amount - result.discountAmount, 0) : pricing.amount
          })
        })
        .sort((a, b) => Number(b.applicable) - Number(a.applicable) || String(a.validTo || '').localeCompare(String(b.validTo || '')))
    }

    throw new Error('未知 coupon 操作')
  },

  async memberLevel(openid, action, data) {
    if (action === 'listLevels') {
      const levels = await getMemberLevels()
      return levels.map((level, idx) => ({
        ...level,
        badgeTag: normalizeMemberBadgeTag(level.badgeTag) || `V${idx + 1}`,
        nameColor: normalizeMemberNameColor(level.nameColor),
        nameEffect: normalizeMemberNameEffect(level.nameEffect),
        badgeStyle: normalizeMemberBadgeStyle(level.badgeStyle),
        pointMultiplier: Math.max(Number(level.pointMultiplier || 1), 1),
        description: safeText(level.description).trim(),
        benefits: normalizeBenefits(level.benefits)
      }))
    }
    if (action === 'myInfo') {
      const user = await getUser(openid)
      const page = Math.max(Number(data.page || 1), 1)
      const pageSize = 20
      const logsRes = await db.collection('point_logs').where({ openid }).orderBy('createdAt', 'desc').limit(page * pageSize).get()
      const countRes = await db.collection('point_logs').where({ openid }).count()
      const allLogs = logsRes.data || []
      const logs = allLogs.slice((page - 1) * pageSize, page * pageSize)
      const levels = (await getMemberLevels()).map((level, idx) => ({
        ...level,
        badgeTag: normalizeMemberBadgeTag(level.badgeTag) || `V${idx + 1}`,
        nameColor: normalizeMemberNameColor(level.nameColor),
        nameEffect: normalizeMemberNameEffect(level.nameEffect),
        badgeStyle: normalizeMemberBadgeStyle(level.badgeStyle),
        pointMultiplier: Math.max(Number(level.pointMultiplier || 1), 1),
        description: safeText(level.description).trim(),
        benefits: normalizeBenefits(level.benefits)
      }))
      const currentLevel = levels.find((level) => level._id === user.memberLevel) || null
      const nextLevel = levels.find((level) => Number(level.minPoints || 0) > Number(user.totalPoints || 0)) || null
      return {
        points: Number(user.points || 0),
        totalPoints: Number(user.totalPoints || 0),
        memberLevel: user.memberLevel || '',
        memberLevelName: user.memberLevelName || '普通会员',
        pointMultiplier: currentLevel ? Math.max(Number(currentLevel.pointMultiplier || 1), 1) : 1,
        retroCardCount: Number(user.retroCardCount || 0),
        inviteCode: safeText(user.inviteCode).trim(),
        inviterOpenid: safeText(user.inviterOpenid).trim(),
        currentLevel,
        nextLevel,
        levels,
        logs,
        total: countRes.total || 0,
        page,
        pageSize
      }
    }
    throw new Error('未知 memberLevel 操作')
  },

  async rewardMail(openid, action, data) {
    if (action === 'getUnreadCount') {
      await getUser(openid)
      const mailsRes = await db.collection('reward_mails').where({ openid }).get()
      const mails = mailsRes.data || []
      return {
        unreadCount: mails.filter((mail) => !mail.readAt).length,
        unclaimedCount: mails.filter((mail) => !mail.claimedAt).length
      }
    }
    if (action === 'listMyMails') {
      await getUser(openid)
      const mailsRes = await db.collection('reward_mails').where({ openid }).orderBy('createdAt', 'desc').get()
      return (mailsRes.data || []).map(formatRewardMail)
    }
    if (action === 'markRead') {
      await getUser(openid)
      const id = safeText(data.id).trim()
      if (!id) throw new Error('缺少邮件 ID')
      const mail = (await db.collection('reward_mails').doc(id).get()).data
      if (!mail || mail.openid !== openid) throw new Error('奖励邮件不存在')
      if (mail.readAt) return formatRewardMail(mail)
      const updated = { readAt: now(), updatedAt: now() }
      await db.collection('reward_mails').doc(id).update({ data: updated })
      return formatRewardMail({ ...mail, ...updated })
    }
    if (action === 'claimReward') {
      const user = await getUser(openid)
      const id = safeText(data.id).trim()
      if (!id) throw new Error('缺少邮件 ID')
      const mail = (await db.collection('reward_mails').doc(id).get()).data
      if (!mail || mail.openid !== openid) throw new Error('奖励邮件不存在')
      if (mail.claimedAt) return formatRewardMail(mail)
      const claimTime = now()
      const claimed = await db.collection('reward_mails').where({ _id: id, openid, claimedAt: null }).update({ data: { readAt: mail.readAt || claimTime, claimedAt: claimTime, updatedAt: claimTime } })
      if (!claimed.stats || !claimed.stats.updated) throw new Error('奖励已领取，请刷新后查看')
      const reward = mail.reward || {}
      let pointsResult = null
      let couponResult = null
      let retroCardResult = null
      try {
        if (reward.type === 'coupon') {
          const templateId = safeText(reward.couponTemplateId).trim()
          if (!templateId) throw new Error('奖励优惠券不存在')
          const template = (await db.collection('coupon_templates').doc(templateId).get()).data
          couponResult = await issueCouponToTargetUser(template, user, {
            adminUserId: safeText(mail.sentByAdminUserId).trim(),
            adminOpenid: safeText(mail.sentByAdminOpenid).trim()
          })
        } else if (reward.type === 'retro_card') {
          const count = Math.max(Math.round(Number(reward.count || 0)), 0)
          if (!count) throw new Error('补签卡奖励数量无效')
          retroCardResult = await getRewardMailRetroCardGrant(openid, id)
          if (!retroCardResult) {
            retroCardResult = await grantRetroCards(openid, user._id, count, 'reward_mail', id, safeText(mail.title).trim() || '奖励邮件补签卡')
          }
        } else {
          const delta = Math.max(Math.round(Number(reward.points || 0)), 0)
          if (delta > 0) {
            pointsResult = await addPoints(openid, user._id, delta, 'reward_mail', id, safeText(mail.title).trim() || '奖励邮件积分', { baseDelta: delta })
          }
        }
      } catch (error) {
        await db.collection('reward_mails').doc(id).update({ data: { claimedAt: null, updatedAt: now() } })
        throw error
      }
      const updated = {
        readAt: mail.readAt || claimTime,
        claimedAt: claimTime,
        rewardClaimResult: {
          pointsDelta: pointsResult ? pointsResult.delta : 0,
          couponId: couponResult ? couponResult._id : '',
          retroCardCountDelta: retroCardResult ? Math.max(Math.round(Number(reward.count || 0)), 0) : 0,
          retroCardBalance: retroCardResult ? retroCardResult.balance : 0
        },
        updatedAt: now()
      }
      await resetRewardClaimResultField(id)
      await db.collection('reward_mails').doc(id).update({ data: updated })
      return formatRewardMail({ ...mail, ...updated })
    }
    throw new Error('未知 rewardMail 操作')
  },

  async lottery(openid, action, data) {
    if (action === 'getActiveActivity') {
      // 不要求登录，首页可公开展示活动信息；已登录时返回今日剩余抽奖次数
      const res = await db.collection('lottery_activities').where({ enabled: true }).limit(1).get()
      const activity = res.data[0] || null
      if (!activity) return null

      let remainingDrawCount = openid ? 1 : 0
      if (openid) {
        const todayStart = cstTodayStart()
        const todayRecord = await db.collection('lottery_records')
          .where({ openid, activityId: activity._id })
          .orderBy('createdAt', 'desc')
          .limit(1)
          .get()
        if (todayRecord.data[0] && new Date(todayRecord.data[0].createdAt).getTime() >= todayStart.getTime()) {
          remainingDrawCount = 0
        }
      }

      return {
        _id: activity._id,
        name: activity.name,
        description: activity.description || '',
        prizeCount: (activity.prizes || []).length,
        remainingDrawCount,
        canDraw: remainingDrawCount > 0
      }
    }
    if (action === 'listMyRecords') {
      const user = await getUser(openid)
      const pageSize = Math.min(Math.max(Math.round(Number(data.pageSize || 20)), 1), 50)
      const records = await db.collection('lottery_records')
        .where({ openid: user.openid || openid })
        .orderBy('createdAt', 'desc')
        .limit(pageSize)
        .get()
      return (records.data || []).map((item) => ({
        _id: item._id,
        activityId: item.activityId || '',
        prizeName: item.prizeName || '谢谢参与',
        couponId: item.couponId || '',
        createdAt: item.createdAt || ''
      }))
    }
    if (action === 'draw') {
      const user = await getUser(openid)
      const activityRes = await db.collection('lottery_activities').where({ enabled: true }).limit(1).get()
      const activity = activityRes.data[0]
      if (!activity) throw new Error('当前没有进行中的抽奖活动')

      // 防竞态：先写抽奖记录占位，再判断今日是否已抽
      const todayStart = cstTodayStart()
      const todayRecord = await db.collection('lottery_records')
        .where({ openid, activityId: activity._id })
        .orderBy('createdAt', 'desc').limit(1).get()
      if (todayRecord.data[0] && new Date(todayRecord.data[0].createdAt).getTime() >= todayStart.getTime()) {
        throw new Error('今天已参与过本次抽奖')
      }

      // 重新从数据库读取最新 activity 数据，防止库存基于旧内存
      const freshActivity = (await db.collection('lottery_activities').doc(activity._id).get()).data
      const prizes = (freshActivity.prizes || []).filter((p) => Number(p.stockLeft || 0) > 0)
      if (!prizes.length) throw new Error('奖品已被领完')

      // 按概率抽取，用 index 而非 templateId 匹配，避免同模板多奖品误扣
      const rand = Math.random() * prizes.reduce((sum, p) => sum + Number(p.probability || 0), 0)
      let cumulative = 0
      let prizeIndex = prizes.length - 1
      for (let i = 0; i < prizes.length; i++) {
        cumulative += Number(prizes[i].probability || 0)
        if (rand <= cumulative) { prizeIndex = i; break }
      }
      const prize = prizes[prizeIndex]

      // 找到该奖品在原始 prizes 数组中的位置（按 name+templateId 精确匹配第一个库存>0的）
      let originalIndex = -1
      let matchCount = 0
      for (let i = 0; i < freshActivity.prizes.length; i++) {
        const p = freshActivity.prizes[i]
        if (p.name === prize.name && p.templateId === prize.templateId && Number(p.stockLeft || 0) > 0) {
          if (matchCount === prizeIndex - prizes.indexOf(prize)) { originalIndex = i; break }
          matchCount++
        }
      }
      // 降级：找第一个匹配
      if (originalIndex === -1) {
        originalIndex = freshActivity.prizes.findIndex(
          (p) => p.name === prize.name && p.templateId === prize.templateId && Number(p.stockLeft || 0) > 0
        )
      }

      const time = now()
      const validDays = 30
      const validTo = new Date(time.getTime() + validDays * 86400000)
      let couponId = ''
      let templateSnapshot = null

      if (prize.templateId) {
        const template = (await db.collection('coupon_templates').doc(prize.templateId).get()).data
        if (template && template.enabled !== false) {
          templateSnapshot = normalizeCouponSnapshot(template)
          const coupon = await db.collection('user_coupons').add({
            data: { templateId: prize.templateId, templateSnapshot, userId: user._id, openid, status: 'available', validFrom: time, validTo, lockedOrderId: '', lockedAt: null, usedOrderId: '', usedAt: null, issuedAt: time, createdAt: time, updatedAt: time }
          })
          couponId = coupon._id
          await db.collection('coupon_templates').doc(prize.templateId).update({
            data: { issuedCount: incUpdateValue(template.issuedCount, 1), updatedAt: time }
          })
        }
      }

      // 用原子操作更新指定奖品库存，避免竞态超发
      if (originalIndex !== -1) {
        const updatedPrizes = freshActivity.prizes.map((p, i) =>
          i === originalIndex ? { ...p, stockLeft: Math.max(Number(p.stockLeft || 0) - 1, 0) } : p
        )
        await db.collection('lottery_activities').doc(activity._id).update({
          data: { prizes: updatedPrizes, updatedAt: time }
        })
      }

      await db.collection('lottery_records').add({
        data: { userId: user._id, openid, activityId: activity._id, prizeTemplateId: prize.templateId || '', prizeName: prize.name || '谢谢参与', couponId, createdAt: time }
      })
      return { prizeName: prize.name || '谢谢参与', couponId, templateSnapshot }
    }
    throw new Error('未知 lottery 操作')
  },

  async mall(openid, action, data) {
    if (action === 'listCategories') {
      const res = await db.collection('mall_categories').where({ enabled: true }).get()
      return (res.data || []).map(normalizeMallCategory).sort((a, b) => a.sortOrder - b.sortOrder)
    }
    if (action === 'listProducts') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const categoryId = safeText(data.categoryId).trim()
      const res = await db.collection('mall_products').where({ status: 'on_sale' }).get()
      let list = (res.data || []).map(publicMallProduct).filter((item) => item.name)
      if (categoryId) list = list.filter((item) => item.categoryId === categoryId)
      if (keyword) list = list.filter((item) => [item.name, item.subtitle, item.specText].some((value) => safeText(value).toLowerCase().includes(keyword)))
      if (data.sort === 'price_asc') list.sort((a, b) => a.minPrice - b.minPrice)
      else if (data.sort === 'price_desc') list.sort((a, b) => b.maxPrice - a.maxPrice)
      else if (data.sort === 'sales_desc') list.sort((a, b) => b.salesCount - a.salesCount)
      else list.sort((a, b) => a.sortOrder - b.sortOrder || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      return paginateList(list, data)
    }
    if (action === 'getProductDetail') {
      const product = await getDocOrNull('mall_products', data.id || data.productId)
      if (!product || product.status !== 'on_sale') throw new Error('商品不存在或已下架')
      return publicMallProduct(product)
    }
    if (action === 'getCart') {
      await getUser(openid)
      return formatMallCart(openid)
    }
    if (action === 'updateCart') {
      await getUser(openid)
      const productId = safeText(data.productId).trim()
      if (!productId) throw new Error('请选择商品')
      if (data.operation === 'remove') {
        const cart = await loadMallCart(openid)
        await saveMallCart(openid, (cart && cart.items || []).filter((item) => !isSameMallCartItem(item, { productId, skuId: data.skuId })))
        return formatMallCart(openid)
      }
      const product = await getDocOrNull('mall_products', productId)
      if (!product || product.status !== 'on_sale') throw new Error('商品不存在或已下架')
      const normalizedProduct = normalizeMallProduct(product)
      const sku = getSkuById(normalizedProduct, data.skuId)
      if (!sku || sku.status === 'off_sale') throw new Error('商品规格不存在或已下架')
      const cart = await loadMallCart(openid)
      let items = cart && Array.isArray(cart.items) ? cart.items.slice() : []
      const target = { productId, skuId: sku.skuId }
      const index = items.findIndex((item) => isSameMallCartItem(item, target))
      const operation = safeText(data.operation).trim() || 'set'
      if (operation === 'remove') {
        items = items.filter((item) => !isSameMallCartItem(item, target))
      } else {
        const quantity = Math.min(Math.max(Math.floor(Number(data.quantity || 1)), 1), 99)
        if (quantity > Number(sku.stock || 0)) throw new Error('商品库存不足')
        const nextQuantity = operation === 'add' && index >= 0 ? Number(items[index].quantity || 0) + quantity : quantity
        if (nextQuantity > Number(sku.stock || 0)) throw new Error('商品库存不足')
        const nextItem = buildMallCartItem(normalizedProduct, sku, nextQuantity, data)
        if (index >= 0) items[index] = { ...items[index], ...nextItem }
        else items.push(nextItem)
      }
      await saveMallCart(openid, items)
      return formatMallCart(openid)
    }
    if (action === 'createOrder') {
      const user = await getUser(openid)
      if (!safeText(user.phone).trim()) throw new Error('请先绑定手机号')
      const clientRequestId = getClientRequestId(data)
      if (clientRequestId) {
        const existing = (await db.collection('mall_orders').where({ clientOpenid: openid, clientRequestId }).limit(1).get()).data[0]
        if (existing) return existing
      }
      let orderItems = []
      if (data.productId) {
        orderItems = [{ productId: safeText(data.productId).trim(), skuId: safeText(data.skuId).trim(), quantity: Math.max(Math.floor(Number(data.quantity || 1)), 1) }]
      } else {
        const cart = await formatMallCart(openid)
        orderItems = cart.items.filter((item) => item.selected !== false && !item.invalid && !item.soldOut).map((item) => ({ productId: item.productId, skuId: item.skuId || 'default', quantity: Number(item.quantity || 1) }))
      }
      if (!orderItems.length) throw new Error('请选择要购买的商品')
      const snapshotItems = []
      for (const item of orderItems) {
        const product = await getDocOrNull('mall_products', item.productId)
        if (!product || product.status !== 'on_sale') throw new Error('商品不存在或已下架')
        const normalizedProduct = normalizeMallProduct(product)
        const sku = getSkuById(normalizedProduct, item.skuId)
        if (!sku || sku.status === 'off_sale') throw new Error('商品规格不存在或已下架')
        const quantity = Math.min(Math.max(Math.floor(Number(item.quantity || 1)), 1), 99)
        if (quantity > Number(sku.stock || 0)) throw new Error(`商品库存不足：${product.name}`)
        snapshotItems.push(buildMallOrderItemSnapshot(normalizedProduct, sku, quantity))
      }
      const address = normalizeShippingAddress(data.shippingAddress || data)
      let couponResult = null
      const basePricing = calcMallPricing(snapshotItems)
      if (data.couponId) {
        const coupon = (await db.collection('user_coupons').doc(data.couponId).get()).data
        const result = evaluateCoupon(coupon, { ...basePricing, serviceTypes: ['mall'] }, openid)
        if (!result.applicable) throw new Error(result.reason)
        couponResult = result
      }
      const pricing = calcMallPricing(snapshotItems, couponResult)
      const time = now()
      const order = { orderType: 'mall', orderNo: createMallOrderNo(), clientRequestId, idempotencyKey: clientRequestId || '', clientUserId: user._id, clientOpenid: openid, clientSnapshot: createClientSnapshot(user), contactPhone: safeText(user.phone).trim(), items: snapshotItems, totalProductAmount: pricing.totalProductAmount, shippingFee: pricing.shippingFee, discountAmount: pricing.discountAmount || 0, amount: pricing.amount, payAmount: pricing.payAmount, couponId: pricing.coupon ? pricing.coupon.couponId : '', couponTemplateId: pricing.coupon ? pricing.coupon.templateId : '', couponName: pricing.coupon ? pricing.coupon.name : '', couponSnapshot: pricing.coupon ? pricing.coupon.snapshot : null, priceSnapshot: pricing.priceSnapshot, shippingAddress: address, status: 'pending_pay', paymentStatus: 'unpaid', paymentNo: '', wxTransactionId: '', refundStatus: 'none', refundReason: '', refundImages: [], refundAmount: 0, refundNo: '', expressCompany: '', trackingNo: '', shippedAt: null, receivedAt: null, createdAt: time, updatedAt: time }
      const created = await db.collection('mall_orders').add({ data: order })
      if (order.couponId) await db.collection('user_coupons').doc(order.couponId).update({ data: { status: 'locked', lockedOrderId: created._id, lockedAt: time, updatedAt: time } })
      if (!data.productId) {
        const cart = await loadMallCart(openid)
        if (cart) await saveMallCart(openid, (cart.items || []).filter((item) => !snapshotItems.some((orderItem) => isSameMallCartItem(item, orderItem))))
      }
      return { _id: created._id, ...order }
    }
    if (action === 'listMyOrders') {
      await getUser(openid)
      const status = safeText(data.status).trim()
      const res = await db.collection('mall_orders').where({ clientOpenid: openid }).orderBy('createdAt', 'desc').get()
      let list = res.data || []
      if (status && status !== 'all') list = list.filter((item) => status === 'after_sale' ? ['refund_applied', 'refunded'].includes(item.status) : item.status === status)
      return paginateList(list.map((item) => ({ ...item, statusText: mallOrderStatusText(item.status) })), data)
    }
    if (action === 'getOrderDetail') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order || order.clientOpenid !== openid) throw new Error('订单不存在')
      return { ...order, statusText: mallOrderStatusText(order.status) }
    }
    if (action === 'cancelOrder') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order || order.clientOpenid !== openid) throw new Error('订单不存在')
      if (order.status !== 'pending_pay') throw new Error('当前订单不可取消')
      const time = now()
      await db.collection('mall_orders').doc(order._id).update({ data: { status: 'cancelled', updatedAt: time } })
      if (order.couponId) await db.collection('user_coupons').doc(order.couponId).update({ data: { status: 'available', lockedOrderId: '', lockedAt: null, updatedAt: time } })
      return { orderId: order._id, status: 'cancelled' }
    }
    if (action === 'confirmReceipt') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order || order.clientOpenid !== openid) throw new Error('订单不存在')
      if (order.status !== 'shipped') throw new Error('当前订单不可确认收货')
      const time = now()
      await db.collection('mall_orders').doc(order._id).update({ data: { status: 'completed', receivedAt: time, updatedAt: time } })
      return { orderId: order._id, status: 'completed' }
    }
    if (action === 'applyRefund') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order || order.clientOpenid !== openid) throw new Error('订单不存在')
      if (!['pending_ship', 'shipped', 'completed'].includes(order.status) || order.paymentStatus !== 'paid') throw new Error('当前订单不可申请售后')
      const reason = safeText(data.reason).trim()
      if (!reason) throw new Error('请填写售后原因')
      const time = now()
      const refundImages = Array.isArray(data.images || data.refundImages) ? (data.images || data.refundImages).map(safeFileId).filter(Boolean).slice(0, 6) : []
      await db.collection('mall_orders').doc(order._id).update({ data: { status: 'refund_applied', refundStatus: 'applied', refundReason: reason, refundImages, refundAmount: Number(order.payAmount || 0), updatedAt: time } })
      return { orderId: order._id, refundStatus: 'applied' }
    }
    throw new Error('未知 mall 操作')
  },

  async adminMall(openid, action, data) {
    const admin = await requireAdmin(openid)
    if (action === 'listCategories') {
      const res = await db.collection('mall_categories').get()
      return (res.data || []).map(normalizeMallCategory).sort((a, b) => a.sortOrder - b.sortOrder)
    }
    if (action === 'saveCategory') {
      const id = safeText(data.id || data._id).trim()
      const time = now()
      const payload = { name: safeText(data.name).trim(), icon: safeText(data.icon).trim(), enabled: data.enabled !== false, sortOrder: Number(data.sortOrder || 0), updatedAt: time }
      if (!payload.name) throw new Error('分类名称不能为空')
      if (id) {
        await db.collection('mall_categories').doc(id).update({ data: payload })
        await logAdmin(admin, 'mall_category', id, 'saveCategory', payload)
        return { _id: id, ...payload }
      }
      const created = await db.collection('mall_categories').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'mall_category', created._id, 'saveCategory', payload)
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'deleteCategory') {
      const id = safeText(data.id).trim()
      if (!id) throw new Error('请选择分类')
      const products = await db.collection('mall_products').where({ categoryId: id }).get()
      if ((products.data || []).length) throw new Error('分类下已有商品，不能删除')
      await db.collection('mall_categories').doc(id).remove()
      await logAdmin(admin, 'mall_category', id, 'deleteCategory')
      return { id, deleted: true }
    }
    if (action === 'listProducts') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const status = safeText(data.status).trim()
      const res = await db.collection('mall_products').get()
      let list = (res.data || []).map(publicMallProduct)
      if (status) list = list.filter((item) => item.status === status)
      if (keyword) list = list.filter((item) => [item.name, item.subtitle, item.specText].some((value) => safeText(value).toLowerCase().includes(keyword)))
      list.sort((a, b) => a.sortOrder - b.sortOrder || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      return paginateList(list, data)
    }
    if (action === 'saveProduct') {
      const id = safeText(data.id || data._id).trim()
      const time = now()
      validateMallProductInput(data)
      const payload = normalizeMallProduct({ ...data, ...(data.specMode !== 'multi' ? { specGroups: [], skus: [] } : {}), updatedAt: time })
      delete payload._id
      if (!payload.name) throw new Error('商品名称不能为空')
      if (!payload.coverFileId && !payload.imageFileIds.length) throw new Error('请上传商品图片')
      if (payload.categoryId) {
        const category = await getDocOrNull('mall_categories', payload.categoryId)
        if (!category) throw new Error('商品分类不存在')
      }
      if (id) {
        await db.collection('mall_products').doc(id).update({ data: payload })
        await logAdmin(admin, 'mall_product', id, 'saveProduct', { name: payload.name })
        return { _id: id, ...payload }
      }
      const created = await db.collection('mall_products').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'mall_product', created._id, 'saveProduct', { name: payload.name })
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'toggleProductStatus') {
      const id = safeText(data.id || data.productId).trim()
      const status = data.status === 'off_sale' ? 'off_sale' : 'on_sale'
      if (!id) throw new Error('请选择商品')
      await db.collection('mall_products').doc(id).update({ data: { status, updatedAt: now() } })
      await logAdmin(admin, 'mall_product', id, 'toggleProductStatus', { status })
      return { id, status }
    }
    if (action === 'listOrders') {
      const status = safeText(data.status).trim()
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const res = await db.collection('mall_orders').orderBy('createdAt', 'desc').get()
      let list = res.data || []
      if (status) list = list.filter((item) => item.status === status)
      if (keyword) list = list.filter((item) => [item.orderNo, item.contactPhone, item.trackingNo, item.expressCompany].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const enriched = list.map((item) => {
        const payAmount = Number(item.payAmount || 0)
        const alreadyRefunded = Number(item.refundAmount || 0)
        const maxRefundable = Math.max(0, Math.round((payAmount - alreadyRefunded) * 100) / 100)
        return {
          ...item,
          statusText: mallOrderStatusText(item.status),
          alreadyRefunded,
          maxRefundable
        }
      })
      return paginateList(enriched, data)
    }
    if (action === 'getOrderDetail') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order) throw new Error('订单不存在')
      const payAmount = Number(order.payAmount || 0)
      const existingRefundsRes = await db.collection('refunds').where({ orderId: order._id }).get()
      const successfulRefundsAmount = (existingRefundsRes.data || [])
        .filter((r) => ['success', 'processing'].includes(r.status))
        .reduce((sum, r) => sum + Number(r.refundAmount || 0), 0)
      const alreadyRefunded = Math.max(Number(order.refundAmount || 0), successfulRefundsAmount)
      const maxRefundable = Math.max(0, Math.round((payAmount - alreadyRefunded) * 100) / 100)
      return { ...order, statusText: mallOrderStatusText(order.status), alreadyRefunded, maxRefundable }
    }
    if (action === 'shipOrder') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order) throw new Error('订单不存在')
      if (order.status !== 'pending_ship') throw new Error('当前订单不可发货')
      const expressCompany = safeText(data.expressCompany).trim()
      const trackingNo = safeText(data.trackingNo).trim()
      if (!expressCompany || !trackingNo) throw new Error('请填写快递公司和单号')
      const time = now()
      await db.collection('mall_orders').doc(order._id).update({ data: { status: 'shipped', expressCompany, trackingNo, shippedAt: time, updatedAt: time } })
      await logAdmin(admin, 'mall_order', order._id, 'shipOrder', { expressCompany, trackingNo })
      return { orderId: order._id, status: 'shipped', expressCompany, trackingNo }
    }
    if (action === 'updateOrderStatus') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const targetStatus = safeText(data.status).trim()
      const remark = safeText(data.remark || data.reason).trim()
      if (!remark) throw new Error('请填写操作说明')
      const allowedStatuses = ['pending_pay', 'pending_ship', 'shipped', 'completed', 'cancelled', 'refunded']
      if (!allowedStatuses.includes(targetStatus)) throw new Error('目标状态无效')

      const order = await getDocOrNull('mall_orders', orderId)
      if (!order) throw new Error('订单不存在')
      const prevStatus = order.status
      if (prevStatus === targetStatus) throw new Error(`订单当前已处于该状态(${targetStatus})`)

      const time = now()
      const updateData = {
        status: targetStatus,
        adminManualStatusUpdatedAt: time,
        adminManualStatusRemark: remark,
        adminManualStatusByOpenid: openid,
        updatedAt: time
      }
      await db.collection('mall_orders').doc(orderId).update({ data: updateData })
      await logAdmin(admin, 'mall_order', orderId, 'updateOrderStatus', { prevStatus, targetStatus, remark })
      return { orderId, status: targetStatus, prevStatus, remark }
    }
    if (action === 'refundOrder') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const order = await getDocOrNull('mall_orders', orderId)
      if (!order) throw new Error('订单不存在')
      const payAmount = Number(order.payAmount || 0)
      if (payAmount <= 0) throw new Error('该订单无需退款（实付金额为0）')
      if (order.status === 'pending_pay' && order.paymentStatus !== 'paid') {
        throw new Error('未付款订单不可退款')
      }

      const existingRefundsRes = await db.collection('refunds').where({ orderId }).get()
      const successfulRefundsAmount = (existingRefundsRes.data || [])
        .filter((r) => ['success', 'processing'].includes(r.status))
        .reduce((sum, r) => sum + Number(r.refundAmount || 0), 0)
      const alreadyRefunded = Math.max(Number(order.refundAmount || 0), successfulRefundsAmount)
      const maxRefundable = Math.max(0, Math.round((payAmount - alreadyRefunded) * 100) / 100)

      if (maxRefundable <= 0) throw new Error('该订单已全额退款，无剩余可退金额')

      const refundAmount = Number(data.refundAmount)
      if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error('请输入有效的退款金额（需大于0）')
      if (refundAmount > maxRefundable) throw new Error(`退款金额不能超过可退金额上限 ¥${maxRefundable.toFixed(2)}`)

      const reason = safeText(data.reason || data.remark).trim()
      if (!reason) throw new Error('请填写退款说明')

      const refund = await createRefundForOrder(order, refundAmount, reason, 'admin_mall_manual', openid, getClientRequestId(data))
      const totalRefundAmount = Math.round((alreadyRefunded + refundAmount) * 100) / 100
      const isFullRefund = totalRefundAmount >= payAmount

      const time = now()
      const orderUpdate = {
        refundAmount: totalRefundAmount,
        refundNo: refund.refundNo,
        refundStatus: isFullRefund ? 'approved' : 'partially_refunded',
        paymentStatus: isFullRefund ? 'refunded' : 'refunding',
        adminManualRefundRemark: reason,
        adminManualRefundByOpenid: openid,
        adminManualRefundAt: time,
        updatedAt: time
      }
      if (isFullRefund && !['completed'].includes(order.status)) {
        orderUpdate.status = 'refunded'
      }
      await db.collection('mall_orders').doc(orderId).update({ data: orderUpdate })
      await logAdmin(admin, 'mall_order', orderId, 'refundOrder', { refundAmount, reason, refundNo: refund.refundNo, isFullRefund })
      return {
        orderId,
        refundNo: refund.refundNo,
        refundAmount,
        totalRefundAmount,
        isFullRefund,
        status: orderUpdate.status || order.status
      }
    }
    if (action === 'auditRefund') {
      const order = await getDocOrNull('mall_orders', data.id || data.orderId)
      if (!order) throw new Error('订单不存在')
      if (order.refundStatus !== 'applied') throw new Error('当前订单没有待审核售后')
      const approved = data.approved === true
      const time = now()
      if (!approved) {
        await db.collection('mall_orders').doc(order._id).update({ data: { status: order.trackingNo ? 'shipped' : 'pending_ship', refundStatus: 'rejected', refundRejectReason: safeText(data.remark).trim(), updatedAt: time } })
        await logAdmin(admin, 'mall_order', order._id, 'auditRefund', { approved: false })
        return { orderId: order._id, refundStatus: 'rejected' }
      }
      const refund = await createRefundForOrder(order, Number(data.refundAmount || order.payAmount || 0), data.remark || order.refundReason || '商城售后退款', 'mall_after_sale', openid, getClientRequestId(data))
      await db.collection('mall_orders').doc(order._id).update({ data: { status: 'refunded', paymentStatus: 'refunding', refundStatus: 'approved', refundAmount: refund.refundAmount, refundNo: refund.refundNo, updatedAt: time } })
      await logAdmin(admin, 'mall_order', order._id, 'auditRefund', { approved: true, refundNo: refund.refundNo })
      return { orderId: order._id, refundStatus: 'approved', refundNo: refund.refundNo }
    }
    throw new Error('未知 adminMall 操作')
  },

  async payment(openid, action, data) {
    if (action === 'createPayment') {
      const { order, collectionName, orderType } = await requireClientPayableOrder(openid, data.orderId, '无权支付该订单')
      const settings = await getSystemSettings({ includeSecrets: true })
      if (settings.payment.enabled === false) throw new Error('支付功能暂未开启')
      assertPaymentModeAllowed(settings.payment)
      if (order.paymentStatus === 'paid') return { orderId: data.orderId, status: 'paid', paid: true }
      if (orderType === 'mall') {
        if (order.status !== 'pending_pay' && order.paymentStatus !== 'paying') throw new Error('订单状态不可支付')
      } else {
        assertOrderTransition(order.status, ORDER_STATUS.PAID, '订单状态不可支付')
      }
      if (Number(order.payAmount || 0) <= 0) throw new Error('订单金额不正确')
      if (order.couponId) {
        const coupon = (await db.collection('user_coupons').doc(order.couponId).get()).data
        if (!coupon || coupon.openid !== openid) throw new Error('优惠券不可用')
        if (coupon.status !== 'locked' || coupon.lockedOrderId !== data.orderId) throw new Error('优惠券状态异常')
      }
      const clientRequestId = getClientRequestId(data)
      const payment = await ensurePaymentRecord(order, openid, settings.payment.mode, clientRequestId)
      const payingUpdate = { paymentStatus: 'paying', paymentNo: payment.paymentNo, paymentClientRequestId: payment.clientRequestId || clientRequestId, updatedAt: now() }
      if (orderType === 'mall') await db.collection(collectionName).doc(data.orderId).update({ data: payingUpdate })
      else await updateOrderWhenStatus(data.orderId, ORDER_STATUS.PENDING_PAY, payingUpdate, '订单状态不可支付')
      if (settings.payment.mode === 'mock') return { mock: true, orderId: data.orderId, paymentNo: payment.paymentNo, amount: payment.amount, message: '当前为模拟支付模式' }

      const config = getWechatPayConfig(settings)
      if (payment.prepayId) return { mock: false, orderId: data.orderId, paymentNo: payment.paymentNo, amount: payment.amount, payParams: buildMiniProgramPayParams(payment.prepayId, config) }
      const requestBody = {
        appid: config.appId,
        mchid: config.mchId,
        description: safeText(order.serviceSummary || order.petName || (orderType === 'mall' ? '宠物用品商城' : '上门宠护服务')).slice(0, 120) || (orderType === 'mall' ? '宠物用品商城' : '上门宠护服务'),
        out_trade_no: payment.paymentNo,
        notify_url: config.notifyUrl,
        amount: { total: amountYuanToFen(order.payAmount), currency: 'CNY' },
        payer: { openid }
      }
      try {
        const response = await wechatPayRequest('POST', '/v3/pay/transactions/jsapi', requestBody, config)
        if (!response.prepay_id) throw new Error('微信支付未返回 prepay_id')
        await db.collection('payments').doc(payment._id).update({ data: { channel: 'wechat', prepayId: response.prepay_id, rawRequest: sanitizeWechatPayload(requestBody), rawResponse: sanitizeWechatPayload(response), updatedAt: now() } })
        await appendPaymentEvent('prepay_created', { orderId: data.orderId, paymentNo: payment.paymentNo, status: 'pending', detail: { channel: 'wechat', amount: payment.amount } })
        return { mock: false, orderId: data.orderId, paymentNo: payment.paymentNo, amount: payment.amount, payParams: buildMiniProgramPayParams(response.prepay_id, config) }
      } catch (error) {
        await appendPaymentEvent('prepay_failed', { orderId: data.orderId, paymentNo: payment.paymentNo, status: 'failed', detail: { message: error.message } })
        throw new Error(`微信支付下单失败：${error.message}`)
      }
    }
    if (action === 'getPaymentStatus') {
      const { order } = await requireClientPayableOrder(openid, data.orderId, '无权查看支付状态')
      const payments = await db.collection('payments').where({ orderId: data.orderId }).get()
      return { orderId: data.orderId, status: order.status, paymentStatus: order.paymentStatus || 'unpaid', paymentNo: order.paymentNo || '', wxTransactionId: order.wxTransactionId || '', paidAt: order.paidAt || '', payments: payments.data || [] }
    }
    if (action === 'paymentCallback') {
      if (!data._isInternalHttpCallback) {
        throw new Error('paymentCallback 仅限内部 HTTP 回调调用')
      }
      const settings = await getSystemSettings({ includeSecrets: true })
      const config = getWechatPayConfig(settings)
      const headers = data.headers || {}
      const rawBody = data.rawBody || (data.isBase64Encoded ? Buffer.from(data.body || '', 'base64').toString('utf8') : safeText(data.body || JSON.stringify(data.callback || {})))
      try {
        verifyWechatPayCallback(headers, rawBody, config)
        const callbackBody = rawBody ? JSON.parse(rawBody) : (data.callback || {})
        const payload = callbackBody.resource ? decryptWechatPayResource(callbackBody.resource, config.apiV3Key) : (data.callbackPayload || callbackBody)
        const paymentNo = safeText(payload.out_trade_no).trim()
        if (!paymentNo) throw new Error('微信支付回调缺少支付单号')
        const payment = (await db.collection('payments').where({ paymentNo }).limit(1).get()).data[0]
        if (!payment) throw new Error('支付单不存在')
        if (payment.targetType === 'staff_deposit') {
          const deposit = (await db.collection('staff_deposits').doc(payment.depositId || payment.orderId).get()).data
          if (!deposit) throw new Error('保证金记录不存在')
          validatePaymentCallbackPayload(payload, { payAmount: deposit.amount }, payment, config)
          const status = mapWechatTradeState(payload.trade_state)
          await db.collection('payments').doc(payment._id).update({ data: { status, wxTransactionId: payload.transaction_id || payment.wxTransactionId || '', rawCallback: sanitizeWechatPayload(payload), updatedAt: now() } })
          await appendPaymentEvent('callback', { orderId: deposit._id, paymentNo, status, detail: { tradeState: payload.trade_state, wxTransactionId: payload.transaction_id || '', targetType: 'staff_deposit' } })
          if (payload.trade_state === 'SUCCESS') {
            await markStaffDepositPaid(deposit._id, { paymentNo, wxTransactionId: payload.transaction_id || '', channel: 'wechat', rawCallback: sanitizeWechatPayload(payload) })
          }
          return { code: 'SUCCESS', message: '成功' }
        }
        const resolved = await getPayableOrder(payment.orderId)
        const order = resolved.order
        if (!order) throw new Error('订单不存在')
        validatePaymentCallbackPayload(payload, order, payment, config)
        const status = mapWechatTradeState(payload.trade_state)
        await db.collection('payments').doc(payment._id).update({ data: { status, wxTransactionId: payload.transaction_id || payment.wxTransactionId || '', rawCallback: sanitizeWechatPayload(payload), updatedAt: now() } })
        await appendPaymentEvent('callback', { orderId: order._id || payment.orderId, paymentNo, status, detail: { tradeState: payload.trade_state, wxTransactionId: payload.transaction_id || '' } })
        if (payload.trade_state === 'SUCCESS') await markOrderPaid(order._id || payment.orderId, { paymentNo, wxTransactionId: payload.transaction_id || '', channel: 'wechat', rawCallback: sanitizeWechatPayload(payload) })
        return { code: 'SUCCESS', message: '成功' }
      } catch (error) {
        await appendPaymentEvent('callback_failed', { status: 'failed', detail: { message: error.message } })
        return { code: 'FAIL', message: error.message }
      }
    }
    if (action === 'mockPayOrder') {
      const { order } = await requireClientPayableOrder(openid, data.orderId, '无权支付该订单')
      const settings = await getSystemSettings()
      assertPaymentModeAllowed(settings.payment)
      if (settings.payment.mode !== 'mock') throw new Error('当前未开启模拟支付')
      if (order.paymentStatus === 'paid') return { orderId: data.orderId, status: 'paid' }
      if (order.status !== 'pending_pay' && order.paymentStatus !== 'paying') throw new Error('订单状态不可支付')
      if (order.couponId) {
        const coupon = (await db.collection('user_coupons').doc(order.couponId).get()).data
        if (!coupon || coupon.openid !== openid) throw new Error('优惠券不可用')
        if (coupon.status !== 'locked' || coupon.lockedOrderId !== data.orderId) throw new Error('优惠券状态异常')
      }
      const payment = await ensurePaymentRecord(order, openid, 'mock')
      return markOrderPaid(data.orderId, { paymentNo: data.paymentNo || payment.paymentNo, channel: 'mock', rawCallback: { mock: true } })
    }
    if (action === 'createRefund') {
      const admin = await requireAdmin(openid)
      const resolved = await getPayableOrder(data.orderId)
      const order = resolved.order
      if (!order) throw new Error('订单不存在')
      const amount = Number(data.refundAmount || order.payAmount || 0)
      if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'refunding') throw new Error('订单未支付，不能退款')
      if (amount <= 0 || amount > Number(order.payAmount || 0)) throw new Error('退款金额不正确')
      const refund = await createRefundForOrder(order, amount, data.reason || '管理员退款', 'admin', openid, getClientRequestId(data))
      const refundUpdate = { paymentStatus: 'refunding', refundStatus: resolved.orderType === 'mall' ? 'approved' : 'processing', refundAmount: amount, refundNo: refund.refundNo, updatedAt: now() }
      await db.collection(resolved.collectionName).doc(data.orderId).update({ data: refundUpdate })
      await logAdmin(admin, resolved.orderType === 'mall' ? 'mall_order' : 'order', data.orderId, 'createRefund', { refundNo: refund.refundNo, refundAmount: amount })
      if (resolved.orderType !== 'mall') await appendOrderTimeline(data.orderId, 'refund_processing', '退款处理中', `退款金额 ¥${amount}`, 'admin')
      return refund
    }
    if (action === 'queryRefund') {
      const user = await getUser(openid)
      const res = await db.collection('refunds').where({ refundNo: data.refundNo }).limit(1).get()
      const refund = res.data[0]
      if (!refund) throw new Error('退款单不存在')
      const resolved = await getPayableOrder(refund.orderId)
      const order = resolved.order
      if (!order || (order.clientOpenid !== openid && !user.roles.includes('admin'))) throw new Error('无权查看退款')
      return refund
    }
    if (action === 'listRefunds') {
      await requireAdmin(openid)
      const where = data.orderId ? { orderId: data.orderId } : {}
      const res = await db.collection('refunds').where(where).orderBy('createdAt', 'desc').get()
      return res.data || []
    }
    throw new Error('未知 payment 操作')
  },

  async finance(openid, action, data) {
    if (action === 'getStaffBalance') {
      await getUser(openid)
      await refreshStaffEarnings(openid)
      const earnings = (await db.collection('staff_earnings').where({ staffOpenid: openid }).get()).data || []
      const withdraws = (await db.collection('withdraw_requests').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').get()).data || []
      const settings = await getSystemSettings()
      return { ...summarizeStaffEarnings(earnings), minWithdrawAmount: settings.settlement.minWithdrawAmount, withdraws }
    }
    if (action === 'listStaffEarnings') {
      await getUser(openid)
      await refreshStaffEarnings(openid)
      const status = safeText(data.status).trim()
      const res = await db.collection('staff_earnings').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').get()
      return (res.data || []).filter((item) => !status || item.status === status)
    }
    if (action === 'listMyWithdraws') {
      await getUser(openid)
      const res = await db.collection('withdraw_requests').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').get()
      return res.data || []
    }
    if (action === 'createWithdrawRequest') {
      await getUser(openid)
      const clientRequestId = getClientRequestId(data)
      const existingByRequest = await findByClientRequestId('withdraw_requests', { staffOpenid: openid, clientRequestId })
      if (existingByRequest) return existingByRequest
      await refreshStaffEarnings(openid)
      const settings = await getSystemSettings()
      const earnings = (await db.collection('staff_earnings').where({ staffOpenid: openid, status: 'available' }).get()).data || []
      const total = earnings.reduce((sum, item) => sum + Number(item.amount || 0), 0)
      const amount = Math.min(Number(data.amount || total), total)
      if (amount <= 0) throw new Error('暂无可提现收益')
      if (amount < Number(settings.settlement.minWithdrawAmount || 0)) throw new Error(`最低提现金额 ¥${settings.settlement.minWithdrawAmount}`)
      let remaining = amount
      const selected = []
      for (const earning of earnings) {
        if (remaining <= 0) break
        selected.push(earning)
        remaining -= Number(earning.amount || 0)
      }
      const time = now()
      const request = {
        staffOpenid: openid,
        openid,
        clientRequestId,
        idempotencyKey: clientRequestId || makeIdempotencyKey('withdraw', openid, time.getTime()),
        amount: selected.reduce((sum, item) => sum + Number(item.amount || 0), 0),
        status: 'pending',
        earningIds: selected.map((item) => item._id),
        accountName: safeText(data.accountName).trim(),
        accountNo: safeText(data.accountNo).trim(),
        remark: safeText(data.remark).trim(),
        auditRemark: '',
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('withdraw_requests').add({ data: request })

      const updateResults = await Promise.all(selected.map(async (earning) => {
        try {
          const updateRes = await db.collection('staff_earnings').where({
            _id: earning._id,
            status: 'available'
          }).update({
            data: {
              status: 'withdrawing',
              withdrawRequestId: created._id,
              updatedAt: time
            }
          })
          return { earningId: earning._id, success: updateRes.stats.updated > 0 }
        } catch (error) {
          return { earningId: earning._id, success: false, error: error.message }
        }
      }))

      const failedUpdates = updateResults.filter(r => !r.success)
      if (failedUpdates.length > 0) {
        await db.collection('withdraw_requests').doc(created._id).remove()
        throw new Error('提现请求失败：部分收益记录已被其他操作占用，请刷新后重试')
      }

      await appendFinanceLog('withdraw_requested', { targetType: 'withdraw_request', targetId: created._id, staffOpenid: openid, amountDelta: -request.amount, detail: { earningIds: request.earningIds } })
      return { _id: created._id, ...request }
    }
    throw new Error('未知 finance 操作')
  },

  async staff(openid, action, data) {
    if (action === 'listApprovedSitters') {
      const keyword = String(data.keyword || '').trim().toLowerCase()
      const serviceCity = String(data.serviceCity || '').trim()
      const serviceArea = String(data.serviceArea || '').trim()
      const sortBy = data.sortBy || 'default'
      const userLat = Number(data.latitude || 0)
      const userLng = Number(data.longitude || 0)
      const userHasLoc = hasCoordinate(userLat, userLng)

      const page = Math.max(Number(data.page || 1), 1)
      const pageSize = Math.min(Math.max(Number(data.pageSize || 20), 1), 50)
      const settings = await getSystemSettings().catch(() => ({}))
      const res = await db.collection('staff_profiles').where({ auditStatus: 'approved' }).orderBy('updatedAt', 'desc').get()
      let sitters = await Promise.all((res.data || []).filter((item) => canTakeOrders(item, settings.staffDeposit)).map(withSitterUserProfile))

      sitters = sitters.filter((profile) => {
        const areas = splitServiceAreas(profile.serviceAreas)
        if (serviceCity) {
          const normFilterCity = normalizeCityName(serviceCity)
          const normSitterCity = normalizeCityName(profile.serviceCity)
          if (normFilterCity && normSitterCity && normFilterCity !== normSitterCity) return false
        }
        if (serviceArea && !areas.includes(serviceArea)) return false
        if (keyword && !(matchText(profile.nickname, keyword) || matchText(profile.realName, keyword) || matchText(profile.serviceCity, keyword) || matchText(profile.serviceAreas, keyword))) return false

        return true
      })

      const publicList = sitters.map((profile) => {
        const publicData = toPublicSitter(profile)
        if (!userHasLoc) return { ...publicData, inServiceRange: true, canDirectBook: true }

        const hasSitterLoc = hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) && Boolean(profile.serviceAddress)
        const radiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)
        const distanceKm = hasSitterLoc ? calcDistanceKm(userLat, userLng, profile.serviceLatitude, profile.serviceLongitude) : null
        const inServiceRange = distanceKm !== null && distanceKm <= radiusKm
        return {
          ...publicData,
          distanceKm,
          distanceText: formatDistance(distanceKm),
          inServiceRange,
          canDirectBook: inServiceRange,
          rangeStatusText: inServiceRange ? '服务范围内' : '超出服务范围'
        }
      })

      const compareRating = (a, b) => Number(b.ratingAverage || 0) - Number(a.ratingAverage || 0) || Number(b.reviewCount || 0) - Number(a.reviewCount || 0) || toTimeValue(b.ratingUpdatedAt || b.updatedAt) - toTimeValue(a.ratingUpdatedAt || a.updatedAt)
      const compareFeatured = (a, b) => {
        const featuredDiff = Number(b.isFeatured === true) - Number(a.isFeatured === true)
        if (featuredDiff) return featuredDiff
        if (a.isFeatured === true && b.isFeatured === true) return toTimeValue(b.featuredAt) - toTimeValue(a.featuredAt)
        return 0
      }
      const compareDefault = (a, b) => compareRating(a, b) || toTimeValue(b.updatedAt) - toTimeValue(a.updatedAt)
      const compareByMode = (a, b) => {
        if (sortBy === 'distance' && userHasLoc) return (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999) || compareRating(a, b)
        if (sortBy === 'city') return String(a.serviceCity || '').localeCompare(String(b.serviceCity || '')) || String(a.serviceAreas || '').localeCompare(String(b.serviceAreas || '')) || compareRating(a, b)
        if (sortBy === 'latest') return toTimeValue(b.updatedAt || b.createdAt) - toTimeValue(a.updatedAt || a.createdAt) || compareRating(a, b)
        if (sortBy === 'rating') return compareRating(a, b)
        return compareDefault(a, b)
      }
      publicList.sort((a, b) => compareFeatured(a, b) || compareByMode(a, b))

      return paginateList(publicList, { ...data, page, pageSize })
    }
    if (action === 'getPublicSitterDetail') {
      const user = await getOptionalUser(openid)
      const settings = await getSystemSettings().catch(() => ({}))
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = profileRes.data
      if (!profile || !canTakeOrders(profile, settings.staffDeposit)) throw new Error('宠托师不可用')
      return toPublicSitterDetail(user ? openid : '', await withSitterUserProfile(normalizeStaffWorkflow(profile)))
    }
    if (action === 'favoriteSitter') {
      const user = await getUser(openid)
      const settings = await getSystemSettings().catch(() => ({}))
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = profileRes.data
      if (!profile || !canTakeOrders(profile, settings.staffDeposit)) throw new Error('宠托师不可用')
      const existing = await db.collection('sitter_favorites').where({ openid, staffProfileId: data.staffProfileId }).limit(1).get()
      if (existing.data[0]) return { staffProfileId: data.staffProfileId, favorite: true }
      await db.collection('sitter_favorites').add({ data: { userId: user._id, openid, staffProfileId: data.staffProfileId, createdAt: now() } })
      return { staffProfileId: data.staffProfileId, favorite: true }
    }
    if (action === 'unfavoriteSitter') {
      await getUser(openid)
      const existing = await db.collection('sitter_favorites').where({ openid, staffProfileId: data.staffProfileId }).limit(1).get()
      if (existing.data[0]) await db.collection('sitter_favorites').doc(existing.data[0]._id).remove()
      return { staffProfileId: data.staffProfileId, favorite: false }
    }
    if (action === 'listFavoriteSitters') {
      await getUser(openid)
      const settings = await getSystemSettings().catch(() => ({}))
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const favorites = await db.collection('sitter_favorites').where({ openid }).orderBy('createdAt', 'desc').get()
      const list = []
      for (let i = 0; i < favorites.data.length; i += 1) {
        try {
          const profileRes = await db.collection('staff_profiles').doc(favorites.data[i].staffProfileId).get()
          if (profileRes.data && canTakeOrders(profileRes.data, settings.staffDeposit)) {
            const profile = await withSitterUserProfile(normalizeStaffWorkflow(profileRes.data))
            list.push({ ...(await toPublicSitterDetail(openid, profile)), favorite: true })
          }
        } catch (error) {}
      }
      const filtered = list.filter((item) => !keyword || [item.displayName, item.serviceCity, item.serviceSummary, item.bio].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(filtered, data) : filtered
    }
    if (action === 'getStaffProfile') {
      await getUser(openid)
      const res = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(res.data[0] || null)
      if (!profile) return null
      const settings = await getSystemSettings().catch(() => ({}))
      const depositConfig = settings.staffDeposit || normalizeStaffDepositConfig()
      const ability = validateStaffTakeOrderAbility(profile, depositConfig)
      const depositSatisfied = staffDepositSatisfied(profile, depositConfig)
      return {
        ...profile,
        depositConfig: {
          enabled: depositConfig.enabled,
          amount: depositConfig.amount
        },
        canTakeOrders: ability.can,
        cannotTakeOrderReason: ability.can ? '' : ability.reason,
        cannotTakeOrderMessage: ability.can ? '' : ability.message,
        depositNotice: (!depositSatisfied && depositConfig.enabled && depositConfig.amount > 0) ? {
          needDeposit: true,
          amount: depositConfig.amount,
          title: '未缴纳履约保证金',
          message: `平台已开启宠托师履约保证金（¥${depositConfig.amount}），请先完成缴纳后再开始抢单/接单。`
        } : null
      }
    }
    if (action === 'getTrainingStatus') {
      await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile) throw new Error('请先提交宠托师认证')
      const progress = profile.trainingVideoProgress || {}
      const settings = await getSystemSettings()
      const training = settings.staffTraining || normalizeStaffTrainingConfig()
      const completedOrders = await getCompletedStaffOrders(openid, 3)
      const videos = enabledTrainingVideos(training).map((video) => ({ ...video, watched: Boolean(progress[video.key] && progress[video.key].watched), watchedAt: progress[video.key] && progress[video.key].watchedAt || '' }))
      return {
        profile,
        quiz: { questions: publicTrainingQuiz(training.quiz), passScore: training.passScore, passed: Boolean(profile.quizPassedAt), score: Number(profile.quizScore || 0), passedAt: profile.quizPassedAt || '' },
        videos,
        videoAuditGuide: normalizeVideoAuditGuide(training.videoAuditGuide),
        supplies: settings.staffSupplies || normalizeStaffSuppliesConfig(),
        completedInternOrders: completedOrders,
        completedInternOrderCount: completedOrders.length,
        canRequestVideoAudit: profile.auditStatus === 'approved' && isTrainingComplete(profile, training) && profile.videoAuditStatus !== 'pending' && profile.videoAuditStatus !== 'approved',
        canSubmitPromotion: profile.staffLevel === 'intern' && profile.promotionStatus !== 'pending' && completedOrders.length >= 3,
        canTakeOrders: canTakeOrders(profile, settings.staffDeposit)
      }
    }
    if (action === 'submitTrainingQuiz') {
      await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可参加培训答题')
      const settings = await getSystemSettings()
      const training = settings.staffTraining || normalizeStaffTrainingConfig()
      const questions = training.quiz || DEFAULT_STAFF_TRAINING_QUIZ
      const answers = data.answers || {}
      const correct = questions.filter((item) => safeText(answers[item.id]).trim() === item.answer).length
      const score = Math.round((correct / questions.length) * 100)
      const passed = score >= training.passScore
      const time = now()
      const update = { quizScore: score, updatedAt: time }
      if (passed) {
        update.quizPassedAt = time
        update.onboardingStatus = 'quiz_passed'
      }
      await db.collection('staff_profiles').doc(profile._id).update({ data: update })
      return { score, passed, passScore: training.passScore }
    }
    if (action === 'markTrainingVideoWatched') {
      await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可观看培训视频')
      const settings = await getSystemSettings()
      const training = settings.staffTraining || normalizeStaffTrainingConfig()
      const videos = enabledTrainingVideos(training)
      const videoKey = safeText(data.videoKey).trim()
      if (!videos.some((item) => item.key === videoKey)) throw new Error('培训视频不存在')

      // 全程观看防作弊校验：如果前端传递了视频时长，必须观看达到90%以上
      const watchedSeconds = Number(data.watchedSeconds)
      const duration = Number(data.duration)
      if (Number.isFinite(duration) && duration > 5) {
        if (!Number.isFinite(watchedSeconds) || watchedSeconds < duration * 0.9) {
          throw new Error('培训视频须全程完整观看，当前播放时长未达标')
        }
      }

      const progress = { ...(profile.trainingVideoProgress || {}) }
      const time = now()
      progress[videoKey] = {
        watched: true,
        watchedAt: time,
        watchedSeconds: Number.isFinite(watchedSeconds) ? watchedSeconds : null,
        duration: Number.isFinite(duration) ? duration : null
      }
      const allWatched = videos.every((video) => progress[video.key] && progress[video.key].watched === true)
      const update = { trainingVideoProgress: progress, updatedAt: time }
      if (allWatched) {
        update.trainingVideosCompletedAt = time
        update.onboardingStatus = profile.quizPassedAt ? 'videos_completed' : profile.onboardingStatus
      }
      await db.collection('staff_profiles').doc(profile._id).update({ data: update })
      return { videoKey, allWatched }
    }
    if (action === 'submitVideoAuditRequest') {
      await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可提交视频审核')
      const settings = await getSystemSettings()
      const training = settings.staffTraining || normalizeStaffTrainingConfig()
      if (!isTrainingComplete(profile, training)) throw new Error('请先完成答题和全部培训视频')
      const time = now()
      const update = { videoAuditStatus: 'pending', videoAuditRequestedAt: time, onboardingStatus: 'video_audit_pending', videoAuditRemark: '', updatedAt: time }
      await db.collection('staff_profiles').doc(profile._id).update({ data: update })
      return { ...profile, ...update }
    }
    if (action === 'submitPromotionApplication') {
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.staffLevel !== 'intern') throw new Error('仅实习宠托师可申请晋升')
      if (profile.promotionStatus === 'pending') throw new Error('已有待审核晋升申请')
      const completedOrders = await getCompletedStaffOrders(openid, 3)
      if (completedOrders.length < 3) throw new Error('完成 3 单实习服务后才可申请晋升')
      const time = now()
      const created = await db.collection('staff_promotion_applications').add({ data: { staffProfileId: profile._id, staffOpenid: openid, staffUserId: user._id, orderIds: completedOrders.map((order) => order._id), status: 'pending', staffRemark: safeText(data.remark).trim(), adminRemark: '', createdAt: time, updatedAt: time } })
      await db.collection('staff_profiles').doc(profile._id).update({ data: { promotionStatus: 'pending', promotionApplicationId: created._id, promotionAppliedAt: time, updatedAt: time } })
      return { applicationId: created._id, status: 'pending' }
    }
    if (action === 'submitStaffProfile') {
      const user = await getUser(openid)
      const realName = safeText(data.realName).trim()
      const phone = safeText(data.phone || user.phone).trim()
      const serviceCity = safeText(data.serviceCity).trim()
      const serviceAreas = safeText(data.serviceAreas).trim()
      const serviceAddress = safeText(data.serviceAddress).trim()
      const serviceLatitude = Number(data.latitude || data.serviceLatitude || 0)
      const serviceLongitude = Number(data.longitude || data.serviceLongitude || 0)
      const serviceRadiusKm = Math.max(Number(data.serviceRadiusKm || 5), 1)
      const idCardFrontFileId = safeFileId(data.idCardFrontFileId)
      const idCardBackFileId = safeFileId(data.idCardBackFileId)
      const facePhotoFileId = safeFileId(data.facePhotoFileId)

      if (!realName) throw new Error('请输入真实姓名')
      if (!phone) throw new Error('请输入手机号')
      if (!serviceAddress || !hasCoordinate(serviceLatitude, serviceLongitude)) {
        throw new Error('宠托师认证必须设置固定服务地址及坐标')
      }
      if (!idCardFrontFileId || !idCardBackFileId) throw new Error('请上传身份证正反面照片')
      if (!facePhotoFileId) throw new Error('请上传自拍/人脸照片')

      const staffText = [realName, serviceCity, serviceAreas, serviceAddress, data.bio, data.intro, data.experience].filter(Boolean).join(' ')
      if (staffText) {
        await checkTextSecurity(openid, staffText, { scene: 1, label: '认证资料' })
      }

      const time = now()
      const identitySummary = {
        idCardFrontFileId,
        idCardBackFileId,
        facePhotoFileId,
        identityStatus: 'pending',
        faceVerifyStatus: 'manual_pending',
        faceVerifyProvider: '',
        faceVerifyRequestId: ''
      }
      const profile = {
        userId: user._id,
        openid,
        realName,
        phone,
        avatarUrl: user.avatarUrl || data.avatarUrl || '',
        serviceCity,
        serviceAreas,
        serviceAddress,
        serviceLatitude,
        serviceLongitude,
        serviceRadiusKm,
        weeklySchedule: normalizeWeeklySchedule(data.weeklySchedule),
        idCardFrontFileId,
        idCardBackFileId,
        facePhotoFileId,
        identityStatus: identitySummary.identityStatus,
        faceVerifyStatus: identitySummary.faceVerifyStatus,
        faceVerifyProvider: identitySummary.faceVerifyProvider,
        faceVerifyRequestId: identitySummary.faceVerifyRequestId,
        auditStatus: 'pending',
        auditRemark: '',
        staffLevel: 'applicant',
        onboardingStatus: 'application_pending',
        videoAuditStatus: 'not_started',
        promotionStatus: 'none',
        quizPassedAt: null,
        quizScore: 0,
        trainingVideoProgress: {},
        trainingVideosCompletedAt: null,
        videoAuditRequestedAt: null,
        videoAuditRemark: '',
        internStartedAt: null,
        internCompletedOrderCount: 0,
        promotionApplicationId: '',
        promotionAppliedAt: null,
        updatedAt: time
      }
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      if (existing.data[0]) {
        if (existing.data[0].auditStatus === 'approved') throw new Error('已是安心宠护师，认证资料不可重复提交')
        await db.collection('staff_profiles').doc(existing.data[0]._id).update({ data: profile })
        const identityPayload = { staffProfileId: existing.data[0]._id, userId: user._id, openid, realName, phone, ...identitySummary, auditStatus: 'pending', updatedAt: time }
        const identityRes = await db.collection('staff_identity_verifications').where({ staffProfileId: existing.data[0]._id }).limit(1).get()
        if (identityRes.data[0]) await db.collection('staff_identity_verifications').doc(identityRes.data[0]._id).update({ data: identityPayload })
        else await db.collection('staff_identity_verifications').add({ data: { ...identityPayload, createdAt: time } })
        return { _id: existing.data[0]._id, ...profile }
      }
      const created = await db.collection('staff_profiles').add({ data: { ...profile, createdAt: time } })
      await db.collection('staff_identity_verifications').add({ data: { staffProfileId: created._id, userId: user._id, openid, realName, phone, ...identitySummary, auditStatus: 'pending', createdAt: time, updatedAt: time } })
      return { _id: created._id, ...profile, createdAt: time }
    }
    if (action === 'updateStaffProfileConfig') {
      await getUser(openid)
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = existing.data[0]
      if (!profile) throw new Error('请先提交宠托师认证')
      if (profile.auditStatus !== 'approved') throw new Error('宠托师认证审核通过后方可设置接单配置')

      console.log('【调试-updateStaffProfileConfig】接收到的 data:', JSON.stringify(data))

      const time = now()
      const updateData = { updatedAt: time }

      // 判断是否只更新 weeklySchedule（从排班日历调用）
      const isOnlyWeeklyScheduleUpdate = data.weeklySchedule !== undefined &&
                                          data.serviceAddress === undefined &&
                                          data.serviceLatitude === undefined &&
                                          data.serviceLongitude === undefined &&
                                          data.serviceRadiusKm === undefined

      if (isOnlyWeeklyScheduleUpdate) {
        // 只更新按周服务时间规则
        const weeklySchedule = normalizeWeeklySchedule(data.weeklySchedule)
        console.log('【调试-updateStaffProfileConfig】只更新 weeklySchedule:', JSON.stringify(weeklySchedule))
        updateData.weeklySchedule = weeklySchedule
      } else {
        // 完整更新（从个人中心调用）
        const serviceAddress = safeText(data.serviceAddress !== undefined ? data.serviceAddress : profile.serviceAddress).trim()
        let serviceLatitude = Number(data.serviceLatitude !== undefined ? data.serviceLatitude : (data.latitude !== undefined ? data.latitude : (profile.serviceLatitude || 0)))
        let serviceLongitude = Number(data.serviceLongitude !== undefined ? data.serviceLongitude : (data.longitude !== undefined ? data.longitude : (profile.serviceLongitude || 0)))
        if (!hasCoordinate(serviceLatitude, serviceLongitude) && hasCoordinate(profile.serviceLatitude, profile.serviceLongitude)) {
          serviceLatitude = Number(profile.serviceLatitude)
          serviceLongitude = Number(profile.serviceLongitude)
        }
        const serviceRadiusKm = Math.max(Number(data.serviceRadiusKm !== undefined ? data.serviceRadiusKm : (profile.serviceRadiusKm || 5)), 1)
        const weeklySchedule = data.weeklySchedule !== undefined ? normalizeWeeklySchedule(data.weeklySchedule) : profile.weeklySchedule

        if (!serviceAddress || !hasCoordinate(serviceLatitude, serviceLongitude)) {
          throw new Error('请选择有效的固定服务地址及坐标')
        }

        updateData.serviceAddress = serviceAddress
        updateData.serviceLatitude = serviceLatitude
        updateData.serviceLongitude = serviceLongitude
        updateData.serviceRadiusKm = serviceRadiusKm
        updateData.weeklySchedule = weeklySchedule
      }

      console.log('【调试-updateStaffProfileConfig】准备保存的 updateData:', JSON.stringify(updateData))

      await db.collection('staff_profiles').doc(profile._id).update({ data: updateData })
      return { _id: profile._id, ...profile, ...updateData }
    }
    if (action === 'updateCurrentLocation') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可更新定位')
      const latitude = Number(data.latitude || 0)
      const longitude = Number(data.longitude || 0)
      if (!hasCoordinate(latitude, longitude)) throw new Error('定位信息无效')
      const existing = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      if (!existing.data[0]) throw new Error('请先提交员工认证')
      const location = { currentLatitude: latitude, currentLongitude: longitude, locationAccuracy: Number(data.accuracy || 0), locationUpdatedAt: now(), updatedAt: now() }
      await db.collection('staff_profiles').doc(existing.data[0]._id).update({ data: location })
      return { _id: existing.data[0]._id, ...location }
    }
    if (action === 'listNearbyOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')

      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0] || {})
      const settings = await getSystemSettings().catch(() => ({}))
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可查看可接订单')
      const latitude = Number(data.latitude || profile.currentLatitude || 0)
      const longitude = Number(data.longitude || profile.currentLongitude || 0)

      const filterCity = data.city ? String(data.city).trim() : ''
      const inServiceRange = Boolean(data.inServiceRange)
      const inServiceTime = Boolean(data.inServiceTime)
      const filterDate = data.filterDate ? String(data.filterDate).trim() : ''
      await expireDueUnacceptedOrders()

      const res = await db.collection('orders').where({ status: 'paid' }).orderBy('startTime', 'asc').get()
      const radiusKm = Math.max(Number(profile.serviceRadiusKm || 5), 1)
      const normalizedSchedule = normalizeWeeklySchedule(profile.weeklySchedule)

      function isOrderInRange(order) {
        return order.distanceKm !== null && order.distanceKm <= radiusKm
      }

      function isOrderInTime(order) {
        if (!normalizedSchedule) {
          console.log('【调试-isOrderInTime】normalizedSchedule 为空，返回 true')
          return true
        }

        // 获取订单的所有时间段（支持单次和多次服务）
        const sessions = getOrderTimeRanges(order)
        console.log('【调试-isOrderInTime】订单时间段:', JSON.stringify(sessions))
        if (!sessions || sessions.length === 0) return true

        console.log('【调试-isOrderInTime】normalizedSchedule:', JSON.stringify(normalizedSchedule))

        // 检查每个时间段是否都在接单时间内
        for (const session of sessions) {
          if (!session.startTime) continue

          // 使用 parseDateTimeParts 正确解析北京时间
          const startParts = parseDateTimeParts(session.startTime)
          console.log('【调试-isOrderInTime】解析时间 session.startTime:', session.startTime)
          console.log('【调试-isOrderInTime】startParts:', JSON.stringify(startParts))
          console.log('【调试-isOrderInTime】dayOfWeek:', startParts.dayOfWeek, 'hour:', startParts.hour, 'minute:', startParts.minute)
          if (!startParts) continue

          const dayKey = String(startParts.dayOfWeek)
          const slots = normalizedSchedule[dayKey]
          console.log('【调试-isOrderInTime】dayKey:', dayKey)
          console.log('【调试-isOrderInTime】slots:', JSON.stringify(slots))

          // 如果某一天没有配置接单时间，视为不在时间内
          if (!Array.isArray(slots) || !slots.length) {
            console.log('【调试-isOrderInTime】该天未配置接单时间，返回 false')
            return false
          }

          // 使用北京时间的小时和分钟
          const orderHour = startParts.hour + startParts.minute / 60
          console.log('【调试-isOrderInTime】orderHour:', orderHour)

          // 检查是否在该天的任一时间段内
          const inSlot = slots.some((slot) => {
            const result = orderHour >= slot.start && orderHour < slot.end
            console.log('【调试-isOrderInTime】检查时间段 [', slot.start, '-', slot.end, ']:', result)
            return result
          })

          console.log('【调试-isOrderInTime】inSlot:', inSlot)

          // 如果任一时间段不在接单时间内，返回 false
          if (!inSlot) {
            console.log('【调试-isOrderInTime】订单时间不在接单时间段内，返回 false')
            return false
          }
        }

        // 所有时间段都在接单时间内
        console.log('【调试-isOrderInTime】所有时间段都在接单时间内，返回 true')
        return true
      }

      let orders = await Promise.all((res.data || []).filter((order) => !isAdminDeletedOrder(order) && isOpenOrder(order)).map(async (order) => {
        const enriched = await attachOrderDisplayData(order)
        let distanceKm = null
        if (hasCoordinate(latitude, longitude) && hasCoordinate(enriched.addressLatitude, enriched.addressLongitude)) {
          distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
        }
        // 【新增】添加收益信息
        const earning = await calculateStaffEarningForOrder(enriched)
        const result = {
          ...enriched,
          distanceKm,
          distanceText: formatDistance(distanceKm),
          staffEarning: earning.earningAmount,
          staffEarningText: `¥${earning.earningAmount.toFixed(2)}`
        }
        result.inRange = isOrderInRange(result)
        result.inTime = isOrderInTime(result)
        return result
      }))

      // 1. 城市筛选：优先用订单 city 字段，历史订单无 city 时从服务地址解析；解析不到城市的旧数据默认保留。
      if (filterCity) {
        orders = orders.filter((order) => orderMatchesCity(order, filterCity))
      }

      // 2. 服务日期筛选 (Date Filter: YYYY-MM-DD)
      if (filterDate) {
        orders = orders.filter((order) => {
          if (!order.startTime) return false
          return String(order.startTime).startsWith(filterDate)
        })
      }

      // 3. 服务范围与时间筛选需在分页前执行，避免当前页被前端过滤后为空
      if (inServiceRange) orders = orders.filter((order) => order.inRange)
      if (inServiceTime) orders = orders.filter((order) => order.inTime)

      const sortedOrders = orders.sort((a, b) => (a.distanceKm === null ? 999999 : a.distanceKm) - (b.distanceKm === null ? 999999 : b.distanceKm))
      const maskedOrders = sortedOrders.map(maskOrderForStaffPreview)
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(maskedOrders, data) : maskedOrders.slice(0, 20)
    }
    if (action === 'listDirectOrders') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0] || {})
      const settings = await getSystemSettings().catch(() => ({}))
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可查看指定订单')
      const latitude = Number(data.latitude || profile.currentLatitude || 0)
      const longitude = Number(data.longitude || profile.currentLongitude || 0)
      await expireDueUnacceptedOrders()
      const res = await db.collection('orders').where({ status: 'paid' }).orderBy('startTime', 'asc').get()
      const directOrders = await Promise.all((res.data || [])
        .filter((order) => !isAdminDeletedOrder(order) && order.publishMode === 'direct' && !order.staffOpenid && order.requestedStaffOpenid === openid)
        .map(async (order) => {
          const enriched = await attachOrderDisplayData(order)
          let distanceKm = null
          if (hasCoordinate(latitude, longitude) && hasCoordinate(enriched.addressLatitude, enriched.addressLongitude)) {
            distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
          }
          return { ...enriched, distanceKm, distanceText: formatDistance(distanceKm) }
        }))
      const maskedDirectOrders = directOrders.map(maskOrderForStaffPreview)
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(maskedDirectOrders, data) : maskedDirectOrders
    }
    if (action === 'getScheduleCalendar') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0]
      if (!profile) throw new Error('请先提交宠托师认证')
      const availability = await buildStaffAvailability(profile, data.startDate || data.dateKey || '', data.days || 14)
      return { weeklySchedule: normalizeWeeklySchedule(profile.weeklySchedule), weeklyScheduleText: formatWeeklyScheduleText(profile.weeklySchedule), availability }
    }
    if (action === 'saveScheduleException') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可设置排班')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0]
      if (!profile || profile.auditStatus !== 'approved') throw new Error('宠托师认证审核通过后方可设置排班')
      const payload = normalizeScheduleException(data, profile)
      const time = now()
      const existing = await db.collection('staff_schedule_exceptions').where({ staffOpenid: openid, dateKey: payload.dateKey }).limit(1).get()
      if (existing.data[0]) {
        await db.collection('staff_schedule_exceptions').doc(existing.data[0]._id).update({ data: { ...payload, updatedAt: time } })
        return { _id: existing.data[0]._id, ...existing.data[0], ...payload, updatedAt: time }
      }
      const created = await db.collection('staff_schedule_exceptions').add({ data: { ...payload, createdAt: time, updatedAt: time } })
      return { _id: created._id, ...payload, createdAt: time, updatedAt: time }
    }
    if (action === 'deleteScheduleException') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可设置排班')
      const dateKey = safeText(data.dateKey).trim()
      const existing = await db.collection('staff_schedule_exceptions').where({ staffOpenid: openid, dateKey }).limit(1).get()
      if (existing.data[0]) await db.collection('staff_schedule_exceptions').doc(existing.data[0]._id).remove()
      return { dateKey, deleted: true }
    }
    if (action === 'listScheduleAvailability') {
      const profileId = data.staffProfileId || data.requestedStaffProfileId
      let profile = null
      if (profileId) {
        profile = (await db.collection('staff_profiles').doc(profileId).get()).data
      } else {
        const user = await getUser(openid)
        if (!user.roles.includes('staff')) throw new Error('请选择宠托师')
        profile = (await db.collection('staff_profiles').where({ openid }).limit(1).get()).data[0]
      }
      const settings = await getSystemSettings().catch(() => ({}))
      if (!profile || !canTakeOrders(profile, settings.staffDeposit)) throw new Error('宠托师不可用')
      return buildStaffAvailability(profile, data.startDate || data.dateKey || '', data.days || 14)
    }
    if (action === 'listStaffReviews') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0]
      if (!profile) throw new Error('请先提交员工认证')
      const res = await db.collection('service_reviews').where({ staffProfileId: profile._id, status: 'visible' }).orderBy('createdAt', 'desc').get()
      return res.data.map((item) => ({ ...item, clientName: maskClientName(item.clientName) }))
    }
    if (action === 'checkUpcomingReminders') {
      const list = await sendUpcomingServiceRemindersToStaff()
      return { remindedCount: list.length, list }
    }
    if (action === 'listStaffOrders') {
      await sendUpcomingServiceRemindersToStaff()
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可查看')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = profileRes.data[0] || {}
      const latitude = Number(data.latitude || profile.currentLatitude || 0)
      const longitude = Number(data.longitude || profile.currentLongitude || 0)
      const res = await db.collection('orders').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').get()
      let list = (res.data || []).filter((order) => !isAdminDeletedOrder(order))
      // 最近的订单排在最前面
      list.sort((a, b) => {
        const bTime = toTimeValue(b.createdAt || b.startTime)
        const aTime = toTimeValue(a.createdAt || a.startTime)
        return bTime - aTime
      })
      if (data.status && data.status !== 'all') list = list.filter((order) => order.status === data.status)
      if (data.statusGroup === 'waiting_service') list = list.filter((order) => ['assigned', 'in_service', 'day_completed'].includes(order.status))
      const orderKeyword = safeText(data.orderKeyword || data.keyword || data.orderNo).trim().toLowerCase()
      if (orderKeyword) {
        list = list.filter((order) => [
          order._id,
          order.orderNo,
          order.petName,
          order.serviceSummary,
          order.serviceAddress,
          order.clientSnapshot && order.clientSnapshot.displayName,
          order.clientSnapshot && order.clientSnapshot.nickname
        ].some((val) => safeText(val).toLowerCase().includes(orderKeyword)))
      }
      const startDate = safeText(data.startDate).trim()
      const endDate = safeText(data.endDate).trim()
      if (startDate) {
        list = list.filter((order) => {
          const start = String(order.serviceStartDate || order.startTime || order.createdAt || '').slice(0, 10)
          const end = String(order.serviceEndDate || order.endTime || start).slice(0, 10)
          return end >= startDate
        })
      }
      if (endDate) {
        list = list.filter((order) => {
          const start = String(order.serviceStartDate || order.startTime || order.createdAt || '').slice(0, 10)
          return start <= endDate
        })
      }
      const decorate = async (order) => {
        const enriched = await attachOrderDisplayData(order)
        const distanceKm = calcDistanceKm(latitude, longitude, enriched.addressLatitude, enriched.addressLongitude)
        // 【新增】添加收益信息
        const earning = await calculateStaffEarningForOrder(enriched)
        return {
          ...enriched,
          distanceKm,
          distanceText: formatDistance(distanceKm),
          staffEarning: earning.earningAmount,
          staffEarningText: `¥${earning.earningAmount.toFixed(2)}`
        }
      }
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      if (wantsPage) {
        const page = paginateList(list, data)
        return { ...page, list: await Promise.all(page.list.map(decorate)) }
      }
      return Promise.all(list.map(decorate))
    }
    if (action === 'checkAcceptOrderRisk') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可接单')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0])
      const settings = await getSystemSettings().catch(() => ({}))
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可接单')
      if (!hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) || !profile.serviceAddress) {
        throw new Error('请先在个人中心设置固定服务地址与接单范围，方可接单')
      }
      const orderRes = await db.collection('orders').doc(data.orderId).get()
      const order = await expireUnacceptedOrder(data.orderId, orderRes.data)
      assertOrderTransition(order.status, ORDER_STATUS.ASSIGNED, '订单状态不可接单')
      if (order.staffOpenid) throw new Error('订单已被分配')
      const publishMode = order.publishMode === 'direct' ? 'direct' : 'open'
      if (publishMode === 'direct' && order.requestedStaffOpenid !== openid) throw new Error('该订单指定了其他宠托师')
      if (publishMode === 'open' && order.requestedStaffOpenid) throw new Error('该订单指定了其他宠托师')
      const orderResForConflict = await db.collection('orders').where({ staffOpenid: profile.openid }).get()
      const conflict = (orderResForConflict.data || []).find((item) => {
        if (item._id === data.orderId) return false
        return isOrderConflictCandidate(item) && orderTimeRangesOverlap(order, item)
      })
      if (conflict) throw new Error('宠托师该时间段已有订单，无法重复预约')
      return checkAcceptOrderRisk(profile, order)
    }
    if (action === 'acceptOrder') {
      const user = await getUser(openid)
      if (!user.roles.includes('staff')) throw new Error('仅员工可接单')
      const profileRes = await db.collection('staff_profiles').where({ openid }).limit(1).get()
      const profile = normalizeStaffWorkflow(profileRes.data[0])
      const settings = await getSystemSettings().catch(() => ({}))
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) throw new Error(ability.message || '完成培训和视频审核成为实习宠托师后方可接单')
      if (!hasCoordinate(profile.serviceLatitude, profile.serviceLongitude) || !profile.serviceAddress) {
        throw new Error('请先在个人中心设置固定服务地址与接单范围，方可接单')
      }

      const orderRes = await db.collection('orders').doc(data.orderId).get()
      const order = await expireUnacceptedOrder(data.orderId, orderRes.data)
      assertOrderTransition(order.status, ORDER_STATUS.ASSIGNED, '订单状态不可接单')
      if (order.staffOpenid) throw new Error('订单已被分配')
      const publishMode = order.publishMode === 'direct' ? 'direct' : 'open'
      if (publishMode === 'direct' && order.requestedStaffOpenid !== openid) throw new Error('该订单指定了其他宠托师')
      if (publishMode === 'open' && order.requestedStaffOpenid) throw new Error('该订单指定了其他宠托师')

      // 验证抢单时的实时位置与订单距离
      const currentLat = Number(data.currentLatitude)
      const currentLng = Number(data.currentLongitude)
      const orderLat = Number(order.serviceLatitude || order.addressLatitude || 0)
      const orderLng = Number(order.serviceLongitude || order.addressLongitude || 0)

      let distanceFromCurrent = null
      if (hasCoordinate(currentLat, currentLng) && hasCoordinate(orderLat, orderLng)) {
        distanceFromCurrent = calcDistanceKm(currentLat, currentLng, orderLat, orderLng)
        const serviceRadiusKm = Number(profile.serviceRadiusKm || 5)
        if (distanceFromCurrent !== null && distanceFromCurrent > serviceRadiusKm) {
          throw new Error(`订单距离你当前位置约 ${formatDistance(distanceFromCurrent)}，超出 ${serviceRadiusKm}km 服务范围，无法接单`)
        }
      }

      const risk = await checkAcceptOrderRisk(profile, order)
      const orderResForConflict = await db.collection('orders').where({ staffOpenid: profile.openid }).get()
      const conflict = (orderResForConflict.data || []).find((item) => {
        if (item._id === data.orderId) return false
        return isOrderConflictCandidate(item) && orderTimeRangesOverlap(order, item)
      })
      if (conflict) throw new Error('宠托师该时间段已有订单，无法重复预约')
      if (risk.requiresConfirmation && data.riskConfirmed !== true) throw new Error('请先阅读并确认超出接单设置的履约责任')
      const time = now()
      const assignmentUpdate = {
        staffUserId: user._id,
        staffOpenid: openid,
        staffProfileId: profile._id,
        status: 'assigned',
        assignmentSource: publishMode === 'direct' ? 'direct_accept' : 'open_grab',
        assignedAt: time,
        updatedAt: time
      }
      // 【新增】只在有有效值时记录接单位置信息
      if (hasCoordinate(currentLat, currentLng)) {
        assignmentUpdate.acceptLocationLatitude = currentLat
        assignmentUpdate.acceptLocationLongitude = currentLng
      }
      if (distanceFromCurrent !== null && !isNaN(distanceFromCurrent)) {
        assignmentUpdate.acceptDistanceKm = distanceFromCurrent
      }
      if (risk.requiresConfirmation) {
        assignmentUpdate.acceptRiskConfirmedAt = time
        assignmentUpdate.acceptRiskWarnings = risk.warnings
      }
      const extraWhere = (db.command && typeof db.command.in === 'function') ? { staffOpenid: db.command.in(['', null]) } : {}
      const updateResult = await updateOrderWhenStatus(data.orderId, ORDER_STATUS.PAID, assignmentUpdate, '订单已被分配', extraWhere)

      // 如果更新失败（没有匹配到订单），说明订单已被其他人抢走
      if (!updateResult || !updateResult.stats || !updateResult.stats.updated) {
        throw new Error('订单已被其他宠托师抢走，请查看其他订单')
      }

      const assignedOrder = { ...order, _id: data.orderId, ...assignmentUpdate }
      const assignedTitle = publishMode === 'direct' ? '指定宠托师已接单' : '宠托师已抢单'
      await appendOrderTimeline(data.orderId, 'assigned', assignedTitle, maskStaffName(profile.realName), 'staff')
      await appendOrderClientMessage(assignedOrder, { eventType: 'assigned', title: assignedTitle, detail: maskStaffName(profile.realName), actorRole: 'staff' })
      const notifyResult = await notifyOrderAccepted(assignedOrder, maskStaffName(profile.realName))
      await db.collection('orders').doc(data.orderId).update({ data: { acceptedNotifyStatus: notifyResult && notifyResult.status || 'skipped', acceptedNotifyError: notifyResult && notifyResult.error || '', updatedAt: time } })
      return { orderId: data.orderId, status: 'assigned', notifyStatus: notifyResult && notifyResult.status || 'skipped', notifyError: notifyResult && notifyResult.error || '' }
    }
    if (action === 'getDepositStatus') {
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      const settings = await getSystemSettings()
      const config = settings.staffDeposit || normalizeStaffDepositConfig()
      const supplies = settings.staffSupplies || normalizeStaffSuppliesConfig()
      let deposit = null
      const depositRes = await db.collection('staff_deposits').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      if (depositRes.data && depositRes.data[0]) {
        deposit = depositRes.data[0]
      }
      const auditApproved = profile && profile.auditStatus === 'approved'
      const canPay = Boolean(config.enabled && config.amount > 0 && auditApproved && (!deposit || deposit.status === 'unpaid'))
      const canRequestRefund = Boolean(deposit && ['paid', 'partially_refunded'].includes(deposit.status) && (deposit.availableRefundAmount || 0) > 0 && deposit.refundStatus !== 'requested')
      return {
        config,
        supplies,
        deposit,
        profile,
        canPay,
        canRequestRefund
      }
    }
    if (action === 'createDepositPayment') {
      if (data.agreed !== true) throw new Error('请先阅读并同意保证金缴纳规则')
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved') throw new Error('资料审核通过后方可缴纳保证金')
      const settings = await getSystemSettings({ includeSecrets: true })
      const config = settings.staffDeposit || normalizeStaffDepositConfig()
      if (!config.enabled || !config.amount || config.amount <= 0) throw new Error('保证金缴纳当前未开放')
      const clientRequestId = getClientRequestId(data)
      let depositRes = await db.collection('staff_deposits').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      let deposit = depositRes.data && depositRes.data[0]
      if (deposit && deposit.status === 'paid') throw new Error('您已缴纳保证金，无需重复缴纳')
      const time = now()
      const amount = Number(config.amount)
      if (!deposit) {
        const created = await db.collection('staff_deposits').add({
          data: {
            staffOpenid: openid,
            staffUserId: user._id,
            staffProfileId: profile._id,
            amount,
            paidAmount: 0,
            refundedAmount: 0,
            forfeitedAmount: 0,
            availableRefundAmount: 0,
            status: 'unpaid',
            statusText: '待支付',
            refundStatus: '',
            clientRequestId,
            createdAt: time,
            updatedAt: time
          }
        })
        deposit = { _id: created._id, staffOpenid: openid, staffUserId: user._id, staffProfileId: profile._id, amount, paidAmount: 0, refundedAmount: 0, forfeitedAmount: 0, availableRefundAmount: 0, status: 'unpaid', statusText: '待支付', refundStatus: '', clientRequestId, createdAt: time, updatedAt: time }
      }
      const paymentMode = (settings.payment && settings.payment.mode) || 'mock'
      if (paymentMode === 'mock') {
        const paymentNo = `dep_mock_${Date.now()}`
        await markStaffDepositPaid(deposit._id, { paymentNo, channel: 'mock' })
        return { paid: true, depositId: deposit._id }
      } else {
        const configWechat = getWechatPayConfig(settings)
        let paymentRecord = (await db.collection('payments').where({ orderId: deposit._id, targetType: 'staff_deposit', status: 'pending' }).limit(1).get()).data[0]
        if (!paymentRecord) {
          const paymentNo = createPaymentNo()
          const pCreated = await db.collection('payments').add({
            data: {
              orderId: deposit._id,
              depositId: deposit._id,
              targetType: 'staff_deposit',
              openid,
              paymentNo,
              prepayId: '',
              wxTransactionId: '',
              amount,
              currency: 'CNY',
              status: 'pending',
              channel: 'wechat',
              clientRequestId,
              idempotencyKey: clientRequestId || makeIdempotencyKey('payment', deposit._id, paymentNo),
              rawRequest: {},
              rawCallback: {},
              createdAt: time,
              updatedAt: time
            }
          })
          paymentRecord = { _id: pCreated._id, paymentNo, prepayId: '' }
        }
        if (paymentRecord.prepayId) {
          return {
            paid: false,
            depositId: deposit._id,
            paymentNo: paymentRecord.paymentNo,
            payParams: buildMiniProgramPayParams(paymentRecord.prepayId, configWechat)
          }
        }
        const requestBody = {
          appid: configWechat.appId,
          mchid: configWechat.mchId,
          description: '宠托师入驻保证金',
          out_trade_no: paymentRecord.paymentNo,
          notify_url: configWechat.notifyUrl,
          amount: { total: amountYuanToFen(amount), currency: 'CNY' },
          payer: { openid }
        }
        try {
          const response = await wechatPayRequest('POST', '/v3/pay/transactions/jsapi', requestBody, configWechat)
          if (!response.prepay_id) throw new Error('微信支付未返回 prepay_id')
          await db.collection('payments').doc(paymentRecord._id).update({
            data: {
              prepayId: response.prepay_id,
              rawRequest: sanitizeWechatPayload(requestBody),
              rawResponse: sanitizeWechatPayload(response),
              updatedAt: now()
            }
          })
          return {
            paid: false,
            depositId: deposit._id,
            paymentNo: paymentRecord.paymentNo,
            payParams: buildMiniProgramPayParams(response.prepay_id, configWechat)
          }
        } catch (error) {
          await appendPaymentEvent('prepay_failed', { orderId: deposit._id, paymentNo: paymentRecord.paymentNo, status: 'failed', detail: { message: error.message, targetType: 'staff_deposit' } })
          throw new Error(`微信支付保证金下单失败：${error.message}`)
        }
      }
    }
    if (action === 'requestDepositRefund') {
      const reason = safeText(data.reason).trim()
      if (!reason) throw new Error('请填写自愿退出及退款原因')
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile) throw new Error('宠托师资料不存在')
      const depositRes = await db.collection('staff_deposits').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      const deposit = depositRes.data && depositRes.data[0]
      if (!deposit || !['paid', 'partially_refunded'].includes(deposit.status) || (deposit.availableRefundAmount || 0) <= 0) {
        throw new Error('暂无可退还保证金')
      }
      if (deposit.refundStatus === 'requested') throw new Error('已有待审核的退出退款申请')
      const activeOrders = await db.collection('orders').where({ staffOpenid: openid }).get()
      const hasUnfinished = (activeOrders.data || []).some((o) => ['assigned', 'in_service'].includes(o.status))
      if (hasUnfinished) throw new Error('尚有进行中的服务订单，请完成所有订单履约后再申请退出')
      const incidents = await db.collection('order_incidents').where({ staffOpenid: openid }).get()
      const hasUnresolvedIncidents = (incidents.data || []).some((inc) => ['open', 'investigating', 'processing'].includes(inc.status))
      if (hasUnresolvedIncidents) throw new Error('存在尚未处理完毕的订单客诉或纠纷，请待纠纷结案后再申请退还保证金')
      const time = now()
      await db.collection('staff_deposits').doc(deposit._id).update({
        data: {
          status: 'refund_requested',
          statusText: '退款审核中',
          refundStatus: 'requested',
          refundReason: reason,
          refundRequestedAt: time,
          updatedAt: time
        }
      })
      await db.collection('staff_profiles').doc(profile._id).update({
        data: {
          exitStatus: 'requested',
          depositStatus: 'refund_requested',
          updatedAt: time
        }
      })
      await db.collection('staff_deposit_events').add({
        data: {
          depositId: deposit._id,
          staffOpenid: openid,
          staffUserId: user._id,
          type: 'refund_request',
          amount: deposit.availableRefundAmount,
          reason,
          operatorOpenid: openid,
          operatorRole: 'staff',
          createdAt: time
        }
      })
      return { success: true, status: 'refund_requested' }
    }
    if (action === 'getSupplyReimbursementStatus') {
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      const settings = await getSystemSettings()
      const supplies = settings.staffSupplies || normalizeStaffSuppliesConfig()
      const res = await db.collection('staff_supply_reimbursements').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      const application = res.data && res.data[0] || null
      const isCertified = Boolean(profile && profile.auditStatus === 'approved' && profile.staffLevel === 'certified')
      const canApply = Boolean(!application && isCertified && supplies.reimbursementEnabled !== false)
      return {
        application,
        canApply,
        supplies
      }
    }
    if (action === 'submitSupplyReimbursement') {
      const clientRequestId = getClientRequestId(data)
      if (clientRequestId) {
        const existingReq = await findByClientRequestId('staff_supply_reimbursements', { staffOpenid: openid, clientRequestId })
        if (existingReq) return existingReq
      }
      const user = await getUser(openid)
      const profile = await getStaffProfileByOpenid(openid)
      if (!profile || profile.auditStatus !== 'approved' || profile.staffLevel !== 'certified') {
        throw new Error('仅正式认证宠托师可申请首次用品报销，实习人员不具备报销资格')
      }
      const settings = await getSystemSettings()
      const supplies = settings.staffSupplies || normalizeStaffSuppliesConfig()
      if (supplies.reimbursementEnabled === false) throw new Error('用品报销申请暂未开放')
      const existing = await db.collection('staff_supply_reimbursements').where({ staffOpenid: openid }).limit(1).get()
      if (existing.data && existing.data.length > 0) {
        throw new Error('每位宠托师仅限申请一次首次宠物用品报销，后续服务用品须自备自费')
      }
      const mediaFileIds = Array.isArray(data.mediaFileIds) ? data.mediaFileIds.filter(Boolean) : []
      if (!mediaFileIds.length) throw new Error('请上传首次购买凭证截图')
      const amount = Number(data.amount)
      if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
        throw new Error('请填写有效的报销金额，最多两位小数')
      }
      const maxCap = supplies.maxReimbursementAmount || 200
      if (amount > maxCap) {
        throw new Error(`首次用品报销金额不能超过上限 ¥${maxCap}`)
      }
      const remark = safeText(data.remark).trim()
      const time = now()
      const record = {
        staffOpenid: openid,
        staffUserId: user._id,
        staffProfileId: profile._id,
        mediaFileIds,
        amount,
        approvedAmount: null,
        remark,
        clientRequestId,
        status: 'pending',
        statusText: '待审核',
        transferStatus: '',
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('staff_supply_reimbursements').add({ data: record })
      await db.collection('staff_profiles').doc(profile._id).update({
        data: {
          supplyReimbursementStatus: 'pending',
          updatedAt: time
        }
      })
      return { _id: created._id, ...record }
    }
    if (action === 'querySupplyReimbursement') {
      await getUser(openid)
      const res = await db.collection('staff_supply_reimbursements').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      return res.data && res.data[0] || null
    }
    if (action === 'getSupplyTransferConfirmation') {
      await getUser(openid)
      const res = await db.collection('staff_supply_reimbursements').where({ staffOpenid: openid }).orderBy('createdAt', 'desc').limit(1).get()
      const app = res.data && res.data[0]
      if (!app) throw new Error('暂无报销申请')
      const settings = await getSystemSettings()
      const mchId = (settings.payment && settings.payment.mchId) || ''
      const appId = (settings.payment && settings.payment.appId) || ''
      return {
        status: app.transferStatus || (app.status === 'approved' ? 'WAIT_USER_CONFIRM' : app.status),
        mchId,
        appId,
        packageInfo: app.transferPackageInfo || ''
      }
    }
    throw new Error('未知 staff 操作')
  },

  async track(openid, action, data) {
    if (action === 'batchUploadTrack') {
      const { user, order } = await requireStaffOrder(openid, data.orderId, '仅订单员工可上传轨迹')
      if (order.status !== 'in_service') throw new Error('仅服务中可上传轨迹')
      const uploadedAt = now()
      const settings = await getSystemSettings()
      const batchSize = settings.reliability.maxTrackBatchSize || 50
      const rawPoints = Array.isArray(data.points) ? data.points.slice(0, batchSize) : []
      if (!rawPoints.length) throw new Error('请上传轨迹点')
      const batchId = safeText(data.batchId).trim()
      const points = rawPoints
        .map((point) => ({
          clientPointId: safeText(point.clientPointId).trim(),
          batchId,
          latitude: Number(point.latitude),
          longitude: Number(point.longitude),
          speed: Number(point.speed || 0),
          accuracy: Number(point.accuracy || 0),
          recordedAt: point.recordedAt || uploadedAt,
          isBackfilled: point.isBackfilled === true || data.isBackfilled === true,
          uploadedAt
        }))
        .filter((point) => hasCoordinate(point.latitude, point.longitude))
      if (!points.length) throw new Error('轨迹点定位无效')
      let count = 0
      for (const point of points) {
        if (point.clientPointId) {
          const existing = await db.collection('track_logs').where({ orderId: data.orderId, clientPointId: point.clientPointId }).limit(1).get()
          if (existing.data[0]) continue
        }
        await db.collection('track_logs').add({ data: { orderId: data.orderId, staffUserId: user._id, staffOpenid: openid, clientPointId: point.clientPointId, batchId: point.batchId, latitude: point.latitude, longitude: point.longitude, speed: point.speed, accuracy: point.accuracy, recordedAt: point.recordedAt, isBackfilled: point.isBackfilled, uploadedAt: point.uploadedAt } })
        count += 1
      }
      return { count }
    }
    if (action === 'getOrderTracks') {
      await getOrderForAccess(openid, data.orderId)
      const res = await db.collection('track_logs').where({ orderId: data.orderId }).orderBy('recordedAt', 'asc').get()
      return res.data
    }
    throw new Error('未知 track 操作')
  },

  async checkin(openid, action, data) {
    if (action === 'getMonthCalendar') {
      await getUser(openid)
      const monthKey = normalizeMonthKey(data.monthKey)
      return buildMonthCalendar(openid, monthKey)
    }
    if (action === 'getMyRetroCards') {
      const user = await getUser(openid)
      const logsRes = await db.collection('retro_card_logs').where({ openid }).orderBy('createdAt', 'desc').get()
      return {
        retroCardCount: Number(user.retroCardCount || 0),
        completedOrderCount: Number(user.completedOrderCount || 0),
        logs: logsRes.data || []
      }
    }
    if (action === 'checkinToday') {
      const user = await getUser(openid)
      const todayInfo = toCstParts()
      const existing = (await db.collection('user_checkins').where({ openid, dateKey: todayInfo.dateKey }).limit(1).get()).data[0]
      if (existing) throw new Error('今天已签到')
      const config = await ensureMonthConfig(todayInfo.monthKey)
      const reward = normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === todayInfo.dayNumber) || {}, todayInfo.dayNumber)
      const claimed = await claimCheckinReward(user, reward, todayInfo, 'normal')
      const time = now()
      const created = await db.collection('user_checkins').add({
        data: {
          userId: user._id,
          openid,
          monthKey: todayInfo.monthKey,
          dateKey: todayInfo.dateKey,
          day: todayInfo.dayNumber,
          checkinType: 'normal',
          usedRetroCard: false,
          rewardSnapshot: claimed.rewardSnapshot,
          pointsDelta: claimed.pointsDelta,
          couponId: claimed.couponId || '',
          createdAt: time,
          updatedAt: time
        }
      })
      return {
        _id: created._id,
        monthKey: todayInfo.monthKey,
        dateKey: todayInfo.dateKey,
        day: todayInfo.dayNumber,
        rewardSnapshot: claimed.rewardSnapshot,
        pointsDelta: claimed.pointsDelta,
        couponId: claimed.couponId || '',
        retroCardCount: Number((await getUser(openid)).retroCardCount || 0)
      }
    }
    if (action === 'retroCheckin') {
      const user = await getUser(openid)
      const todayInfo = toCstParts()
      const monthKey = normalizeMonthKey(data.monthKey || todayInfo.monthKey)
      const day = Math.max(Math.round(Number(data.day || 0)), 1)
      if (monthKey !== todayInfo.monthKey) throw new Error('当前仅支持补签本月日期')
      if (day >= todayInfo.dayNumber) throw new Error('只能补签今天之前的日期')
      if (day > getMonthDays(monthKey)) throw new Error('补签日期无效')
      const dateKey = `${monthKey}-${String(day).padStart(2, '0')}`
      const clientRequestId = safeText(data.clientRequestId).trim()
      if (clientRequestId) {
        const sameRequest = (await db.collection('user_checkins').where({ openid, clientRequestId }).limit(1).get()).data[0]
        if (sameRequest) return { ...sameRequest, retroCardCount: Number((await getUser(openid)).retroCardCount || 0) }
      }
      const existing = (await db.collection('user_checkins').where({ openid, dateKey }).limit(1).get()).data[0]
      if (existing) throw new Error(existing.status === 'processing' ? '补签处理中，请稍后刷新' : '该日期已签到')

      const time = now()
      const checkinId = `checkin_${openid}_${dateKey}`
      let cardSpent = false
      let rewardClaimed = false
      try {
        await db.collection('user_checkins').add({
          data: {
            _id: checkinId,
            userId: user._id,
            openid,
            monthKey,
            dateKey,
            day,
            clientRequestId,
            checkinType: 'retro',
            usedRetroCard: true,
            status: 'processing',
            rewardSnapshot: {},
            pointsDelta: 0,
            couponId: '',
            createdAt: time,
            updatedAt: time
          }
        })
        await grantRetroCards(openid, user._id, -1, 'retro_checkin', dateKey, `补签 ${dateKey} 消耗补签卡 1 张`)
        cardSpent = true
        const config = await ensureMonthConfig(monthKey)
        const reward = normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === day) || {}, day)
        const claimed = await claimCheckinReward(user, reward, { monthKey, dateKey, dayNumber: day }, 'retro')
        rewardClaimed = true
        await db.collection('user_checkins').doc(checkinId).update({
          data: {
            status: 'completed',
            rewardSnapshot: claimed.rewardSnapshot,
            pointsDelta: claimed.pointsDelta,
            couponId: claimed.couponId || '',
            updatedAt: now()
          }
        })
        return {
          _id: checkinId,
          monthKey,
          dateKey,
          day,
          rewardSnapshot: claimed.rewardSnapshot,
          pointsDelta: claimed.pointsDelta,
          couponId: claimed.couponId || '',
          retroCardCount: Number((await getUser(openid)).retroCardCount || 0)
        }
      } catch (error) {
        const locked = (await db.collection('user_checkins').where({ openid, dateKey }).limit(1).get()).data[0]
        const isOwnProcessing = locked && locked._id === checkinId && locked.status === 'processing'
        if (cardSpent && !rewardClaimed) {
          await grantRetroCards(openid, user._id, 1, 'retro_checkin_rollback', dateKey, `补签 ${dateKey} 失败退回补签卡 1 张`)
        }
        if (isOwnProcessing && !rewardClaimed) {
          await db.collection('user_checkins').doc(checkinId).remove()
        }
        if (!isOwnProcessing && locked) throw new Error(locked.status === 'processing' ? '补签处理中，请稍后刷新' : '该日期已签到')
        throw error
      }
    }
    if (action === 'createCheckin') {
      const { user, order } = await requireStaffOrder(openid, data.orderId, '仅订单员工可打卡')
      const isSanitization = data.eventType === 'sanitization'
      if (isSanitization) {
        if (![ORDER_STATUS.ASSIGNED, ORDER_STATUS.DAY_COMPLETED].includes(order.status)) throw new Error('消毒打卡须在开始服务前完成')
        const session = getNextPendingServiceSession({ ...order, _id: data.orderId })
        if (!session || !(await canStartOrderSession({ ...order, _id: data.orderId }, session))) throw new Error('服务时间未到，可申请提前开始')
        if (data.isBackfilled === true) throw new Error('消毒打卡须现场拍照上传，不支持补传')
      } else if (order.status !== 'in_service') throw new Error('仅服务中可打卡')
      if (!data.eventType) throw new Error('请选择打卡类型')
      if (!CHECKIN_EVENT_TYPES.has(data.eventType)) throw new Error('打卡类型无效')
      if (!data.mediaFileId) throw new Error('请先上传打卡照片')
      if (data.eventType === 'pet_beauty_photo') {
        await checkImageSecurity(openid, data.mediaFileId, { scene: 3, label: '美照' })
      }
      const clientRequestId = safeText(data.clientRequestId).trim()
      if (clientRequestId) {
        const existing = await db.collection('checkin_logs').where({ orderId: data.orderId, clientRequestId }).limit(1).get()
        if (existing.data[0]) {
          if (isSanitization && (!isValidSanitization(existing.data[0], order) || existing.data[0].mediaFileId !== data.mediaFileId)) throw new Error('消毒打卡请求已失效，请重新拍照')
          if (isSanitization) await validateSanitizationMedia(data.mediaFileId, data.orderId, openid)
          return existing.data[0]
        }
      }
      const latitude = Number(data.latitude || 0)
      const longitude = Number(data.longitude || 0)
      if (!hasCoordinate(latitude, longitude)) throw new Error('打卡定位无效')
      const time = now()
      if (isSanitization) {
        await validateSanitizationMedia(data.mediaFileId, data.orderId, openid)
        const parts = data.mediaFileId.slice(data.mediaFileId.lastIndexOf('/') + 1).split('_')
        const uploadedAt = Number(parts[0])
        if (Number.isFinite(uploadedAt) && uploadedAt > 0 && (uploadedAt > time.getTime() + 60000 || time.getTime() - uploadedAt > 15 * 60 * 1000)) {
          throw new Error('消毒照片已过期，请重新现场拍照')
        }
        const reused = await db.collection('checkin_logs').where({ mediaFileId: data.mediaFileId }).limit(1).get()
        if (reused.data.length) throw new Error('消毒照片已使用，请重新现场拍照')
      }
      const recordedAt = isSanitization ? time : (data.recordedAt || time)
      const existingEventPhotos = await db.collection('checkin_logs').where({ orderId: data.orderId, eventType: data.eventType }).get()
      const shouldWriteTimeline = !(existingEventPhotos.data || []).some(hasCheckinPhoto)
      const checkin = { orderId: data.orderId, staffUserId: user._id, staffOpenid: openid, clientRequestId, eventType: data.eventType, mediaFileId: data.mediaFileId || '', watermarkedMediaFileId: '', latitude, longitude, serverTime: time, recordedAt, isBackfilled: data.isBackfilled === true, remark: data.remark || data.note || '', createdAt: time, updatedAt: time, deletedAt: null, deletedByOpenid: '' }
      if (isSanitization) {
        checkin.preStart = true
        checkin.sanitizationVersion = 1
      }
      const created = await db.collection('checkin_logs').add({ data: checkin })
      if (shouldWriteTimeline) await appendOrderTimeline(data.orderId, 'checkin', data.isBackfilled === true ? '服务打卡已补传' : '服务打卡', data.eventType, 'staff')
      return { _id: created._id, ...checkin }
    }
    if (action === 'deleteCheckin') {
      const { order } = await requireStaffOrder(openid, data.orderId, '仅订单员工可删除打卡照片')
      if (order.status !== 'in_service') throw new Error('仅服务中可删除打卡照片')
      if (!data.checkinId) throw new Error('请选择要删除的照片')
      const checkin = (await db.collection('checkin_logs').doc(data.checkinId).get()).data
      if (!checkin || checkin.orderId !== data.orderId) throw new Error('打卡照片不存在')
      if (checkin.eventType === 'sanitization') throw new Error('服务前消毒凭证不可删除')
      if (checkin.deletedAt) return { _id: data.checkinId, deletedAt: checkin.deletedAt }
      const time = now()
      await db.collection('checkin_logs').doc(data.checkinId).update({ data: { deletedAt: time, deletedByOpenid: openid, updatedAt: time } })
      return { _id: data.checkinId, deletedAt: time }
    }
    if (action === 'listOrderCheckins') {
      await getOrderForAccess(openid, data.orderId)
      const res = await db.collection('checkin_logs').where({ orderId: data.orderId }).orderBy('recordedAt', 'asc').get()
      return (res.data || []).filter(isActiveCheckin)
    }
    throw new Error('未知 checkin 操作')
  },

  async incident(openid, action, data) {
    if (action === 'createSosIncident') {
      const clientRequestId = getClientRequestId(data)
      const existingByRequest = await findByClientRequestId('order_incidents', { orderId: data.orderId, staffOpenid: openid, clientRequestId })
      if (existingByRequest) return existingByRequest
      const { user, order } = await requireStaffOrder(openid, data.orderId, '不是该订单员工')
      const time = now()
      const incident = { orderId: data.orderId, clientOpenid: order.clientOpenid || '', staffUserId: user._id, staffOpenid: openid, clientRequestId, idempotencyKey: clientRequestId || makeIdempotencyKey('incident_sos', data.orderId, openid, time.getTime()), incidentType: normalizeIncidentType(data.incidentType, 'sos'), title: data.title || '宠托师 SOS', description: data.description || '', latitude: Number(data.latitude || 0), longitude: Number(data.longitude || 0), mediaFileIds: data.mediaFileIds || [], status: 'open', resolution: null, refundId: '', refundNo: '', frozenEarningIds: [], createdByRole: 'staff', createdAt: time, updatedAt: time }
      const created = await db.collection('order_incidents').add({ data: incident })
      await recordIncidentAction(created._id, 'created_sos', 'staff', openid, { orderId: data.orderId })
      await appendOrderTimeline(data.orderId, 'incident_open', '宠托师发起 SOS', incident.description, 'staff')
      return { _id: created._id, ...incident }
    }
    if (action === 'createComplaint') {
      const clientRequestId = getClientRequestId(data)
      const existingByRequest = await findByClientRequestId('order_incidents', { orderId: data.orderId, openid, clientRequestId })
      if (existingByRequest) return existingByRequest
      const { user, order } = await requireClientOrder(openid, data.orderId, '仅宠物主可发起投诉')
      const description = safeText(data.description).trim()
      if (!description) throw new Error('请填写投诉说明')
      const time = now()
      const incident = { orderId: data.orderId, clientUserId: user._id, clientOpenid: openid, openid, clientRequestId, idempotencyKey: clientRequestId || makeIdempotencyKey('incident', data.orderId, openid, time.getTime()), staffOpenid: order.staffOpenid || '', staffProfileId: order.staffProfileId || '', incidentType: normalizeIncidentType(data.incidentType, 'complaint'), title: safeText(data.title).trim() || '订单投诉', description, latitude: Number(data.latitude || 0), longitude: Number(data.longitude || 0), mediaFileIds: Array.isArray(data.mediaFileIds) ? data.mediaFileIds.slice(0, 9) : [], status: 'open', resolution: null, refundId: '', refundNo: '', frozenEarningIds: [], createdByRole: 'client', createdAt: time, updatedAt: time }
      const created = await db.collection('order_incidents').add({ data: incident })
      await recordIncidentAction(created._id, 'created_complaint', 'client', openid, { orderId: data.orderId })
      await appendOrderTimeline(data.orderId, 'incident_open', '宠物主发起投诉', incident.title, 'client')
      return { _id: created._id, ...incident }
    }
    if (action === 'getIncidentDetail') {
      const { user, incident } = await getIncidentForAccess(openid, data.id || data.incidentId)
      const comments = (await db.collection('incident_comments').where({ incidentId: incident._id }).orderBy('createdAt', 'asc').get()).data || []
      const actions = user.roles.includes('admin') ? ((await db.collection('incident_actions').where({ incidentId: incident._id }).orderBy('createdAt', 'asc').get()).data || []) : []
      const order = incident.orderId ? (await db.collection('orders').doc(incident.orderId).get()).data : null
      return { incident, comments, actions, order: order ? await attachOrderDisplayData(order) : null }
    }
    if (action === 'appendIncidentComment') {
      const { user, incident } = await getIncidentForAccess(openid, data.incidentId)
      const actorRole = user.roles.includes('admin') ? 'admin' : (incident.staffOpenid === openid ? 'staff' : 'client')
      const comment = await appendIncidentComment(data.incidentId, actorRole, openid, data.content, data.mediaFileIds)
      await db.collection('order_incidents').doc(data.incidentId).update({ data: { updatedAt: now() } })
      await recordIncidentAction(data.incidentId, 'commented', actorRole, openid, { commentId: comment._id })
      return comment
    }
    if (action === 'uploadIncidentEvidence') {
      const { user, incident } = await getIncidentForAccess(openid, data.incidentId)
      const actorRole = user.roles.includes('admin') ? 'admin' : (incident.staffOpenid === openid ? 'staff' : 'client')
      const comment = await appendIncidentComment(data.incidentId, actorRole, openid, data.remark || '补充证据', data.mediaFileIds)
      await recordIncidentAction(data.incidentId, 'evidence_uploaded', actorRole, openid, { commentId: comment._id })
      return comment
    }
    if (action === 'listMyIncidents') {
      const user = await getUser(openid)
      const role = data.role === 'staff' ? 'staff' : 'client'
      const where = role === 'staff' && user.roles.includes('staff') ? { staffOpenid: openid } : { clientOpenid: openid }
      const status = safeText(data.status).trim()
      const res = await db.collection('order_incidents').where(where).orderBy('createdAt', 'desc').get()
      const list = (res.data || []).filter((item) => !status || item.status === status)
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'listIncidents') {
      await requireAdmin(openid)
      const status = safeText(data.status).trim()
      const orderId = safeText(data.orderId).trim()
      const res = await db.collection('order_incidents').orderBy('createdAt', 'desc').get()
      return paginateList((res.data || []).filter((item) => (!status || item.status === status) && (!orderId || item.orderId === orderId)), data)
    }
    if (action === 'updateIncidentStatus' || action === 'resolveIncident') {
      await requireAdmin(openid)
      const id = data.id || data.incidentId
      const status = action === 'resolveIncident' ? normalizeIncidentStatus(data.status, 'resolved') : normalizeIncidentStatus(data.status, 'processing')
      const update = { status, updatedAt: now() }
      await db.collection('order_incidents').doc(id).update({ data: update })
      await recordIncidentAction(id, 'status_updated', 'admin', openid, { status })
      return { id, status }
    }
    if (action === 'proposeResolution') {
      const admin = await requireAdmin(openid)
      const id = data.id || data.incidentId
      const incident = (await db.collection('order_incidents').doc(id).get()).data
      if (!incident) throw new Error('纠纷不存在')
      const type = safeText(data.resolutionType || data.type).trim() || 'explain'
      const resolution = { type, content: safeText(data.content).trim(), refundAmount: Number(data.refundAmount || 0), couponTemplateId: '', couponId: '', couponSnapshot: null, createdByOpenid: openid, createdAt: now() }
      if (type === 'coupon') {
        const couponTemplateId = safeText(data.couponTemplateId).trim()
        if (!couponTemplateId) throw new Error('请选择补偿优惠券')
        const order = (await db.collection('orders').doc(incident.orderId).get()).data
        const targetUser = (await db.collection('users').where({ openid: order.clientOpenid || incident.clientOpenid }).limit(1).get()).data[0]
        if (!targetUser) throw new Error('目标用户不存在')
        const template = (await db.collection('coupon_templates').doc(couponTemplateId).get()).data
        const issued = await issueCouponToTargetUser(template, targetUser, { adminUserId: admin._id, adminOpenid: openid })
        resolution.couponTemplateId = couponTemplateId
        resolution.couponId = issued._id
        resolution.couponSnapshot = issued.templateSnapshot
        await recordIncidentAction(id, 'coupon_issued', 'admin', openid, { couponId: issued._id, couponTemplateId })
      }
      const status = data.status ? normalizeIncidentStatus(data.status) : 'processing'
      await db.collection('order_incidents').doc(id).update({ data: { resolution, status, updatedAt: now() } })
      await recordIncidentAction(id, 'resolution_proposed', 'admin', openid, resolution)
      await appendOrderTimeline(incident.orderId, 'incident_resolution', '平台提出处理方案', resolution.content || type, 'admin')
      return { id, resolution, status }
    }
    if (action === 'freezeStaffEarning') {
      await requireAdmin(openid)
      const id = data.id || data.incidentId
      const incident = (await db.collection('order_incidents').doc(id).get()).data
      if (!incident) throw new Error('纠纷不存在')
      const frozen = await freezeOrderEarnings(incident.orderId, id)
      await db.collection('order_incidents').doc(id).update({ data: { frozenEarningIds: frozen, updatedAt: now() } })
      await recordIncidentAction(id, 'earning_frozen', 'admin', openid, { earningIds: frozen })
      return { id, frozenEarningIds: frozen }
    }
    if (action === 'linkRefund') {
      await requireAdmin(openid)
      const id = data.id || data.incidentId
      const incident = (await db.collection('order_incidents').doc(id).get()).data
      if (!incident) throw new Error('纠纷不存在')
      const order = (await db.collection('orders').doc(incident.orderId).get()).data
      if (!order) throw new Error('订单不存在')
      let refund = null
      let actionName = 'refund_linked'
      const refundAmount = Number(data.refundAmount || 0)
      if (refundAmount > 0) {
        if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'refunding') throw new Error('订单未支付，不能退款')
        if (refundAmount > Number(order.payAmount || 0)) throw new Error('退款金额不正确')
        refund = await createRefundForOrder({ ...order, _id: incident.orderId }, refundAmount, safeText(data.reason).trim() || '纠纷处理退款', 'incident', openid, getClientRequestId(data))
        actionName = 'refund_created'
      } else if (data.refundId) {
        refund = (await db.collection('refunds').doc(data.refundId).get()).data
        if (!refund) throw new Error('退款单不存在')
      }
      const update = { refundId: (refund && refund._id) || data.refundId || '', refundNo: (refund && refund.refundNo) || data.refundNo || '', status: 'refund_pending', updatedAt: now() }
      await db.collection('order_incidents').doc(id).update({ data: update })
      if (refund) {
        await db.collection('orders').doc(incident.orderId).update({ data: { paymentStatus: 'refunding', refundStatus: 'processing', refundAmount: Number(refund.refundAmount || refundAmount || 0), refundNo: refund.refundNo || '', updatedAt: now() } })
        await appendOrderTimeline(incident.orderId, 'refund_processing', '纠纷处理退款中', `退款金额 ¥${Number(refund.refundAmount || refundAmount || 0)}`, 'admin')
      }
      await recordIncidentAction(id, actionName, 'admin', openid, { ...update, refundAmount: refund ? Number(refund.refundAmount || 0) : 0 })
      return { id, ...update }
    }
    if (action === 'closeIncident') {
      await requireAdmin(openid)
      const id = data.id || data.incidentId
      const incident = (await db.collection('order_incidents').doc(id).get()).data
      if (!incident) throw new Error('纠纷不存在')
      const status = normalizeIncidentStatus(data.status, 'closed')
      const closeRemark = safeText(data.closeRemark).trim()
      const earningResult = await finalizeIncidentEarnings(incident, data.earningDecision, data.deductAmount, safeText(data.earningRemark || closeRemark).trim())
      const update = { status, closeRemark, closedAt: now(), updatedAt: now() }
      if (earningResult.decision) update.earningResolution = earningResult
      await db.collection('order_incidents').doc(id).update({ data: update })
      if (earningResult.decision) await recordIncidentAction(id, `earning_${earningResult.decision}`, 'admin', openid, earningResult)
      await recordIncidentAction(id, 'closed', 'admin', openid, { status, closeRemark })
      await appendOrderTimeline(incident.orderId, 'incident_closed', '纠纷已结案', closeRemark || status, 'admin')
      return { id, status, earningResolution: earningResult.decision ? earningResult : null }
    }
    throw new Error('未知 incident 操作')
  },

  async admin(openid, action, data) {
    const admin = await requireAdmin(openid)
    if (action === 'dashboard') {
      await expireDueUnacceptedOrders()
      const statuses = ['paid', 'assigned', 'in_service', 'completed']
      const counts = {}
      for (let i = 0; i < statuses.length; i += 1) counts[statuses[i]] = (await db.collection('orders').where({ status: statuses[i] }).count()).total
      const staffPending = await db.collection('staff_profiles').where({ auditStatus: 'pending' }).count()
      const incidentsOpen = await db.collection('order_incidents').where({ status: 'open' }).count()
      const ordersRes = await db.collection('orders').get()
      const usersRes = await db.collection('users').get()
      return { orders: counts, staffPending: staffPending.total, incidentsOpen: incidentsOpen.total, monthly: buildMonthlyDashboard(ordersRes.data || [], usersRes.data || []) }
    }
    if (action === 'financeDashboard') {
      await refreshStaffEarnings()
      const range = buildDateRange(data)
      const [orders, payments, refunds, earnings, withdraws, logs] = await Promise.all([
        getAllDocuments('orders', 'createdAt', 'desc'),
        getAllDocuments('payments', 'createdAt', 'desc'),
        getAllDocuments('refunds', 'createdAt', 'desc'),
        getAllDocuments('staff_earnings', 'createdAt', 'desc'),
        getAllDocuments('withdraw_requests', 'createdAt', 'desc'),
        getAllDocuments('finance_logs', 'createdAt', 'desc')
      ])
      return buildFinanceDashboardData({ orders, payments, refunds, earnings, withdraws, logs }, range)
    }
    if (action === 'listFinanceLogs') {
      const range = buildDateRange(data)
      const targetType = safeText(data.targetType).trim()
      const res = await db.collection('finance_logs').orderBy('createdAt', 'desc').get()
      return limitList((res.data || []).filter((item) => (!targetType || item.targetType === targetType) && inDateRange(item, range, ['createdAt'])), data.pageSize || 50)
    }
    if (action === 'listPayments') {
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const res = await db.collection('payments').orderBy('createdAt', 'desc').get()
      return limitList((res.data || []).filter((item) => (!status || item.status === status) && inDateRange(item, range, ['paidAt', 'updatedAt', 'createdAt'])), data.pageSize || 50)
    }
    if (action === 'listRefunds') {
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const res = await db.collection('refunds').orderBy('createdAt', 'desc').get()
      return limitList((res.data || []).filter((item) => (!status || item.status === status) && inDateRange(item, range, ['createdAt', 'updatedAt'])), data.pageSize || 50)
    }
    if (action === 'listStaffEarnings') {
      await refreshStaffEarnings()
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const res = await db.collection('staff_earnings').orderBy('createdAt', 'desc').get()
      return limitList((res.data || []).filter((item) => (!status || item.status === status) && inDateRange(item, range, ['createdAt', 'completedAt'])), data.pageSize || 50)
    }
    if (action === 'listWithdrawRequests') {
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const res = await db.collection('withdraw_requests').orderBy('createdAt', 'desc').get()
      return limitList((res.data || []).filter((item) => (!status || item.status === status) && inDateRange(item, range, ['createdAt', 'paidAt'])), data.pageSize || 50)
    }
    if (action === 'auditWithdrawRequest') {
      const request = (await db.collection('withdraw_requests').doc(data.id).get()).data
      if (!request) throw new Error('提现申请不存在')
      if (request.status !== 'pending') throw new Error('当前状态不可审核')
      const approved = data.approved === true
      const time = now()
      const nextStatus = approved ? 'approved' : 'rejected'
      const updated = await db.collection('withdraw_requests').where({ _id: data.id, status: 'pending' }).update({ data: { status: nextStatus, auditRemark: safeText(data.auditRemark).trim(), auditedByOpenid: openid, auditedAt: time, updatedAt: time } })
      if (!updated.stats || !updated.stats.updated) throw new Error('当前状态不可审核，请刷新后重试')
      if (!approved) {
        await Promise.all((request.earningIds || []).map((id) => db.collection('staff_earnings').doc(id).update({ data: { status: 'available', withdrawRequestId: '', updatedAt: time } })))
      }
      await appendFinanceLog(approved ? 'withdraw_approved' : 'withdraw_rejected', { targetType: 'withdraw_request', targetId: data.id, staffOpenid: request.staffOpenid, amountDelta: 0, detail: { auditRemark: data.auditRemark || '' } })
      await logAdmin(admin, 'withdraw_request', data.id, 'auditWithdrawRequest', { approved })
      await sendSubscribeMessage(request.staffOpenid, 'withdrawResult', 'pages/staff/earnings/index', buildSubscriptionData('withdrawResult', { orderNo: data.id }, { amount: request.amount, statusText: approved ? '已审核' : '已驳回' }), '')
      return { id: data.id, status: nextStatus }
    }
    if (action === 'markWithdrawPaid') {
      const request = (await db.collection('withdraw_requests').doc(data.id).get()).data
      if (!request) throw new Error('提现申请不存在')
      if (request.status !== 'approved') throw new Error('仅已审核提现可标记打款')
      const time = now()
      const updated = await db.collection('withdraw_requests').where({ _id: data.id, status: 'approved' }).update({ data: { status: 'paid', paidAt: time, paidByOpenid: openid, payRemark: safeText(data.payRemark).trim(), updatedAt: time } })
      if (!updated.stats || !updated.stats.updated) throw new Error('仅已审核提现可标记打款，请刷新后重试')
      await Promise.all((request.earningIds || []).map((id) => db.collection('staff_earnings').doc(id).update({ data: { status: 'withdrawn', updatedAt: time } })))
      await appendFinanceLog('withdraw_paid', { targetType: 'withdraw_request', targetId: data.id, staffOpenid: request.staffOpenid, amountDelta: -Number(request.amount || 0), detail: { payRemark: data.payRemark || '' } })
      await logAdmin(admin, 'withdraw_request', data.id, 'markWithdrawPaid', { amount: request.amount })
      await sendSubscribeMessage(request.staffOpenid, 'withdrawResult', 'pages/staff/earnings/index', buildSubscriptionData('withdrawResult', { orderNo: data.id }, { amount: request.amount, statusText: '已打款' }), '')
      return { id: data.id, status: 'paid' }
    }
    if (action === 'getSystemSettings') {
      return getSystemSettings({ includeSecrets: data.includeSecrets === true })
    }
    if (action === 'saveSystemSettings') {
      const saved = await saveSystemSettings(data)
      const publicValue = normalizeSystemSettings(saved.value)
      await logAdmin(admin, 'platform_config', 'system_settings', 'saveSystemSettings', publicValue)
      return publicValue
    }
    if (action === 'updateVideoAuditGuide') {
      const currentSettings = await getSystemSettings({ includeSecrets: true })
      const guide = normalizeVideoAuditGuide(data.guide || data)
      const staffTraining = {
        ...(currentSettings.staffTraining || {}),
        videoAuditGuide: guide
      }
      await saveSystemSettings({
        ...currentSettings,
        staffTraining
      })
      await logAdmin(admin, 'platform_config', 'video_audit_guide', 'updateVideoAuditGuide', guide)
      return { success: true, videoAuditGuide: guide }
    }
    if (action === 'listUsers') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const role = safeText(data.role).trim()
      const status = safeText(data.status).trim()
      const res = await db.collection('users').orderBy('createdAt', 'desc').get()
      const list = (res.data || [])
        .filter((user) => !role || (Array.isArray(user.roles) && user.roles.includes(role)))
        .filter((user) => !status || user.status === status)
        .filter((user) => !keyword || [user.openid, user.nickname, user.phone].some((value) => safeText(value).toLowerCase().includes(keyword)))
        .map((user) => safeUserSummary(user))
      return paginateList(list, data)
    }
    if (action === 'getUserDetail') {
      const targetOpenid = safeText(data.openid).trim()
      const targetUserId = safeText(data.userId || data._id).trim()
      let target = null
      if (targetOpenid) target = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      else if (targetUserId) target = (await db.collection('users').doc(targetUserId).get()).data
      if (!target) throw new Error('用户不存在')
      const stats = await getUserManageStats(target)
      return { ...safeUserSummary(target, { isSelf: target.openid === openid }), inviteCode: target.inviteCode || '', retroCardCount: Number(target.retroCardCount || 0), completedOrderCount: Number(target.completedOrderCount || 0), stats }
    }
    if (action === 'updateUserProfile') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('缺少用户 openid')
      const target = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      if (!target) throw new Error('用户不存在')
      if (target.status === 'deleted') throw new Error('已删除用户不可编辑')
      const status = safeText(data.status || target.status || 'active').trim()
      if (!['active', 'disabled'].includes(status)) throw new Error('用户状态无效')
      const roles = normalizeEditableRoles(data.roles)
      await assertAdminRoleChangeAllowed(target, roles, openid)
      const activeRole = roles.includes(data.activeRole) ? data.activeRole : (roles.includes(target.activeRole) ? target.activeRole : roles[0])
      const points = Math.max(Math.round(Number(data.points || 0)), 0)
      const totalPoints = Math.max(Math.round(Number(data.totalPoints || 0)), points)
      const levels = await getMemberLevels()
      const levelInfo = resolveUserMemberLevel({
        memberLevel: data.memberLevel,
        memberLevelName: data.memberLevelName,
        points,
        totalPoints
      }, levels)
      const update = {
        nickname: safeText(data.nickname).trim() || '微信用户',
        phone: safeText(data.phone).trim(),
        avatarUrl: safeText(data.avatarUrl).trim(),
        status,
        roles,
        activeRole,
        memberLevel: levelInfo.memberLevel,
        memberLevelName: levelInfo.memberLevelName,
        badgeTag: levelInfo.badgeTag,
        badgeStyle: levelInfo.badgeStyle,
        nameColor: levelInfo.nameColor,
        nameEffect: levelInfo.nameEffect,
        points,
        totalPoints,
        retroCardCount: Math.max(Math.round(Number(data.retroCardCount || 0)), 0),
        updatedAt: now()
      }
      await db.collection('users').doc(target._id).update({ data: update })
      await logAdmin(admin, 'user', targetOpenid, 'updateUserProfile', update)
      return safeUserSummary({ ...target, ...update }, { retroCardCount: update.retroCardCount })
    }
    if (action === 'deleteUser') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('缺少用户 openid')
      const target = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      if (!target) throw new Error('用户不存在')
      await assertUserDeleteAllowed(target, openid)
      const cleanup = await cleanupUserPersonalData(targetOpenid)
      const time = now()
      const update = {
        status: 'deleted',
        nickname: '已删除用户',
        avatarUrl: '',
        phone: '',
        roles: ['client'],
        activeRole: 'client',
        points: 0,
        totalPoints: 0,
        retroCardCount: 0,
        deletedAt: time,
        deletedByOpenid: openid,
        updatedAt: time
      }
      await db.collection('users').doc(target._id).update({ data: update })
      await logAdmin(admin, 'user', targetOpenid, 'deleteUser', { cleanup })
      return { openid: targetOpenid, cleanup, user: safeUserSummary({ ...target, ...update }) }
    }
    if (action === 'hardDeleteUser') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('缺少用户 openid')
      const target = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      if (!target) throw new Error('用户不存在')
      await assertUserDeleteAllowed(target, openid, '不能彻底删除自己的账号')
      const time = now()
      const cleanup = await cleanupUserPersonalData(targetOpenid)
      cleanup.historicalRecordsDetached = await detachUserFromHistoricalRecords(targetOpenid, time)
      await db.collection('users').doc(target._id).remove()
      await logAdmin(admin, 'user', targetOpenid, 'hardDeleteUser', { userId: target._id, cleanup })
      return { openid: targetOpenid, userId: target._id, cleanup }
    }
    if (action === 'listStaffProfiles') {
      const auditStatus = safeText(data.auditStatus).trim()
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const profilesRes = await db.collection('staff_profiles').orderBy('updatedAt', 'desc').get()
      const usersRes = await db.collection('users').get()
      const userMap = new Map((usersRes.data || []).map((user) => [user.openid, user]))
      const list = (profilesRes.data || [])
        .filter((profile) => !auditStatus || profile.auditStatus === auditStatus)
        .map((profile) => {
          const user = userMap.get(profile.openid) || {}
          const workflow = normalizeStaffWorkflow(profile)
          return {
            _id: profile._id,
            openid: profile.openid || '',
            realName: profile.realName || '',
            phone: profile.phone || user.phone || '',
            serviceCity: profile.serviceCity || '',
            serviceAreas: profile.serviceAreas || '',
            auditStatus: profile.auditStatus || 'pending',
            auditStatusText: auditStatusText(profile.auditStatus || 'pending'),
            auditRemark: profile.auditRemark || '',
            staffLevel: workflow.staffLevel,
            staffLevelText: workflow.staffLevelText,
            onboardingStatus: workflow.onboardingStatus,
            onboardingStatusText: workflow.onboardingStatusText,
            videoAuditStatus: workflow.videoAuditStatus,
            videoAuditStatusText: workflow.videoAuditStatusText,
            promotionStatus: workflow.promotionStatus,
            promotionStatusText: workflow.promotionStatusText,
            internCompletedOrderCount: workflow.internCompletedOrderCount,
            ratingAverage: Number(profile.ratingAverage || 0),
            reviewCount: Number(profile.reviewCount || 0),
            isFeatured: profile.isFeatured === true,
            featuredAt: profile.featuredAt || '',
            createdAt: profile.createdAt || '',
            updatedAt: profile.updatedAt || '',
            userNickname: user.nickname || '微信用户',
            userAvatarUrl: user.avatarUrl || '',
            userStatus: user.status || '',
            roles: Array.isArray(user.roles) ? user.roles : []
          }
        })
        .filter((item) => !keyword || [item.openid, item.realName, item.phone, item.serviceCity, item.serviceAreas, item.userNickname].some((value) => safeText(value).toLowerCase().includes(keyword)))
      return paginateList(list, data)
    }
    if (action === 'setSitterFeatured') {
      const staffProfileId = safeText(data.staffProfileId).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
      const profile = profileRes.data
      if (!profile) throw new Error('宠托师不存在')
      if (!isCertifiedSitter(profile)) throw new Error('仅已审核通过的宠托师可设为精选')
      const time = now()
      const isFeatured = data.isFeatured === true
      const update = isFeatured
        ? { isFeatured: true, featuredAt: time, featuredByOpenid: openid, updatedAt: time }
        : { isFeatured: false, featuredAt: '', featuredByOpenid: '', updatedAt: time }
      await db.collection('staff_profiles').doc(staffProfileId).update({ data: update })
      await logAdmin(admin, 'staff_profile', staffProfileId, 'setSitterFeatured', { isFeatured })
      return { staffProfileId, ...update }
    }
    if (action === 'listAdmins') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const usersRes = await db.collection('users').get()
      const list = (usersRes.data || [])
        .filter((user) => Array.isArray(user.roles) && user.roles.includes('admin'))
        .filter((user) => !keyword || [user.openid, user.nickname, user.phone, user.status].some((value) => safeText(value).toLowerCase().includes(keyword)))
        .map((user) => safeUserSummary(user, { isSelf: user.openid === openid }))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'grantAdmin') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('请输入用户 openid')
      const userRes = await db.collection('users').where({ openid: targetOpenid }).limit(1).get()
      const target = userRes.data[0]
      if (!target || target.status !== 'active') throw new Error('目标用户不存在或不可用')
      const roles = Array.from(new Set([...(Array.isArray(target.roles) ? target.roles : ['client']), 'admin']))
      await db.collection('users').doc(target._id).update({ data: { roles, updatedAt: now() } })
      await logAdmin(admin, 'user', targetOpenid, 'grantAdmin', {})
      return safeUserSummary({ ...target, roles })
    }
    if (action === 'revokeAdmin') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('请输入用户 openid')
      if (targetOpenid === openid) throw new Error('不能移除自己的管理员权限')
      const usersRes = await db.collection('users').get()
      const admins = (usersRes.data || []).filter((user) => Array.isArray(user.roles) && user.roles.includes('admin'))
      if (admins.length <= 1) throw new Error('至少保留一个管理员')
      const target = (usersRes.data || []).find((user) => user.openid === targetOpenid)
      if (!target) throw new Error('目标用户不存在')
      const roles = (Array.isArray(target.roles) ? target.roles : []).filter((role) => role !== 'admin')
      const update = { roles, updatedAt: now() }
      if (target.activeRole === 'admin') update.activeRole = 'client'
      await db.collection('users').doc(target._id).update({ data: update })
      await logAdmin(admin, 'user', targetOpenid, 'revokeAdmin', {})
      return safeUserSummary({ ...target, ...update })
    }
    if (action === 'listOrders') {
      await expireDueUnacceptedOrders()
      const rawStatus = safeText(data.status).trim()
      const specialFilter = safeText(data.specialFilter).trim()
      const isAutoFilter = rawStatus === 'auto_completed' || specialFilter === 'auto_completed'
      const isOverdueFilter = rawStatus === 'overdue' || specialFilter === 'overdue'
      const isNormalStatus = rawStatus && !['all', 'overdue', 'auto_completed'].includes(rawStatus)
      const where = isNormalStatus ? { status: rawStatus } : {}
      const res = await db.collection('orders').where(where).orderBy('createdAt', 'desc').get()
      const orderKeyword = safeText(data.orderKeyword || data.keyword).trim().toLowerCase()
      const clientPhone = safeText(data.clientPhone || data.phone).trim()
      const staffPhone = safeText(data.staffPhone).trim()
      const usersRes = (clientPhone || staffPhone) ? await db.collection('users').get() : { data: [] }
      let clientOpenids = null
      if (clientPhone) {
        clientOpenids = new Set((usersRes.data || [])
          .filter((user) => safeText(user.phone).includes(clientPhone))
          .map((user) => safeText(user.openid))
          .filter(Boolean))
      }
      let staffOpenids = null
      let staffProfileIds = null
      if (staffPhone) {
        staffOpenids = new Set((usersRes.data || [])
          .filter((user) => safeText(user.phone).includes(staffPhone))
          .map((user) => safeText(user.openid))
          .filter(Boolean))
        const profilesRes = await db.collection('staff_profiles').get()
        staffProfileIds = new Set()
        ;(profilesRes.data || []).forEach((profile) => {
          if (!safeText(profile.phone).includes(staffPhone)) return
          const profileOpenid = safeText(profile.openid).trim()
          const profileId = safeText(profile._id).trim()
          if (profileOpenid) staffOpenids.add(profileOpenid)
          if (profileId) staffProfileIds.add(profileId)
        })
      }
      let orders = (res.data || []).filter((order) => !isAdminDeletedOrder(order))
      if (isAutoFilter) {
        orders = orders.filter((order) => order.autoCompleted === true)
      }
      if (isOverdueFilter) {
        orders = orders.filter((order) => isOrderOverdue(order))
      }
      if (orderKeyword) {
        orders = orders.filter((order) => [order._id, order.orderNo].some((value) => safeText(value).toLowerCase().includes(orderKeyword)))
      }
      if (clientOpenids) {
        orders = orders.filter((order) => clientOpenids.has(safeText(order.clientOpenid)) || safeText(order.contactPhone).includes(clientPhone))
      }
      if (staffOpenids && staffProfileIds) {
        orders = orders.filter((order) => staffOpenids.has(safeText(order.staffOpenid)) || staffOpenids.has(safeText(order.requestedStaffOpenid)) || staffProfileIds.has(safeText(order.staffProfileId)) || staffProfileIds.has(safeText(order.requestedStaffProfileId)))
      }
      const page = paginateList(orders, data)
      return { ...page, list: await Promise.all(page.list.map(attachAdminOrderContactData)) }
    }
    if (action === 'batchDeleteOrders') {
      const orderIds = Array.from(new Set((Array.isArray(data.orderIds) ? data.orderIds : []).map((id) => safeText(id).trim()).filter(Boolean)))
      if (!orderIds.length) throw new Error('请选择要删除的订单')
      if (orderIds.length > 100) throw new Error('单次最多删除 100 个订单')
      const reason = safeText(data.reason).trim()
      const time = now()
      const deletedIds = []
      const skippedIds = []
      for (const orderId of orderIds) {
        try {
          const orderRes = await db.collection('orders').doc(orderId).get()
          if (orderRes.data.adminDeletedAt) {
            skippedIds.push(orderId)
            continue
          }
          await db.collection('orders').doc(orderId).update({ data: { adminDeletedAt: time, adminDeletedByOpenid: openid, adminDeletedReason: reason, updatedAt: time } })
          await logAdmin(admin, 'order', orderId, 'batchDeleteOrders', { reason })
          deletedIds.push(orderId)
        } catch (error) {
          skippedIds.push(orderId)
        }
      }
      return { deletedIds, skippedIds, count: deletedIds.length }
    }
    if (action === 'getOrderDetail' || action === 'getEvidence') {
      const id = data.id || data.orderId
      const order = await db.collection('orders').doc(id).get()
      if (!order.data) throw new Error('订单不存在')
      const tracks = await db.collection('track_logs').where({ orderId: id }).orderBy('recordedAt', 'asc').get()
      const checkins = await db.collection('checkin_logs').where({ orderId: id }).orderBy('createdAt', 'asc').get()
      const unlockLogs = await db.collection('unlock_code_logs').where({ orderId: id }).orderBy('createdAt', 'desc').get()
      const displayOrder = await attachAdminOrderContactData(order.data)
      const payAmount = Number(order.data.payAmount || 0)
      const existingRefundsRes = await db.collection('refunds').where({ orderId: id }).get()
      const successfulRefundsAmount = (existingRefundsRes.data || [])
        .filter((r) => ['success', 'processing'].includes(r.status))
        .reduce((sum, r) => sum + Number(r.refundAmount || 0), 0)
      const alreadyRefunded = Math.max(Number(order.data.refundAmount || 0), successfulRefundsAmount)
      const maxRefundable = Math.max(0, Math.round((payAmount - alreadyRefunded) * 100) / 100)
      displayOrder.maxRefundable = maxRefundable
      displayOrder.alreadyRefunded = alreadyRefunded

      if (action === 'getEvidence') await logAdmin(admin, 'order', id, 'getEvidence', { trackCount: (tracks.data || []).length, checkinCount: (checkins.data || []).filter(isActiveCheckin).length })
      return { order: displayOrder, tracks: tracks.data, checkins: (checkins.data || []).filter(isActiveCheckin), unlockLogs: unlockLogs.data }
    }
    if (action === 'assignOrder') {
      const orderRes = await db.collection('orders').doc(data.orderId).get()
      if (orderRes.data.status !== 'paid') throw new Error('仅已支付订单可派单')
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = normalizeStaffWorkflow(profileRes.data)
      const settings = await getSystemSettings().catch(() => ({}))
      const ability = validateStaffTakeOrderAbility(profile, settings.staffDeposit)
      if (!ability.can) {
        if (ability.reason === 'deposit_unpaid') {
          throw new Error('该宠托师尚未缴纳履约保证金，不能派单')
        }
        throw new Error(ability.message || '该宠托师尚未完成培训/视频审核，不能派单')
      }
      await validateStaffAvailability(profile, orderRes.data.startTime, orderRes.data.endTime, { excludeOrderId: data.orderId })
      const staffUserRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = staffUserRes.data[0]
      if (!staffUser) throw new Error('员工用户不存在')
      const time = now()
      const assignmentUpdate = { staffUserId: staffUser._id, staffOpenid: staffUser.openid, staffProfileId: profile._id, status: 'assigned', assignmentSource: 'admin_assign', assignedAt: time, updatedAt: time }
      await updateOrderWhenStatus(data.orderId, ORDER_STATUS.PAID, assignmentUpdate, '订单已被分配', { staffOpenid: '' })
      const assignedOrder = { ...orderRes.data, _id: data.orderId, ...assignmentUpdate }
      await appendOrderTimeline(data.orderId, 'assigned', '管理员已派单', maskStaffName(profile.realName), 'admin')
      await appendOrderClientMessage(assignedOrder, { eventType: 'assigned', title: '平台已派单', detail: maskStaffName(profile.realName), actorRole: 'admin' })
      await notifyOrder(orderRes.data.clientOpenid, 'orderAssigned', { ...orderRes.data, _id: data.orderId }, { statusText: '已派单' })
      await logAdmin(admin, 'order', data.orderId, 'assignOrder', { staffProfileId: data.staffProfileId })
      return { orderId: data.orderId }
    }
    if (action === 'updateOrderStatus') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const targetStatus = safeText(data.status).trim()
      const remark = safeText(data.remark || data.reason).trim()
      if (!remark) throw new Error('请填写操作说明')
      const allowedStatuses = ['pending_pay', 'paid', 'assigned', 'in_service', 'completed', 'cancelled', 'refunded']
      if (!allowedStatuses.includes(targetStatus)) throw new Error('目标状态无效')

      const orderRes = await db.collection('orders').doc(orderId).get()
      if (!orderRes.data) throw new Error('订单不存在')
      const order = orderRes.data
      const prevStatus = order.status
      if (prevStatus === targetStatus) throw new Error(`订单当前已处于该状态(${targetStatus})`)

      const time = now()
      const updateData = {
        status: targetStatus,
        adminManualStatusUpdatedAt: time,
        adminManualStatusRemark: remark,
        adminManualStatusByOpenid: openid,
        updatedAt: time
      }
      if (targetStatus === 'completed' && !order.completedAt) {
        updateData.completedAt = time
      }
      if (targetStatus === 'cancelled' && !order.cancelledAt) {
        updateData.cancelledAt = time
      }
      await db.collection('orders').doc(orderId).update({ data: updateData })

      const statusLabels = {
        pending_pay: '待支付',
        paid: '已支付/待接单',
        assigned: '已派单/待服务',
        in_service: '服务中',
        completed: '已完成',
        cancelled: '已取消',
        refunded: '已退款'
      }
      const fromLabel = statusLabels[prevStatus] || prevStatus
      const toLabel = statusLabels[targetStatus] || targetStatus

      await appendOrderTimeline(orderId, 'status_changed', `管理员手动修改状态：${fromLabel} ➔ ${toLabel}`, remark, 'admin')
      await appendOrderClientMessage({ ...order, _id: orderId }, {
        eventType: 'status_changed',
        title: `订单状态更新为：${toLabel}`,
        detail: `管理员操作说明：${remark}`,
        actorRole: 'admin'
      })
      await logAdmin(admin, 'order', orderId, 'updateOrderStatus', { prevStatus, targetStatus, remark })
      return { orderId, status: targetStatus, prevStatus, remark }
    }
    if (action === 'refundOrder') {
      const orderId = safeText(data.id || data.orderId).trim()
      if (!orderId) throw new Error('缺少订单 ID')
      const orderRes = await db.collection('orders').doc(orderId).get()
      if (!orderRes.data) throw new Error('订单不存在')
      const order = orderRes.data
      const payAmount = Number(order.payAmount || 0)
      if (payAmount <= 0) throw new Error('该订单无需退款（实付金额为0）')
      if (order.paymentStatus !== 'paid' && order.paymentStatus !== 'refunding' && order.status !== 'paid' && !order.paidAt) {
        throw new Error('订单未支付或状态不支持退款')
      }

      const existingRefundsRes = await db.collection('refunds').where({ orderId }).get()
      const successfulRefundsAmount = (existingRefundsRes.data || [])
        .filter((r) => ['success', 'processing'].includes(r.status))
        .reduce((sum, r) => sum + Number(r.refundAmount || 0), 0)
      const alreadyRefunded = Math.max(Number(order.refundAmount || 0), successfulRefundsAmount)
      const maxRefundable = Math.max(0, Math.round((payAmount - alreadyRefunded) * 100) / 100)

      if (maxRefundable <= 0) throw new Error('该订单已全额退款，无剩余可退金额')

      const refundAmount = Number(data.refundAmount)
      if (!Number.isFinite(refundAmount) || refundAmount <= 0) throw new Error('请输入有效的退款金额（需大于0）')
      if (refundAmount > maxRefundable) throw new Error(`退款金额不能超过可退金额上限 ¥${maxRefundable.toFixed(2)}`)

      const reason = safeText(data.reason || data.remark).trim()
      if (!reason) throw new Error('请填写退款说明')

      const refund = await createRefundForOrder(order, refundAmount, reason, 'admin_manual', openid, getClientRequestId(data))
      const totalRefundAmount = Math.round((alreadyRefunded + refundAmount) * 100) / 100
      const isFullRefund = totalRefundAmount >= payAmount

      const time = now()
      const orderUpdate = {
        refundAmount: totalRefundAmount,
        refundNo: refund.refundNo,
        refundStatus: isFullRefund ? 'full_refunded' : 'partially_refunded',
        paymentStatus: isFullRefund ? 'refunded' : 'refunding',
        refundRemark: reason,
        adminManualRefundByOpenid: openid,
        adminManualRefundAt: time,
        updatedAt: time
      }
      if (isFullRefund && !['completed'].includes(order.status)) {
        orderUpdate.status = 'refunded'
      }
      await db.collection('orders').doc(orderId).update({ data: orderUpdate })
      await appendOrderTimeline(orderId, 'refund', `管理员手动退款 ¥${refundAmount.toFixed(2)}`, `说明：${reason}${isFullRefund ? '（已全额退款）' : ''}`, 'admin')
      await logAdmin(admin, 'order', orderId, 'refundOrder', { refundAmount, reason, refundNo: refund.refundNo, isFullRefund })
      return {
        orderId,
        refundNo: refund.refundNo,
        refundAmount,
        totalRefundAmount,
        isFullRefund,
        status: orderUpdate.status || order.status
      }
    }
    if (action === 'listServicePrices') {
      return listServicePrices(true)
    }
    if (action === 'listServiceCheckinRules') {
      return listServiceCheckinRules()
    }
    if (action === 'saveServiceCheckinRules') {
      const validServiceKeys = (await listServicePrices(true)).map((item) => item.key)
      const rules = (Array.isArray(data.rules) ? data.rules : []).map((rule) => normalizeServiceCheckinRule(rule, validServiceKeys))
      const time = now()
      await removeByQuery('service_checkin_rules', {})
      await Promise.all(rules.map((rule) => db.collection('service_checkin_rules').add({ data: { ...rule, createdAt: time, updatedAt: time } })))
      await logAdmin(admin, 'service_checkin_rule', 'rules', 'saveServiceCheckinRules', { count: rules.length })
      return listServiceCheckinRules()
    }
    if (action === 'resetDefaultServiceCheckinRules') {
      const time = now()
      await removeByQuery('service_checkin_rules', {})
      await Promise.all(defaultServiceCheckinRules.map((rule) => db.collection('service_checkin_rules').add({ data: { ...normalizeServiceCheckinRule(rule), createdAt: time, updatedAt: time } })))
      await logAdmin(admin, 'service_checkin_rule', 'defaults', 'resetDefaultServiceCheckinRules', {})
      return listServiceCheckinRules()
    }
    if (action === 'saveServicePrice') {
      const key = String(data.key || '').trim()
      if (!/^[a-z][a-z0-9_]{1,40}$/.test(key)) throw new Error('服务标识格式不正确')
      if (RETIRED_SERVICE_KEYS.has(key)) throw new Error('该服务项目已下线')
      const preset = defaultServicePrices.find((item) => item.key === key)
      const label = safeText(data.label || (preset && preset.label)).trim()
      if (!label) throw new Error('服务名称不能为空')
      const price = Number(data.price)
      if (!Number.isFinite(price) || price < 0) throw new Error('价格不正确')
      const extraPetFee = Number(data.extraPetFee || 0)
      if (!Number.isFinite(extraPetFee) || extraPetFee < 0) throw new Error('多宠物加价不正确')
      const internPrice = data.internPrice === undefined || data.internPrice === '' ? price : Number(data.internPrice)
      if (!Number.isFinite(internPrice) || internPrice < 0) throw new Error('实习宠托师价格不正确')
      const internExtraPetFee = data.internExtraPetFee === undefined || data.internExtraPetFee === '' ? extraPetFee : Number(data.internExtraPetFee)
      if (!Number.isFinite(internExtraPetFee) || internExtraPetFee < 0) throw new Error('实习宠托师多宠物加价不正确')
      const extraHalfHourFee = data.extraHalfHourFee === undefined || data.extraHalfHourFee === '' ? 0 : Number(data.extraHalfHourFee)
      if (!Number.isFinite(extraHalfHourFee) || extraHalfHourFee < 0) throw new Error('续时加价不正确')
      const internExtraHalfHourFee = data.internExtraHalfHourFee === undefined || data.internExtraHalfHourFee === '' ? extraHalfHourFee : Number(data.internExtraHalfHourFee)
      if (!Number.isFinite(internExtraHalfHourFee) || internExtraHalfHourFee < 0) throw new Error('实习宠托师续时加价不正确')
      const time = now()
      const payload = normalizeServicePrice({
        ...(preset || {}),
        key,
        label,
        price,
        internPrice,
        extraPetFee,
        internExtraPetFee,
        extraHalfHourFee,
        internExtraHalfHourFee,
        extraPetRule: key === VISIT_FEE_SERVICE_KEY ? 'none' : data.extraPetRule,
        showOnHome: key === VISIT_FEE_SERVICE_KEY ? false : Boolean(data.showOnHome),
        enabled: data.enabled !== false,
        description: safeText(data.description || (preset && preset.description)).trim(),
        detailDescription: safeText(data.detailDescription).trim().slice(0, 5000),
        caseImageFileIds: normalizeServiceCaseImageFileIds(data.caseImageFileIds),
        coverUrl: (data.coverUrl !== undefined && !String(data.coverUrl).startsWith('/images/services/'))
          ? safeText(data.coverUrl).trim()
          : ((preset && typeof preset.coverUrl === 'string' && !preset.coverUrl.startsWith('/images/services/')) ? safeText(preset.coverUrl).trim() : ''),
        sortOrder: Number(data.sortOrder || (preset && preset.sortOrder) || 100),
        updatedAt: time
      })
      const existing = await db.collection('service_prices').where({ key }).limit(1).get()
      if (existing.data[0]) {
        await db.collection('service_prices').doc(existing.data[0]._id).update({ data: { ...payload, updatedAt: time } })
      } else {
        await db.collection('service_prices').add({ data: { ...payload, createdAt: time, updatedAt: time } })
      }
      await logAdmin(admin, 'service_price', key, 'saveServicePrice', { price, internPrice: payload.internPrice, extraPetFee: payload.extraPetFee, internExtraPetFee: payload.internExtraPetFee, extraHalfHourFee: payload.extraHalfHourFee, internExtraHalfHourFee: payload.internExtraHalfHourFee, extraPetRule: payload.extraPetRule, enabled: payload.enabled, showOnHome: payload.showOnHome })
      return payload
    }
    if (action === 'deleteServicePrice') {
      const key = String(data.key || '').trim()
      if (!key) throw new Error('服务标识不能为空')
      if (key === VISIT_FEE_SERVICE_KEY) throw new Error('上门费不能删除')
      const time = now()
      const existing = await db.collection('service_prices').where({ key }).limit(1).get()
      if (isPresetServiceKey(key)) {
        const payload = { enabled: false, showOnHome: false, updatedAt: time }
        if (existing.data[0]) await db.collection('service_prices').doc(existing.data[0]._id).update({ data: payload })
        else await db.collection('service_prices').add({ data: { key, label: (defaultServicePrices.find((item) => item.key === key) || {}).label || key, price: 0, ...payload, createdAt: time } })
      } else if (existing.data[0]) {
        await db.collection('service_prices').doc(existing.data[0]._id).remove()
        await removeByQuery('service_checkin_rules', { serviceType: key })
      }
      await logAdmin(admin, 'service_price', key, 'deleteServicePrice', {})
      return listServicePrices(true)
    }
    if (action === 'resetDefaultServicePrices') {
      const time = now()
      await Promise.all(defaultServicePrices.map(async (preset) => {
        const existing = await db.collection('service_prices').where({ key: preset.key }).limit(1).get()
        const existingItem = existing.data[0] || {}
        const payload = {
          ...normalizeServicePrice({
            ...preset,
            detailDescription: existingItem.detailDescription || '',
            caseImageFileIds: existingItem.caseImageFileIds || []
          }),
          updatedAt: time
        }
        if (existing.data[0]) return db.collection('service_prices').doc(existing.data[0]._id).update({ data: payload })
        return db.collection('service_prices').add({ data: { ...payload, createdAt: time } })
      }))
      await logAdmin(admin, 'service_price', 'defaults', 'resetDefaultServicePrices', {})
      return listServicePrices(true)
    }
    if (action === 'listCouponTemplates') {
      const res = await db.collection('coupon_templates').orderBy('sortOrder', 'asc').get()
      return (res.data || []).sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    }
    if (action === 'saveCouponTemplate') {
      const name = safeText(data.name).trim()
      if (!name) throw new Error('优惠券名称不能为空')
      const discountAmount = Math.round(Number(data.discountAmount || 0))
      const minOrderAmount = Math.max(Math.round(Number(data.minOrderAmount || 0)), 0)
      const validType = data.validType === 'fixed_range' ? 'fixed_range' : 'relative_days'
      const validDays = Math.max(Math.round(Number(data.validDays || 30)), 1)
      const validFromFixed = safeText(data.validFromFixed).trim()
      const validToFixed = safeText(data.validToFixed).trim()
      if (!discountAmount || discountAmount < 0) throw new Error('优惠金额不正确')
      if (validType === 'fixed_range') {
        if (!validFromFixed || !validToFixed) throw new Error('请填写固定有效期')
        if (validToFixed < validFromFixed) throw new Error('固定有效期结束时间不能早于开始时间')
      }
      const usageScope = normalizeCouponUsageScope(data.usageScope || data.businessType)
      const validServiceKeys = (await listServicePrices(true)).map((item) => item.key)
      const applicableServiceTypes = usageScope === 'mall' ? [] : (Array.isArray(data.applicableServiceTypes) ? data.applicableServiceTypes.map((item) => String(item || '').trim()).filter(Boolean) : [])
      if (applicableServiceTypes.some((key) => !validServiceKeys.includes(key))) throw new Error('适用服务不正确')
      const time = now()
      const payload = {
        name,
        description: safeText(data.description).trim(),
        type: 'fixed',
        usageScope,
        usageScopeText: couponUsageScopeText(usageScope),
        discountAmount,
        minOrderAmount,
        applicableServiceTypes,
        validType,
        validDays,
        validFromFixed: validType === 'fixed_range' ? validFromFixed : '',
        validToFixed: validType === 'fixed_range' ? validToFixed : '',
        displayTag: safeText(data.displayTag).trim(),
        claimNotice: safeText(data.claimNotice).trim(),
        useNotice: safeText(data.useNotice).trim(),
        newbieOnly: data.newbieOnly === true,
        enabled: data.enabled !== false,
        totalIssueLimit: Math.max(Math.round(Number(data.totalIssueLimit || 0)), 0),
        perUserLimit: Math.max(Math.round(Number(data.perUserLimit || 1)), 1),
        sortOrder: Number(data.sortOrder || 100),
        updatedAt: time
      }
      if (data._id) {
        const existing = await db.collection('coupon_templates').doc(data._id).get()
        await db.collection('coupon_templates').doc(data._id).update({ data: payload })
        await logAdmin(admin, 'coupon_template', data._id, 'saveCouponTemplate', { name, discountAmount, validType })
        return { ...existing.data, ...payload, _id: data._id }
      }
      const created = await db.collection('coupon_templates').add({ data: { ...payload, issuedCount: 0, createdAt: time } })
      await logAdmin(admin, 'coupon_template', created._id, 'saveCouponTemplate', { name, discountAmount, validType })
      return { _id: created._id, ...payload, issuedCount: 0, createdAt: time }
    }
    if (action === 'issueCouponToUser') {
      const templateId = safeText(data.templateId).trim()
      const targetOpenid = safeText(data.openid).trim()
      if (!templateId) throw new Error('请选择优惠券模板')
      if (!targetOpenid) throw new Error('请输入用户 openid')
      const template = (await db.collection('coupon_templates').doc(templateId).get()).data
      if (!template || template.enabled === false) throw new Error('优惠券模板不可用')
      const targetUser = (await db.collection('users').where({ openid: targetOpenid }).limit(1).get()).data[0]
      if (!targetUser || targetUser.status !== 'active') throw new Error('目标用户不存在')
      const issued = await issueCouponToTargetUser(template, targetUser, { adminUserId: admin._id, adminOpenid: openid })
      await logAdmin(admin, 'coupon_template', templateId, 'issueCouponToUser', { targetOpenid, couponId: issued._id })
      return { _id: issued._id, templateId, openid: targetOpenid, status: 'available', templateSnapshot: issued.templateSnapshot, validFrom: issued.validFrom, validTo: issued.validTo }
    }
    if (action === 'listFeedback') {
      const status = safeText(data.status).trim()
      const category = safeText(data.category).trim()
      const res = await db.collection('user_feedback').orderBy('createdAt', 'desc').get()
      const list = (res.data || [])
        .filter((item) => !status || item.status === status)
        .filter((item) => !category || item.category === category)
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'replyFeedback') {
      const id = safeText(data.id || data.feedbackId).trim()
      const replyContent = safeText(data.replyContent || data.reply).trim()
      const status = safeText(data.status).trim() || 'resolved'
      if (!id) throw new Error('请选择反馈')
      if (!replyContent) throw new Error('请输入回复内容')
      const time = now()
      const updateData = {
        replyContent,
        repliedByOpenid: openid,
        repliedAt: time,
        status,
        updatedAt: time
      }
      await db.collection('user_feedback').doc(id).update({ data: updateData })
      await logAdmin(admin, 'user_feedback', id, 'replyFeedback', { status })
      return { id, status }
    }
    if (action === 'listStaffAudits') {
      const status = safeText(data.auditStatus).trim()
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const where = status ? { auditStatus: status } : {}
      const res = await db.collection('staff_profiles').where(where).orderBy('updatedAt', 'desc').get()
      const list = (res.data || []).filter((item) => !keyword || [item.realName, item.phone, item.serviceCity, item.serviceAreas].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'auditStaff') {
      const status = data.auditStatus === 'approved' ? 'approved' : 'rejected'
      const profileRes = await db.collection('staff_profiles').doc(data.staffProfileId).get()
      const profile = profileRes.data
      const identityStatus = status === 'approved' ? 'verified' : 'failed'
      const faceVerifyStatus = status === 'approved' ? 'verified' : 'failed'
      const time = now()
      const workflowUpdate = status === 'approved'
        ? { staffLevel: 'applicant', onboardingStatus: 'training_pending', videoAuditStatus: 'not_started', promotionStatus: 'none' }
        : { staffLevel: 'applicant', onboardingStatus: 'application_pending', videoAuditStatus: 'not_started', promotionStatus: 'none' }
      await db.collection('staff_profiles').doc(data.staffProfileId).update({ data: { auditStatus: status, auditRemark: data.auditRemark || '', identityStatus, faceVerifyStatus, ...workflowUpdate, updatedAt: time } })
      const identityRes = await db.collection('staff_identity_verifications').where({ staffProfileId: data.staffProfileId }).limit(1).get()
      if (identityRes.data[0]) await db.collection('staff_identity_verifications').doc(identityRes.data[0]._id).update({ data: { auditStatus: status, auditRemark: data.auditRemark || '', identityStatus, faceVerifyStatus, auditedByOpenid: openid, auditedAt: time, updatedAt: time } })
      const userRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = userRes.data[0]
      if (staffUser && status === 'rejected') {
        const existingRoles = Array.isArray(staffUser.roles) ? staffUser.roles : ['client']
        const roles = existingRoles.filter((role) => role !== 'staff')
        const userUpdate = { roles: roles.length ? roles : ['client'], updatedAt: time }
        if (staffUser.activeRole === 'staff') userUpdate.activeRole = 'client'
        await db.collection('users').doc(staffUser._id).update({ data: userUpdate })
      }
      await logAdmin(admin, 'staff_profile', data.staffProfileId, 'auditStaff', { status })
      return { staffProfileId: data.staffProfileId, auditStatus: status }
    }
    if (action === 'revokeStaff') {
      const staffProfileId = safeText(data.staffProfileId || data.id).trim()
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
      const profile = profileRes.data
      if (!profile) throw new Error('宠托师不存在')
      const time = now()
      const auditRemark = safeText(data.auditRemark || data.remark).trim() || '管理员移除宠托师身份'
      const update = {
        auditStatus: 'revoked',
        auditRemark,
        staffLevel: 'applicant',
        onboardingStatus: 'application_pending',
        videoAuditStatus: 'not_started',
        promotionStatus: 'none',
        isFeatured: false,
        quizPassedAt: null,
        quizScore: 0,
        trainingVideoProgress: {},
        trainingVideosCompletedAt: null,
        videoAuditRequestedAt: null,
        videoAuditRemark: '',
        internStartedAt: null,
        internCompletedOrderCount: 0,
        promotionApplicationId: '',
        promotionAppliedAt: null,
        updatedAt: time
      }
      await db.collection('staff_profiles').doc(staffProfileId).update({ data: update })
      const userRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = userRes.data[0]
      if (staffUser) {
        const roles = (Array.isArray(staffUser.roles) ? staffUser.roles : ['client']).filter((role) => role !== 'staff')
        const userUpdate = { roles: roles.length ? roles : ['client'], updatedAt: time }
        if (staffUser.activeRole === 'staff') userUpdate.activeRole = 'client'
        await db.collection('users').doc(staffUser._id).update({ data: userUpdate })
      }
      await logAdmin(admin, 'staff_profile', staffProfileId, 'revokeStaff', { auditRemark })
      return { staffProfileId, auditStatus: 'revoked' }
    }
    if (action === 'listTrainingAudits') {
      const keyword = safeText(data.keyword).trim().toLowerCase()
      const res = await db.collection('staff_profiles').where({ auditStatus: 'approved', videoAuditStatus: 'pending' }).orderBy('videoAuditRequestedAt', 'desc').get()
      const list = (res.data || []).map(normalizeStaffWorkflow).filter((item) => !keyword || [item.realName, item.phone, item.serviceCity, item.serviceAreas].some((value) => safeText(value).toLowerCase().includes(keyword)))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'auditTrainingVideo') {
      const staffProfileId = safeText(data.staffProfileId).trim()
      const status = data.status === 'approved' ? 'approved' : 'rejected'
      if (!staffProfileId) throw new Error('请选择宠托师')
      const profileRes = await db.collection('staff_profiles').doc(staffProfileId).get()
      const profile = profileRes.data
      if (!profile) throw new Error('宠托师不存在')
      const time = now()
      const update = status === 'approved'
        ? { videoAuditStatus: 'approved', onboardingStatus: 'intern', staffLevel: 'intern', internStartedAt: profile.internStartedAt || time, videoAuditRemark: safeText(data.remark).trim(), updatedAt: time }
        : { videoAuditStatus: 'rejected', onboardingStatus: 'videos_completed', videoAuditRemark: safeText(data.remark).trim(), updatedAt: time }
      await db.collection('staff_profiles').doc(staffProfileId).update({ data: update })
      const staffUserRes = await db.collection('users').where({ openid: profile.openid }).limit(1).get()
      const staffUser = staffUserRes.data[0]
      if (staffUser && status === 'approved') {
        const roles = Array.from(new Set([...(Array.isArray(staffUser.roles) ? staffUser.roles : ['client']), 'staff']))
        await db.collection('users').doc(staffUser._id).update({ data: { roles, updatedAt: time } })
      }
      await logAdmin(admin, 'staff_profile', staffProfileId, 'auditTrainingVideo', { status })
      return { staffProfileId, status, ...update }
    }
    if (action === 'listPromotionApplications') {
      const status = safeText(data.status).trim()
      const appsRes = await db.collection('staff_promotion_applications').orderBy('createdAt', 'desc').get()
      const profilesRes = await db.collection('staff_profiles').get()
      const profileMap = new Map((profilesRes.data || []).map((item) => [item._id, normalizeStaffWorkflow(item)]))
      const list = (appsRes.data || [])
        .filter((item) => !status || item.status === status)
        .map((item) => ({ ...item, profile: profileMap.get(item.staffProfileId) || null }))
      const wantsPage = data.page !== undefined || data.pageSize !== undefined
      return wantsPage ? paginateList(list, data) : list
    }
    if (action === 'getPromotionApplicationDetail') {
      const applicationId = safeText(data.applicationId || data.id).trim()
      if (!applicationId) throw new Error('请选择晋升申请')
      const app = (await db.collection('staff_promotion_applications').doc(applicationId).get()).data
      if (!app) throw new Error('晋升申请不存在')
      const profile = normalizeStaffWorkflow((await db.collection('staff_profiles').doc(app.staffProfileId).get()).data)
      const orders = []
      for (const orderId of (app.orderIds || [])) {
        const order = (await db.collection('orders').doc(orderId).get()).data
        if (!order) continue
        const tracks = await db.collection('track_logs').where({ orderId }).orderBy('recordedAt', 'asc').get()
        const checkins = await db.collection('checkin_logs').where({ orderId }).orderBy('createdAt', 'asc').get()
        const reviews = await db.collection('service_reviews').where({ orderId }).get()
        orders.push({ order: await attachAdminOrderContactData({ ...order, _id: orderId }), tracks: tracks.data || [], checkins: (checkins.data || []).filter(isActiveCheckin), review: (reviews.data || [])[0] || null })
      }
      return { application: app, profile, orders }
    }
    if (action === 'auditPromotionApplication') {
      const applicationId = safeText(data.applicationId || data.id).trim()
      const status = data.status === 'approved' ? 'approved' : 'rejected'
      if (!applicationId) throw new Error('请选择晋升申请')
      const app = (await db.collection('staff_promotion_applications').doc(applicationId).get()).data
      if (!app) throw new Error('晋升申请不存在')
      const time = now()
      const appUpdate = { status, adminRemark: safeText(data.remark).trim(), reviewedByOpenid: openid, reviewedAt: time, updatedAt: time }
      await db.collection('staff_promotion_applications').doc(applicationId).update({ data: appUpdate })
      const profileUpdate = status === 'approved'
        ? { staffLevel: 'certified', promotionStatus: 'approved', certifiedAt: time, updatedAt: time }
        : { promotionStatus: 'rejected', promotionRejectReason: safeText(data.remark).trim(), updatedAt: time }
      await db.collection('staff_profiles').doc(app.staffProfileId).update({ data: profileUpdate })
      await logAdmin(admin, 'staff_promotion_application', applicationId, 'auditPromotionApplication', { status })
      return { applicationId, status }
    }
    if (action === 'listMemberLevels') {
      const levels = await getMemberLevels()
      return levels.map((level, idx) => ({
        ...level,
        badgeTag: normalizeMemberBadgeTag(level.badgeTag) || `V${idx + 1}`,
        nameColor: normalizeMemberNameColor(level.nameColor),
        nameEffect: normalizeMemberNameEffect(level.nameEffect),
        badgeStyle: normalizeMemberBadgeStyle(level.badgeStyle),
        pointMultiplier: Math.max(Number(level.pointMultiplier || 1), 1),
        description: safeText(level.description).trim(),
        benefits: normalizeBenefits(level.benefits)
      }))
    }
    if (action === 'saveMemberLevel') {
      const name = safeText(data.name).trim()
      if (!name) throw new Error('等级名称不能为空')
      const existingLevels = await getMemberLevels()
      const duplicate = existingLevels.find((item) => item.name === name && item._id !== data._id)
      if (duplicate) throw new Error('已存在同名会员等级，请先编辑原等级或换一个名称')
      const minPoints = Math.max(Math.round(Number(data.minPoints || 0)), 0)
      const time = now()
      const payload = {
        name,
        badgeTag: normalizeMemberBadgeTag(data.badgeTag),
        nameColor: normalizeMemberNameColor(data.nameColor),
        nameEffect: normalizeMemberNameEffect(data.nameEffect),
        badgeStyle: normalizeMemberBadgeStyle(data.badgeStyle),
        minPoints,
        icon: safeText(data.icon).trim(),
        pointMultiplier: Math.max(Number(data.pointMultiplier || 1), 1),
        description: safeText(data.description).trim(),
        benefits: normalizeBenefits(data.benefits),
        sortOrder: Number(data.sortOrder || 0),
        updatedAt: time
      }
      if (data._id) {
        await db.collection('member_levels').doc(data._id).update({ data: payload })
        await syncUsersMemberLevelName(data._id, name)
        await logAdmin(admin, 'member_level', data._id, 'saveMemberLevel', { name, minPoints, pointMultiplier: payload.pointMultiplier })
        return { _id: data._id, ...payload }
      }
      const created = await db.collection('member_levels').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'member_level', created._id, 'saveMemberLevel', { name, minPoints, pointMultiplier: payload.pointMultiplier })
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'deleteMemberLevel') {
      if (!data._id) throw new Error('缺少等级 ID')
      await db.collection('member_levels').doc(data._id).remove()
      await recalcUsersForDeletedLevel(data._id)
      await logAdmin(admin, 'member_level', data._id, 'deleteMemberLevel', {})
      return { _id: data._id }
    }
    if (action === 'grantPoints') {
      const targetOpenid = safeText(data.openid).trim()
      if (!targetOpenid) throw new Error('请输入用户 openid')
      const delta = Math.round(Number(data.delta || 0))
      if (!delta) throw new Error('积分变动不能为 0')
      const reason = safeText(data.reason).trim() || '管理员操作'
      await addPoints(targetOpenid, '', delta, 'admin_grant', admin._id, reason)
      await logAdmin(admin, 'user', targetOpenid, 'grantPoints', { delta, reason })
      return { openid: targetOpenid, delta }
    }
    if (action === 'listPointLogs') {
      const where = data.openid ? { openid: safeText(data.openid).trim() } : {}
      const res = await db.collection('point_logs').where(where).orderBy('createdAt', 'desc').get()
      return res.data || []
    }
    if (action === 'getCheckinMonthConfig') {
      const monthKey = normalizeMonthKey(data.monthKey)
      const config = await ensureMonthConfig(monthKey)
      return {
        ...config,
        days: defaultCheckinDays(monthKey).map((fallback) => normalizeCheckinReward((config.days || []).find((item) => Number(item.day) === fallback.day) || fallback, fallback.day))
      }
    }
    if (action === 'saveCheckinMonthConfig') {
      const monthKey = normalizeMonthKey(data.monthKey)
      const dayCount = getMonthDays(monthKey)
      const couponIds = Array.from(new Set((Array.isArray(data.days) ? data.days : []).map((item) => safeText(item.couponTemplateId).trim()).filter(Boolean)))
      const couponTemplates = {}
      for (const couponId of couponIds) {
        const template = (await db.collection('coupon_templates').doc(couponId).get()).data
        if (!template || template.enabled === false) throw new Error('签到奖励优惠券不可用')
        couponTemplates[couponId] = normalizeCouponSnapshot(template)
      }
      const days = Array.from({ length: dayCount }, (_, index) => {
        const day = index + 1
        const raw = (Array.isArray(data.days) ? data.days : []).find((item) => Number(item.day) === day) || {}
        const reward = normalizeCheckinReward(raw, day)
        if (reward.rewardType === 'coupon') {
          if (!reward.couponTemplateId) throw new Error(`第 ${day} 天未选择优惠券模板`)
          reward.couponSnapshot = couponTemplates[reward.couponTemplateId] || null
        } else {
          reward.couponTemplateId = ''
          reward.couponSnapshot = null
        }
        if (reward.rewardType !== 'points') reward.points = 0
        return reward
      })
      const time = now()
      const payload = { monthKey, days, status: safeText(data.status).trim() || 'active', updatedAt: time }
      const existing = await getMonthConfig(monthKey)
      if (existing) {
        await db.collection('checkin_month_configs').doc(existing._id).update({ data: payload })
        await logAdmin(admin, 'checkin_month_config', existing._id, 'saveCheckinMonthConfig', { monthKey })
        return { _id: existing._id, ...existing, ...payload }
      }
      const created = await db.collection('checkin_month_configs').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'checkin_month_config', created._id, 'saveCheckinMonthConfig', { monthKey })
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'issueCouponByLevels') {
      const templateId = safeText(data.templateId).trim()
      const targetLevelIds = normalizeTargetLevelIds(data.targetLevelIds)
      if (!templateId) throw new Error('请选择优惠券模板')
      if (!targetLevelIds.length) throw new Error('请选择至少一个会员段位')
      const targetLevels = await resolveTargetLevels(targetLevelIds)
      if (!targetLevels.length) throw new Error('所选会员段位不存在')
      const targetLevelNamesSnapshot = targetLevels.map((level) => level.name)
      const template = (await db.collection('coupon_templates').doc(templateId).get()).data
      if (!template || template.enabled === false) throw new Error('优惠券模板不可用')
      const usersRes = await db.collection('users').where({ status: 'active' }).get()
      const eligible = (usersRes.data || []).filter((u) => targetLevelIds.includes(u.memberLevel || ''))
      let issued = 0; let skipped = 0
      const skippedReasons = {}
      for (const targetUser of eligible) {
        try {
          await issueCouponToTargetUser(template, targetUser, { adminUserId: admin._id, adminOpenid: openid })
          issued++
        } catch (error) {
          skipped++
          const reason = safeText(error.message).trim() || '发放失败'
          skippedReasons[reason] = (skippedReasons[reason] || 0) + 1
        }
      }
      const skippedReasonText = Object.keys(skippedReasons).map((reason) => `${reason}：${skippedReasons[reason]}人`).join('\n')
      await logAdmin(admin, 'coupon_template', templateId, 'issueCouponByLevels', { targetLevelIds, targetLevelNamesSnapshot, issued, skipped, skippedReasons, eligibleCount: eligible.length })
      return { issued, skipped, targetLevelIds, targetLevelNamesSnapshot, eligibleCount: eligible.length, skippedReasons, skippedReasonText }
    }
    if (action === 'publishRewardMailByLevels') {
      const targetLevelIds = normalizeTargetLevelIds(data.targetLevelIds)
      if (!targetLevelIds.length) throw new Error('请选择至少一个会员段位')
      const targetLevels = await resolveTargetLevels(targetLevelIds)
      if (!targetLevels.length) throw new Error('所选会员段位不存在')
      const targetLevelNamesSnapshot = targetLevels.map((level) => level.name)
      const rewardType = data.rewardType === 'coupon' ? 'coupon' : 'points'
      const title = safeText(data.title).trim() || '会员奖励到账'
      const content = safeText(data.content).trim()
      const reward = { type: rewardType }
      if (rewardType === 'coupon') {
        const couponTemplateId = safeText(data.couponTemplateId).trim()
        if (!couponTemplateId) throw new Error('请选择奖励优惠券')
        const template = (await db.collection('coupon_templates').doc(couponTemplateId).get()).data
        if (!template || template.enabled === false) throw new Error('奖励优惠券不可用')
        reward.couponTemplateId = couponTemplateId
        reward.couponSnapshot = normalizeCouponSnapshot(template)
      } else {
        reward.points = Math.max(Math.round(Number(data.points || 0)), 0)
        if (!reward.points) throw new Error('奖励积分必须大于 0')
      }
      const usersRes = await db.collection('users').where({ status: 'active' }).get()
      const eligible = (usersRes.data || []).filter((u) => targetLevelIds.includes(u.memberLevel || ''))
      const time = now()
      let issued = 0
      for (const targetUser of eligible) {
        await db.collection('reward_mails').add({
          data: {
            userId: targetUser._id,
            openid: targetUser.openid,
            targetLevelIds,
            targetLevelNamesSnapshot,
            title,
            content,
            reward,
            sentByAdminUserId: admin._id,
            sentByAdminOpenid: openid,
            readAt: null,
            claimedAt: null,
            rewardClaimResult: {},
            createdAt: time,
            updatedAt: time
          }
        })
        issued++
      }
      await logAdmin(admin, 'reward_mail', title, 'publishRewardMailByLevels', { targetLevelIds, targetLevelNamesSnapshot, rewardType, issued })
      return { issued, skipped: 0, targetLevelIds, targetLevelNamesSnapshot }
    }
    if (action === 'publishRetroCardMail') {
      const count = Math.max(Math.round(Number(data.count || 0)), 0)
      if (!count) throw new Error('补签卡数量必须大于 0')
      const target = await resolveRewardMailTargets(data)
      if (!target.users.length) throw new Error('没有符合条件的用户')
      const title = safeText(data.title).trim() || '补签卡奖励到账'
      const content = safeText(data.content).trim() || `你获得 ${count} 张补签卡，请及时领取。`
      const reward = { type: 'retro_card', count }
      const time = now()
      let issued = 0
      for (const targetUser of target.users) {
        await db.collection('reward_mails').add({
          data: {
            userId: targetUser._id,
            openid: targetUser.openid,
            targetType: target.targetType,
            targetOpenids: target.openids || [],
            targetRole: target.role || '',
            targetLevelIds: target.targetLevelIds || [],
            targetLevelNamesSnapshot: target.targetLevelNamesSnapshot || [],
            title,
            content,
            reward,
            sentByAdminUserId: admin._id,
            sentByAdminOpenid: openid,
            readAt: null,
            claimedAt: null,
            rewardClaimResult: {},
            createdAt: time,
            updatedAt: time
          }
        })
        issued++
      }
      await logAdmin(admin, 'reward_mail', title, 'publishRetroCardMail', { targetType: target.targetType, openids: target.openids || [], role: target.role || '', targetLevelIds: target.targetLevelIds || [], targetLevelNamesSnapshot: target.targetLevelNamesSnapshot || [], count, issued })
      return { issued, eligibleCount: target.users.length, targetType: target.targetType, count }
    }
    if (action === 'saveLotteryActivity') {
      const name = safeText(data.name).trim()
      if (!name) throw new Error('活动名称不能为空')
      const prizes = Array.isArray(data.prizes) ? data.prizes.map((p) => ({
        templateId: safeText(p.templateId).trim(),
        name: safeText(p.name).trim(),
        probability: Math.max(Number(p.probability || 0), 0),
        stockLeft: Math.max(Math.round(Number(p.stockLeft || 0)), 0)
      })).filter((p) => p.name) : []
      const time = now()
      const payload = { name, description: safeText(data.description).trim(), prizes, enabled: data.enabled === true, updatedAt: time }
      if (data._id) {
        await db.collection('lottery_activities').doc(data._id).update({ data: payload })
        await logAdmin(admin, 'lottery_activity', data._id, 'saveLotteryActivity', { name })
        return { _id: data._id, ...payload }
      }
      const created = await db.collection('lottery_activities').add({ data: { ...payload, createdAt: time } })
      await logAdmin(admin, 'lottery_activity', created._id, 'saveLotteryActivity', { name })
      return { _id: created._id, ...payload, createdAt: time }
    }
    if (action === 'listLotteryActivities') {
      const res = await db.collection('lottery_activities').orderBy('createdAt', 'desc').get()
      return res.data || []
    }
    if (action === 'toggleLotteryActivity') {
      const activityRes = await db.collection('lottery_activities').doc(data._id).get()
      const enabled = !activityRes.data.enabled
      await db.collection('lottery_activities').doc(data._id).update({ data: { enabled, updatedAt: now() } })
      await logAdmin(admin, 'lottery_activity', data._id, 'toggleLotteryActivity', { enabled })
      return { _id: data._id, enabled }
    }
    if (action === 'listStaffDeposits') {
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const res = await db.collection('staff_deposits').orderBy('createdAt', 'desc').get()
      const users = (await db.collection('users').get()).data || []
      const profiles = (await db.collection('staff_profiles').get()).data || []
      const userMap = users.reduce((m, u) => ({ ...m, [u.openid]: u }), {})
      const profileMap = profiles.reduce((m, p) => ({ ...m, [p.openid]: p }), {})
      const list = (res.data || [])
        .filter((item) => (!status || item.status === status) && inDateRange(item, range, ['createdAt', 'paidAt']))
        .map((item) => {
          const u = userMap[item.staffOpenid] || {}
          const p = profileMap[item.staffOpenid] || {}
          return {
            ...item,
            staffNickname: u.nickname || '',
            staffPhone: p.phone || u.phone || '',
            staffRealName: p.realName || '',
            staffLevel: p.staffLevel || ''
          }
        })
      return limitList(list, data.pageSize || 50)
    }
    if (action === 'auditDepositRefund') {
      const deposit = (await db.collection('staff_deposits').doc(data.id).get()).data
      if (!deposit) throw new Error('保证金记录不存在')
      if (deposit.refundStatus !== 'requested') throw new Error('当前状态不可审核退款')
      const approved = data.approved === true
      const reason = safeText(data.reason || data.auditRemark).trim()
      const time = now()
      if (approved) {
        const activeOrders = await db.collection('orders').where({ staffOpenid: deposit.staffOpenid }).get()
        const hasUnfinished = (activeOrders.data || []).some((o) => ['assigned', 'in_service'].includes(o.status))
        if (hasUnfinished) throw new Error('该宠托师尚有未完成订单，暂不可通过退出退款')
        const incidents = await db.collection('order_incidents').where({ staffOpenid: deposit.staffOpenid }).get()
        const hasUnresolvedIncidents = (incidents.data || []).some((inc) => ['open', 'investigating', 'processing'].includes(inc.status))
        if (hasUnresolvedIncidents) throw new Error('该宠托师存在尚未结案的客诉或纠纷，暂不可通过退出退款')
        const refundAmount = Number(deposit.availableRefundAmount || 0)
        await db.collection('staff_deposits').doc(data.id).update({
          data: {
            refundedAmount: (deposit.refundedAmount || 0) + refundAmount,
            availableRefundAmount: 0,
            status: 'refunded',
            statusText: '已全额退还',
            refundStatus: 'approved',
            refundAuditedAt: time,
            refundAuditedBy: openid,
            refundAuditRemark: reason || '审核通过退款',
            updatedAt: time
          }
        })
        const profileRes = await db.collection('staff_profiles').where({ openid: deposit.staffOpenid }).limit(1).get()
        if (profileRes.data && profileRes.data[0]) {
          await db.collection('staff_profiles').doc(profileRes.data[0]._id).update({
            data: {
              exitStatus: 'exited',
              depositStatus: 'refunded',
              auditStatus: 'revoked',
              updatedAt: time
            }
          })
        }
        await db.collection('staff_deposit_events').add({
          data: {
            depositId: data.id,
            staffOpenid: deposit.staffOpenid,
            staffUserId: deposit.staffUserId,
            type: 'refund',
            amount: refundAmount,
            reason: reason || '宠托师自愿退出全额退还保证金',
            operatorOpenid: openid,
            operatorRole: 'admin',
            createdAt: time
          }
        })
        await appendFinanceLog('deposit_refunded', { targetType: 'staff_deposit', targetId: data.id, staffOpenid: deposit.staffOpenid, amountDelta: -refundAmount, detail: { reason } })
        await logAdmin(admin, 'staff_deposit', data.id, 'auditDepositRefund', { approved: true, refundAmount })
        return { id: data.id, status: 'refunded' }
      } else {
        await db.collection('staff_deposits').doc(data.id).update({
          data: {
            status: 'paid',
            statusText: '已缴纳',
            refundStatus: 'rejected',
            refundRejectReason: reason || '退款申请已驳回',
            refundAuditedAt: time,
            refundAuditedBy: openid,
            updatedAt: time
          }
        })
        const profileRes = await db.collection('staff_profiles').where({ openid: deposit.staffOpenid }).limit(1).get()
        if (profileRes.data && profileRes.data[0]) {
          await db.collection('staff_profiles').doc(profileRes.data[0]._id).update({
            data: {
              exitStatus: 'none',
              depositStatus: 'paid',
              updatedAt: time
            }
          })
        }
        await logAdmin(admin, 'staff_deposit', data.id, 'auditDepositRefund', { approved: false, reason })
        return { id: data.id, status: 'paid', refundStatus: 'rejected' }
      }
    }
    if (action === 'forfeitStaffDeposit') {
      const deposit = (await db.collection('staff_deposits').doc(data.id).get()).data
      if (!deposit) throw new Error('保证金记录不存在')
      const amount = Number(data.amount)
      if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-7) {
        throw new Error('请输入有效的没收金额，最多两位小数')
      }
      const available = Number(deposit.availableRefundAmount || 0)
      if (amount > available) throw new Error(`没收金额不能大于当前可用保证金余额 ¥${available}`)
      const reason = safeText(data.reason).trim()
      if (!reason) throw new Error('请填写没收保证金的违规原因（如私单、严重服务违规、虚假打卡等）')
      const time = now()
      const newForfeited = (deposit.forfeitedAmount || 0) + amount
      const newAvailable = available - amount
      const newStatus = newAvailable <= 0 ? 'forfeited' : deposit.status
      const newStatusText = newAvailable <= 0 ? '已全额没收' : `部分没收（余¥${newAvailable}）`
      await db.collection('staff_deposits').doc(data.id).update({
        data: {
          forfeitedAmount: newForfeited,
          availableRefundAmount: newAvailable,
          status: newStatus,
          statusText: newStatusText,
          lastForfeitReason: reason,
          lastForfeitedAt: time,
          lastForfeitedBy: openid,
          updatedAt: time
        }
      })
      await db.collection('staff_deposit_events').add({
        data: {
          depositId: data.id,
          staffOpenid: deposit.staffOpenid,
          staffUserId: deposit.staffUserId,
          type: 'forfeit',
          amount,
          reason,
          operatorOpenid: openid,
          operatorRole: 'admin',
          createdAt: time
        }
      })
      await appendFinanceLog('deposit_forfeited', { targetType: 'staff_deposit', targetId: data.id, staffOpenid: deposit.staffOpenid, amountDelta: 0, detail: { forfeitAmount: amount, reason } })
      await logAdmin(admin, 'staff_deposit', data.id, 'forfeitStaffDeposit', { amount, reason })
      return { id: data.id, status: newStatus, availableRefundAmount: newAvailable }
    }
    if (action === 'listSupplyReimbursements') {
      const range = buildDateRange(data)
      const status = safeText(data.status).trim()
      const res = await db.collection('staff_supply_reimbursements').orderBy('createdAt', 'desc').get()
      const users = (await db.collection('users').get()).data || []
      const profiles = (await db.collection('staff_profiles').get()).data || []
      const userMap = users.reduce((m, u) => ({ ...m, [u.openid]: u }), {})
      const profileMap = profiles.reduce((m, p) => ({ ...m, [p.openid]: p }), {})
      const list = (res.data || [])
        .filter((item) => (!status || item.status === status) && inDateRange(item, range, ['createdAt', 'paidAt']))
        .map((item) => {
          const u = userMap[item.staffOpenid] || {}
          const p = profileMap[item.staffOpenid] || {}
          return {
            ...item,
            staffNickname: u.nickname || '',
            staffPhone: p.phone || u.phone || '',
            staffRealName: p.realName || '',
            staffLevel: p.staffLevel || ''
          }
        })
      return limitList(list, data.pageSize || 50)
    }
    if (action === 'auditSupplyReimbursement') {
      const app = (await db.collection('staff_supply_reimbursements').doc(data.id).get()).data
      if (!app) throw new Error('报销申请不存在')
      if (app.status !== 'pending') throw new Error('当前状态不可审核')
      const approved = data.approved === true
      const reason = safeText(data.rejectReason || data.reason || data.auditRemark).trim()
      const time = now()
      if (approved) {
        let approvedAmount = Number(data.approvedAmount !== undefined && data.approvedAmount !== null ? data.approvedAmount : app.amount)
        if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) approvedAmount = Number(app.amount)
        if (approvedAmount > Number(app.amount)) {
          throw new Error('审批报销金额不能大于宠托师申请金额')
        }
        await db.collection('staff_supply_reimbursements').doc(data.id).update({
          data: {
            approvedAmount,
            status: 'approved',
            statusText: '审核通过，等待打款',
            auditedAt: time,
            auditedBy: openid,
            auditRemark: reason || '审核通过',
            updatedAt: time
          }
        })
        const profileRes = await db.collection('staff_profiles').where({ openid: app.staffOpenid }).limit(1).get()
        if (profileRes.data && profileRes.data[0]) {
          await db.collection('staff_profiles').doc(profileRes.data[0]._id).update({
            data: {
              supplyReimbursementStatus: 'approved',
              updatedAt: time
            }
          })
        }
        await logAdmin(admin, 'staff_supply_reimbursement', data.id, 'auditSupplyReimbursement', { approved: true, approvedAmount })
        return { id: data.id, status: 'approved', approvedAmount }
      } else {
        if (!reason) throw new Error('请填写驳回原因')
        await db.collection('staff_supply_reimbursements').doc(data.id).update({
          data: {
            status: 'rejected',
            statusText: '审核驳回',
            rejectReason: reason,
            auditedAt: time,
            auditedBy: openid,
            updatedAt: time
          }
        })
        const profileRes = await db.collection('staff_profiles').where({ openid: app.staffOpenid }).limit(1).get()
        if (profileRes.data && profileRes.data[0]) {
          await db.collection('staff_profiles').doc(profileRes.data[0]._id).update({
            data: {
              supplyReimbursementStatus: 'rejected',
              updatedAt: time
            }
          })
        }
        await logAdmin(admin, 'staff_supply_reimbursement', data.id, 'auditSupplyReimbursement', { approved: false, reason })
        return { id: data.id, status: 'rejected' }
      }
    }
    if (action === 'paySupplyReimbursement') {
      const app = (await db.collection('staff_supply_reimbursements').doc(data.id).get()).data
      if (!app) throw new Error('报销申请不存在')
      if (app.status !== 'approved') throw new Error('仅审核通过的报销可进行打款')
      const time = now()
      const payAmount = Number(app.approvedAmount || app.amount || 0)
      await db.collection('staff_supply_reimbursements').doc(data.id).update({
        data: {
          status: 'paid',
          statusText: '已打款',
          transferStatus: 'SUCCESS',
          paidAt: time,
          paidBy: openid,
          updatedAt: time
        }
      })
      const profileRes = await db.collection('staff_profiles').where({ openid: app.staffOpenid }).limit(1).get()
      if (profileRes.data && profileRes.data[0]) {
        await db.collection('staff_profiles').doc(profileRes.data[0]._id).update({
          data: {
            supplyReimbursementStatus: 'paid',
            updatedAt: time
          }
        })
      }
      await appendFinanceLog('supply_reimbursement_paid', { targetType: 'staff_supply_reimbursement', targetId: data.id, staffOpenid: app.staffOpenid, amountDelta: -payAmount, detail: { payAmount } })
      await logAdmin(admin, 'staff_supply_reimbursement', data.id, 'paySupplyReimbursement', { payAmount })
      return { id: data.id, status: 'paid' }
    }
    throw new Error('未知 admin 操作')
  },

  async ai(openid, action, data) {
    if (action === 'aiPetAssistant') {
      const question = safeText(data.question).trim()
      if (!question) throw new Error('请填写咨询问题')
      const petId = safeText(data.petId).trim()
      let petInfo = ''
      if (petId) {
        const petRes = await db.collection('pets').doc(petId).get()
        if (petRes.data) {
          const p = petRes.data
          petInfo = `【宠物资料】名称：${p.name}，种类：${p.species === 'dog' ? '狗' : p.species === 'cat' ? '猫' : '其他'}，品种：${p.breed || '未知'}，体重：${p.weight || '未填'}kg。`
        }
      }

      let answer = ''
      // 直接调用微信云开发内置的 hy3-preview 大模型
      const model = cloud.extend.AI.createModel('hunyuan')
      const res = await model.generateText({
        model: 'hy3',
        messages: [
          { role: 'system', content: `你是一个VIP上门宠护平台的专业AI智能助手和宠物医生顾问，性格温馨专业，精通宠物护理、疾病预防、上门服务注意事项。${petInfo}` },
          { role: 'user', content: question }
        ]
      })

      if (res && res.choices && res.choices[0] && res.choices[0].message) {
        answer = res.choices[0].message.content
      } else if (res && res.text) {
        answer = res.text
      } else {
        answer = JSON.stringify(res)
      }

      return {
        question,
        answer,
        generatedAt: nowText(),
        source: 'hy3-preview'
      }
    }

    if (action === 'aiGenerateReport') {
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单 ID 不能为空')
      const orderRes = await db.collection('orders').doc(orderId).get()
      const order = orderRes.data
      if (!order) throw new Error('订单不存在')

      const checkinsRes = await db.collection('checkin_logs').where({ orderId }).get()
      const checkins = checkinsRes.data || []
      const eventLabels = checkins.map(c => c.eventType).join('、')

      const reportSummary = `【AI 智能宠护报告总结】
今日给宝贝「${order.petName || '宠物'}」的服务已顺利完成！
服务项目：${order.serviceSummary || '上门宠护'}
关键服务打卡记录：${checkins.length} 次（打卡环节包含：${eventLabels || '基础入户与服务'}）。
宠物状态：精神状态良好，打卡互动顺畅，离户时已确认门锁与电源安全。感谢您的信任！`

      return {
        orderId,
        reportSummary,
        generatedAt: nowText()
      }
    }

    throw new Error('未知 ai 操作')
  },

  async message(openid, action, data) {
    await getUser(openid)
    if (action === 'listThreads') {
      const res = await db.collection('order_message_threads').where({ clientOpenid: openid }).get()
      const visibleThreads = (res.data || []).filter((thread) => thread.hiddenForClient !== true)
      const list = sortMessageThreads(visibleThreads.map((thread) => ({
        ...thread,
        orderStatusText: orderStatusText(thread.orderStatus),
        hasUnread: Number(thread.unreadCount || 0) > 0
      })))
      return paginateList(list, data)
    }
    if (action === 'getUnreadSummary') {
      const res = await db.collection('order_message_threads').where({ clientOpenid: openid }).get()
      const totalUnread = (res.data || [])
        .filter((thread) => thread.hiddenForClient !== true)
        .reduce((sum, thread) => sum + Math.max(Number(thread.unreadCount || 0), 0), 0)
      return { totalUnread, hasUnread: totalUnread > 0 }
    }
    if (action === 'getThreadMessages') {
      const threadId = safeText(data.threadId).trim()
      const orderId = safeText(data.orderId).trim()
      if (!threadId && !orderId) throw new Error('消息会话不存在')
      let thread = null
      if (threadId) {
        const doc = await db.collection('order_message_threads').doc(threadId).get()
        thread = doc.data
      } else if (orderId) {
        const res = await db.collection('order_message_threads').where({ orderId, clientOpenid: openid }).limit(1).get()
        thread = res.data[0]
      }
      if (!thread || thread.clientOpenid !== openid) throw new Error('消息会话不存在')
      const res = await db.collection('order_messages').where({ threadId: thread._id }).orderBy('createdAt', 'asc').get()
      return {
        thread: { ...thread, orderStatusText: orderStatusText(thread.orderStatus) },
        messages: (res.data || []).map((message) => ({ ...message }))
      }
    }
    if (action === 'deleteThread') {
      const threadId = safeText(data.threadId).trim()
      const orderId = safeText(data.orderId).trim()
      if (!threadId && !orderId) throw new Error('参数缺失')
      let query = { clientOpenid: openid }
      if (threadId) query._id = threadId
      else if (orderId) query.orderId = orderId
      const res = await db.collection('order_message_threads').where(query).limit(1).get()
      if (res.data[0]) {
        const time = now()
        await db.collection('order_message_threads').doc(res.data[0]._id).update({
          data: { hiddenForClient: true, hiddenAt: time, unreadCount: 0, updatedAt: time }
        })
      }
      return { success: true }
    }
    if (action === 'markThreadRead') {
      const threadId = safeText(data.threadId).trim()
      if (!threadId) throw new Error('消息会话不存在')
      const thread = (await db.collection('order_message_threads').doc(threadId).get()).data
      if (!thread || thread.clientOpenid !== openid) throw new Error('消息会话不存在')
      const time = now()
      await db.collection('order_message_threads').doc(threadId).update({ data: { unreadCount: 0, readAt: time } })
      return { threadId, unreadCount: 0 }
    }
    if (action === 'markOrderThreadRead') {
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单消息不存在')
      const res = await db.collection('order_message_threads').where({ orderId, clientOpenid: openid }).limit(1).get()
      const thread = res.data[0]
      if (!thread) return { orderId, unreadCount: 0 }
      const time = now()
      await db.collection('order_message_threads').doc(thread._id).update({ data: { unreadCount: 0, readAt: time } })
      return { threadId: thread._id, orderId, unreadCount: 0 }
    }
    throw new Error('未知 message 操作')
  },

  async staffMessage(openid, action, data) {
    const user = await getUser(openid)
    if (!(user.roles || []).includes('staff')) throw new Error('仅宠托师可查看消息')
    if (action === 'listThreads') {
      const res = await db.collection('order_staff_message_threads').where({ staffOpenid: openid }).get()
      const visibleThreads = (res.data || []).filter((thread) => thread.hiddenForStaff !== true)
      const list = sortMessageThreads(visibleThreads.map((thread) => ({
        ...thread,
        orderStatusText: orderStatusText(thread.orderStatus),
        hasUnread: Number(thread.unreadCount || 0) > 0
      })))
      return paginateList(list, data)
    }
    if (action === 'getUnreadSummary') {
      const res = await db.collection('order_staff_message_threads').where({ staffOpenid: openid }).get()
      const totalUnread = (res.data || [])
        .filter((thread) => thread.hiddenForStaff !== true)
        .reduce((sum, thread) => sum + Math.max(Number(thread.unreadCount || 0), 0), 0)
      return { totalUnread, hasUnread: totalUnread > 0 }
    }
    if (action === 'getThreadMessages') {
      const threadId = safeText(data.threadId).trim()
      const orderId = safeText(data.orderId).trim()
      if (!threadId && !orderId) throw new Error('消息会话不存在')
      let thread = null
      if (threadId) {
        const doc = await db.collection('order_staff_message_threads').doc(threadId).get()
        thread = doc.data
      } else if (orderId) {
        const res = await db.collection('order_staff_message_threads').where({ orderId, staffOpenid: openid }).limit(1).get()
        thread = res.data[0]
      }
      if (!thread || thread.staffOpenid !== openid) throw new Error('消息会话不存在')
      const res = await db.collection('order_staff_messages').where({ threadId: thread._id }).orderBy('createdAt', 'asc').get()
      return {
        thread: { ...thread, orderStatusText: orderStatusText(thread.orderStatus) },
        messages: (res.data || []).map((message) => ({ ...message }))
      }
    }
    if (action === 'deleteThread') {
      const threadId = safeText(data.threadId).trim()
      const orderId = safeText(data.orderId).trim()
      if (!threadId && !orderId) throw new Error('参数缺失')
      let query = { staffOpenid: openid }
      if (threadId) query._id = threadId
      else if (orderId) query.orderId = orderId
      const res = await db.collection('order_staff_message_threads').where(query).limit(1).get()
      if (res.data[0]) {
        const time = now()
        await db.collection('order_staff_message_threads').doc(res.data[0]._id).update({
          data: { hiddenForStaff: true, hiddenAt: time, unreadCount: 0, updatedAt: time }
        })
      }
      return { success: true }
    }
    if (action === 'markThreadRead') {
      const threadId = safeText(data.threadId).trim()
      if (!threadId) throw new Error('消息会话不存在')
      const thread = (await db.collection('order_staff_message_threads').doc(threadId).get()).data
      if (!thread || thread.staffOpenid !== openid) throw new Error('消息会话不存在')
      const time = now()
      await db.collection('order_staff_message_threads').doc(threadId).update({ data: { unreadCount: 0, readAt: time } })
      return { threadId, unreadCount: 0 }
    }
    if (action === 'markOrderThreadRead') {
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单消息不存在')
      const res = await db.collection('order_staff_message_threads').where({ orderId, staffOpenid: openid }).limit(1).get()
      const thread = res.data[0]
      if (!thread) return { orderId, unreadCount: 0 }
      const time = now()
      await db.collection('order_staff_message_threads').doc(thread._id).update({ data: { unreadCount: 0, readAt: time } })
      return { threadId: thread._id, orderId, unreadCount: 0 }
    }
    throw new Error('未知 staffMessage 操作')
  },

  async initData(openid, action, data = {}) {
    function getInitAdminSecret() {
      return safeText(process.env.INIT_ADMIN_SECRET).trim()
    }

    function assertInitAdminSecret() {
      const secret = getInitAdminSecret()
      if (!secret) throw new Error('初始管理员配置未完成')
      if (safeText(data.secret).trim() !== secret) throw new Error('初始化密钥不正确')
    }

    async function hasActiveAdmin() {
      const usersRes = await db.collection('users').get()
      return (usersRes.data || []).some((user) => user.status === 'active' && Array.isArray(user.roles) && user.roles.includes('admin'))
    }

    async function requireInitSecretOrAdmin() {
      if (await hasActiveAdmin()) return requireAdmin(openid)
      assertInitAdminSecret()
      return null
    }

    if (action === 'checkCollections') {
      await requireInitSecretOrAdmin()
      const result = []
      for (let i = 0; i < collections.length; i += 1) {
        const name = collections[i]
        try {
          await db.collection(name).limit(1).get()
          result.push({ name, exists: true })
        } catch (error) {
          result.push({ name, exists: false, message: '请在云开发控制台创建该集合' })
        }
      }
      return result
    }

    async function claimInitialAdmin() {
      assertInitAdminSecret()
      const allowedPhones = safeText(process.env.INIT_ADMIN_PHONES)
        .split(',')
        .map((phone) => phone.trim())
        .filter(Boolean)
      if (!allowedPhones.length) throw new Error('初始管理员配置未完成')
      const user = await getUser(openid)
      const phone = safeText(user.phone).trim()
      if (!phone) throw new Error('请先绑定手机号')
      if (!allowedPhones.includes(phone)) throw new Error('当前手机号不在初始管理员白名单')
      if (await hasActiveAdmin()) throw new Error('初始管理员已存在')
      const time = now()
      const roles = Array.from(new Set([...(Array.isArray(user.roles) ? user.roles : ['client']), 'admin']))
      await db.collection('users').doc(user._id).update({ data: { roles, activeRole: 'admin', status: 'active', updatedAt: time } })
      return { ...user, roles, activeRole: 'admin', status: 'active', updatedAt: time }
    }

    if (action === 'claimInitialAdmin' || action === 'seedAdmin') return claimInitialAdmin()
    if (action === 'seedDemoData') {
      const user = await requireAdmin(openid)
      const time = now()
      const petRes = await db.collection('pets').where({ openid, name: '可乐' }).limit(1).get()
      let pet = petRes.data[0]
      if (!pet) {
        const petData = { userId: user._id, openid, name: '可乐', species: 'dog', breed: '柴犬', weight: 12, specialNotes: '有轻微爆冲，需短牵。', createdAt: time, updatedAt: time }
        const createdPet = await db.collection('pets').add({ data: petData })
        pet = { _id: createdPet._id, ...petData }
      }
      const orderRes = await db.collection('orders').where({ clientOpenid: openid, petId: pet._id }).limit(1).get()
      let order = orderRes.data[0]
      if (!order) {
        const start = new Date(Date.now() + 60 * 60 * 1000)
        const end = new Date(Date.now() + 2 * 60 * 60 * 1000)
        const orderData = { orderNo: `D${Date.now()}`, clientUserId: user._id, clientOpenid: openid, staffUserId: '', staffOpenid: '', staffProfileId: '', publishMode: 'open', requestedStaffProfileId: '', requestedStaffUserId: '', requestedStaffOpenid: '', requestedStaffName: '', requestedStaffSnapshot: null, assignmentSource: '', petId: pet._id, petName: pet.name, serviceType: 'walk', serviceTypes: ['walk'], serviceLabels: ['上门遛狗'], serviceSummary: '上门遛狗', serviceAddress: '演示小区 1 号楼', addressDetail: '1号楼 101', doorplate: '门牌 101', addressLatitude: 0, addressLongitude: 0, startTime: start.toISOString().slice(0, 16).replace('T', ' '), endTime: end.toISOString().slice(0, 16).replace('T', ' '), durationMinutes: 60, amount: 89, payAmount: 89, priceSnapshot: { services: [{ key: 'walk', label: '上门遛狗', price: 89 }], durationMinutes: 60, weight: 12 }, paymentStatus: 'paid', status: 'paid', requiredCheckins: requiredCheckins('walk', ['walk']), insurancePolicyNo: '', cancelReason: '', paidAt: time, createdAt: time, updatedAt: time }
        const createdOrder = await db.collection('orders').add({ data: orderData })
        order = { _id: createdOrder._id, ...orderData }
      }
      return { user, pet, order }
    }
    throw new Error('未知 initData 操作')
  }
}

function isWechatPayHttpCallback(event = {}) {
  const headers = event.headers || event.header || {}
  const hasWechatHeader = Object.keys(headers).some((key) => key.toLowerCase().startsWith('wechatpay-'))
  return !event.module && !event.action && (hasWechatHeader || event.httpMethod || event.requestContext) && (event.body || event.rawBody)
}

exports.main = async (event = {}) => {
  try {
    if (event.Type === 'Timer') {
      await cancelUnpaidOrders()
      await expireDueUnacceptedOrders()
      const upcomingReminders = await sendUpcomingServiceRemindersToStaff()
      const overdueUnstarted = await processOverdueUnstartedOrders()
      const overdueUnfinished = await processOverdueUnfinishedOrders()
      const today = toCstParts()
      let petBeautySettled = null
      const isLastDayOfMonth = today.dayNumber === getMonthDays(today.monthKey)
      if (isLastDayOfMonth) {
        petBeautySettled = await settlePetBeautyMonthlyRanking(today.monthKey, { source: 'timer' })
      }
      if (today.dayNumber <= 2) {
        const prevMonth = today.month === '01'
          ? `${today.year - 1}-12`
          : `${today.year}-${String(Number(today.month) - 1).padStart(2, '0')}`
        const prevSettled = await settlePetBeautyMonthlyRanking(prevMonth, { source: 'timer_catchup' })
        if (!petBeautySettled) petBeautySettled = prevSettled
      }
      return ok({
        expired: true,
        upcomingRemindersCount: upcomingReminders.length,
        overdueUnstartedCount: overdueUnstarted.length,
        overdueUnfinishedCount: overdueUnfinished.length,
        petBeautySettled
      })
    }
    if (isWechatPayHttpCallback(event)) {
      return handlers.payment('', 'paymentCallback', {
        _isInternalHttpCallback: true,
        headers: event.headers || event.header || {},
        rawBody: event.rawBody,
        body: event.body,
        isBase64Encoded: event.isBase64Encoded === true
      })
    }
    const { OPENID } = cloud.getWXContext()
    const moduleName = event.module || event.name
    const action = event.action
    const data = event.data || {}
    const handler = handlers[moduleName]
    if (!handler) throw new Error(`未知模块：${moduleName}`)
    return ok(await handler(OPENID, action, data))
  } catch (error) {
    return fail(error.message, error.code)
  }
}
