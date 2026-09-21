const { callFunction, showError, setCachedSystemSettings } = require('../../../utils/cloud')

const quizOptionValues = ['A', 'B', 'C', 'D', 'E', 'F']
const requiredSupplyItems = ['一次性手套', '一次性口罩', '一次性鞋套', '宠物安全消毒用品']

const defaultSupplyItemObjects = [
  { id: 'supply_gloves', name: '一次性手套', description: '佩戴防接触感染，足量自备', purchaseUrl: '', enabled: true },
  { id: 'supply_mask', name: '一次性口罩', description: '规范防护，入户全程佩戴', purchaseUrl: '', enabled: true },
  { id: 'supply_shoes', name: '一次性鞋套', description: '进门即穿戴，保护家庭卫生', purchaseUrl: '', enabled: true },
  { id: 'supply_disinfectant', name: '安全宠物消毒用品', description: '宠物专用安全无毒，进门及工具消毒', purchaseUrl: '', enabled: true }
]

// Amounts use yuan in the existing settings/API; require exact positive cents.
function validAmount(value, allowZero = false) {
  const text = String(value).trim()
  const amount = Number(text)
  return /^\d+(\.\d{1,2})?$/.test(text) && Number.isFinite(amount) &&
    Number.isSafeInteger(Math.round(amount * 100)) && (allowZero ? amount >= 0 : amount > 0)
}

function normalizeStaffDeposit(deposit = {}) {
  return {
    ...deposit,
    enabled: deposit.enabled === true && validAmount(deposit.amount),
    amount: validAmount(deposit.amount, true) ? Number(deposit.amount) : 0,
    rulesText: deposit.rulesText || '保证金金额以平台配置为准；用品报销由平台独立出资，绝不扣减保证金。',
    refundRulesText: deposit.refundRulesText || '自愿退出时保证金全额原路退回；仅扣除管理员已记录依据、金额和原因的违规没收部分，已退金额不重复退还。',
    forfeitRulesText: deposit.forfeitRulesText || '仅管理员可根据有据可查的违规事实没收保证金，必须记录依据、金额和原因；不得以用品报销为由扣减。'
  }
}

function normalizeStaffSupplies(supplies = {}) {
  let items = Array.isArray(supplies.items) && supplies.items.length
    ? supplies.items.map((item, idx) => ({
        id: item.id || `supply_${idx + 1}`,
        name: String(item.name || '').trim(),
        description: String(item.description || '').trim(),
        purchaseUrl: String(item.purchaseUrl || '').trim(),
        enabled: item.enabled !== false
      })).filter((i) => i.name)
    : (Array.isArray(supplies.requiredItems) ? supplies.requiredItems : requiredSupplyItems).map((name, idx) => {
        const defaultObj = defaultSupplyItemObjects.find((d) => d.name === name)
        return {
          id: `supply_${idx + 1}`,
          name: String(name || '').trim(),
          description: defaultObj ? defaultObj.description : '',
          purchaseUrl: '',
          enabled: true
        }
      }).filter((i) => i.name)

  if (!items.some((i) => i.name.includes('鞋套'))) {
    items.splice(2, 0, { id: 'supply_shoes', name: '一次性鞋套', description: '进门即穿戴，保护家庭卫生', purchaseUrl: '', enabled: true })
  }

  const requiredItems = items.filter((i) => i.enabled).map((i) => i.name)

  return {
    ...supplies,
    reimbursementEnabled: supplies.reimbursementEnabled === true,
    items,
    requiredItems: requiredItems.length ? requiredItems : [...requiredSupplyItems],
    auditNotice: supplies.auditNotice || '视频审核必须检查手套、口罩、鞋套、宠物安全消毒用品。严格考核可能不通过；未正式认证不报销。仅正式认证后首次申请可报销，实习阶段不可申请。',
    serviceReminder: supplies.serviceReminder || '服务前带齐手套、口罩、鞋套和宠物安全消毒用品，按规范完成消毒。',
    transfer: { enabled: false, sceneId: '', userRecvPerception: '', sceneReportInfos: [], ...(supplies.transfer || {}) }
  }
}

const CAROUSEL_LINK_PRESETS = [
  { label: '不跳转（仅展示图片/视频）', value: 'none', url: '', title: '' },
  { label: '快速预约服务', value: 'booking', url: '/pages/client/orders/create/index', title: '去预约' },
  { label: '附近宠托师', value: 'sitters', url: '/pages/client/sitters/list/index', title: '找宠托师' },
  { label: '积分商城', value: 'points', url: '/pages/client/points/index', title: '积分商城' },
  { label: '宠物用品商城', value: 'mall', url: '/pages/client/mall/list/index', title: '逛商城' },
  { label: '领券中心', value: 'coupons', url: '/pages/client/coupons/list/index', title: '领优惠券' },
  { label: '幸运大转盘抽奖', value: 'lottery', url: '/pages/client/lottery/index', title: '去抽奖' },
  { label: '最美宠物评选', value: 'petBeauty', url: '/pages/client/pet-beauty/activity/index', title: '去参赛' },
  { label: 'AI 宠护管家', value: 'aiAssistant', url: '/pages/client/ai-assistant/index', title: '体验 AI' },
  { label: '我的订单中心', value: 'orders', url: '/pages/client/orders/list/index', title: '我的订单' },
  { label: '我的宠物档案', value: 'pets', url: '/pages/client/pets/list/index', title: '宠物档案' },
  { label: '平台服务与保障', value: 'agreement', url: '/pages/common/agreement/index', title: '服务保障' },
  { label: '自定义页面路径', value: 'custom', url: '', title: '查看详情' }
]

function getLinkPresetIndex(url, linkType) {
  const cleanUrl = String(url || '').trim()
  if (!cleanUrl && (!linkType || linkType === 'none')) return 0
  const found = CAROUSEL_LINK_PRESETS.findIndex((p) => p.url && cleanUrl.startsWith(p.url))
  if (found > 0) return found
  if (linkType && linkType !== 'none') {
    const byType = CAROUSEL_LINK_PRESETS.findIndex((p) => p.value === linkType)
    if (byType > 0) return byType
  }
  return cleanUrl ? CAROUSEL_LINK_PRESETS.length - 1 : 0
}

function createEmptyItem() {
  return {
    id: `hero_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type: 'image',
    fileId: '',
    posterFileId: '',
    title: '',
    subtitle: '',
    linkType: 'none',
    linkUrl: '',
    linkTitle: '',
    enabled: true,
    sort: 10,
    tempUrl: '',
    posterTempUrl: ''
  }
}

function createEmptyTrainingVideo(index = 0) {
  return {
    key: `training_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    title: '',
    description: '',
    durationText: '',
    fileId: '',
    posterFileId: '',
    enabled: true,
    sort: (index + 1) * 10,
    tempUrl: '',
    posterTempUrl: ''
  }
}

