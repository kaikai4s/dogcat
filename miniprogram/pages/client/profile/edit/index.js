const { callFunction, showError, ensureLogin, setCachedUser, requirePrivacyAuthorize } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

Page({
  data: {
    from: 'client',
    initialized: false,
    form: {
      nickname: '',
      phone: '',
      avatarUrl: ''
    },
    sectionHomeUrl: '',
    canGoBack: false,
    phoneAuthReady: false
  },

  onLoad(query) {
    this.setData({ ...createPageNav(query), from: query.from === 'staff' ? 'staff' : 'client' })
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
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  preparePhoneAuth() {
    requirePrivacyAuthorize()
      .then(() => {
        this.setData({ phoneAuthReady: true })
        wx.showToast({ title: '请再次点击授权手机号', icon: 'none' })
      })
      .catch(() => wx.showToast({ title: '请先同意隐私保护指引', icon: 'none' }))
  },

  bindPhone(e) {
    const code = e.detail && e.detail.code
    if (!code) {
      wx.showToast({ title: '未完成手机号授权', icon: 'none' })
      return
    }
    callFunction('auth', 'loginByPhoneCode', { code })
      .then((user) => {
        setCachedUser(user)
        this.setData({ form: { ...this.data.form, ...user } })
        wx.showToast({ title: '手机号已绑定' })
      })
      .catch(showError)
  },

  chooseAvatar() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const filePath = res.tempFiles[0].tempFilePath
        const ext = filePath.includes('.') ? filePath.substring(filePath.lastIndexOf('.')) : '.jpg'
        wx.cloud.uploadFile({
          cloudPath: `users/${Date.now()}${ext}`,
          filePath,
          success: (upload) => this.setData({ ['form.avatarUrl']: upload.fileID }),
          fail: showError
        })
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
        wx.showToast({ title: '已保存' })
        wx.navigateBack()
      })
      .catch(showError)
  },

  ...navMethods()
})
