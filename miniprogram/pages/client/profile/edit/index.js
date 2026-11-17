const { uploadImage } = require('../../../../utils/image-upload')
const { callFunction, showError, ensureLogin, setCachedUser, preparePhonePrivacyAuthorize, bindPhoneByWechatEvent } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

Page({
  data: {
    from: 'client',
    returnOnPhoneBind: false,
    focusPhone: false,
    initialized: false,
    form: {
      nickname: '',
      phone: '',
      avatarUrl: ''
    },
    sectionHomeUrl: '',
    canGoBack: false
  },

  onLoad(query = {}) {
    const returnOnPhoneBind = query.from === 'booking'
    this.setData({
      ...createPageNav(query),
      from: query.from === 'staff' ? 'staff' : 'client',
      returnOnPhoneBind,
      focusPhone: query.focus === 'phone' || returnOnPhoneBind
    })
  },

  onShow() {
    ensureLogin({ content: '登录后可编辑个人资料。' })
      .then(() => {
        if (this.data.initialized) return null
        this.setData({ initialized: true })
        return callFunction('auth', 'me')
      })
      .then((user) => {
        if (user) this.setData({ form: { ...this.data.form, ...user } })
      })
      .catch((error) => {
        if (error && error.code === 'LOGIN_CANCELLED') wx.redirectTo({ url: '/pages/client/home/index' })
        else showError(error)
      })
  },

  input(e) {
    if (e.currentTarget.dataset.field === 'phone') return
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  onUnload() {
    clearTimeout(this._backTimer)
  },

  preparePrivacyAuthorize() {
    return preparePhonePrivacyAuthorize()
  },

  bindPhone(e) {
    return bindPhoneByWechatEvent(e)
      .then((user) => {
        if (!user) return null
        this.setData({ ['form.phone']: user.phone || '', focusPhone: false })
        wx.showToast({ title: '手机号已绑定' })
        if (this.data.returnOnPhoneBind && user.phone && getCurrentPages().length > 1) {
          clearTimeout(this._backTimer)
          this._backTimer = setTimeout(() => wx.navigateBack({ delta: 1 }), 450)
        }
        return user
      })
      .catch(() => null)
  },

  uploadAvatar(filePath, successTitle = '已选择头像') {
    if (!filePath) return
    wx.showLoading({ title: '处理头像中...' })
    const cleanPath = String(filePath).split('?')[0]
    const rawExt = cleanPath.includes('.') ? cleanPath.substring(cleanPath.lastIndexOf('.')).toLowerCase() : '.jpg'
    const ext = /^\.(jpg|jpeg|png|webp)$/.test(rawExt) ? rawExt : '.jpg'
    uploadImage({
      cloudPath: `users/${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`,
      filePath,
      success: (upload) => {
        wx.hideLoading()
        this.setData({ ['form.avatarUrl']: upload.fileID })
        wx.showToast({ title: successTitle, icon: 'success' })
      },
      fail: (err) => {
        wx.hideLoading()
        showError(err)
      }
    })
  },

  onChooseAvatar(e) {
    const avatarUrl = e.detail && e.detail.avatarUrl
    if (!avatarUrl) return
    this.uploadAvatar(avatarUrl, '已选用微信头像')
  },

  onNicknameBlur(e) {
    const value = e.detail && e.detail.value
    if (value !== undefined) {
      this.setData({ ['form.nickname']: value })
    }
  },

  chooseAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const filePath = res.tempFiles[0].tempFilePath
        this.uploadAvatar(filePath)
      },
      fail: (err) => {
        const errMsg = (err && (err.errMsg || err.message)) || ''
        if (errMsg.includes('cancel')) return
        showError(err)
      }
    })
  },

  save() {
    if (!this.data.form.nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' })
      return
    }
    callFunction('auth', 'updateProfile', {
      nickname: this.data.form.nickname,
      avatarUrl: this.data.form.avatarUrl
    })
      .then((user) => {
        getApp().globalData.user = user
        setCachedUser(user)
        wx.showToast({ title: '已保存' })
        wx.navigateBack()
      })
      .catch(showError)
  },

  ...navMethods()
})
