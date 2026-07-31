function createPageNav() {
  return {
    canGoBack: getCurrentPages().length > 1
  }
}

function goBack() {
  const pages = getCurrentPages()
  if (pages.length > 1) {
    wx.navigateBack()
    return
  }
  wx.redirectTo({ url: '/pages/client/home/index' })
}

function navMethods() {
  return { goBack }
}

module.exports = { createPageNav, navMethods }
