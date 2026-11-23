const test = require('node:test')
const assert = require('node:assert/strict')
const { createCloudAssets, getManorAssetFileId, hasManorAssets } = require('../../miniprogram/packageManor3d/utils/cloud-assets')

const TRIAL = 'cloud1-5gnhqn4t0554c1d9'
const PRODUCTION = 'production-d2g5jx277f41a81a6'
const ROOT = 'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/3d/assets/manor-v1/'
const flush = () => new Promise(resolve => setImmediate(resolve))

function glb() {
  const data = new ArrayBuffer(24)
  const view = new DataView(data)
  for (const [offset, value] of [[0, 0x46546c67], [4, 2], [8, 24], [12, 4], [16, 0x4e4f534a], [20, 0x20207d7b]]) {
    view.setUint32(offset, value, true)
  }
  return data
}

function fixture() {
  const files = new Map(), calls = [], saved = []
  const fs = {
    readFile({ filePath, success, fail }) {
      if (files.has(filePath)) success({ data: files.get(filePath) })
      else fail({ errMsg: 'file does not exist' })
    },
    saveFile({ tempFilePath, filePath, success }) {
      files.set(filePath, files.get(tempFilePath))
      files.delete(tempFilePath)
      saved.push(filePath)
      success({ savedFilePath: filePath })
    },
    unlinkSync(path) { files.delete(path) }
  }
  const wx = {
    env: { USER_DATA_PATH: 'wxfile://store' },
    getFileSystemManager: () => fs,
    cloud: { downloadFile(options) {
      const call = { options, progress: null, aborts: 0 }
      calls.push(call)
      return { onProgressUpdate: fn => { call.progress = fn }, abort: () => { call.aborts++ } }
    } }
  }
  function finish(index, data) {
    const path = 'wxfile://temp-' + index
    files.set(path, data)
    calls[index].options.success({ statusCode: 200, tempFilePath: path })
    return path
  }
  return { wx, fs, files, calls, saved, finish, create: () => createCloudAssets({ wx, envId: TRIAL }) }
}

test('only the confirmed cloud environment can use the uploaded 3D asset files', async () => {
  assert.equal(getManorAssetFileId(TRIAL, 'layout'), ROOT + 'layout.json')
  assert.equal(getManorAssetFileId(TRIAL, 'manor'), ROOT + 'manor.glb')
  assert.equal(getManorAssetFileId(TRIAL, 'villa'), ROOT + 'manor-villa.glb')
  assert.equal(getManorAssetFileId(TRIAL, 'courtyardVilla'), ROOT + 'courtyard-villa.glb')
  assert.equal(getManorAssetFileId(TRIAL, 'interiorModel'), ROOT + 'model.json')
  assert.equal(getManorAssetFileId(TRIAL, 'interior'), ROOT + 'manor-villa-interior.glb')
  assert.equal(getManorAssetFileId(TRIAL, 'boy'), ROOT + 'boy-animated.glb')
  assert.equal(getManorAssetFileId(TRIAL, 'girl'), ROOT + 'girl-animated.glb')
  assert.equal(getManorAssetFileId(TRIAL, 'dog'), ROOT + 'dog.glb')
  assert.equal(getManorAssetFileId(TRIAL, 'cat'), ROOT + 'cat.glb')
  assert.equal(getManorAssetFileId(TRIAL, 'car'), ROOT + 'copper-gt-fitted.glb')
  assert.equal(getManorAssetFileId(PRODUCTION, 'boy'), '')
  assert.equal(getManorAssetFileId(PRODUCTION, 'girl'), '')
  assert.equal(getManorAssetFileId(PRODUCTION, 'car'), '')
  assert.equal(getManorAssetFileId(PRODUCTION, 'courtyardVilla'), '')
  assert.equal(getManorAssetFileId(TRIAL, '../layout.json'), '')
  assert.equal(hasManorAssets(PRODUCTION), false)
  assert.equal(hasManorAssets('constructor'), false)
  const f = fixture()
  await assert.rejects(createCloudAssets({ wx: f.wx, envId: PRODUCTION }).read('manor'), { code: 'MANOR_ASSETS_UNAVAILABLE' })
  assert.equal(f.calls.length, 0)
})

test('the courtyard villa downloads and caches separately from the existing demo villa', async () => {
  const f = fixture(), assets = f.create(), demo = glb(), courtyard = glb()
  const demoPath = 'wxfile://store/dogcat-manor-v1-' + TRIAL + '-manor-villa.glb'
  f.files.set(demoPath, demo)
  const pending = assets.read('courtyardVilla')
  await flush()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].options.fileID, ROOT + 'courtyard-villa.glb')
  f.finish(0, courtyard)
  assert.equal(await pending, courtyard)
  assert.equal(await f.create().read('courtyardVilla'), courtyard)
  assets.invalidate('courtyardVilla')
  assert.equal(await assets.read('villa'), demo)
  assert.equal(f.calls.length, 1)
})

