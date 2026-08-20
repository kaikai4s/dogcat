const { callFunction, showError, chooseSelectedLocation } = require('../../../utils/cloud')
const { withAuditText } = require('../../../utils/format')
const { applyTheme, getThemeState } = require('../../../utils/theme')

const { createPageNav, navMethods } = require('../../../utils/nav')

const statusText = {
  pending: '资料已提交，等待平台审核',
  approved: '审核已通过，可以进入工作台接单',
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
    wx.cloud.uploadFile({
      cloudPath: `staff_identity/${type}_${Date.now()}_${Math.random().toString(16).slice(2)}${ext}`,
      filePath,
      success: (res) => resolve(res.fileID),
      fail: reject
    })
  })
}

Page({
  data: {
    themeClass: 'theme-day',
    form: {
      realName: '',
      phone: '',
      serviceCity: '',
      serviceAreas: '',
      serviceAddress: '',
      serviceLatitude: 0,
      serviceLongitude: 0,
      serviceRadiusKm: 5,
      idCardFrontFileId: '',
      idCardBackFileId: '',
      facePhotoFileId: ''
    },
    identityPreviews: { idCardFrontFileId: '', idCardBackFileId: '', facePhotoFileId: '' },
    radiusOptions,
    profile: null,
    statusTip: '',
    isApproved: false,
    canGoBack: false
  },

  onLoad(q) {
    this.setData(createPageNav(q))
  },

  ...navMethods(),

  onShow() {
    this.applyCurrentTheme()
    callFunction('staff', 'getStaffProfile')
      .then((profile) => {
        if (!profile) return
        this.setData({
          profile: withAuditText(profile),
          form: {
            ...this.data.form,
            ...profile,
            serviceRadiusKm: Number(profile.serviceRadiusKm || 5),
            serviceLatitude: Number(profile.serviceLatitude || 0),
            serviceLongitude: Number(profile.serviceLongitude || 0)
          },
          identityPreviews: {
            idCardFrontFileId: profile.idCardFrontFileId || '',
            idCardBackFileId: profile.idCardBackFileId || '',
            facePhotoFileId: profile.facePhotoFileId || ''
          },
          statusTip: profile.auditRemark || statusText[profile.auditStatus] || '',
          isApproved: profile.auditStatus === 'approved'
        })
      })
      .catch(showError)
  },

  applyCurrentTheme() {
    const theme = applyTheme()
    this.setData(getThemeState(theme.value))
  },

  input(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  chooseAddress() {
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
    const radius = Number(e.currentTarget.dataset.radius || 5)
    this.setData({ ['form.serviceRadiusKm']: radius })
  },

  chooseIdentityPhoto(e) {
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

  submit() {
    if (this.data.isApproved) {
      wx.showToast({ title: '已完成认证，无需重复提交', icon: 'none' })
      return
    }
    const { realName, phone, idCardFrontFileId, idCardBackFileId, facePhotoFileId, serviceAddress, serviceLatitude, serviceLongitude } = this.data.form
    if (!realName) {
      wx.showToast({ title: '请填写真实姓名', icon: 'none' })
      return
    }
    if (!phone) {
      wx.showToast({ title: '请填写手机号', icon: 'none' })
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

    callFunction('staff', 'submitStaffProfile', this.data.form)
      .then((profile) => {
        this.setData({
          profile: withAuditText(profile),
          statusTip: statusText.pending
        })
        wx.showToast({ title: '已提交审核', icon: 'none' })
      })
      .catch(showError)
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url })
  },

  backProfile() {
    wx.redirectTo({ url: '/pages/staff/profile/index' })
  }
})
