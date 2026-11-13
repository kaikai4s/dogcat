const test = require('node:test')
const assert = require('node:assert/strict')
const { preparePortraitImage, MAX_UPLOAD_BYTES } = require('../../miniprogram/pages/admin/memorial/portrait-upload')
function setup({ width = 1024, height = 1024, size = 3 * 1024 * 1024, sizes = [200000], type = 'png', decodeError = false } = {}) {
  const draws = [], exports = [], source = '/source.png'
  let count = 0, disposed = false
  const canvas = { createImage() { return { set src(value) { assert.equal(value, source); decodeError ? this.onerror() : this.onload() } } },
    getContext() { return { clearRect(...args) { assert.deepEqual(args, [0, 0, 512, 512]) }, drawImage(...args) { draws.push(args.slice(1)) } } } }
  const api = {
    getFileSystemManager: () => ({ getFileInfo(o) { o.success({size:o.filePath === source ? size : sizes[Math.min(count - 1, sizes.length - 1)]}) } }),
    getImageInfo(o) { o.success({ width, height, type }) },
    canvasToTempFilePath(o) { exports.push(o); count++; o.success({tempFilePath:'/export-' + count + '.png'}) }
  }
  return { draws, exports, canvas, cancel() { disposed = true },
    run: () => preparePortraitImage({tempFilePath:source,size}, api, async () => canvas, () => disposed) }
}
test('album PNG larger than 1MB is exported as a bounded transparent PNG before uploading', async () => {
  const f = setup(), result = await f.run()
  assert.equal(result.filePath, '/export-1.png'); assert.ok(result.size <= MAX_UPLOAD_BYTES)
  assert.deepEqual(f.draws, [[0, 0, 512, 512]])
  assert.equal(f.exports[0].fileType, 'png'); assert.equal(f.exports[0].destWidth, 512)
  assert.equal(f.canvas.width, 1); assert.equal(f.canvas.height, 1)
})
test('wide sleeping pets and tall standing pets fit without cropping or stretching', async () => {
  const wide = setup({width:2048,height:1024}), tall = setup({width:1024,height:2048})
  await wide.run(); await tall.run()
  assert.deepEqual(wide.draws, [[0, 128, 512, 256]])
  assert.deepEqual(tall.draws, [[128, 0, 256, 512]])
})
test('large exports reduce subject resolution inside the same canvas and stay within the upload budget', async () => {
  const f = setup({sizes:[1100000,950000,700000]})
  assert.equal((await f.run()).filePath, '/export-3.png')
  assert.deepEqual(f.draws, [[0,0,512,512],[32,32,448,448],[64,64,384,384]])
  assert.ok(f.exports.every(o => o.destWidth === 512 && o.destHeight === 512))
  const tooLarge = setup({sizes:[1100000]})
  await assert.rejects(tooLarge.run(), /仍然过大/); assert.equal(tooLarge.exports.length, 4)
})
test('bad source files and unloads never produce an uploadable image', async () => {
  for (const [options, message] of [[{size:11*1024*1024},/10MB/],[{size:0},/为空/],[{width:8192},/4096/],[{type:'jpeg'},/透明 PNG/],[{decodeError:true},/完整 PNG/]]) {
    const f=setup(options); await assert.rejects(f.run(),message); assert.equal(f.exports.length,0)
  }
  const f=setup();f.cancel();await assert.rejects(f.run(),/取消/);assert.equal(f.exports.length,0)
})
