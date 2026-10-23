const { uploadImage } = require('../../../utils/image-upload')
const { callFunction, showError, chooseSelectedLocation } = require('../../../utils/cloud')
const { withAuditText, withStaffWorkflowText } = require('../../../utils/format')
const { applyTheme, getThemeState } = require('../../../utils/theme')
const { loadMessageUnread } = require('../../../utils/client-nav')

const { createPageNav, navMethods } = require('../../../utils/nav')

const statusText = {
  pending: '资料已提交，等待平台审核',
  approved: '资料审核已通过，请前往培训中心查看保证金及后续认证要求',
  rejected: '审核未通过，请修改资料后重新提交'
}

const radiusOptions = [
  { label: '3公里', value: 3 },
  { label: '5公里', value: 5 },
  { label: '10公里', value: 10 },
  { label: '15公里', value: 15 },
  { label: '20公里', value: 20 }
]

function uploadIdentityFile(filePath, type) {
  const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
  return new Promise((resolve, reject) => {
    uploadImage({
      cloudPath: `staff_identity/${type}_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`,
      filePath,
      success: (res) => resolve(res.fileID),
      fail: reject
    })
  })
}

function validateIdCardLocal(idCard) {
  if (!idCard || typeof idCard !== 'string') return false
  const id = idCard.trim().toUpperCase()
  if (!/^\d{17}[\dX]$/.test(id)) return false
  const year = parseInt(id.substring(6, 10), 10)
  const month = parseInt(id.substring(10, 12), 10)
  const day = parseInt(id.substring(12, 14), 10)
  const currentYear = new Date().getFullYear()
  if (year < 1900 || year > currentYear) return false
  if (month < 1 || month > 12) return false
  const maxDays = new Date(year, month, 0).getDate()
  if (day < 1 || day > maxDays) return false
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const checkCodes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  let sum = 0
  for (let i = 0; i < 17; i++) {
    sum += parseInt(id[i], 10) * weights[i]
  }
  return id[17] === checkCodes[sum % 11]
}

