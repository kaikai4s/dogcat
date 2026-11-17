const { callFunction, showError, ensureLogin } = require('../../../../utils/cloud')
const { applyTheme, getThemeState } = require('../../../../utils/theme')
const { applyFont, getFontState } = require('../../../../utils/font')
const { safeNavigateTo } = require('../../../../utils/nav')

const SERVICE_ICON_MAP = {
  walk: 'ri-footprint-fill',
  feed: 'ri-restaurant-fill',
  clean: 'ri-sparkling-fill',
  litter: 'ri-delete-bin-fill',
  play: 'ri-gamepad-fill',
  medicine: 'ri-capsule-fill',
  visit_fee: 'ri-map-pin-2-fill'
}

const STEP_ICON_MAP = {
  sanitization: 'ri-shield-check-fill',
  enter_door: 'ri-home-5-fill',
  leash_on: 'ri-footprint-fill',
  feed: 'ri-restaurant-fill',
  water: 'ri-heart-3-fill',
  clean: 'ri-sparkling-fill',
  medicine: 'ri-capsule-fill',
  pet_status: 'ri-heart-pulse-fill',
  return_home: 'ri-home-5-fill',
  leave_door: 'ri-door-lock-fill',
  video_checkin: 'ri-camera-lens-fill',
  pet_beauty_photo: 'ri-camera-lens-fill'
}

function resolveCloudUrls(fileIds = []) {
  const uniqueIds = Array.from(new Set((fileIds || []).filter((id) => typeof id === 'string' && id.startsWith('cloud://'))))
  if (!uniqueIds.length || typeof wx === 'undefined' || !wx.cloud || typeof wx.cloud.getTempFileURL !== 'function') {
    return Promise.resolve({})
  }
  return new Promise((resolve) => {
    wx.cloud.getTempFileURL({
      fileList: uniqueIds,
      success: (res) => {
        const map = {}
        ;(res.fileList || []).forEach((item) => {
          if (item && item.fileID && item.tempFileURL) {
            map[item.fileID] = item.tempFileURL
          }
        })
        resolve(map)
      },
      fail: () => resolve({})
    })
  })
}

function buildFeeRules(service = {}, visitFeePrice = 0) {
  const rules = []
  const price = Number(service.price || 0)
  const internPrice = Number(service.internPrice !== undefined ? service.internPrice : price)
  if (internPrice >= 0 && internPrice !== price) {
    rules.push({ label: '实习宠托师', value: `¥${internPrice}起` })
  }
  const extraPetFee = Number(service.extraPetFee || 0)
  if (service.extraPetRule === 'dog') {
    rules.push({ label: '多宠加收', value: extraPetFee > 0 ? `每多一只狗狗 +¥${extraPetFee}` : '不额外加收' })
  } else if (service.extraPetRule === 'all') {
    rules.push({ label: '多宠加收', value: extraPetFee > 0 ? `每多一只宠物 +¥${extraPetFee}` : '不额外加收' })
  } else {
    rules.push({ label: '多宠说明', value: '不额外加收多宠费用' })
  }
  const extraHalfHourFee = Number(service.extraHalfHourFee || 0)
  if (extraHalfHourFee > 0) {
    rules.push({ label: '加时费用', value: `每 30 分钟 +¥${extraHalfHourFee}` })
  }
  if (Number(visitFeePrice || 0) > 0) {
    rules.push({ label: '上门保障费', value: `每次上门 ¥${visitFeePrice}（订单固定包含）` })
  }
  return rules
}

