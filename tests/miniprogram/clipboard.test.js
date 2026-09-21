const test = require('node:test')
const assert = require('node:assert/strict')

const { copyText } = require('../../miniprogram/utils/clipboard')

test('copyText: empty, null, or undefined text displays emptyTitle toast and does not call setClipboardData', () => {
  let toastParams = null
  let clipboardCalled = false

  global.wx = {
    showToast: (params) => {
      toastParams = params
    },
    showModal: () => {},
    setClipboardData: () => {
      clipboardCalled = true
    }
  }

  // 1. null
  copyText(null)
  assert.equal(clipboardCalled, false)
  assert.deepEqual(toastParams, { title: '暂无可复制内容', icon: 'none' })

  // 2. undefined with custom emptyTitle
  toastParams = null
  copyText(undefined, { emptyTitle: '暂无订单号' })
  assert.equal(clipboardCalled, false)
  assert.deepEqual(toastParams, { title: '暂无订单号', icon: 'none' })

  // 3. blank whitespace string
  toastParams = null
  copyText('   ', { emptyTitle: '暂无微信号' })
  assert.equal(clipboardCalled, false)
  assert.deepEqual(toastParams, { title: '暂无微信号', icon: 'none' })
})

test('copyText: success triggers toast feedback and success callback', () => {
  let clipboardData = ''
  let toastParams = null
  let successCalled = false

  global.wx = {
    showToast: (params) => {
      toastParams = params
    },
    showModal: () => {},
    setClipboardData: ({ data, success }) => {
      clipboardData = data
      if (success) success()
    }
  }

  copyText('  O20260921001  ', {
    successTitle: '订单号已复制',
    duration: 2000,
    success: () => {
      successCalled = true
    }
  })

  assert.equal(clipboardData, 'O20260921001', 'Should trim input text')
  assert.equal(successCalled, true)
  assert.deepEqual(toastParams, {
    title: '订单号已复制',
    icon: 'none',
    duration: 2000
  })
})

test('copyText: success with successModal option triggers modal feedback', () => {
  let clipboardData = ''
  let modalParams = null
  let toastCalled = false

  global.wx = {
    showToast: () => {
      toastCalled = true
    },
    showModal: (params) => {
      modalParams = params
    },
    setClipboardData: ({ data, success }) => {
      clipboardData = data
      if (success) success()
    }
  }

  const testUrl = 'https://example.com/item/123'
  copyText(testUrl, {
    successModal: true,
    successTitle: '购买链接已复制',
    successModalContent: `已复制链接：${testUrl}`
  })

  assert.equal(clipboardData, testUrl)
  assert.equal(toastCalled, false)
  assert.ok(modalParams)
  assert.equal(modalParams.title, '购买链接已复制')
  assert.equal(modalParams.content, `已复制链接：${testUrl}`)
  assert.equal(modalParams.showCancel, false)
})

test('copyText: async fail triggers fallback modal and fail callback', () => {
  let modalParams = null
  let failCalled = false
  let failErr = null

  global.wx = {
    showToast: () => {},
    showModal: (params) => {
      modalParams = params
    },
    setClipboardData: ({ fail }) => {
      if (fail) fail(new Error('permission denied'))
    }
  }

  const contentToCopy = 'wx_audit_helper_01'
  copyText(contentToCopy, {
    failTitle: '复制失败',
    failContent: '环境限制自动复制，请手动复制：',
    fail: (err) => {
      failCalled = true
      failErr = err
    }
  })

  assert.equal(failCalled, true)
  assert.ok(failErr)
  assert.ok(modalParams)
  assert.equal(modalParams.title, '复制失败')
  assert.ok(modalParams.content.includes(contentToCopy), 'Modal content must contain the text for manual copying')
  assert.equal(modalParams.showCancel, false)
})

test('copyText: sync exception during setClipboardData is safely caught and falls back to modal', () => {
  let modalParams = null
  let failCalled = false

  global.wx = {
    showToast: () => {},
    showModal: (params) => {
      modalParams = params
    },
    setClipboardData: () => {
      throw new Error('sync runtime exception in native bridge')
    }
  }

  const contentToCopy = 'https://mall.example.com/shoes'
  copyText(contentToCopy, {
    fail: () => {
      failCalled = true
    }
  })

  assert.equal(failCalled, true)
  assert.ok(modalParams)
  assert.equal(modalParams.title, '复制失败')
  assert.ok(modalParams.content.includes(contentToCopy))
})
