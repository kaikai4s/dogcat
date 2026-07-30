function callFunction(name, action, data = {}) {
  const app = getApp()

  if (!app.globalData.env) {
    return Promise.reject(new Error('请先在 miniprogram/envList.js 配置云开发环境 ID'))
  }

  return wx.cloud.callFunction({
    name: 'api',
    data: {
      module: name,
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
  const message = error.message || '操作失败'
  const title = message.includes('collection.get') || message.includes('-501003')
    ? '请先在云开发中创建数据库集合并部署 api 云函数'
    : message
  wx.showToast({
    title,
    icon: 'none'
  })
}

module.exports = {
  callFunction,
  showError
}