Page({
  data: {
    themeClass: 'theme-day',
    fontClass: 'font-system',
    key: '',
    loading: true,
    errorText: '',
    service: null,
    serviceIcon: 'ri-price-tag-3-fill',
    coverUrl: '',
    feeRules: [],
    flowSteps: [],
    caseImageUrls: [],
    cases: [],
    maintenance: {},
    navigatingOrder: false
  },

  onLoad(options = {}) {
    const key = String(options.key || options.serviceType || '').trim()
    this.setData({ key })
    this.applyAppearance()
    if (!key) {
      this.setData({ loading: false, errorText: '未指定服务项目' })
      return
    }
    this.loadDetail()
  },

  onShow() {
    this._isPageActive = true
    this.applyAppearance()
  },

  onHide() {
    this._isPageActive = false
  },

  onUnload() {
    this._isPageActive = false
    clearTimeout(this._navTimer)
  },

  onPullDownRefresh() {
    this.loadDetail().finally(() => {
      if (typeof wx.stopPullDownRefresh === 'function') {
        wx.stopPullDownRefresh()
      }
    })
  },

  applyAppearance() {
    const theme = applyTheme()
    const font = applyFont()
    this.setData({
      ...getThemeState(theme.value),
      ...getFontState(font.value)
    })
  },

  loadDetail() {
    const key = this.data.key
    if (!key) return Promise.resolve()
    const requestSeq = (this._requestSeq || 0) + 1
    this._requestSeq = requestSeq
    this.setData({ loading: true, errorText: '' })

    const detailPromise = callFunction('system', 'getPublicServiceDetail', { key })
    const casesPromise = callFunction('order', 'listPublicCompletedOrders', { serviceType: key, page: 1, pageSize: 6 })
      .catch(() => ({ list: [] }))

    return Promise.all([detailPromise, casesPromise])
      .then(([detailRes, casesRes]) => {
        if (requestSeq !== this._requestSeq) return
        const service = (detailRes && detailRes.service) || null
        if (!service) {
          this.setData({ loading: false, errorText: '服务项目不存在或已下架' })
          return
        }
        const rawCaseIds = Array.isArray(service.caseImageFileIds) ? service.caseImageFileIds.filter(Boolean) : []
        const rawCover = (typeof service.coverUrl === 'string' && !service.coverUrl.startsWith('/images/services/')) ? service.coverUrl : ''
        const flowSteps = ((detailRes && detailRes.flowSteps) || []).map((step) => ({
          ...step,
          icon: STEP_ICON_MAP[step.eventType] || 'ri-checkbox-circle-fill'
        }))
        const caseList = Array.isArray(casesRes) ? casesRes : ((casesRes && casesRes.list) || [])
        const detailText = String(service.detailDescription || service.description || '').trim()

        this.setData({
          loading: false,
          service: {
            ...service,
            detailText
          },
          serviceIcon: SERVICE_ICON_MAP[service.key] || 'ri-price-tag-3-fill',
          coverUrl: rawCover,
          feeRules: buildFeeRules(service, detailRes && detailRes.visitFeePrice),
          flowSteps,
          caseImageUrls: rawCaseIds,
          cases: caseList,
          maintenance: (detailRes && detailRes.maintenance) || {}
        })
        if (service.label && typeof wx.setNavigationBarTitle === 'function') {
          wx.setNavigationBarTitle({ title: service.label })
        }

        const cloudIds = [rawCover].concat(rawCaseIds).filter((id) => id && id.startsWith('cloud://'))
        if (cloudIds.length) {
          resolveCloudUrls(cloudIds).then((urlMap) => {
            if (requestSeq !== this._requestSeq) return
            this.setData({
              coverUrl: (rawCover && urlMap[rawCover]) || rawCover,
              caseImageUrls: rawCaseIds.map((id) => urlMap[id] || id)
            })
          })
        }
      })
      .catch((error) => {
        if (requestSeq !== this._requestSeq) return
        this.setData({
          loading: false,
          errorText: (error && error.message) || '加载服务详情失败'
        })
        showError(error)
      })
  },

  previewCover() {
    const url = this.data.coverUrl
    if (!url) return
    wx.previewImage({ current: url, urls: [url] })
  },

  previewCaseImage(e) {
    const url = e.currentTarget.dataset.url
    const urls = this.data.caseImageUrls || []
    if (!url) return
    wx.previewImage({ current: url, urls: urls.length ? urls : [url] })
  },

  previewOrderPhoto(e) {
    const url = e.currentTarget.dataset.url
    const orderId = e.currentTarget.dataset.orderId
    if (!url) return
    const order = (this.data.cases || []).find((item) => item._id === orderId)
    let urls = []
    if (order) {
      if (Array.isArray(order.allCheckinPhotos) && order.allCheckinPhotos.length) {
        urls = order.allCheckinPhotos.map((item) => item.mediaFileId).filter(Boolean)
      } else if (Array.isArray(order.checkinPhotos) && order.checkinPhotos.length) {
        urls = order.checkinPhotos.map((item) => item.mediaFileId).filter(Boolean)
      }
    }
    wx.previewImage({ current: url, urls: urls.length ? urls : [url] })
  },

  openPublicOrderDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/client/orders/public-detail/index?id=${id}` })
  },

  openAllCases() {
    wx.navigateTo({ url: '/pages/client/orders/public-list/index' })
  },

  goOrder() {
    if (this.data.navigatingOrder || !this.data.key) return
    if (this.data.maintenance && this.data.maintenance.booking === true) {
      wx.showModal({ title: '功能维护', content: '预约下单功能暂时不可使用，正在维护中', showCancel: false })
      return
    }
    this.setData({ navigatingOrder: true })
    clearTimeout(this._navTimer)
    this._navTimer = setTimeout(() => {
      this.setData({ navigatingOrder: false })
    }, 1500)

    const targetUrl = `/pages/client/orders/create/index?serviceType=${encodeURIComponent(this.data.key)}`
    return ensureLogin({
      content: '登录后可预约服务、管理宠物、查看订单和消息。',
      isActive: () => this._isPageActive !== false
    })
      .then(() => {
        return new Promise((resolve, reject) => {
          safeNavigateTo({
            url: targetUrl,
            success: resolve,
            fail: reject
          })
        })
      }, () => {})
      .catch((err) => {
        showError(err)
      })
      .finally(() => {
        clearTimeout(this._navTimer)
        this.setData({ navigatingOrder: false })
      })
  }
})