test('GLB reads share a download with progress and persist only validated files across page instances', async () => {
  const f = fixture(), assets = f.create(), progress = [], alsoProgress = []
  const first = assets.read('manor', { onProgress: event => progress.push(event.progress) })
  const concurrent = assets.read('manor', { onProgress: event => alsoProgress.push(event.progress) })
  assert.equal(first, concurrent)
  await flush()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].options.fileID, ROOT + 'manor.glb')
  assert.deepEqual(f.calls[0].options.config, { env: TRIAL })
  f.calls[0].progress({ progress: 45, totalBytesWritten: 26500000, totalBytesExpectedToWrite: 58869484 })
  const data = glb(), temp = f.finish(0, data)
  assert.equal(await first, data)
  assert.deepEqual(progress, [45, 100])
  assert.deepEqual(alsoProgress, [45, 100])
  assert.equal(f.files.has(temp), false)
  assert.equal(await f.create().read('manor'), data)
  assert.equal(f.calls.length, 1)
  assert.ok(f.saved[0].includes(TRIAL))

  f.files.set(f.saved[0], new ArrayBuffer(24))
  const retry = f.create().read('manor')
  await flush()
  assert.equal(f.calls.length, 2)
  f.finish(1, glb())
  assert.ok(await retry instanceof ArrayBuffer)
  assets.invalidate('manor')
  assert.equal(f.files.has(f.saved[0]), false)
})

test('fallback resolves the same cloud file, downloads it, and still works if local storage is full', async () => {
  const f = fixture(), progress = [], payload = '{"plots":[]}'
  f.wx.cloud.downloadFile = () => Promise.reject(new Error('cloud download unavailable'))
  f.wx.cloud.getTempFileURL = ({ fileList, config }) => {
    assert.deepEqual(fileList, [ROOT + 'layout.json'])
    assert.deepEqual(config, { env: TRIAL })
    return Promise.resolve({ fileList: [{ fileID: fileList[0], status: 0, tempFileURL: 'https://storage.example/layout.json' }] })
  }
  f.fs.saveFile = ({ fail }) => fail({ errMsg: 'disk full' })
  f.wx.downloadFile = options => {
    assert.equal(options.url, 'https://storage.example/layout.json')
    f.files.set('wxfile://signed', payload)
    options.success({ statusCode: 200, tempFilePath: 'wxfile://signed' })
  }
  assert.equal(await f.create().read('layout', { onProgress: event => progress.push(event.progress) }), payload)
  assert.deepEqual(progress, [0, 100])
  assert.equal(f.files.size, 0)
})

test('interior metadata is read as UTF-8 text and cached only after anchor validation', async () => {
  const f = fixture(), metadata = JSON.stringify({
    model: 'manor-villa-interior.glb',
    anchors: { FrontDoor: { position: [2.7, .4, 3.1] }, InteriorSpawn: { position: [2.7, .41, 1.97] } }
  })
  const readOptions = []
  const originalRead = f.fs.readFile
  f.fs.readFile = options => {
    if (options.filePath.includes('model.json')) readOptions.push(options)
    return originalRead(options)
  }
  const promise = f.create().read('interiorModel')
  await flush()
  assert.equal(f.calls[0].options.fileID, ROOT + 'model.json')
  const path = 'wxfile://metadata'
  f.files.set(path, metadata)
  f.calls[0].options.success({ statusCode: 200, tempFilePath: path })
  assert.equal(await promise, metadata)
  assert.equal(readOptions[0].encoding, 'utf8')
  const bad = fixture(), invalid = bad.create().read('interiorModel')
  await flush()
  bad.files.set('wxfile://invalid', '{}')
  bad.calls[0].options.success({ statusCode: 200, tempFilePath: 'wxfile://invalid' })
  await assert.rejects(invalid, { code: 'MANOR_ASSET_INVALID' })
})

test('the elevator interior bypasses the old staircase cache', async () => {
  const f = fixture()
  const old = glb()
  f.files.set('wxfile://store/dogcat-manor-v1-' + TRIAL + '-manor-villa-interior.glb', old)
  const load = f.create().read('interior')
  await flush()
  assert.equal(f.calls[0].options.fileID, ROOT + 'manor-villa-interior.glb')
  const elevator = glb()
  f.finish(0, elevator)
  assert.equal(await load, elevator)
  assert.equal(await f.create().read('interior'), elevator)
  assert.equal(f.calls.length, 1)
})

test('a truncated cloud model is rejected and removed instead of persisting', async () => {
  const f = fixture(), assets = f.create()
  const read = assets.read('villa')
  await flush()
  const data = glb()
  new DataView(data).setUint32(8, 100, true)
  f.finish(0, data)
  await assert.rejects(read, { code: 'MANOR_ASSET_INVALID' })
  assert.equal(f.files.size, 0)
  assert.equal(f.saved.length, 0)
})

test('leaving 3D aborts an active download and discards late files without starting a fallback', async () => {
  const f = fixture(), assets = f.create(), progress = []
  let signedRequests = 0
  f.wx.cloud.getTempFileURL = () => { signedRequests++ }
  f.wx.downloadFile = () => {}
  const read = assets.read('villa', { onProgress: event => progress.push(event.progress) })
  await flush()
  assets.cancel()
  await assert.rejects(read, { code: 'MANOR_LOAD_CANCELLED' })
  assert.equal(f.calls[0].aborts, 1)
  f.calls[0].progress({ progress: 80 })
  const path = f.finish(0, glb())
  assert.equal(f.files.has(path), false)
  assert.deepEqual(progress, [])
  assert.equal(signedRequests, 0)
  await assert.rejects(assets.read('layout'), { code: 'MANOR_LOAD_CANCELLED' })
})
