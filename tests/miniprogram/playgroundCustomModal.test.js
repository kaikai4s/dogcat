const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const vm = require('node:vm')

const root = path.join(__dirname, '../../miniprogram')

function setupPlaygroundPage() {
  const calls = []
  let pageConfig
  const wx = {
    showToast: (opts) => calls.push({ type: 'toast', ...opts }),
    showLoading: (opts) => calls.push({ type: 'loading', ...opts }),
    hideLoading: () => calls.push({ type: 'hideLoading' }),
    showModal: (opts) => {
      calls.push({ type: 'modal', ...opts })
      if (opts.success) opts.success({ confirm: true })
    },
    redirectTo: (opts) => calls.push({ type: 'redirectTo', ...opts }),
    navigateTo: (opts) => calls.push({ type: 'navigateTo', ...opts }),
    chooseMedia: (opts) => {
      calls.push({ type: 'chooseMedia' })
      if (opts.success) opts.success({ tempFiles: [{ tempFilePath: '/tmp/photo.jpg' }] })
    },
    chooseMessageFile: (opts) => {
      calls.push({ type: 'chooseMessageFile' })
      if (opts.success) opts.success({ tempFiles: [{ path: '/tmp/model.glb' }] })
    },
    cloud: {
      uploadFile: (opts) => {
        calls.push({ type: 'uploadFile', cloudPath: opts.cloudPath })
        if (opts.success) opts.success({ fileID: `cloud://${opts.cloudPath}` })
      }
    }
  }

  const cloudDeps = {
    ensureLogin: async () => {},
    callFunction: async (module, action, data) => {
      calls.push({ type: 'callFunction', module, action, data })
      if (action === 'getOverview') {
        return {
          pets: [
            { _id: 'pet_1', name: '旺财', species: 'dog', customModelUrl: '' }
          ]
        }
      }
      return { success: true }
    },
    showError: (err) => calls.push({ type: 'error', err })
  }

  const script = fs.readFileSync(path.join(root, 'packagePlayground/pages/index.js'), 'utf8')
  vm.runInNewContext(script, {
    Page: (cfg) => { pageConfig = cfg },
    require: (name) => {
      if (name.includes('cloud')) return cloudDeps
      return {}
    },
    wx,
    console,
    setTimeout,
    clearTimeout
  })

  pageConfig.setData = function (data, cb) {
    Object.assign(this.data, data)
    if (cb) cb.call(this)
  }

  return { page: pageConfig, calls, wx }
}

test('playground page openCustomModal and switchCustomTab work as expected', () => {
  const { page } = setupPlaygroundPage()
  page.data.pets = [{ _id: 'p1', name: '大黄', avatarFileId: 'avatar.jpg', customModelUrl: 'cloud://old.glb' }]
  page.choosePet({ currentTarget: { dataset: { id: 'p1' } } })

  assert.equal(page.data.selectedPet._id, 'p1')
  assert.equal(page.data.customModalVisible, false)

  page.openCustomModal()
  assert.equal(page.data.customModalVisible, true)
  assert.equal(page.data.customTab, 'ai')

  page.switchCustomTab({ currentTarget: { dataset: { tab: 'manual' } } })
  assert.equal(page.data.customTab, 'manual')

  page.onScaleChange({ currentTarget: { dataset: { scale: 1.2 } } })
  assert.equal(page.data.manualScale, 1.2)
})

test('playground page triggerAiGeneration calls playground generatePet3DModel', async () => {
  const { page, calls } = setupPlaygroundPage()
  page.data.pets = [{ _id: 'p1', name: '大黄', avatarFileId: 'cloud://photo.jpg' }]
  page.choosePet({ currentTarget: { dataset: { id: 'p1' } } })
  page.openCustomModal()

  await page.triggerAiGeneration()

  const aiCall = calls.find(c => c.action === 'generatePet3DModel')
  assert.ok(aiCall, 'Should call generatePet3DModel')
  assert.equal(aiCall.data.petId, 'p1')
  assert.equal(aiCall.data.provider, 'auto')
})

test('playground page saveManualModel calls bindPetCustomModel', async () => {
  const { page, calls } = setupPlaygroundPage()
  page.data.pets = [{ _id: 'p1', name: '大黄' }]
  page.choosePet({ currentTarget: { dataset: { id: 'p1' } } })
  page.openCustomModal()

  page.onManualUrlInput({ detail: { value: 'cloud://my_custom_model.glb' } })
  await page.saveManualModel()

  const bindCall = calls.find(c => c.action === 'bindPetCustomModel')
  assert.ok(bindCall, 'Should call bindPetCustomModel')
  assert.equal(bindCall.data.petId, 'p1')
  assert.equal(bindCall.data.modelUrl, 'cloud://my_custom_model.glb')
})

test('playground page resetToDefaultModel calls bindPetCustomModel with empty modelUrl', async () => {
  const { page, calls } = setupPlaygroundPage()
  page.data.pets = [{ _id: 'p1', name: '大黄', customModelUrl: 'cloud://old.glb' }]
  page.choosePet({ currentTarget: { dataset: { id: 'p1' } } })
  page.openCustomModal()

  await page.resetToDefaultModel()

  const resetCall = calls.find(c => c.action === 'bindPetCustomModel' && c.data.modelUrl === '')
  assert.ok(resetCall, 'Should reset model with empty modelUrl')
})
