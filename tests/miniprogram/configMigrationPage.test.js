const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
function setup({ confirm = true, file = { name: 'config.json', size: 100, path: '/selected.json' }, contents = '{"format":"dogcat-config"}', failShare = false } = {}) {
  let page
  const calls = [], errors = [], writes = [], shares = [], modals = [], storage = {}
  let env = 'production-env'
  const preview = { token: 'preview-token', source: { envId: 'test-env' }, target: { envId: env }, changedCount: 4, summary: [], assets: [{ source: 'old', target: 'new' }] }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/config-migration/index.js'), 'utf8'), {
    Page: value => { page = value },
    require: () => ({ getCloudEnv: () => env, setCachedSystemSettings() {}, showError: error => errors.push(error.message),
      callFunction: async (module, action, data) => {
        calls.push({ module, action, data })
        if (action === 'preview') return preview
        if (action === 'import') return { backupId: 'migration_backup', changedCount: 4 }
        return { format: 'dogcat-config', sections: {} }
      } }),
    wx: { env: { USER_DATA_PATH: '/wx-user' },
      getStorageSync: key => storage[key], setStorageSync: (key, value) => { storage[key] = value },
      getFileSystemManager: () => ({ readFile: options => options.success({ data: contents }), writeFile: options => { writes.push(options); options.success() } }),
      chooseMessageFile: options => options.success({ tempFiles: [file] }),
      shareFileMessage: options => { shares.push(options); if (failShare) options.fail({ errMsg: 'cancel' }); else options.success() },
      showModal: options => { modals.push(options); options.success({ confirm }) }, showToast() {}
    }
  })
  page.setData = patch => Object.assign(page.data, patch)
  page.onShow()
  return { page, calls, errors, writes, shares, modals, storage, setEnv(value) { env = value } }
}

test('exports JSON through the backend and allows cancelled sharing without losing the file', async () => {
  const { page, calls, writes, shares } = setup({ failShare: true })
  await page.exportConfig()
  assert.equal(calls[0].module, 'configMigration')
  assert.equal(calls[0].action, 'export')
  assert.equal(JSON.parse(writes[0].data).format, 'dogcat-config')
  assert.match(writes[0].filePath, /\.json$/)
  assert.equal(page.data.savedPath, writes[0].filePath)
  assert.equal(shares.length, 1)
  assert.equal(page.data.busy, false)
})

test('choosing a file only previews and cancellation never imports', async () => {
  const { page, calls, modals } = setup({ confirm: false })
  await page.chooseImport()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'preview')
  await page.importConfig()
  assert.equal(calls.length, 1)
  assert.match(modals[0].content, /test-env/)
  assert.match(modals[0].content, /production-env/)
  assert.equal(page.data.busy, false)
})

test('confirmed import sends the reviewed token, caches settings and retains a downloadable backup', async () => {
  const { page, calls, storage } = setup()
  await page.chooseImport()
  await page.importConfig()
  const imported = calls.find(call => call.action === 'import')
  assert.equal(imported.data.token, 'preview-token')
  assert.equal(imported.data.confirmEnvId, 'production-env')
  assert.match(imported.data.requestId, /^config_/)
  assert.equal(page.data.preview, null)
  assert.equal(storage.config_migration_last_backup_production_env, undefined)
  assert.equal(storage['config_migration_last_backup_production-env'], 'migration_backup')
  await page.exportBackup()
  assert.equal(calls.find(call => call.action === 'backup').data.id, 'migration_backup')
})

test('malformed files and environment switches cannot initiate import', async () => {
  for (const options of [{ contents: 'not json' }, { file: { name: 'large.json', size: 900000, path: '/big' } }]) {
    const { page, calls, errors } = setup(options)
    await page.chooseImport()
    assert.equal(calls.length, 0)
    assert.equal(page.data.preview, null)
    assert.ok(errors.length)
  }
  const { page, calls, errors, setEnv } = setup()
  await page.chooseImport()
  setEnv('other-env')
  await page.importConfig()
  assert.ok(!calls.some(call => call.action === 'import'))
  assert.match(errors.at(-1), /环境已变化/)
})

test('asset manifest contains the exact remapped source and destination paths', async () => {
  const { page, writes } = setup()
  await page.chooseImport()
  await page.exportAssetList()
  const manifest = JSON.parse(writes[0].data)
  assert.equal(manifest.files[0].source, 'old')
  assert.equal(manifest.files[0].target, 'new')
})
