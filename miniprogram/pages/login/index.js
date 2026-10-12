const { loginWithWechat, callFunction, showError, setCachedUser } = require('../../utils/cloud')
const { envList, getActiveEnvId } = require('../../envList')

Page({
  data: {
    step: 'login', // 'login' | 'profile'
    loading: false,
    submitting: false,
    envReady: Boolean((typeof getActiveEnvId === 'function' && getActiveEnvId()) || (envList[0] && envList[0].envId)),
    errorText: '',
    form: {
      nickname: '',
      avatarUrl: '',
      phone: ''
    }
  },

  login() {
    this.setData({ loading: true, errorText: '' })
    loginWithWechat()
      .then((user) => {
        getApp().globalData.activeRole = 'client'
        getApp().globalData.user = user
        const isNewUser = !user || user.nickname === '微信用户' || !user.avatarUrl
        if (isNewUser) {
          this.setData({
            step: 'profile',
            form: {
              nickname: user?.nickname === '微信用户' ? '' : (user?.nickname || ''),
              avatarUrl: user?.avatarUrl || '',
              phone: user?.phone || ''
            }
          })
          wx.showToast({ title: '登录成功，请完善资料', icon: 'none' })
        } else {
          wx.redirectTo({ url: '/pages/client/home/index' })
        }
      })
      .catch((error) => {
        const message = error.message || '登录失败'
        this.setData({ errorText: message })
        wx.showModal({ title: '登录失败', content: message, showCancel: false })
      })
      .finally(() => this.setData({ loading: false }))
  },

  onChooseAvatar(e) {
    const avatarUrl = e.detail && e.detail.avatarUrl
    if (!avatarUrl) return
    wx.showLoading({ title: '上传头像中...' })
    const ext = avatarUrl.includes('.') ? avatarUrl.substring(avatarUrl.lastIndexOf('.')) : '.jpg'
    wx.cloud.uploadFile({
      cloudPath: `users/${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`,
      filePath: avatarUrl,
      success: (upload) => {
        wx.hideLoading()
        this.setData({ ['form.avatarUrl']: upload.fileID })
        wx.showToast({ title: '已选择头像', icon: 'success' })
      },
      fail: (err) => {
        wx.hideLoading()
        showError(err)
      }
    })
  },

  inputNickname(e) {
    this.setData({ ['form.nickname']: e.detail.value })
  },

  onNicknameBlur(e) {
    const value = e.detail && e.detail.value
    if (value !== undefined) {
      this.setData({ ['form.nickname']: value })
    }
  },

  inputPhone(e) {
    this.setData({ ['form.phone']: e.detail.value })
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
        this.setData({ ['form.phone']: user.phone || '' })
        wx.showToast({ title: '手机号已绑定' })
      })
      .catch((err) => {
        wx.hideLoading()
        showError(err)
      })
  },

  saveAndEnter() {
    const nickname = String(this.data.form.nickname || '').trim() || '微信爱宠用户'
    const phone = String(this.data.form.phone || '').trim()
    if (phone && !/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '手机号格式不正确', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    wx.showLoading({ title: '保存中...' })
    callFunction('auth', 'updateProfile', {
      nickname,
      avatarUrl: this.data.form.avatarUrl,
      phone
    })
      .then((user) => {
        wx.hideLoading()
        getApp().globalData.user = user
        setCachedUser(user)
        wx.showToast({ title: '欢迎加入多芙琳！', icon: 'success' })
        setTimeout(() => {
          wx.redirectTo({ url: '/pages/client/home/index' })
        }, 400)
      })
      .catch((err) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        showError(err)
      })
  },

  skipAndEnter() {
    wx.redirectTo({ url: '/pages/client/home/index' })
  }
})
