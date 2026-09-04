const { callFunction, showError, setCachedSystemSettings } = require('../../../utils/cloud')

function createEmptyItem() {
  return {
    id: `hero_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type: 'image',
    fileId: '',
    posterFileId: '',
    title: '',
    subtitle: '',
    enabled: true,
    sort: 10,
    tempUrl: '',
    posterTempUrl: ''
  }
}

function normalizePaymentConfig(payment = {}) {
  return {
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
    staffCommissionRate: Number(settlement.staffCommissionRate || 0.7),
    settlementDelayDays: Number(settlement.settlementDelayDays || 1),
    minWithdrawAmount: Number(settlement.minWithdrawAmount || 10),
    withdrawFeeRate: Number(settlement.withdrawFeeRate || 0)
  }
}

function normalizeSubscriptionConfig(subscription = {}) {
  const templates = subscription.templates || {}
  return {
    enabled: subscription.enabled === true,
    templates: {
      orderPaid: templates.orderPaid || '',
      orderAssigned: templates.orderAssigned || '',
      orderAccepted: templates.orderAccepted || '',
      serviceStart: templates.serviceStart || '',
      serviceFinish: templates.serviceFinish || '',
      remoteUnlock: templates.remoteUnlock || '',
      refundResult: templates.refundResult || '',
      disputeUpdate: templates.disputeUpdate || '',
      withdrawResult: templates.withdrawResult || ''
    }
  }
}

function normalizeReliabilityConfig(reliability = {}) {
  return {
    enableOfflineQueue: reliability.enableOfflineQueue !== false,
    maxTrackBatchSize: Number(reliability.maxTrackBatchSize || 50),
    maxRetryTimes: Number(reliability.maxRetryTimes || 5)
  }
}

function normalizeCustomerServiceConfig(customerService = {}) {
  return {
    phone: customerService.phone || '',
    wechatId: customerService.wechatId || '',
    workHours: customerService.workHours || '每天 9:00-21:00',
    officialAccountName: customerService.officialAccountName || ''
  }
}

function normalizeCheckinShareConfig(checkinShare = {}) {
  return {
    title: checkinShare.title || '来签到领福利，补签卡也能拿',
    imageUrl: checkinShare.imageUrl || '',
    imageTempUrl: checkinShare.imageUrl && /^https?:\/\//.test(checkinShare.imageUrl) ? checkinShare.imageUrl : ''
  }
}

function normalizeCarouselConfig(carousel = {}) {
  const source = carousel || {}
  const rotateIntervalMs = Number(source.rotateIntervalMs || 5000)
  const rotateIntervalSec = Math.max(Math.round(rotateIntervalMs / 1000), 1)
  const items = Array.isArray(source.items) ? source.items : []
  const normalizedItems = items.map((item, index) => ({
    id: item.id || `hero_${Date.now()}_${index}`,
    type: item.type === 'video' ? 'video' : 'image',
    fileId: item.fileId || '',
    posterFileId: item.posterFileId || '',
    title: item.title || '',
    subtitle: item.subtitle || '',
    enabled: item.enabled !== false,
    sort: Number(item.sort) || (index + 1) * 10,
    tempUrl: '',
    posterTempUrl: ''
  })).sort((a, b) => a.sort - b.sort)

  return {
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
    ctaTitle: homePage.ctaTitle || '立即预约上门宠护',
    ctaSubtitle: homePage.ctaSubtitle || '填写宠物和服务时间，平台认证宠托师快速响应。',
    ctaText: homePage.ctaText || '立即预约',
    nearbyTitle: homePage.nearbyTitle || '附近宠托师',
    repeatTitle: homePage.repeatTitle || '再次预约',
    couponTitle: homePage.couponTitle || '新人优惠',
    assuranceTitle: homePage.assuranceTitle || '平台保障',
    modules: homeModuleOptions.reduce((result, item) => ({ ...result, [item.key]: modules[item.key] !== false }), {})
  }
}

Page({
  data: {
    settings: {
      enableTestAddressMode: false,
      payment: normalizePaymentConfig(),
      settlement: normalizeSettlementConfig(),
      subscription: normalizeSubscriptionConfig(),
      reliability: normalizeReliabilityConfig(),
      customerService: normalizeCustomerServiceConfig(),
      checkinShare: normalizeCheckinShareConfig(),
      homeHeroCarousel: normalizeCarouselConfig(),
      homePage: normalizeHomePageConfig()
    },
    homeModuleOptions,
    editingIndex: -1,
    editingItem: createEmptyItem(),
    uploadingMedia: false,
    uploadingPoster: false,
    uploadingCheckinShareImage: false,
    saving: false
  },

  onShow() {
    this.load()
  },

  load() {
    callFunction('admin', 'getSystemSettings')
      .then((settings) => {
        const normalized = {
          enableTestAddressMode: settings.enableTestAddressMode === true,
          payment: normalizePaymentConfig(settings.payment),
          settlement: normalizeSettlementConfig(settings.settlement),
          subscription: normalizeSubscriptionConfig(settings.subscription),
          reliability: normalizeReliabilityConfig(settings.reliability),
          customerService: normalizeCustomerServiceConfig(settings.customerService),
          checkinShare: normalizeCheckinShareConfig(settings.checkinShare),
          homeHeroCarousel: normalizeCarouselConfig(settings.homeHeroCarousel),
          homePage: normalizeHomePageConfig(settings.homePage)
        }
        setCachedSystemSettings(normalized)
        this.setData({ settings: normalized }, () => {
          this.resolveMediaUrls(normalized.homeHeroCarousel.items)
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

  toggleTestAddressMode(e) {
    this.setData({ ['settings.enableTestAddressMode']: e.detail.value })
  },

  toggleCarouselEnabled(e) {
    this.setData({ ['settings.homeHeroCarousel.enabled']: e.detail.value })
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
      editingItem: newItem
    })
  },

  startEditItem(e) {
    const index = Number(e.currentTarget.dataset.index)
    const items = this.data.settings.homeHeroCarousel.items || []
    if (items[index]) {
      this.setData({
        editingIndex: index,
        editingItem: { ...items[index] }
      })
    }
  },

  cancelEditItem() {
    this.setData({
      editingIndex: -1,
      editingItem: createEmptyItem()
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
    const item = this.data.editingItem
    if (!item.fileId) {
      wx.showToast({ title: '请先上传图片或视频', icon: 'none' })
      return
    }
    if (item.type === 'video' && !item.posterFileId) {
      wx.showToast({ title: '视频素材请传一张封面图', icon: 'none' })
      return
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
      editingItem: createEmptyItem()
    })
    wx.showToast({ title: '素材已提交到当前列表，请点击底部“保存设置”' })
  },

  deleteItem(e) {
    const index = Number(e.currentTarget.dataset.index)
    const items = [...(this.data.settings.homeHeroCarousel.items || [])]
    items.splice(index, 1)
    this.setData({
      ['settings.homeHeroCarousel.items']: items,
      editingIndex: -1,
      editingItem: createEmptyItem()
    })
  },

  toggleItemEnabled(e) {
    const index = Number(e.currentTarget.dataset.index)
    const key = `settings.homeHeroCarousel.items[${index}].enabled`
    this.setData({ [key]: e.detail.value })
  },

  save() {
    if (this.data.saving) return
    this.setData({ saving: true })

    const carousel = this.data.settings.homeHeroCarousel || {}
    const itemsToSave = (carousel.items || []).map((item) => ({
      id: item.id,
      type: item.type,
      fileId: item.fileId,
      posterFileId: item.posterFileId || '',
      title: item.title || '',
      subtitle: item.subtitle || '',
      enabled: item.enabled !== false,
      sort: Number(item.sort) || 10
    }))

    const checkinShare = this.data.settings.checkinShare || {}
    const payload = {
      enableTestAddressMode: this.data.settings.enableTestAddressMode === true,
      payment: this.data.settings.payment,
      settlement: this.data.settings.settlement,
      subscription: this.data.settings.subscription,
      reliability: this.data.settings.reliability,
      customerService: this.data.settings.customerService,
      checkinShare: {
        title: checkinShare.title || '',
        imageUrl: checkinShare.imageUrl || ''
      },
      homePage: this.data.settings.homePage,
      homeHeroCarousel: {
        enabled: carousel.enabled === true,
        autoRotate: carousel.autoRotate !== false,
        rotateIntervalMs: Math.max(Number(carousel.rotateIntervalSec || 5), 1) * 1000,
        items: itemsToSave
      }
    }

    callFunction('admin', 'saveSystemSettings', payload)
      .then((settings) => {
        const normalized = {
          enableTestAddressMode: settings.enableTestAddressMode === true,
          payment: normalizePaymentConfig(settings.payment),
          settlement: normalizeSettlementConfig(settings.settlement),
          subscription: normalizeSubscriptionConfig(settings.subscription),
          reliability: normalizeReliabilityConfig(settings.reliability),
          customerService: normalizeCustomerServiceConfig(settings.customerService),
          checkinShare: normalizeCheckinShareConfig(settings.checkinShare),
          homeHeroCarousel: normalizeCarouselConfig(settings.homeHeroCarousel),
          homePage: normalizeHomePageConfig(settings.homePage)
        }
        setCachedSystemSettings(normalized)
        this.setData({ settings: normalized, saving: false })
        this.resolveMediaUrls(normalized.homeHeroCarousel.items)
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
    wx.navigateTo({ url })
  }
})
