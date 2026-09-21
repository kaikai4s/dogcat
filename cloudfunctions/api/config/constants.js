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

const WEEKDAY_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

const serviceIcons = { visit_fee: '🏠', walk: '🐶', feed: '🐱', litter: '🚽', play: '🧶', medicine: '💊', clean: '🧹' }

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

const PET_TIMED_SERVICE_KEYS = ['walk', 'play']

const CHECKIN_EVENT_TYPES = new Set(['sanitization', 'enter_door', 'leash_on', 'feed', 'water', 'pet_status', 'return_home', 'leave_door', 'clean', 'medicine', 'video_checkin', 'pet_beauty_photo'])

module.exports = {
  collections,
  VISIT_FEE_SERVICE_KEY,
  RETIRED_SERVICE_KEYS,
  EXTRA_PET_RULES,
  defaultServicePrices,
  defaultServiceCheckinRules,
  DEFAULT_STAFF_TRAINING_PASS_SCORE,
  STAFF_TRAINING_VIDEOS,
  DEFAULT_STAFF_TRAINING_QUIZ,
  STAFF_VIDEO_AUDIT_GUIDE,
  DEFAULT_DISPOSABLE_SUPPLY_ITEMS,
  QUIZ_OPTION_VALUES,
  defaultHomeModules,
  WEEKDAY_NAMES,
  serviceIcons,
  ORDER_STATUS,
  ORDER_TRANSITIONS,
  PET_TIMED_SERVICE_KEYS,
  CHECKIN_EVENT_TYPES
}