function normalizePaymentConfig(payment = {}) {
  // Never render returned credentials, even if an older backend omits redaction.
  const { apiV3Key, privateKey, merchantPrivateKey, platformPublicKey, ...publicPayment } = payment
  return {
    ...publicPayment,
    enabled: payment.enabled !== false,
    mode: payment.mode === 'wechat' ? 'wechat' : 'mock',
    mchId: payment.mchId || '',
    appId: payment.appId || '',
    notifyUrl: payment.notifyUrl || '',
    certSerialNo: payment.certSerialNo || payment.merchantCertSerialNo || '',
    refundEnabled: payment.refundEnabled !== false,
    allowMockInProduction: payment.allowMockInProduction === true,
    apiV3KeyConfigured: payment.apiV3KeyConfigured === true,
    privateKeyConfigured: payment.privateKeyConfigured === true,
    platformPublicKeyConfigured: payment.platformPublicKeyConfigured === true,
    apiV3KeyInput: '',
    privateKeyInput: '',
    platformPublicKeyInput: ''
  }
}

function normalizeSettlementConfig(settlement = {}) {
  return {
    ...settlement,
    staffCommissionRate: Number(settlement.staffCommissionRate === undefined ? 0.7 : settlement.staffCommissionRate),
    settlementDelayDays: Number(settlement.settlementDelayDays === undefined ? 1 : settlement.settlementDelayDays),
    minWithdrawAmount: Number(settlement.minWithdrawAmount === undefined ? 10 : settlement.minWithdrawAmount),
    withdrawFeeRate: Number(settlement.withdrawFeeRate || 0)
  }
}

function normalizeSubscriptionConfig(subscription = {}) {
  const templates = subscription.templates || {}
  return {
    ...subscription,
    enabled: subscription.enabled === true,
    templates: {
      ...templates,
      orderPaid: templates.orderPaid || '',
      orderAssigned: templates.orderAssigned || '',
      orderAccepted: templates.orderAccepted || '',
      serviceStart: templates.serviceStart || '',
      serviceFinish: templates.serviceFinish || '',
      remoteUnlock: templates.remoteUnlock || '',
      refundResult: templates.refundResult || '',
      disputeUpdate: templates.disputeUpdate || '',
      withdrawResult: templates.withdrawResult || '',
      upcomingServiceReminder: templates.upcomingServiceReminder || templates.serviceReminder || ''
    }
  }
}

function normalizeReliabilityConfig(reliability = {}) {
  return {
    ...reliability,
    enableOfflineQueue: reliability.enableOfflineQueue !== false,
    maxTrackBatchSize: Number(reliability.maxTrackBatchSize || 50),
    maxRetryTimes: Number(reliability.maxRetryTimes || 5)
  }
}

function normalizeCustomerServiceConfig(customerService = {}) {
  return {
    ...customerService,
    phone: customerService.phone || '',
    wechatId: customerService.wechatId || '',
    workHours: customerService.workHours || '每天 9:00-21:00',
    officialAccountName: customerService.officialAccountName || ''
  }
}

function normalizeCheckinShareConfig(checkinShare = {}) {
  return {
    ...checkinShare,
    title: checkinShare.title || '来签到领福利，补签卡也能拿',
    imageUrl: checkinShare.imageUrl || '',
    imageTempUrl: checkinShare.imageUrl && /^https?:\/\//.test(checkinShare.imageUrl) ? checkinShare.imageUrl : ''
  }
}

function createEmptyQuizQuestion() {
  const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
  return {
    id,
    type: 'single',
    question: '',
    options: [
      { value: 'A', label: '' },
      { value: 'B', label: '' },
      { value: 'C', label: '' }
    ],
    answer: 'A'
  }
}

