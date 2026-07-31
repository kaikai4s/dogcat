// app.js
const { envList } = require('./envList')

App({
  onLaunch() {
    const env = envList[0] && envList[0].envId ? envList[0].envId : ''

    this.globalData = {
      env,
      user: null,
      isGuest: true,
      authChecked: false,
      activeRole: 'client',
      selectedLocation: null
    }

    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力')
      return
    }

    wx.cloud.init({
      env,
      traceUser: true
    })
  },

  globalData: {
    env: '',
    user: null,
    isGuest: true,
    authChecked: false,
    activeRole: 'client',
    selectedLocation: null
  }
})
