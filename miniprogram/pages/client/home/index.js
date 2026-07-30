Page({
  data: {
    locationName: '选择位置',
    locationTip: '点击选择当前位置或常用地址',
    latitude: 0,
    longitude: 0
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    wx.redirectTo({ url })
  },


  updateLocation() {
    wx.chooseLocation({
      success: (loc) => {
        this.setData({
          locationName: loc.name || '已选择位置',
          locationTip: loc.address || '已选择服务附近位置',
          latitude: loc.latitude,
          longitude: loc.longitude
        })
      },
      fail: () => this.showLocationAuth()
    })
  },

  showLocationAuth() {
    this.setData({
      locationName: '点击选择位置',
      locationTip: '打开地图后可手动选择地点'
    })
    wx.showModal({
      title: '需要位置权限',
      content: '请选择你的当前位置或服务区域，方便推荐附近宠托师。',
      confirmText: '去开启',
      success: (res) => {
        if (res.confirm) wx.openSetting()
      }
    })
  }
})
