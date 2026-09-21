function copyText(text, options = {}) {
  const value = String(text || '').trim()
  if (!value) {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({
        title: options.emptyTitle || '暂无可复制内容',
        icon: 'none'
      })
    }
    return
  }

  const handleFail = (err) => {
    if (typeof options.fail === 'function') {
      options.fail(err)
    }
    const failContent = options.failContent
      ? (options.failContent.includes(value) ? options.failContent : `${options.failContent}\n\n${value}`)
      : `当前微信环境未能自动写入剪贴板，请长按下面内容手动复制：\n\n${value}`
    if (typeof wx !== 'undefined' && typeof wx.showModal === 'function') {
      wx.showModal({
        title: options.failTitle || '复制失败',
        content: failContent,
        showCancel: false,
        confirmText: options.confirmText || '我知道了'
      })
    }
  }

  try {
    if (typeof wx === 'undefined' || typeof wx.setClipboardData !== 'function') {
      handleFail(new Error('wx.setClipboardData is not supported'))
      return
    }

    wx.setClipboardData({
      data: value,
      success: () => {
        if (options.successModal) {
          if (typeof wx.showModal === 'function') {
            wx.showModal({
              title: options.successModalTitle || options.successTitle || '复制成功',
              content: options.successModalContent || `已成功复制到剪贴板！\n\n${value}\n\n可在微信对话框或手机浏览器中长按粘贴打开。`,
              showCancel: false,
              confirmText: options.confirmText || '我知道了'
            })
          }
        } else if (options.showToast !== false) {
          if (typeof wx.showToast === 'function') {
            wx.showToast({
              title: options.successTitle || '复制成功',
              icon: options.icon || 'none',
              duration: options.duration || 1500
            })
          }
        }
        if (typeof options.success === 'function') {
          options.success()
        }
      },
      fail: handleFail
    })
  } catch (err) {
    handleFail(err)
  }
}

module.exports = { copyText }

