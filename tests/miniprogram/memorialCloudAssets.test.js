const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createCloudAssets, fileID, FILES } = require('../../miniprogram/packageMemorial/scene/cloud-assets')
const { setForceEnvId } = require('../../miniprogram/envList')
const { MemorialScene } = require('../../miniprogram/packageMemorial/scene/engine')
const { GardenSound } = require('../../miniprogram/packageMemorial/scene/sound')
const flush = () => new Promise(resolve => setImmediate(resolve))
function fixture() {
  const calls = [], paths = new Set()
  const api = { cloud: { downloadFile(options) { calls.push(options) } }, getFileSystemManager: () => ({
    accessSync(path) { if (!paths.has(path)) throw new Error('expired') }
  }) }
  const resolve = createCloudAssets(api)
  const finish = (n, path) => { paths.add(path); calls[n].success({ statusCode: 200, tempFilePath: path }) }
  return { calls, paths, api, resolve, finish }
}

test('versioned runtime keys route to the existing dev/production roots and reject unknown paths', () => {
  const world = require('../../miniprogram/packageMemorial/scene/world-template')
  assert.equal(FILES.filter(key => key.startsWith(world.CHUNK_DIRECTORY + '/')).length, world.WIDTH / world.CHUNK * world.HEIGHT / world.CHUNK)
  assert.ok(FILES.includes('seasons-v1/foliage.png'))
  assert.equal(new Set(FILES).size, FILES.length)
  for (const key of FILES) assert.ok(fs.existsSync(require('node:path').resolve(__dirname, '../../miniprogram/packageMemorial/assets', key)), key)
  const uploadedGarden = 'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/memorial-cloud-v1/packageMemorial/v1/garden.jpg'
  assert.equal(fileID('garden.jpg', 'cloud1-5gnhqn4t0554c1d9'), uploadedGarden)
  for (const key of FILES) assert.equal(fileID(key, 'cloud1-5gnhqn4t0554c1d9'), uploadedGarden.replace(/garden\.jpg$/, key))
  assert.match(fileID('audio/music.wav', 'production-d2g5jx277f41a81a6'), /^cloud:\/\/production-.*\/packageMemorial\/v1\/audio\/music.wav$/)
  assert.throws(() => fileID('../garden.jpg'), /无效/)
  assert.throws(() => fileID('garden.jpg', 'unknown'), /未配置/)
})

test('cloud download deduplicates pending calls, reuses valid temp files and refetches expired files', async () => {
  const f = fixture()
  const a = f.resolve('garden.jpg'), b = f.resolve('garden.jpg')
  assert.equal(a, b)
  assert.equal(f.calls.length, 1)
  f.finish(0, 'wxfile://garden')
  assert.equal(await a, 'wxfile://garden')
  assert.equal(await f.resolve('garden.jpg'), 'wxfile://garden')
  assert.equal(f.calls.length, 1)
  f.paths.clear()
  const again = f.resolve('garden.jpg')
  f.finish(1, 'wxfile://fresh')
  assert.equal(await again, 'wxfile://fresh')
  f.resolve.dispose()
})

test('failed downloads and corrupt images invalidate the cache; no package path fallback', async () => {
  const f = fixture()
  const failure = f.resolve('garden.jpg')
  f.calls[0].fail({ errMsg: 'missing' })
  await assert.rejects(failure, /资源下载失败/)
  const retry = f.resolve('garden.jpg')
  f.calls[1].success({ statusCode: 404, tempFilePath: 'bad' })
  await assert.rejects(retry, /不可用/)
  const third = f.resolve('garden.jpg')
  f.finish(2, 'wxfile://valid')
  await third
  f.resolve.invalidate('garden.jpg')
  const fourth = f.resolve('garden.jpg')
  f.finish(3, 'wxfile://new')
  await fourth
  assert.equal(f.calls.length, 4)
  f.resolve.dispose()
})

test('environment changes do not reuse a different bucket cache', async () => {
  const f = fixture()
  try {
    setForceEnvId('cloud1-5gnhqn4t0554c1d9')
    const dev = f.resolve('garden.jpg'); f.finish(0, 'wxfile://dev'); await dev
    setForceEnvId('production-d2g5jx277f41a81a6')
    const prod = f.resolve('garden.jpg'); f.finish(1, 'wxfile://prod')
    assert.equal(await prod, 'wxfile://prod')
    assert.notEqual(f.calls[0].fileID, f.calls[1].fileID)
  } finally { setForceEnvId(''); f.resolve.dispose() }
})

