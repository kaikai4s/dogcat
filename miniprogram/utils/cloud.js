function callFunction(name, action, data = {}) {
  const app = getApp()

  if (!app.globalData.env) {
    return Promise.reject(new Error('请先在 miniprogram/envList.js 配置云开发环境 ID'))
  }

  return wx.cloud.callFunction({
    name,
    data: {
      action,
      data
    }
  }).then((res) => {
    const result = res.result || {}
    if (!result.ok) {
      throw new Error(result.message || '云函数调用失败')
    }
    return result.data
  })
}

function showError(error) {
  wx.showToast({
    title: error.message || '操作失败',
    icon: 'none'
  })
}

module.exports = {
  callFunction,
  showError
}
