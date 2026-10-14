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

  preparePrivacyAuthorize() {
    return requirePrivacyAuthorize().catch((error) => {
      const message = String((error && (error.errMsg || error.message)) || '')
      if (message.includes('privacy agreement') || message.includes('not declared')) {
        wx.showModal({ title: '隐私协议未配置', content: '微信后台隐私协议还没有声明“手机号”或“头像昵称”用途，请先在微信公众平台补充隐私协议后再使用快捷授权。', showCancel: false })
      }
      throw error
    })
  },

  bindPhone(e) {
    const detail = e.detail || {}
    const code = detail.code
    if (!code) {
      const errMsg = String(detail.errMsg || detail.message || '')
      if (errMsg.includes('deny') || errMsg.includes('cancel')) {
        wx.showToast({ title: '已取消授权', icon: 'none' })
        return
      }
      if (errMsg.includes('privacy agreement') || errMsg.includes('not declared') || errMsg.includes('errno:112')) {
        wx.showModal({ title: '隐私协议未配置', content: '微信后台隐私协议还没有声明“手机号”用途，所以微信拦截了快捷授权。请在微信公众平台「设置与开发 > 服务内容声明 > 用户隐私保护指引」补充手机号用途；配置生效前可直接输入手机号保存。', showCancel: false })
        return
      }
      if (errMsg.includes('no permission') || errMsg.includes('not support') || errMsg.includes('fail')) {
        wx.showModal({ title: '快捷授权不可用', content: '当前小程序主体、调试环境或权限未返回手机号授权码。配置企业认证与手机号快速验证能力前，请直接输入手机号保存。', showCancel: false })
        return
      }
      wx.showModal({ title: '快捷授权未完成', content: '微信没有返回手机号授权码，请直接输入手机号保存，或在真机正式环境重新尝试快捷授权。', showCancel: false })
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

  uploadAvatar(filePath, successTitle = '已选择头像') {
    if (!filePath) return
    wx.showLoading({ title: '处理头像中...' })
    const cleanPath = String(filePath).split('?')[0]
    const rawExt = cleanPath.includes('.') ? cleanPath.substring(cleanPath.lastIndexOf('.')).toLowerCase() : '.jpg'
    const ext = /^\.(jpg|jpeg|png|webp)$/.test(rawExt) ? rawExt : '.jpg'
    wx.cloud.uploadFile({
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
