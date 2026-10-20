const CLOUD_ASSET_BASE =
  'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/2d/baseImage'
const { YARD_EXTRAS } = require('./yard-layout')
const { CHARACTER_ASSETS } = require('./character-assets')
const { PET_ATLASES } = require('./pet-assets')
const ASSET_NAMES = [
  'grass_tile',
  'house',
  'tree',
  'flower_bush',
  'street_lamp',
  'dog_walk',
  'cat_walk',
  'stone_tile',
  'road_tile',
  ...YARD_EXTRAS
]
const downloads = new Map()
function isDirectPath(str) {
  if (typeof str !== 'string') return false
  return (
    str.startsWith('cloud://') ||
    str.startsWith('http://') ||
    str.startsWith('https://') ||
    str.startsWith('wxfile://') ||
    str.startsWith('/')
  )
}
function assetId(name) {
  if (isDirectPath(name)) return name
  return CHARACTER_ASSETS[name] || (PET_ATLASES[name] && PET_ATLASES[name].fileID) || CLOUD_ASSET_BASE + '/' + name + '.png'
}
function download(name) {
  const id = assetId(name)
  if (id.startsWith('/') || id.startsWith('wxfile://')) return Promise.resolve(id)
  if (!downloads.has(id))
    downloads.set(
      id,
      new Promise((resolve, reject) => {
        if (id.startsWith('http://') || id.startsWith('https://')) {
          if (typeof wx !== 'undefined' && typeof wx.downloadFile === 'function') {
            wx.downloadFile({
              url: id,
              success: (r) =>
                r.tempFilePath
                  ? resolve(r.tempFilePath)
                  : reject(new Error('网络图片下载未返回有效文件')),
              fail: reject
            })
          } else {
            resolve(id)
          }
        } else if (typeof wx !== 'undefined' && wx.cloud && typeof wx.cloud.downloadFile === 'function') {
          wx.cloud.downloadFile({
            fileID: id,
            success: (r) =>
              r.tempFilePath
                ? resolve(r.tempFilePath)
                : reject(new Error('云图片未返回有效文件')),
            fail: reject
          })
        } else {
          resolve(id)
        }
      }).catch((e) => {
        downloads.delete(id)
        throw e
      })
    )
  return downloads.get(id)
}
function surface(width, height) {
  return wx.createOffscreenCanvas({ type: '2d', width, height })
}
function prepare(image, name) {
  // Character assets already have alpha and fixed anchors. Background removal
  // would damage white shoes; resizing an atlas would break its frame grid.
  if (isDirectPath(name) || CHARACTER_ASSETS[name] || PET_ATLASES[name]) return image
  if (name === 'grass_tile') {
    const tile = surface(256, 256),
      c = tile.getContext('2d')
    const w = image.width,
      h = image.height
    // Mirrored interior samples meet at every edge without the source's soil rim.
    for (let i = 0; i < 4; i++) {
      c.save()
      c.translate(i % 2 ? 256 : 0, i > 1 ? 256 : 0)
      c.scale(i % 2 ? -1 : 1, i > 1 ? -1 : 1)
      c.drawImage(image, w * 0.4, h * 0.4, w * 0.2, h * 0.2, 0, 0, 128, 128)
      c.restore()
    }
    return tile
  }
  const size = name === 'house' ? 640 : 320
  const out = surface(size, size),
    c = out.getContext('2d')
  c.drawImage(image, 0, 0, size, size)
  const pixels = c.getImageData(0, 0, size, size),
    d = pixels.data
  const seen = new Uint8Array(size * size),
    q = new Int32Array(size * size)
  let head = 0,
    tail = 0
  const add = (p) => {
    if (seen[p]) return
    seen[p] = 1
    const j = p * 4,
      lo = Math.min(d[j], d[j + 1], d[j + 2]),
      hi = Math.max(d[j], d[j + 1], d[j + 2])
    if (d[j + 3] < 10 || (lo > 185 && hi - lo < 18)) q[tail++] = p
  }
  for (let i = 0; i < size; i++) {
    add(i)
    add((size - 1) * size + i)
    add(i * size)
    add(i * size + size - 1)
  }
  while (head < tail) {
    const p = q[head++]
    d[p * 4 + 3] = 0
    if (p % size) add(p - 1)
    if (p % size < size - 1) add(p + 1)
    if (p >= size) add(p - size)
    if (p < size * (size - 1)) add(p + size)
  }
  if (name === 'tree') {
    // The source includes a concrete planting tile and a blue baked shadow.
    // Keep the colored trunk and grass at its base so it sits on our lawn.
    for (let y = Math.floor(size * 0.6); y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        const green = d[i + 1] > d[i] * 0.92 && d[i + 1] > d[i + 2] * 1.3
        const wood = d[i] > d[i + 1] * 1.18 && d[i] > d[i + 2] * 1.5
        if (!green && !wood) d[i + 3] = 0
      }
    }
  }
  c.putImageData(pixels, 0, 0)
  // The villa image has a blue shadow baked over its checkerboard. Trim only
  // the area below the walls and outside the original ground platform.
  if (name === 'house') {
    c.save()
    c.globalCompositeOperation = 'destination-in'
    c.beginPath()
    c.moveTo(0, 0)
    c.lineTo(size, 0)
    c.lineTo(size, size * 0.64)
    c.lineTo(size * 0.955, size * 0.64)
    c.lineTo(size * 0.96, size * 0.675)
    c.lineTo(size * 0.47, size * 0.922)
    c.lineTo(size * 0.025, size * 0.705)
    c.lineTo(0, size * 0.64)
    c.closePath()
    c.fill()
    c.restore()
  }
  return out
}
class AssetLoader2D {
  constructor(canvas) {
    this.canvas = canvas
    this.cache = new Map()
    this.inflight = new Map()
  }
  async loadImage(name) {
    if (this.cache.has(name)) return this.cache.get(name)
    if (this.inflight.has(name)) return this.inflight.get(name)
    const promise = this.loadPrepared(name).finally(() =>
      this.inflight.delete(name)
    )
    this.inflight.set(name, promise)
    return promise
  }
  async loadAtlas(atlas) {
    const image=await this.loadImage(atlas.fileID)
    if(image.width!==atlas.columns*atlas.frameSize || image.height!==atlas.rows*atlas.frameSize) {
      this.cache.delete(atlas.fileID)
      downloads.delete(atlas.fileID)
      throw new Error('专属形象图集尺寸不匹配')
    }
    return image
  }
  async loadPrepared(name) {
    const path = await download(name)
    const img = await new Promise((resolve, reject) => {
      const i = this.canvas.createImage()
      i.onload = () => resolve(i)
      i.onerror = reject
      i.src = path
    }).catch((error) => {
      downloads.delete(assetId(name))
      throw error
    })
    const prepared = prepare(img, name)
    this.cache.set(name, prepared)
    return prepared
  }
  async loadAll(progress, names = ASSET_NAMES, { optional = false } = {}) {
    const result = {}
    let next = 0,
      done = 0
    const worker = async () => {
      while (next < names.length) {
        const name = names[next++]
        try {
          result[name] = await this.loadImage(name)
        } catch (error) {
          if (!optional) throw error
        }
        if (progress) progress(Math.round((++done / names.length) * 100), name)
      }
    }
    await Promise.all([worker(), worker(), worker()])
    return result
  }
  get(name) {
    return this.cache.get(name) || null
  }
}
module.exports = { AssetLoader2D, ASSET_NAMES, prepare }
