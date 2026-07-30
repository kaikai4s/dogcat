const { callFunction, showError } = require('../../../../utils/cloud')
const { createPageNav, navMethods } = require('../../../../utils/nav')

Page({
  data: {
    from: 'client',
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
    callFunction('auth', 'me')
      .then((user) => this.setData({ form: { ...this.data.form, ...user } }))
      .catch(showError)
  },

  input(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
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
      fail: showError
    })
  },

  save() {
    if (!this.data.form.nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' })
      return
    }
    callFunction('auth', 'updateProfile', {
      nickname: this.data.form.nickname,
      phone: this.data.form.phone,
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
