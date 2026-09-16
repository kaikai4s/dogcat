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
    canGoBack: false
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

  bindPhone(e) {
    const code = e.detail && e.detail.code
    if (!code) {
      const errMsg = (e.detail && (e.detail.errMsg || e.detail.message)) || ''
      if (errMsg.includes('deny') || errMsg.includes('cancel')) {
        wx.showToast({ title: '已取消授权', icon: 'none' })
        return
      }
      wx.showToast({ title: '未完成手机号授权', icon: 'none' })
      return
    }
    wx.showLoading({ title: '绑定中...' })
    callFunction('auth', 'loginByPhoneCode', { code })
      .then((user) => {
        wx.hideLoading()
        setCachedUser(user)
        if (getApp().globalData) getApp().globalData.user = user
        this.setData({ form: { ...this.data.form, ...user } })
        wx.showToast({ title: '手机号已绑定' })
      })
      .catch((err) => {
        wx.hideLoading()
        showError(err)
      })
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
    const phone = String(this.data.form.phone || '').trim()
    if (phone && !/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '手机号格式不正确', icon: 'none' })
      return
    }
    callFunction('auth', 'updateProfile', {
      nickname: this.data.form.nickname,
      avatarUrl: this.data.form.avatarUrl,
      phone
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
