const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const fs = require('node:fs')
const path = require('node:path')
const flush = () => new Promise(resolve => setImmediate(resolve))
function setup(files, { failCompression = false, neverSmall = false } = {}) {
  const compressions = [], uploads = [], module = { exports: {} }
  const wx = {
    getImageInfo(o) { const image = files[o.src]; image ? o.success(image) : o.fail(new Error('missing image')) },
    getFileSystemManager() { return { getFileInfo(o) { o.success({ size: files[o.filePath].size }) } } },
    compressImage(o) {
      compressions.push(o)
      if (failCompression) return o.fail(new Error('compression failed'))
      const file = '/compressed-' + compressions.length + '.jpg'
      files[file] = { width: o.compressedWidth, height: o.compressedHeight, size: neverSmall ? 3e6 : 100000, type: 'jpeg' }
      o.success({ tempFilePath: file })
    },
    cloud: { uploadFile(o) { uploads.push(o); o.success({ fileID: 'cloud://env/' + o.cloudPath }); return { onProgressUpdate(fn) { fn({ progress: 100 }) } } } }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/utils/image-upload.js'), 'utf8'), { module, wx, console })
  return { api: module.exports, compressions, uploads }
}

test('large photos are resized before uploading and receive an extension matching the processed format', async () => {
  const { api, compressions, uploads } = setup({ '/photo.png': { width: 4000, height: 3000, size: 4e6, type: 'png' } })
  const result = await api.uploadImage({ filePath: '/photo.png', cloudPath: 'checkins/order/photo.png' })
  assert.equal(compressions.length, 1)
  assert.equal(compressions[0].compressedWidth, 750)
  assert.equal(compressions[0].compressedHeight, 562)
  assert.equal(uploads[0].filePath, '/compressed-1.jpg')
  assert.equal(result.fileID, 'cloud://env/checkins/order/photo.jpg')
})

test('small valid images preserve their original pixels without recompression', async () => {
  const { api, compressions, uploads } = setup({ '/small.png': { width: 512, height: 512, size: 50000, type: 'png' } })
  await api.uploadImage({ filePath: '/small.png', cloudPath: 'photos/small.png' })
  assert.equal(compressions.length, 0)
  assert.equal(uploads[0].filePath, '/small.png')
})

test('invalid formats, compression failures, and oversized output never upload the unchecked original', async () => {
  const files = { '/big.jpg': { width: 4000, height: 3000, size: 4e6, type: 'jpeg' }, '/bad.gif': { width: 10, height: 10, size: 1000, type: 'gif' } }
  for (const options of [{ failCompression: true }, { neverSmall: true }]) {
    const { api, uploads } = setup({ ...files }, options)
    await assert.rejects(api.uploadImage({ filePath: '/big.jpg', cloudPath: 'photos/big.jpg' }))
    assert.equal(uploads.length, 0)
  }
  const { api, uploads } = setup(files)
  await assert.rejects(api.uploadImage({ filePath: '/bad.gif', cloudPath: 'photos/bad.gif' }), /JPG 或 PNG/)
  assert.equal(uploads.length, 0)
})

test('callback callers retain progress updates and receive compression failures through fail', async () => {
  const { api } = setup({ '/small.png': { width: 20, height: 20, size: 100, type: 'png' } })
  let progress = 0, result
  const task = api.uploadImage({ filePath: '/small.png', cloudPath: 'small.png', success(value) { result = value } })
  task.onProgressUpdate(event => { progress = event.progress })
  await flush()
  assert.equal(progress, 100)
  assert.ok(result.fileID)
  const failed = setup({ '/big.jpg': { width: 4000, height: 3000, size: 4e6, type: 'jpeg' } }, { failCompression: true })
  let error
  failed.api.uploadImage({ filePath: '/big.jpg', cloudPath: 'big.jpg', fail(value) { error = value } })
  await flush()
  assert.ok(error)
  assert.equal(failed.uploads.length, 0)
})