test('disposing a page rejects outstanding downloads and ignores late completion', async () => {
  const f = fixture()
  const pending = f.resolve('audio/music.wav')
  f.resolve.dispose()
  await assert.rejects(pending, /已关闭/)
  f.finish(0, 'wxfile://late')
  await assert.rejects(f.resolve('audio/music.wav'), /已关闭/)
})

test('Canvas2D decodes cloud temp files only after downloading and can retry a decode failure', async () => {
  const f = fixture(), images = []
  const scene = new MemorialScene({ getContext: () => ({}), cancelAnimationFrame() {}, createImage() {
    const img = {}; images.push(img); return img
  } }, { resolveAsset: f.resolve })
  const pending = scene.image('girl/walk-ne.png')
  assert.equal(images.length, 0)
  f.finish(0, 'wxfile://atlas'); await flush()
  assert.equal(images[0].src, 'wxfile://atlas')
  images[0].onerror()
  await assert.rejects(pending, /未能加载/)
  const retry = scene.image('girl/walk-ne.png')
  assert.equal(f.calls.length, 2)
  f.finish(1, 'wxfile://atlas-retry'); await flush()
  images[1].onload()
  assert.equal(await retry, images[1])
  scene.destroy(); f.resolve.dispose()
})

test('cloud audio waits for download and never starts a late download after mute, hide or destroy', async () => {
  for (const action of ['mute', 'hide', 'destroy', 'play']) {
    let finish
    const node = { plays: 0, onError() {}, play() { this.plays++ }, pause() {}, seek() {}, destroy() {} }
    const sound = new GardenSound(() => node, () => {}, () => new Promise(resolve => { finish = resolve }))
    sound.toggle('music')
    assert.equal(node.plays, 0)
    if (action === 'mute') sound.toggle('music')
    if (action === 'hide') sound.pause()
    if (action === 'destroy') sound.destroy()
    finish('wxfile://music'); await flush()
    assert.equal(node.plays, action === 'play' ? 1 : 0)
    if (action === 'play') assert.equal(node.src, 'wxfile://music')
    sound.destroy()
  }
})

test('native page injects the cloud resolver into both images and audio; packer excludes all local resources', () => {
  let page, sceneOptions, soundResolver
  const resolver = () => Promise.resolve('wxfile://cloud')
  resolver.dispose = () => {}
  vm.runInNewContext(fs.readFileSync(require.resolve('../../miniprogram/packageMemorial/pages/garden'), 'utf8'), {
    setTimeout, clearTimeout, Page: definition => { page = definition }, wx: { getStorageSync() {} },
    require: name => ({
      '../scene/cloud-assets': { createCloudAssets: () => resolver, createCloudChunks: () => () => Promise.resolve({}) },
      '../scene/sound': { GardenSound: class { constructor(create, error, resolve) { soundResolver = resolve } pause() {} configure() {} } },
      '../scene/gestures': { MapGestures: class {} },
      '../scene/world-index': require('../../miniprogram/packageMemorial/scene/world-index'),
      '../scene/plot-layout': require('../../miniprogram/packageMemorial/scene/plot-layout'),
      '../scene/terrain': require('../../miniprogram/packageMemorial/scene/terrain'),
      '../scene/plot-number': require('../../miniprogram/packageMemorial/scene/plot-number'),
      '../scene/engine': { MemorialScene: class { constructor(canvas, options) { sceneOptions = options }
        load() { return new Promise(() => {}) } } }
    })[name]
  })
  page.setData = value => Object.assign(page.data, value)
  page.onLoad()
  page.measure = callback => callback({ node: {}, width: 390, height: 740 }, 2)
  page.initialize()
  assert.equal(soundResolver, resolver)
  assert.equal(sceneOptions.resolveAsset, resolver)
  const config = require('../../project.config.json')
  assert.ok(config.packOptions.ignore.some(item => item.type === 'folder' && item.value === 'packageMemorial/assets'))
})