Page({
  data: {
    themeClass: 'theme-day',
    form: {
      realName: '',
      gender: '',
      idCardNumber: '',
      phone: '',
      serviceCity: '',
      serviceAreas: '',
      serviceAddress: '',
      serviceLatitude: 0,
      serviceLongitude: 0,
      serviceRadiusKm: 5,
      idCardFrontFileId: '',
      idCardBackFileId: '',
      facePhotoFileId: '',
      zhimaScore: '',
      zhimaScoreFileId: '',
      alipayProfileFileId: ''
    },
    identityPreviews: {
      idCardFrontFileId: '',
      idCardBackFileId: '',
      facePhotoFileId: '',
      zhimaScoreFileId: '',
      alipayProfileFileId: ''
    },
    radiusOptions,
    profile: null,
    zhimaConfig: null,
    statusTip: '',
    isApproved: false,
    isSubmittedApplication: false,
    certificationLocked: false,
    canGoBack: false,
    messageUnreadCount: 0,
    messageHasUnread: false
  },

  onLoad(q) {
    this.setData(createPageNav(q))
  },

  ...navMethods(),

  onShow() {
    this.applyCurrentTheme()
    loadMessageUnread(this, 'staff')
    callFunction('staff', 'getStaffCertificationConfig')
      .then((cfg) => {
        if (cfg && cfg.zhima) {
          this.setData({ zhimaConfig: cfg.zhima })
        }
      })
      .catch(() => {})
    callFunction('staff', 'getStaffProfile')
      .then((profile) => {
        if (!profile) return
        const zhimaScore = profile.zhimaScore || (profile.zhimaCredit && profile.zhimaCredit.score) || this.data.form.zhimaScore || ''
        const zhimaScoreFileId = profile.zhimaScoreFileId || (profile.zhimaCredit && profile.zhimaCredit.scoreFileId) || this.data.form.zhimaScoreFileId || ''
        const alipayProfileFileId = profile.alipayProfileFileId || (profile.zhimaCredit && profile.zhimaCredit.profileFileId) || this.data.form.alipayProfileFileId || ''
        this.setData({
          profile: withStaffWorkflowText(withAuditText(profile)),
          zhimaConfig: profile.zhimaConfig || this.data.zhimaConfig,
          form: {
            ...this.data.form,
            ...profile,
            idCardNumber: profile.idCardNumber || profile.idCardMasked || this.data.form.idCardNumber || '',
            serviceRadiusKm: Number(profile.serviceRadiusKm || 5),
            serviceLatitude: Number(profile.serviceLatitude || 0),
            serviceLongitude: Number(profile.serviceLongitude || 0),
            zhimaScore,
            zhimaScoreFileId,
            alipayProfileFileId
          },
          identityPreviews: {
            idCardFrontFileId: profile.idCardFrontFileId || '',
            idCardBackFileId: profile.idCardBackFileId || '',
            facePhotoFileId: profile.facePhotoFileId || '',
            zhimaScoreFileId,
            alipayProfileFileId
          },
          statusTip: profile.auditRemark || statusText[profile.auditStatus] || '',
          isApproved: profile.auditStatus === 'approved',
          isSubmittedApplication: ['pending', 'rejected'].includes(profile.auditStatus),
          certificationLocked: profile.certificationLocked === true || profile.auditStatus === 'approved'
        })
      })
      .catch(showError)
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  input(e) {
    if (this.data.certificationLocked) return
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  chooseAddress() {
    if (this.data.certificationLocked) return
    chooseSelectedLocation()
      .then((loc) => {
        this.setData({
          ['form.serviceAddress']: loc.name || loc.address || '',
          ['form.serviceLatitude']: loc.latitude,
          ['form.serviceLongitude']: loc.longitude
        })
      })
      .catch((err) => {
        if (err && err.errMsg && err.errMsg.includes('cancel')) return
        showError(err)
      })
  },

  selectRadius(e) {
    if (this.data.certificationLocked) return
    const radius = Number(e.currentTarget.dataset.radius || 5)
    this.setData({ ['form.serviceRadiusKm']: radius })
  },

  chooseIdentityPhoto(e) {
    if (this.data.certificationLocked) return
    const field = e.currentTarget.dataset.field
    if (!field) return
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const filePath = res.tempFiles[0].tempFilePath
        this.setData({ [`identityPreviews.${field}`]: filePath })
        wx.showLoading({ title: '上传中...' })
        uploadIdentityFile(filePath, field)
          .then((fileId) => {
            wx.hideLoading()
            this.setData({ ['form.' + field]: fileId, [`identityPreviews.${field}`]: fileId })
          })
          .catch((error) => {
            wx.hideLoading()
            showError(error)
          })
      }
    })
  },

  inputIdCard(e) {
    if (this.data.certificationLocked) return
    const val = (e.detail.value || '').toUpperCase().trim()
    this.setData({ 'form.idCardNumber': val })
  },

  chooseGender(e) {
    if (this.data.certificationLocked) return
    const gender = e.detail.value
    if (gender === 'male' || gender === 'female') this.setData({ 'form.gender': gender })
  },

  inputZhimaScore(e) {
    if (this.data.certificationLocked) return
    const val = (e.detail.value || '').trim()
    this.setData({ 'form.zhimaScore': val })
  },

  previewTemplate(e) {
    const url = e.currentTarget.dataset.url
    if (url) {
      wx.previewImage({ urls: [url] })
    }
  },

  previewIdentity(e) {
    const url = e.currentTarget.dataset.url
    if (url) {
      wx.previewImage({ urls: [url] })
    }
  },

  cancelApplication() {
    if (!this.data.isSubmittedApplication || this.data.isApproved) return
    wx.showModal({
      title: '取消入驻申请',
      content: '取消后将删除已提交的入驻申请和审核材料记录。如需入驻，可以重新填写并提交。',
      confirmText: '确认取消',
      confirmColor: '#ef4444',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '取消中...', mask: true })
        callFunction('staff', 'cancelStaffProfileApplication', {})
          .then(() => {
            wx.hideLoading()
            this.setData({
              profile: null,
              statusTip: '',
              isSubmittedApplication: false,
              isApproved: false,
              certificationLocked: false
            })
            wx.showToast({ title: '已取消申请', icon: 'success' })
          })
          .catch((err) => {
            wx.hideLoading()
            showError(err)
          })
      }
    })
  },

  submit() {
    if (this.data.isApproved) {
      wx.navigateTo({ url: '/pages/staff/training/index' })
      return
    }
    if (this.data.certificationLocked) {
      wx.showToast({ title: '认证资料已锁定，请联系平台', icon: 'none' })
      return
    }
    if (!['male', 'female'].includes(this.data.form.gender)) {
      wx.showToast({ title: '请选择性别', icon: 'none' })
      return
    }
    const { realName, idCardNumber, phone, idCardFrontFileId, idCardBackFileId, facePhotoFileId, serviceAddress, serviceLatitude, serviceLongitude } = this.data.form
    if (!realName) {
      wx.showToast({ title: '请填写真实姓名', icon: 'none' })
      return
    }
    if (!idCardNumber) {
      wx.showToast({ title: '请输入身份证号码', icon: 'none' })
      return
    }
    if (!validateIdCardLocal(idCardNumber)) {
      wx.showToast({ title: '请输入有效的18位身份证号码', icon: 'none' })
      return
    }
    if (!phone) {
      wx.showToast({ title: '请填写手机号', icon: 'none' })
      return
    }
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      wx.showToast({ title: '请输入有效的11位手机号', icon: 'none' })
      return
    }
    if (!idCardFrontFileId || !idCardBackFileId || !facePhotoFileId) {
      wx.showToast({ title: '请上传身份证和人脸照片', icon: 'none' })
      return
    }
    if (!serviceAddress || !serviceLatitude || !serviceLongitude) {
      wx.showToast({ title: '请设置固定服务地址及位置', icon: 'none' })
      return
    }

    const zhimaConfig = this.data.zhimaConfig
    const isZhimaRequired = zhimaConfig && zhimaConfig.enabled
    const hasZhimaInput = this.data.form.zhimaScore || this.data.form.zhimaScoreFileId || this.data.form.alipayProfileFileId

    if (isZhimaRequired || hasZhimaInput) {
      const rawScore = Number(this.data.form.zhimaScore)
      if (!this.data.form.zhimaScore || !Number.isFinite(rawScore) || rawScore < 350 || rawScore > 950) {
        wx.showToast({ title: '请输入有效的芝麻信用分(350-950分)', icon: 'none' })
        return
      }
      const minScore = (zhimaConfig && zhimaConfig.minScore) || 650
      if (isZhimaRequired && rawScore < minScore) {
        wx.showToast({ title: `芝麻信用分需达到${minScore}分方可申请成为宠托师`, icon: 'none', duration: 2500 })
        return
      }
      if (!this.data.form.zhimaScoreFileId) {
        wx.showToast({ title: '请上传支付宝芝麻信用分截图', icon: 'none' })
        return
      }
      if (!this.data.form.alipayProfileFileId) {
        wx.showToast({ title: '请上传支付宝个人主页截图', icon: 'none' })
        return
      }
    }

    if (this.submitting) return
    this.submitting = true
    wx.showLoading({ title: '实名三要素核验中...', mask: true })
    callFunction('staff', 'submitStaffProfile', this.data.form)
      .then((profile) => {
        this.submitting = false
        wx.hideLoading()
        this.setData({
          profile: withStaffWorkflowText(withAuditText(profile)),
          statusTip: statusText.pending,
          isSubmittedApplication: true,
          isApproved: false,
          certificationLocked: false
        })
        wx.showToast({ title: '实名核验通过，已提交', icon: 'success' })
      })
      .catch((err) => {
        this.submitting = false
        wx.hideLoading()
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
    const mainNavUrls = ['/pages/staff/home/index', '/pages/staff/orders/list/index', '/pages/staff/messages/index', '/pages/staff/certification/index', '/pages/staff/profile/index']
    const method = mainNavUrls.includes(url) ? 'redirectTo' : 'navigateTo'
    wx[method]({ url })
  },

  backProfile() {
    wx.redirectTo({ url: '/pages/staff/profile/index' })
  }
})
