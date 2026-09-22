const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('admin finance forfeit deposit supports internal proof photos: chooseMedia限定image、最多4张、可删除与预览、提交包含evidenceImages', async () => {
  let mediaOptions = null
  let previewOptions = null
  let calledFunction = null
  let calledAction = null
  let calledPayload = null

  global.wx = {
    showToast: () => {},
    showLoading: () => {},
    hideLoading: () => {},
    getStorageSync: () => null,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    chooseMedia: (opts) => {
      mediaOptions = opts
      opts.success({
        tempFiles: [
          { tempFilePath: 'http://tmp/proof1.jpg' },
          { tempFilePath: 'http://tmp/proof2.png' }
        ]
      })
    },
    previewImage: (opts) => {
      previewOptions = opts
    },
    cloud: {
      uploadFile: async ({ cloudPath, filePath }) => {
        return { fileID: `cloud://env/${cloudPath}` }
      }
    }
  }

  // 模拟 finance 页面实例
  const page = {
    data: {
      forfeitDepositId: 'dep_100',
      forfeitMaxAmount: 500,
      forfeitAmountInput: '100',
      forfeitReasonInput: '宠托师未按约定入户服务且失联，留存微信聊天截图证据',
      forfeitEvidenceId: 'ev_200',
      forfeitImages: ['http://tmp/existing.jpg'],
      forfeiting: false,
      actionBusy: false
    },
    setData(patch) {
      Object.assign(this.data, patch)
    },
    closeForfeitModal() {
      this.setData({
        showForfeitModal: false,
        forfeitImages: []
      })
    },
    loadStaffFinance() {},

    chooseForfeitImages() {
      const remain = 4 - (this.data.forfeitImages || []).length
      if (remain <= 0) return
      global.wx.chooseMedia({
        count: remain,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        success: (res) => {
          const files = (res.tempFiles || []).map((f) => f.tempFilePath).filter(Boolean)
          this.setData({
            forfeitImages: [...(this.data.forfeitImages || []), ...files]
          })
        }
      })
    },

    removeForfeitImage(e) {
      const index = Number(e.currentTarget.dataset.index)
      const list = [...(this.data.forfeitImages || [])]
      list.splice(index, 1)
      this.setData({ forfeitImages: list })
    },

    previewForfeitModalImage(e) {
      const current = e.currentTarget.dataset.url
      const urls = this.data.forfeitImages || []
      if (!current || !urls.length) return
      global.wx.previewImage({ current, urls })
    },

    previewForfeitReceipt(e) {
      const current = e.currentTarget.dataset.current
      const urls = e.currentTarget.dataset.urls || (current ? [current] : [])
      if (!current || !urls.length) return
      global.wx.previewImage({ current, urls })
    },

    async submitForfeitDeposit() {
      const id = this.data.forfeitDepositId
      const amount = Number(this.data.forfeitAmountInput)
      const reason = String(this.data.forfeitReasonInput || '').trim()
      const evidenceId = this.data.forfeitEvidenceId || ''

      const localImages = this.data.forfeitImages || []
      const evidenceImages = localImages.map((p) => (p.startsWith('cloud://') ? p : `cloud://env/deposit_forfeits/uploaded_${path.basename(p)}`))

      const payload = {
        id,
        amount,
        reason,
        clientRequestId: 'req_123',
        evidenceImages
      }
      if (evidenceId) payload.evidenceId = evidenceId

      calledFunction = 'admin'
      calledAction = 'forfeitStaffDeposit'
      calledPayload = payload
      this.closeForfeitModal()
    }
  }

  // 1. 测试选择照片：验证限定为 image 且数量计算正确 (4 - 1 = 3)
  page.chooseForfeitImages()
  assert.ok(mediaOptions, 'wx.chooseMedia must be called')
  assert.deepEqual(mediaOptions.mediaType, ['image'], 'Must only allow photos (mediaType: ["image"])')
  assert.equal(mediaOptions.count, 3, 'Must limit count to remain slots')
  assert.equal(page.data.forfeitImages.length, 3, 'New photos should be appended to forfeitImages')

  // 2. 测试删除单张照片
  page.removeForfeitImage({ currentTarget: { dataset: { index: 1 } } })
  assert.equal(page.data.forfeitImages.length, 2, 'Should remove 1 image')
  assert.equal(page.data.forfeitImages[0], 'http://tmp/existing.jpg')
  assert.equal(page.data.forfeitImages[1], 'http://tmp/proof2.png')

  // 3. 测试大图预览
  page.previewForfeitModalImage({ currentTarget: { dataset: { url: 'http://tmp/proof2.png' } } })
  assert.equal(previewOptions.current, 'http://tmp/proof2.png')
  assert.deepEqual(previewOptions.urls, ['http://tmp/existing.jpg', 'http://tmp/proof2.png'])

  // 4. 测试提交扣款：验证 evidenceImages 传给云函数
  await page.submitForfeitDeposit()
  assert.equal(calledAction, 'forfeitStaffDeposit')
  assert.equal(calledPayload.id, 'dep_100')
  assert.equal(calledPayload.amount, 100)
  assert.equal(calledPayload.evidenceId, 'ev_200')
  assert.equal(calledPayload.evidenceImages.length, 2)
  assert.ok(calledPayload.evidenceImages[0].includes('existing.jpg'))
  assert.ok(calledPayload.evidenceImages[1].includes('proof2.png'))
  assert.equal(page.data.forfeitImages.length, 0, 'Modal forfeitImages must be reset on close')

  // 5. 校验 WXML 模板包含上传组件与“只限照片”说明
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/finance/index.wxml'), 'utf8')
  assert.ok(wxml.includes('forfeit-uploader-grid'), 'WXML must contain forfeit-uploader-grid')
  assert.ok(wxml.includes('chooseForfeitImages'), 'WXML must bind chooseForfeitImages')
  assert.ok(wxml.includes('previewForfeitModalImage'), 'WXML must bind previewForfeitModalImage')
  assert.ok(wxml.includes('removeForfeitImage'), 'WXML must bind removeForfeitImage')
  assert.ok(wxml.includes('item.lastForfeitImages'), 'WXML must display item.lastForfeitImages in deposits card')
  assert.ok(wxml.includes('previewForfeitReceipt'), 'WXML must bind previewForfeitReceipt for card photos')
  assert.ok(wxml.includes('只限照片'), 'WXML prompt must state "只限照片"')
})