function formatFileSize(size) {
  if (!size) return ''
  return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(size / 1024)}KB`
}

function getUploadErrorMessage(error, label, maxSizeText) {
  const message = (error && (error.errMsg || error.message)) || ''
  if (/size|exceed|too large|oversize|最大|大小|limit/i.test(message)) {
    return `${label}上传失败：压缩后的文件仍超过云存储限制，请重新压缩后再上传${maxSizeText ? `（建议不超过 ${maxSizeText}）` : ''}`
  }
  return `${label}上传失败：${message || '请检查文件大小、格式或网络后重试'}`
}

function normalizeStaffTrainingConfig(training = {}) {
  const sourceQuiz = Array.isArray(training.quiz) ? training.quiz : []
  const sourceVideos = Array.isArray(training.videos) ? training.videos : []
  const guide = training.videoAuditGuide || {}
  return {
    ...training,
    passScore: Math.min(Math.max(Math.round(Number(training.passScore || 80)), 1), 100),
    videoAuditGuide: {
      wechatId: (guide.wechatId || 'pet-service-admin').trim(),
      remarkTemplate: (guide.remarkTemplate || '宠托师审核 + 姓名 + 手机号').trim(),
      description: (guide.description || '请添加平台审核微信并按备注格式发送信息，管理员完成线上视频审核后会在后台更新结果。').trim(),
      requiredItemsNotice: (guide.requiredItemsNotice || '视频通话审核必备用品（须提前自备）：一次性手套、一次性口罩、一次性鞋套安全宠物消毒用品。').trim(),
      strictWarning: (guide.strictWarning || '温馨提醒：平台对审核员有严格要求，存在不通过的风险。备齐物资为必备前提，但不代表必然通过；如因其他原因未正式通过认证，平台不予报销宠物用品。成为认证宠托师后可申请首次用品报销，每人仅限首次申请，后续用品自备且不报销。').trim()
    },
    quiz: sourceQuiz.map((item, index) => {
      const options = (Array.isArray(item.options) ? item.options : []).slice(0, quizOptionValues.length).map((option, optionIndex) => ({
        ...option,
        value: quizOptionValues[optionIndex],
        label: option.label || ''
      }))
      while (options.length < 2) options.push({ value: quizOptionValues[options.length], label: '' })
      const answer = options.some((option) => option.value === item.answer) ? item.answer : options[0].value
      return {
        ...item,
        id: item.id || `q${index + 1}`,
        type: 'single',
        question: item.question || '',
        options,
        answer
      }
    }),
    videos: sourceVideos.map((item, index) => ({
      ...item,
      key: item.key || `training_${index + 1}`,
      title: item.title || '',
      description: item.description || '',
      durationText: item.durationText || '',
      fileId: item.fileId || '',
      posterFileId: item.posterFileId || '',
      enabled: item.enabled !== false,
      sort: Number(item.sort) || (index + 1) * 10,
      tempUrl: item.tempUrl || '',
      posterTempUrl: item.posterTempUrl || ''
    })).sort((a, b) => a.sort - b.sort)
  }
}

function normalizeCarouselConfig(carousel = {}) {
  const source = carousel || {}
  const rotateIntervalMs = Number(source.rotateIntervalMs || 5000)
  const rotateIntervalSec = Math.max(Math.round(rotateIntervalMs / 1000), 1)
  const items = Array.isArray(source.items) ? source.items : []
  const normalizedItems = items.map((item, index) => ({
    ...item,
    id: item.id || `hero_${Date.now()}_${index}`,
    type: item.type === 'video' ? 'video' : 'image',
    fileId: item.fileId || '',
    posterFileId: item.posterFileId || '',
    title: item.title || '',
    subtitle: item.subtitle || '',
    linkType: item.linkType || (item.linkUrl ? 'custom' : 'none'),
    linkUrl: item.linkUrl || '',
    linkTitle: item.linkTitle || '',
    enabled: item.enabled !== false,
    sort: Number(item.sort) || (index + 1) * 10,
    tempUrl: '',
    posterTempUrl: ''
  })).sort((a, b) => a.sort - b.sort)

  return {
    ...source,
    enabled: source.enabled === true,
    autoRotate: source.autoRotate !== false,
    rotateIntervalMs: rotateIntervalSec * 1000,
    rotateIntervalSec,
    items: normalizedItems
  }
}

const homeModuleOptions = [
  { key: 'quickBooking', label: '核心预约 CTA' },
  { key: 'nearbySitters', label: '附近宠托师入口' },
  { key: 'repeatBooking', label: '再次预约' },
  { key: 'hotServices', label: '热门服务卡' },
  { key: 'newbieCoupon', label: '新人优惠' },
  { key: 'featuredSitters', label: '精选宠托师' },
  { key: 'platformAssurance', label: '平台保障' },
  { key: 'historyStats', label: '历史服务统计' },
  { key: 'lottery', label: '抽奖活动横幅' },
  { key: 'petBeautyActivity', label: '最美宠物活动' }
]

function normalizeHomePageConfig(homePage = {}) {
  const modules = homePage.modules || {}
  return {
    ...homePage,
    ctaTitle: homePage.ctaTitle || '立即预约上门宠护',
    ctaSubtitle: homePage.ctaSubtitle || '填写宠物和服务时间，平台认证宠托师快速响应。',
    ctaText: homePage.ctaText || '立即预约',
    nearbyTitle: homePage.nearbyTitle || '附近宠托师',
    repeatTitle: homePage.repeatTitle || '一键复购',
    couponTitle: homePage.couponTitle || '新人优惠',
    assuranceTitle: homePage.assuranceTitle || '平台保障',
    modules: homeModuleOptions.reduce((result, item) => ({ ...result, [item.key]: modules[item.key] !== false }), { ...modules })
  }
}

function buildSettingSummary(settings = {}) {
  const payment = settings.payment || normalizePaymentConfig()
  const subscription = settings.subscription || normalizeSubscriptionConfig()
  const templates = subscription.templates || {}
  const configuredTemplateCount = Object.keys(templates).filter((key) => String(templates[key] || '').trim()).length
  const carousel = settings.homeHeroCarousel || normalizeCarouselConfig()
  const carouselItems = carousel.items || []
  const enabledCarouselCount = carouselItems.filter((item) => item.enabled !== false).length
  const homePage = settings.homePage || normalizeHomePageConfig()
  const modules = homePage.modules || {}
  const enabledModuleCount = homeModuleOptions.filter((item) => modules[item.key] !== false).length
  const customerService = settings.customerService || normalizeCustomerServiceConfig()
  const checkinShare = settings.checkinShare || normalizeCheckinShareConfig()
  const settlement = settings.settlement || normalizeSettlementConfig()
  const reliability = settings.reliability || normalizeReliabilityConfig()
  const staffTraining = settings.staffTraining || normalizeStaffTrainingConfig()
  const quiz = staffTraining.quiz || []
  const videos = staffTraining.videos || []
  const enabledVideoCount = videos.filter((item) => item.enabled !== false).length

  return {
    debug: settings.enableTestAddressMode ? '测试地址模式已开启' : '测试地址模式已关闭',
    petBreedAi: settings.enablePetBreedAi === false ? '前台宠物档案 AI 识别已关闭' : '前台宠物档案 AI 识别已开启',
    payment: `${payment.enabled ? '支付已启用' : '支付已关闭'} · ${payment.mode === 'wechat' ? '微信支付' : '模拟支付'} · ${payment.refundEnabled ? '退款已启用' : '退款已关闭'}`,
    subscription: `${subscription.enabled ? '订阅已启用' : '订阅已关闭'} · 已配置 ${configuredTemplateCount} 个模板`,
    customerService: `${customerService.phone || '未配置电话'} · ${customerService.workHours || '未配置时间'}`,
    checkinShare: `${checkinShare.title || '未配置标题'} · ${checkinShare.imageUrl ? '已配置封面' : '未配置封面'}`,
    settlementReliability: `分成 ${Math.round(Number(settlement.staffCommissionRate || 0) * 100)}% · T+${settlement.settlementDelayDays} · ${reliability.enableOfflineQueue ? '离线补传开' : '离线补传关'}`,
    carousel: `${carousel.enabled ? '轮播已启用' : '轮播已关闭'} · ${enabledCarouselCount}/${carouselItems.length} 个素材启用`,
    homePage: `${enabledModuleCount}/${homeModuleOptions.length} 个模块启用 · ${homePage.ctaTitle || '未配置标题'}`,
    staffTraining: `及格 ${staffTraining.passScore} 分 · ${quiz.length} 道题 · ${enabledVideoCount}/${videos.length} 视频 · 审核微信: ${(staffTraining.videoAuditGuide && staffTraining.videoAuditGuide.wechatId) || '未配置'}`,
    configuredTemplateCount,
    enabledCarouselCount,
    carouselCount: carouselItems.length,
    enabledModuleCount,
    moduleCount: homeModuleOptions.length
  }
}

Page({
  data: {
    loaded: false,
    requiredItemsText: '',
    sceneReportInfosText: '[]',
    settings: {
      staffDeposit: normalizeStaffDeposit(),
      staffSupplies: normalizeStaffSupplies(),
      enableTestAddressMode: false,
      enablePetBreedAi: true,
      payment: normalizePaymentConfig(),
      settlement: normalizeSettlementConfig(),
      subscription: normalizeSubscriptionConfig(),
      reliability: normalizeReliabilityConfig(),
      customerService: normalizeCustomerServiceConfig(),
      checkinShare: normalizeCheckinShareConfig(),
      homeHeroCarousel: normalizeCarouselConfig(),
      homePage: normalizeHomePageConfig(),
      staffTraining: normalizeStaffTrainingConfig()
    },
    homeModuleOptions,
    settingSummary: buildSettingSummary({
      enableTestAddressMode: false,
      enablePetBreedAi: true,
      payment: normalizePaymentConfig(),
      settlement: normalizeSettlementConfig(),
      subscription: normalizeSubscriptionConfig(),
      reliability: normalizeReliabilityConfig(),
      customerService: normalizeCustomerServiceConfig(),
      checkinShare: normalizeCheckinShareConfig(),
      homeHeroCarousel: normalizeCarouselConfig(),
      homePage: normalizeHomePageConfig(),
      staffTraining: normalizeStaffTrainingConfig()
    }),
    showSettingModal: false,
    activeSettingPanel: '',
    showCarouselEditor: false,
    editingIndex: -1,
    editingItem: createEmptyItem(),
    carouselLinkPresets: CAROUSEL_LINK_PRESETS,
    carouselLinkPresetLabels: CAROUSEL_LINK_PRESETS.map((p) => p.label),
    selectedLinkPresetIndex: 0,
    uploadingMedia: false,
    uploadingPoster: false,
    uploadingCheckinShareImage: false,
    uploadingTrainingVideo: false,
    uploadingTrainingPoster: false,
    saving: false
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('admin', 'getSystemSettings')
      .then((settings) => {
        const normalized = {
          ...settings,
          staffDeposit: normalizeStaffDeposit(settings.staffDeposit),
          staffSupplies: normalizeStaffSupplies(settings.staffSupplies),
          enableTestAddressMode: settings.enableTestAddressMode === true,
          enablePetBreedAi: settings.enablePetBreedAi !== false,
          payment: normalizePaymentConfig(settings.payment),
          settlement: normalizeSettlementConfig(settings.settlement),
          subscription: normalizeSubscriptionConfig(settings.subscription),
          reliability: normalizeReliabilityConfig(settings.reliability),
          customerService: normalizeCustomerServiceConfig(settings.customerService),
          checkinShare: normalizeCheckinShareConfig(settings.checkinShare),
          homeHeroCarousel: normalizeCarouselConfig(settings.homeHeroCarousel),
          homePage: normalizeHomePageConfig(settings.homePage),
          staffTraining: normalizeStaffTrainingConfig(settings.staffTraining)
        }
        this.setData({ loaded: true, requiredItemsText: normalized.staffSupplies.requiredItems.join('\n'), sceneReportInfosText: JSON.stringify(normalized.staffSupplies.transfer.sceneReportInfos, null, 2) })
        setCachedSystemSettings(normalized)
        this.setData({ settings: normalized, settingSummary: buildSettingSummary(normalized) }, () => {
          this.resolveMediaUrls(normalized.homeHeroCarousel.items)
          this.resolveTrainingVideoUrls(normalized.staffTraining.videos)
          this.resolveCheckinShareImageUrl(normalized.checkinShare.imageUrl)
        })
      })
      .catch(showError)
  },

  resolveMediaUrls(items = []) {
    const fileIds = []
    items.forEach((item) => {
      if (item.fileId) fileIds.push(item.fileId)
      if (item.posterFileId) fileIds.push(item.posterFileId)
    })
    const uniqueIds = Array.from(new Set(fileIds))
    if (!uniqueIds.length) return

    wx.cloud.getTempFileURL({
      fileList: uniqueIds,
      success: (res) => {
        const urlMap = {}
        ;(res.fileList || []).forEach((f) => {
          if (f.fileID && f.tempFileURL) urlMap[f.fileID] = f.tempFileURL
        })
        const updatedItems = items.map((item) => ({
          ...item,
          tempUrl: urlMap[item.fileId] || item.tempUrl || '',
          posterTempUrl: urlMap[item.posterFileId] || item.posterTempUrl || ''
        }))
        this.setData({ ['settings.homeHeroCarousel.items']: updatedItems })
      }
    })
  },

  resolveTrainingVideoUrls(videos = []) {
    const fileIds = []
    videos.forEach((item) => {
      if (item.fileId) fileIds.push(item.fileId)
      if (item.posterFileId) fileIds.push(item.posterFileId)
    })
    const uniqueIds = Array.from(new Set(fileIds))
    if (!uniqueIds.length) return

    wx.cloud.getTempFileURL({
      fileList: uniqueIds,
      success: (res) => {
        const urlMap = {}
        ;(res.fileList || []).forEach((f) => {
          if (f.fileID && f.tempFileURL) urlMap[f.fileID] = f.tempFileURL
        })
        const currentVideos = this.data.settings.staffTraining.videos || []
        const updatedVideos = currentVideos.map((item) => ({
          ...item,
          tempUrl: item.fileId ? (urlMap[item.fileId] || item.tempUrl || item.fileId) : '',
          posterTempUrl: item.posterFileId ? (urlMap[item.posterFileId] || item.posterTempUrl || item.posterFileId) : ''
        }))
        this.setData({ ['settings.staffTraining.videos']: updatedVideos })
      },
      fail: () => {
        const currentVideos = this.data.settings.staffTraining.videos || []
        this.setData({
          ['settings.staffTraining.videos']: currentVideos.map((item) => ({
            ...item,
            tempUrl: item.fileId ? (item.tempUrl || item.fileId) : '',
            posterTempUrl: item.posterFileId ? (item.posterTempUrl || item.posterFileId) : ''
          }))
        })
      }
    })
  },

  resolveCheckinShareImageUrl(imageUrl) {
    if (!imageUrl) {
      this.setData({ ['settings.checkinShare.imageTempUrl']: '' })
      return
    }
    if (/^https?:\/\//.test(imageUrl)) {
      this.setData({ ['settings.checkinShare.imageTempUrl']: imageUrl })
      return
    }
    wx.cloud.getTempFileURL({
      fileList: [imageUrl],
      success: (res) => {
        const file = res.fileList && res.fileList[0]
        this.setData({ ['settings.checkinShare.imageTempUrl']: (file && file.tempFileURL) || '' })
      }
    })
  },

  refreshSettingSummary() {
    this.setData({ settingSummary: buildSettingSummary(this.data.settings) })
  },

  openSettingModal(e) {
    const panel = e.currentTarget.dataset.panel
    if (!panel) return
    this.setData({ showSettingModal: true, activeSettingPanel: panel })
  },

  closeSettingModal() {
    this.setData({ showSettingModal: false, activeSettingPanel: '', showCarouselEditor: false })
    this.refreshSettingSummary()
  },

  noop() {},

  toggleTestAddressMode(e) {
    this.setData({ ['settings.enableTestAddressMode']: e.detail.value })
  },

  togglePetBreedAi(e) {
    this.setData({ ['settings.enablePetBreedAi']: e.detail.value })
  },

  toggleCarouselEnabled(e) {
    this.setData({ ['settings.homeHeroCarousel.enabled']: e.detail.value })
  },

  addSupplyItem() {
    const items = [...(this.data.settings.staffSupplies.items || [])]
    items.push({
      id: `supply_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: '',
      description: '',
      purchaseUrl: '',
      enabled: true
    })
    this.setData({ 'settings.staffSupplies.items': items })
  },

  removeSupplyItem(e) {
    const index = Number(e.currentTarget.dataset.index)
    const items = [...(this.data.settings.staffSupplies.items || [])]
    if (items.length <= 1) {
      wx.showToast({ title: '至少保留一项必备用品', icon: 'none' })
      return
    }
    items.splice(index, 1)
    const requiredItems = items.filter((i) => i.enabled).map((i) => i.name).filter(Boolean)
    this.setData({
      'settings.staffSupplies.items': items,
      requiredItemsText: requiredItems.join('\n')
    })
  },

  inputSupplyItem(e) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    const items = [...(this.data.settings.staffSupplies.items || [])]
    if (!items[index]) return
    items[index] = { ...items[index], [field]: value }
    const requiredItems = items.filter((i) => i.enabled).map((i) => i.name).filter(Boolean)
    this.setData({
      'settings.staffSupplies.items': items,
      requiredItemsText: requiredItems.join('\n')
    })
  },

  toggleSupplyItem(e) {
    const index = Number(e.currentTarget.dataset.index)
    const items = [...(this.data.settings.staffSupplies.items || [])]
    if (!items[index]) return
    items[index] = { ...items[index], enabled: e.detail.value }
    const requiredItems = items.filter((i) => i.enabled).map((i) => i.name).filter(Boolean)
    this.setData({
      'settings.staffSupplies.items': items,
      requiredItemsText: requiredItems.join('\n')
    })
  },

  toggleCarouselAutoRotate(e) {
    this.setData({ ['settings.homeHeroCarousel.autoRotate']: e.detail.value })
  },

  inputIntervalSec(e) {
    const sec = Math.max(Number(e.detail.value || 5), 1)
    this.setData({
      ['settings.homeHeroCarousel.rotateIntervalSec']: sec,
      ['settings.homeHeroCarousel.rotateIntervalMs']: sec * 1000
    })
  },

  togglePaymentEnabled(e) {
    this.setData({ ['settings.payment.enabled']: e.detail.value })
  },

  paymentModeChange(e) {
    this.setData({ ['settings.payment.mode']: e.detail.value === 'wechat' ? 'wechat' : 'mock' })
  },

  toggleRefundEnabled(e) {
    this.setData({ ['settings.payment.refundEnabled']: e.detail.value })
  },

  toggleAllowMockInProduction(e) {
    this.setData({ ['settings.payment.allowMockInProduction']: e.detail.value })
  },

  paymentInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`settings.payment.${field}`]: e.detail.value })
  },

  settlementInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`settings.settlement.${field}`]: Number(e.detail.value || 0) })
  },

  reliabilityInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`settings.reliability.${field}`]: Number(e.detail.value || 0) })
  },

  customerServiceInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`settings.customerService.${field}`]: e.detail.value })
  },

  checkinShareInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`settings.checkinShare.${field}`]: e.detail.value })
  },

  chooseCheckinShareImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file || !file.tempFilePath) return
        const filePath = file.tempFilePath
        const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
        const cloudPath = `checkin_share/${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`

        this.setData({ uploadingCheckinShareImage: true })
        wx.showLoading({ title: '上传封面...' })
        wx.cloud.uploadFile({
          cloudPath,
          filePath,
          success: (upload) => {
            const fileId = upload.fileID
            wx.cloud.getTempFileURL({
              fileList: [fileId],
              success: (tempRes) => {
                wx.hideLoading()
                const tempFile = tempRes.fileList && tempRes.fileList[0]
                this.setData({
                  ['settings.checkinShare.imageUrl']: fileId,
                  ['settings.checkinShare.imageTempUrl']: (tempFile && tempFile.tempFileURL) || filePath,
                  uploadingCheckinShareImage: false
                })
                wx.showToast({ title: '封面上传成功' })
              },
              fail: () => {
                wx.hideLoading()
                this.setData({
                  ['settings.checkinShare.imageUrl']: fileId,
                  ['settings.checkinShare.imageTempUrl']: filePath,
                  uploadingCheckinShareImage: false
                })
                wx.showToast({ title: '封面上传成功' })
              }
            })
          },
          fail: (err) => {
            wx.hideLoading()
            this.setData({ uploadingCheckinShareImage: false })
            showError(err)
          }
        })
      },
      fail: (err) => {
        const errMsg = (err && err.errMsg) || ''
        if (errMsg.includes('cancel')) return
        showError(err)
      }
    })
  },

  toggleOfflineQueue(e) {
    this.setData({ ['settings.reliability.enableOfflineQueue']: e.detail.value })
  },

  toggleSubscriptionEnabled(e) {
    this.setData({ ['settings.subscription.enabled']: e.detail.value })
  },

  subscriptionTemplateInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`settings.subscription.templates.${field}`]: e.detail.value })
  },

  homePageInput(e) {
    const field = e.currentTarget.dataset.field
    this.setData({ [`settings.homePage.${field}`]: e.detail.value })
  },

  toggleHomeModule(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ [`settings.homePage.modules.${key}`]: e.detail.value })
  },

  trainingPassScoreInput(e) {
    const passScore = Math.min(Math.max(Math.round(Number(e.detail.value || 80)), 1), 100)
    this.setData({ ['settings.staffTraining.passScore']: passScore })
  },

  trainingAuditGuideInput(e) {
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    this.setData({ [`settings.staffTraining.videoAuditGuide.${field}`]: value })
  },

  addQuizQuestion() {
    const quiz = [...(this.data.settings.staffTraining.quiz || [])]
    quiz.push(createEmptyQuizQuestion())
    this.setData({ ['settings.staffTraining.quiz']: quiz })
  },

  deleteQuizQuestion(e) {
    const index = Number(e.currentTarget.dataset.index)
    const quiz = [...(this.data.settings.staffTraining.quiz || [])]
    if (quiz.length <= 1) {
      wx.showToast({ title: '至少保留 1 道题', icon: 'none' })
      return
    }
    quiz.splice(index, 1)
    this.setData({ ['settings.staffTraining.quiz']: quiz })
  },

  quizQuestionInput(e) {
    const index = Number(e.currentTarget.dataset.index)
    this.setData({ [`settings.staffTraining.quiz[${index}].question`]: e.detail.value })
  },

  quizOptionInput(e) {
    const questionIndex = Number(e.currentTarget.dataset.questionIndex)
    const optionIndex = Number(e.currentTarget.dataset.optionIndex)
    this.setData({ [`settings.staffTraining.quiz[${questionIndex}].options[${optionIndex}].label`]: e.detail.value })
  },

  quizAnswerChange(e) {
    const index = Number(e.currentTarget.dataset.index)
    this.setData({ [`settings.staffTraining.quiz[${index}].answer`]: e.detail.value })
  },

  addQuizOption(e) {
    const index = Number(e.currentTarget.dataset.index)
    const quiz = [...(this.data.settings.staffTraining.quiz || [])]
    const question = quiz[index]
    if (!question) return
    const options = [...(question.options || [])]
    if (options.length >= quizOptionValues.length) {
      wx.showToast({ title: '最多 6 个选项', icon: 'none' })
      return
    }
    options.push({ value: quizOptionValues[options.length], label: '' })
    quiz[index] = { ...question, options }
    this.setData({ ['settings.staffTraining.quiz']: quiz })
  },

  deleteQuizOption(e) {
    const questionIndex = Number(e.currentTarget.dataset.questionIndex)
    const optionIndex = Number(e.currentTarget.dataset.optionIndex)
    const quiz = [...(this.data.settings.staffTraining.quiz || [])]
    const question = quiz[questionIndex]
    if (!question) return
    const options = [...(question.options || [])]
    if (options.length <= 2) {
      wx.showToast({ title: '至少保留 2 个选项', icon: 'none' })
      return
    }
    options.splice(optionIndex, 1)
    const normalizedOptions = options.map((option, index) => ({ ...option, value: quizOptionValues[index] }))
    const answer = normalizedOptions.some((option) => option.value === question.answer) ? question.answer : normalizedOptions[0].value
    quiz[questionIndex] = { ...question, options: normalizedOptions, answer }
    this.setData({ ['settings.staffTraining.quiz']: quiz })
  },

  addTrainingVideo() {
    const videos = [...(this.data.settings.staffTraining.videos || [])]
    videos.push(createEmptyTrainingVideo(videos.length))
    this.setData({ ['settings.staffTraining.videos']: videos })
  },

  deleteTrainingVideo(e) {
    const index = Number(e.currentTarget.dataset.index)
    const videos = [...(this.data.settings.staffTraining.videos || [])]
    videos.splice(index, 1)
    this.setData({ ['settings.staffTraining.videos']: videos })
  },

  trainingVideoInput(e) {
    const index = Number(e.currentTarget.dataset.index)
    const field = e.currentTarget.dataset.field
    let value = e.detail.value
    if (field === 'sort') value = Number(value) || 0
    this.setData({ [`settings.staffTraining.videos[${index}].${field}`]: value })
  },

  toggleTrainingVideoEnabled(e) {
    const index = Number(e.currentTarget.dataset.index)
    this.setData({ [`settings.staffTraining.videos[${index}].enabled`]: e.detail.value })
  },

  chooseTrainingVideoFile(e) {
    if (this.data.uploadingTrainingVideo || this.data.uploadingTrainingPoster) return
    const index = Number(e.currentTarget.dataset.index)
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      maxDuration: 600,
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file || !file.tempFilePath) return
        if (file.size && file.size > 200 * 1024 * 1024) {
          wx.showModal({ title: '视频过大', content: `当前压缩后大小约 ${formatFileSize(file.size)}，培训视频不能超过 200MB，请继续压缩后再上传。`, showCancel: false })
          return
        }
        const filePath = file.tempFilePath
        const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.mp4'
        const cloudPath = `staff_training/videos/${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`
        this.setData({ uploadingTrainingVideo: true })
        wx.showLoading({ title: '上传视频...' })
        wx.cloud.uploadFile({
          cloudPath,
          filePath,
          success: (upload) => {
            const fileId = upload.fileID
            wx.cloud.getTempFileURL({
              fileList: [fileId],
              complete: (tempRes) => {
                wx.hideLoading()
                const fileInfo = tempRes && tempRes.fileList && tempRes.fileList[0]
                const url = (fileInfo && fileInfo.tempFileURL) || filePath
                const current = (this.data.settings.staffTraining.videos || [])[index] || {}
                this.setData({
                  [`settings.staffTraining.videos[${index}]`]: { ...current, fileId, tempUrl: url },
                  uploadingTrainingVideo: false
                })
                wx.showToast({ title: '视频上传成功' })
              }
            })
          },
          fail: (err) => {
            wx.hideLoading()
            this.setData({ uploadingTrainingVideo: false })
            wx.showModal({ title: '上传失败', content: getUploadErrorMessage(err, '培训视频', '200MB'), showCancel: false })
          }
        })
      },
      fail: (err) => {
        const errMsg = (err && err.errMsg) || ''
        if (errMsg.includes('cancel')) return
        wx.showModal({ title: '选择失败', content: getUploadErrorMessage(err, '培训视频', '200MB'), showCancel: false })
      }
    })
  },

  chooseTrainingPosterFile(e) {
    if (this.data.uploadingTrainingVideo || this.data.uploadingTrainingPoster) return
    const index = Number(e.currentTarget.dataset.index)
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file || !file.tempFilePath) return
        if (file.size && file.size > 10 * 1024 * 1024) {
          wx.showModal({ title: '封面过大', content: `当前压缩后大小约 ${formatFileSize(file.size)}，封面图片不能超过 10MB，请继续压缩后再上传。`, showCancel: false })
          return
        }
        const filePath = file.tempFilePath
        const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
        const cloudPath = `staff_training/posters/${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`
        this.setData({ uploadingTrainingPoster: true })
        wx.showLoading({ title: '上传封面...' })
        wx.cloud.uploadFile({
          cloudPath,
          filePath,
          success: (upload) => {
            const fileId = upload.fileID
            wx.cloud.getTempFileURL({
              fileList: [fileId],
              complete: (tempRes) => {
                wx.hideLoading()
                const fileInfo = tempRes && tempRes.fileList && tempRes.fileList[0]
                const url = (fileInfo && fileInfo.tempFileURL) || filePath
                const current = (this.data.settings.staffTraining.videos || [])[index] || {}
                this.setData({
                  [`settings.staffTraining.videos[${index}]`]: { ...current, posterFileId: fileId, posterTempUrl: url },
                  uploadingTrainingPoster: false
                })
                wx.showToast({ title: '封面上传成功' })
              }
            })
          },
          fail: (err) => {
            wx.hideLoading()
            this.setData({ uploadingTrainingPoster: false })
            wx.showModal({ title: '上传失败', content: getUploadErrorMessage(err, '视频封面', '10MB'), showCancel: false })
          }
        })
      },
      fail: (err) => {
        const errMsg = (err && err.errMsg) || ''
        if (errMsg.includes('cancel')) return
        wx.showModal({ title: '选择失败', content: getUploadErrorMessage(err, '视频封面', '10MB'), showCancel: false })
      }
    })
  },

  startAddItem() {
    const items = this.data.settings.homeHeroCarousel.items || []
    if (items.length >= 5) {
      wx.showToast({ title: '最多支持添加 5 个轮播素材', icon: 'none' })
      return
    }
    const nextSort = (items.length + 1) * 10
    const newItem = createEmptyItem()
    newItem.sort = nextSort
    this.setData({
      editingIndex: -1,
      editingItem: newItem,
      selectedLinkPresetIndex: 0,
      showCarouselEditor: true
    })
  },

  startEditItem(e) {
    const index = Number(e.currentTarget.dataset.index)
    const items = this.data.settings.homeHeroCarousel.items || []
    const item = items[index]
    if (item) {
      const presetIdx = getLinkPresetIndex(item.linkUrl, item.linkType)
      this.setData({
        editingIndex: index,
        editingItem: {
          ...item,
          linkType: item.linkType || (item.linkUrl ? 'custom' : 'none'),
          linkUrl: item.linkUrl || '',
          linkTitle: item.linkTitle || ''
        },
        selectedLinkPresetIndex: presetIdx,
        showCarouselEditor: true
      })
    }
  },

  cancelEditItem() {
    this.setData({
      editingIndex: -1,
      editingItem: createEmptyItem(),
      selectedLinkPresetIndex: 0,
      showCarouselEditor: false
    })
  },

  onLinkPresetChange(e) {
    const index = Number(e.detail.value) || 0
    const preset = CAROUSEL_LINK_PRESETS[index] || CAROUSEL_LINK_PRESETS[0]
    const currentItem = this.data.editingItem || {}
    const updates = {
      selectedLinkPresetIndex: index,
      ['editingItem.linkType']: preset.value
    }
    if (preset.value === 'none') {
      updates['editingItem.linkUrl'] = ''
      updates['editingItem.linkTitle'] = ''
    } else if (preset.value !== 'custom') {
      updates['editingItem.linkUrl'] = preset.url
      if (!currentItem.linkTitle || CAROUSEL_LINK_PRESETS.some((p) => p.title === currentItem.linkTitle)) {
        updates['editingItem.linkTitle'] = preset.title
      }
    } else {
      if (!currentItem.linkTitle) {
        updates['editingItem.linkTitle'] = '查看详情'
      }
    }
    this.setData(updates)
  },

  editingLinkUrlInput(e) {
    const value = e.detail.value
    const presetIdx = getLinkPresetIndex(value, this.data.editingItem.linkType)
    this.setData({
      ['editingItem.linkUrl']: value,
      selectedLinkPresetIndex: presetIdx
    })
  },

  typeChange(e) {
    const type = e.detail.value === 'video' ? 'video' : 'image'
    this.setData({
      ['editingItem.type']: type,
      ['editingItem.fileId']: '',
      ['editingItem.tempUrl']: ''
    })
  },

  editingInput(e) {
    const field = e.currentTarget.dataset.field
    let value = e.detail.value
    if (field === 'sort') value = Number(value) || 0
    this.setData({ [`editingItem.${field}`]: value })
  },

  toggleEditingEnabled(e) {
    this.setData({ ['editingItem.enabled']: e.detail.value })
  },

  chooseMediaFile() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image', 'video'],
      maxDuration: 60,
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file || !file.tempFilePath) return

        // 自动识别文件类型
        const isVideo = file.fileType === 'video' || file.tempFilePath.endsWith('.mp4') || file.tempFilePath.endsWith('.mov')
        const detectedType = isVideo ? 'video' : 'image'

        // 50MB 大小检查
        if (file.size && file.size > 50 * 1024 * 1024) {
          wx.showToast({ title: '文件大小不能超过 50MB', icon: 'none' })
          return
        }

        const filePath = file.tempFilePath
        const ext = isVideo ? '.mp4' : (filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg')
        const cloudPath = `hero_banners/${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`

        this.setData({
          uploadingMedia: true,
          ['editingItem.type']: detectedType
        })
        wx.showLoading({ title: '上传中...' })

        wx.cloud.uploadFile({
          cloudPath,
          filePath,
          success: (upload) => {
            const fileId = upload.fileID
            wx.cloud.getTempFileURL({
              fileList: [fileId],
              success: (tempRes) => {
                wx.hideLoading()
                const url = tempRes.fileList && tempRes.fileList[0] ? tempRes.fileList[0].tempFileURL : file.tempFilePath
                this.setData({
                  ['editingItem.fileId']: fileId,
                  ['editingItem.tempUrl']: url,
                  uploadingMedia: false
                })
                wx.showToast({ title: '素材上传成功' })
              },
              fail: () => {
                wx.hideLoading()
                this.setData({
                  ['editingItem.fileId']: fileId,
                  ['editingItem.tempUrl']: file.tempFilePath,
                  uploadingMedia: false
                })
                wx.showToast({ title: '素材上传成功' })
              }
            })
          },
          fail: (err) => {
            wx.hideLoading()
            this.setData({ uploadingMedia: false })
            showError(err)
          }
        })
      },
      fail: (err) => {
        const errMsg = (err && err.errMsg) || ''
        if (errMsg.includes('cancel')) return
        showError(err)
      }
    })
  },

  choosePosterFile() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file || !file.tempFilePath) return
        const filePath = file.tempFilePath
        const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
        const cloudPath = `hero_banners/poster_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`

        this.setData({ uploadingPoster: true })
        wx.showLoading({ title: '上传封面...' })
        wx.cloud.uploadFile({
          cloudPath,
          filePath,
          success: (upload) => {
            const fileId = upload.fileID
            wx.cloud.getTempFileURL({
              fileList: [fileId],
              success: (tempRes) => {
                wx.hideLoading()
                const url = tempRes.fileList && tempRes.fileList[0] ? tempRes.fileList[0].tempFileURL : ''
                this.setData({
                  ['editingItem.posterFileId']: fileId,
                  ['editingItem.posterTempUrl']: url,
                  uploadingPoster: false
                })
                wx.showToast({ title: '封面上传成功' })
              },
              fail: () => {
                wx.hideLoading()
                this.setData({ ['editingItem.posterFileId']: fileId, uploadingPoster: false })
                wx.showToast({ title: '封面上传成功' })
              }
            })
          },
          fail: (err) => {
            wx.hideLoading()
            this.setData({ uploadingPoster: false })
            showError(err)
          }
        })
      }
    })
  },

  saveEditingItem() {
    const item = { ...this.data.editingItem }
    if (!item.fileId) {
      wx.showToast({ title: '请先上传图片或视频', icon: 'none' })
      return
    }
    if (item.type === 'video' && !item.posterFileId) {
      wx.showToast({ title: '视频素材请传一张封面图', icon: 'none' })
      return
    }

    if (item.linkType && item.linkType !== 'none') {
      let cleanUrl = String(item.linkUrl || '').trim()
      if (cleanUrl && !cleanUrl.startsWith('/') && !cleanUrl.startsWith('http')) {
        cleanUrl = `/${cleanUrl}`
      }
      item.linkUrl = cleanUrl
    } else {
      item.linkType = 'none'
      item.linkUrl = ''
      item.linkTitle = ''
    }

    const items = [...(this.data.settings.homeHeroCarousel.items || [])]
    if (this.data.editingIndex >= 0) {
      items[this.data.editingIndex] = item
    } else {
      items.push(item)
    }
    items.sort((a, b) => a.sort - b.sort)

    this.setData({
      ['settings.homeHeroCarousel.items']: items,
      editingIndex: -1,
      editingItem: createEmptyItem(),
      selectedLinkPresetIndex: 0,
      showCarouselEditor: false
    })
    wx.showToast({ title: '素材已暂存，请点击底部“保存设置”' })
  },

  deleteItem(e) {
    const index = Number(e.currentTarget.dataset.index)
    const items = [...(this.data.settings.homeHeroCarousel.items || [])]
    items.splice(index, 1)
    this.setData({
      ['settings.homeHeroCarousel.items']: items,
      editingIndex: -1,
      editingItem: createEmptyItem(),
      showCarouselEditor: false
    })
  },

  toggleItemEnabled(e) {
    const index = Number(e.currentTarget.dataset.index)
    const key = `settings.homeHeroCarousel.items[${index}].enabled`
    this.setData({ [key]: e.detail.value })
  },

  staffPolicyInput(e) {
    this.setData({ [`settings.${e.currentTarget.dataset.field}`]: e.detail.value })
  },

  staffDepositToggle(e) {
    if (e.detail.value && !validAmount(this.data.settings.staffDeposit.amount)) {
      this.setData({ 'settings.staffDeposit.enabled': false })
      return showError(new Error('先设置大于 0、最多两位小数的有效保证金金额，再启用'))
    }
    this.setData({ 'settings.staffDeposit.enabled': e.detail.value })
  },

  policyTextInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value })
  },

  save() {
    if (this.data.saving) return
    if (!this.data.loaded) return showError(new Error('请等待设置加载成功后再保存'))
    const deposit = this.data.settings.staffDeposit
    if (!validAmount(deposit.amount, !deposit.enabled)) return showError(new Error('保证金金额须为有效金额，最多两位小数；启用时必须大于 0'))
    let sceneReportInfos
    try {
      sceneReportInfos = JSON.parse(this.data.sceneReportInfosText)
      if (!Array.isArray(sceneReportInfos) || sceneReportInfos.some((item) => !item || typeof item.info_type !== 'string' || !item.info_type.trim() || typeof item.info_content !== 'string' || !item.info_content.trim())) throw new Error()
    } catch (err) { return showError(new Error('场景报备信息须为 JSON 数组，每项包含非空 info_type 和 info_content')) }
    const transfer = this.data.settings.staffSupplies.transfer
    if (transfer.enabled && (!String(transfer.sceneId).trim() || !String(transfer.userRecvPerception).trim() || !sceneReportInfos.length)) {
      return showError(new Error('启用前请填写商户已获批的真实转账场景、收款感知与对应报备信息'))
    }
    const items = (this.data.settings.staffSupplies.items || []).filter((item) => item.name && String(item.name).trim())
    const requiredItems = items.filter((i) => i.enabled).map((item) => String(item.name).trim())
    if (!requiredItems.length) return showError(new Error('请配置必备一次性用品，必须涵盖手套、口罩、鞋套和宠物安全消毒用品'))
    this.setData({
      'settings.staffDeposit.amount': Number(deposit.amount),
      'settings.staffSupplies.items': items,
      'settings.staffSupplies.requiredItems': requiredItems,
      'settings.staffSupplies.transfer.sceneReportInfos': sceneReportInfos
    })
    if (this.data.uploadingTrainingVideo || this.data.uploadingTrainingPoster) {
      wx.showToast({ title: '请等待培训素材上传完成', icon: 'none' })
      return
    }
    this.setData({ saving: true })

    const carousel = this.data.settings.homeHeroCarousel || {}
    const itemsToSave = (carousel.items || []).map((item) => ({
      ...item,
      id: item.id,
      type: item.type,
      fileId: item.fileId,
      posterFileId: item.posterFileId || '',
      title: item.title || '',
      subtitle: item.subtitle || '',
      linkType: item.linkType || (item.linkUrl ? 'custom' : 'none'),
      linkUrl: String(item.linkUrl || '').trim(),
      linkTitle: String(item.linkTitle || '').trim(),
      enabled: item.enabled !== false,
      sort: Number(item.sort) || 10
    }))

    const checkinShare = this.data.settings.checkinShare || {}
    const staffTraining = this.data.settings.staffTraining || normalizeStaffTrainingConfig()
    const trainingVideos = (staffTraining.videos || []).map((item, index) => ({
      ...item,
      key: item.key || `training_${index + 1}`,
      title: item.title || '',
      description: item.description || '',
      durationText: item.durationText || '',
      fileId: item.fileId || '',
      posterFileId: item.posterFileId || '',
      enabled: item.enabled !== false,
      sort: Number(item.sort) || (index + 1) * 10
    }))
    const payload = {
      ...this.data.settings,
      enableTestAddressMode: this.data.settings.enableTestAddressMode === true,
      enablePetBreedAi: this.data.settings.enablePetBreedAi !== false,
      payment: this.data.settings.payment,
      settlement: this.data.settings.settlement,
      subscription: this.data.settings.subscription,
      reliability: this.data.settings.reliability,
      customerService: this.data.settings.customerService,
      checkinShare: {
        ...checkinShare,
        title: checkinShare.title || '',
        imageUrl: checkinShare.imageUrl || ''
      },
      homePage: this.data.settings.homePage,
      staffTraining: {
        ...staffTraining,
        passScore: staffTraining.passScore,
        quiz: staffTraining.quiz || [],
        videos: trainingVideos,
        videoAuditGuide: staffTraining.videoAuditGuide || {}
      },
      homeHeroCarousel: {
        ...carousel,
        enabled: carousel.enabled === true,
        autoRotate: carousel.autoRotate !== false,
        rotateIntervalMs: Math.max(Number(carousel.rotateIntervalSec || 5), 1) * 1000,
        items: itemsToSave
      }
    }

    callFunction('admin', 'saveSystemSettings', payload)
      .then((settings) => {
        const normalized = {
          ...settings,
          staffDeposit: normalizeStaffDeposit(settings.staffDeposit),
          staffSupplies: normalizeStaffSupplies(settings.staffSupplies),
          enableTestAddressMode: settings.enableTestAddressMode === true,
          enablePetBreedAi: settings.enablePetBreedAi !== false,
          payment: normalizePaymentConfig(settings.payment),
          settlement: normalizeSettlementConfig(settings.settlement),
          subscription: normalizeSubscriptionConfig(settings.subscription),
          reliability: normalizeReliabilityConfig(settings.reliability),
          customerService: normalizeCustomerServiceConfig(settings.customerService),
          checkinShare: normalizeCheckinShareConfig(settings.checkinShare),
          homeHeroCarousel: normalizeCarouselConfig(settings.homeHeroCarousel),
          homePage: normalizeHomePageConfig(settings.homePage),
          staffTraining: normalizeStaffTrainingConfig(settings.staffTraining)
        }
        this.setData({ loaded: true, requiredItemsText: normalized.staffSupplies.requiredItems.join('\n'), sceneReportInfosText: JSON.stringify(normalized.staffSupplies.transfer.sceneReportInfos, null, 2) })
        setCachedSystemSettings(normalized)
        this.setData({ settings: normalized, settingSummary: buildSettingSummary(normalized), saving: false })
        this.resolveMediaUrls(normalized.homeHeroCarousel.items)
        this.resolveTrainingVideoUrls(normalized.staffTraining.videos)
        this.resolveCheckinShareImageUrl(normalized.checkinShare.imageUrl)
        wx.showToast({ title: '设置已保存' })
      })
      .catch((err) => {
        this.setData({ saving: false })
        showError(err)
      })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const pages = getCurrentPages()
    const current = pages[pages.length - 1]
    const currentRoute = current && current.route ? '/' + current.route : ''
    if (currentRoute === url) return
    const mainNavUrls = ['/pages/admin/home/index', '/pages/admin/orders/list/index', '/pages/admin/staff-audit/list/index', '/pages/admin/incidents/list/index', '/pages/admin/coupons/index', '/pages/admin/member-levels/index', '/pages/admin/checkin-config/index', '/pages/admin/points/index', '/pages/admin/settings/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  }
})
