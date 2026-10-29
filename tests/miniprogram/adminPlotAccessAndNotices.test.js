const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const root = path.resolve(__dirname, '../../miniprogram')
const flush = () => new Promise((resolve) => setImmediate(resolve))

function pageAt(file, dependencies, wx = {}) {
  let page
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    Page(config) { page = config }, wx, console, setTimeout, clearTimeout,
    require(name) {
      if (name.endsWith('/cloud')) return dependencies.cloud || {}
      if (name.endsWith('/image-upload')) return dependencies.imageUpload || {}
      if (name.endsWith('/payment-config')) return require(path.join(root, 'pages/admin/settings/payment-config'))
      if (name.endsWith('/subscription-options')) return require(path.join(root, 'utils/subscription-options'))
      if (name.endsWith('/adminAccess')) return { can: () => true }
      return {}
    }
  })
  page.setData = function (patch) {
    for (const [key, value] of Object.entries(patch)) {
      const parts = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      let target = this.data
      for (const segment of parts.slice(0, -1)) target = target[segment]
      target[parts.at(-1)] = value
    }
  }
  return page
}

test('plot level checkboxes retain their selected state and submit incremental counts', async () => {
  const calls = []
  const page = pageAt('pages/admin/playground-buildings/index.js', {
    cloud: { callFunction: async (_, action, data) => {
      calls.push({ action, data })
      return { revision: 2 }
    }, showError: error => assert.fail(error.message) }
  }, { showToast() {} })
  page.data.adminAccess = {}
  page.data.revision = 1
  page.data.plotSizes = [{ size: 48, unlockLevelIds: [], choices: [{ _id: 'silver', checked: false, count: 1 }, { _id: 'gold', checked: false, count: 1 }] }]
  page.plotLevelsChange({ currentTarget: { dataset: { size: 48 } }, detail: { value: ['silver', 'gold'] } })
  assert.equal(page.data.plotSizes[0].choices.every((choice) => choice.checked), true)
  page.plotCountChange({ currentTarget: { dataset: { size: 48, id: 'gold' } }, detail: { value: '2' } })
  await page.savePlotLevels({ currentTarget: { dataset: { size: 48 } } })
  assert.deepEqual(Array.from(calls[0].data.levelGrants, (grant) => ({ ...grant })), [
    { levelId: 'silver', count: 1 }, { levelId: 'gold', count: 2 }
  ])
})

test('all admin share cover uploads use processed image upload and keep the unsaved cover when returning from picker', async () => {
  const uploads = [], errors = [], toasts = []
  const wx = {
    chooseMedia(options) { options.success({ tempFiles: [{ tempFilePath: '/tmp/cover.png' }] }) },
    showLoading() {}, hideLoading() {}, showToast(options) { toasts.push(options.title) },
    cloud: { getTempFileURL(options) { options.success({ fileList: [{ tempFileURL: 'https://example.test/cover.jpg' }] }) } }
  }
  const page = pageAt('pages/admin/settings/index.js', {
    cloud: { getCloudEnv: () => 'test-env', showError: error => errors.push(error), callFunction: () => assert.fail('Modal return must not reload settings') },
    imageUpload: { async uploadImage(options) { uploads.push(options); return { fileID: `cloud://test/${options.cloudPath}` } } }
  }, wx)
  page.data.showSettingModal = true
  const chooseBySection = { invitation: 'chooseInvitationShareImage', checkinShare: 'chooseCheckinShareImage', generalShare: 'chooseGeneralShareImage' }
  for (const section of ['invitation', 'checkinShare', 'generalShare']) {
    page[chooseBySection[section]]()
    page.onShow()
    await flush()
    const key = section === 'invitation' ? 'shareImageUrl' : 'imageUrl'
    assert.match(page.data.settings[section][key], /^cloud:\/\/test\//)
  }
  assert.equal(uploads.length, 3)
  assert.equal(uploads[0].config.env, 'test-env')
  assert.equal(uploads[1].filePath, '/tmp/cover.png')
  assert.equal(errors.length, 0)
  assert.equal(toasts.length, 3)
})

test('saving settings waits for the check-in cover upload and includes its completed file ID', async () => {
  let completeUpload
  const saves = [], toasts = [], errors = []
  const page = pageAt('pages/admin/settings/index.js', {
    cloud: {
      getCloudEnv: () => 'test-env',
      showError: error => errors.push(error),
      callFunction: (...args) => { saves.push(args); return new Promise(() => {}) }
    },
    imageUpload: { uploadImage: () => new Promise(resolve => { completeUpload = resolve }) }
  }, {
    chooseMedia(options) { options.success({ tempFiles: [{ tempFilePath: '/tmp/checkin-cover.png' }] }) },
    showLoading() {}, hideLoading() {}, showToast(options) { toasts.push(options.title) },
    cloud: { getTempFileURL(options) { options.success({ fileList: [{ tempFileURL: 'https://example.test/checkin-cover.jpg' }] }) } }
  })
  page.data.loaded = true
  page.data.settings.staffTraining.quiz = structuredClone(require('../../cloudfunctions/api/config/constants').DEFAULT_STAFF_TRAINING_QUIZ)
  page.chooseCheckinShareImage()
  assert.equal(page.data.uploadingCheckinShareImage, true)
  page.save()
  assert.equal(saves.length, 0)
  assert.ok(toasts.includes('请等待素材上传完成'))

  completeUpload({ fileID: 'cloud://test/checkin-share/new-cover.jpg' })
  await flush()
  assert.equal(page.data.uploadingCheckinShareImage, false)
  page.save()
  assert.equal(saves.length, 1)
  assert.equal(saves[0][2].checkinShare.imageUrl, 'cloud://test/checkin-share/new-cover.jpg')
  assert.deepEqual(errors, [])
  const view = fs.readFileSync(path.join(root, 'pages/admin/settings/index.wxml'), 'utf8')
  assert.equal((view.match(/disabled="\{\{[^\"]*uploadingCheckinShareImage[^\"]*\}\}" bindtap="save"/g) || []).length, 2)
})
