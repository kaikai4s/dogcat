const { getSelectedLocation, chooseSelectedLocation, callFunction, showError } = require('../../../utils/cloud')
const { ensureLogin } = require('../../../utils/cloud')

Page({
  data: {
    locationName: '选择位置',
    locationTip: '点击选择当前位置或常用地址',
    latitude: 0,
    longitude: 0,
    lotteryActivity: null
  },

  onShow() {
    this.applySavedLocation()
    this.loadLottery()
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.navigateTo({ url })
  },

  goProtected(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    ensureLogin({ content: '登录后可预约服务、管理宠物和查看订单。' })
      .then(() => wx.navigateTo({ url }))
      .catch(() => {})
  },

  applySavedLocation() {
    const location = getSelectedLocation()
    if (!location) return
    this.setData({
      locationName: location.name,
      locationTip: location.address || '已选择服务附近位置',
      latitude: location.latitude,
      longitude: location.longitude
    })
  },

  updateLocation() {
    chooseSelectedLocation()
      .then((loc) => {
        this.setData({
          locationName: loc.name || '已选择位置',
          locationTip: loc.address || '已选择服务附近位置',
          latitude: loc.latitude,
          longitude: loc.longitude
        })
      })
      .catch((err) => {
        console.log('chooseSelectedLocation fail error:', err)
        const errMsg = (err && err.errMsg) || ''
        if (errMsg.includes('cancel')) return
        if (errMsg.includes('authorize') || errMsg.includes('auth deny') || errMsg.includes('scope.userLocation')) {
          this.showLocationAuth()
          return
        }
        wx.showToast({ title: '获取位置失败', icon: 'none' })
      })
  },

  loadLottery() {
    // 不要求登录，公开接口
    callFunction('lottery', 'getActiveActivity')
      .then((activity) => this.setData({ lotteryActivity: activity }))
      .catch(() => {})
  },

  goLottery() {
    ensureLogin({ content: '登录后可参与抽奖。' })
      .then(() => wx.navigateTo({ url: '/pages/client/lottery/index' }))
      .catch(() => {})
  },

  showLocationAuth() {
    this.setData({
      locationName: '点击选择位置',
      locationTip: '打开地图后可手动选择地点'
    })
    wx.showModal({
      title: '需要位置权限',
      content: '请开启位置信息权限，方便推荐附近宠托师和附近订单。',
      confirmText: '去开启',
      success: (res) => {
        if (res.confirm) wx.openSetting()
      }
    })
  }
})
