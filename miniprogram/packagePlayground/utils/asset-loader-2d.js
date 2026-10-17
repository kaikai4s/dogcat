const CLOUD_ASSET_BASE =
  'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/2d/baseImage'
const ASSET_NAMES = [
  'grass_tile',
  'house',
  'tree',
  'flower_bush',
  'street_lamp',
  'dog_stand',
  'dog_run',
  'cat_stand',
  'cat_run',
  'stone_tile',
  'road_tile'
]
const downloads = new Map()
function download(name) {
  const id = CLOUD_ASSET_BASE + '/' + name + '.png'
  if (!downloads.has(id))
    downloads.set(
      id,
      new Promise((resolve, reject) =>
        wx.cloud.downloadFile({
          fileID: id,
          success: (r) =>
            r.tempFilePath
              ? resolve(r.tempFilePath)
              : reject(new Error('云图片未返回有效文件')),
          fail: reject
        })
      ).catch((e) => {
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
  async loadPrepared(name) {
    const path = await download(name)
    const img = await new Promise((resolve, reject) => {
      const i = this.canvas.createImage()
      i.onload = () => resolve(i)
      i.onerror = reject
      i.src = path
    }).catch((error) => {
      downloads.delete(CLOUD_ASSET_BASE + '/' + name + '.png')
      throw error
    })
    const prepared = prepare(img, name)
    this.cache.set(name, prepared)
    return prepared
  }
  async loadAll(progress, names = ASSET_NAMES) {
    const result = {}
    let next = 0,
      done = 0
    const worker = async () => {
      while (next < names.length) {
        const name = names[next++]
        result[name] = await this.loadImage(name)
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
