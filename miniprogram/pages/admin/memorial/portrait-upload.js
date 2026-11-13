const MAX_SOURCE_BYTES = 10 * 1024 * 1024
const MAX_UPLOAD_BYTES = 900 * 1024
const OUTPUT_SIZE = 512

// Decode and export pixels instead of forwarding album container/metadata bytes.
// Keep alpha: the ordinary photo compressor can turn a PNG into an opaque JPEG.
async function preparePortraitImage(file, api, getCanvas, isCancelled = () => false) {
  const source = file && (file.tempFilePath || file.path)
  if (!source) throw new Error('请从相册选择透明 PNG 画像')
  const invoke = (target, name, options) => new Promise((resolve, reject) => {
    if (!target || typeof target[name] !== 'function') return reject(new Error('当前微信版本不支持画像处理，请更新微信后重试'))
    target[name]({ ...options, success: resolve, fail: reject })
  })
  const checkActive = () => { if (isCancelled()) throw new Error('已取消画像上传') }
  const fs = api.getFileSystemManager && api.getFileSystemManager()
  const original = await invoke(fs, 'getFileInfo', { filePath: source })
  if (!(original.size > 0)) throw new Error('图片文件为空，请重新保存原图')
  if (original.size > MAX_SOURCE_BYTES) throw new Error('请选择不超过 10MB 的透明 PNG 画像')
  checkActive()
  const info = await invoke(api, 'getImageInfo', { src: source })
  if (String(info.type).toLowerCase() !== 'png') throw new Error('请选择透明 PNG 原图；请重新下载并保存原图，不要截图或转换为 JPG')
  if (![info.width, info.height].every(value => Number.isInteger(value) && value > 0 && value <= 4096)) throw new Error('画像边长不能超过 4096 像素，请缩小后重试')
  checkActive()
  const canvas = await getCanvas()
  if (!canvas || typeof canvas.createImage !== 'function') throw new Error('画像处理画布未就绪，请重新进入页面后重试')
  try {
    checkActive()
    canvas.width = OUTPUT_SIZE; canvas.height = OUTPUT_SIZE
    const image = canvas.createImage()
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); image.onload = null; image.onerror = null; error ? reject(error) : resolve() }
      const timer = setTimeout(() => finish(new Error('读取画像超时，请重新保存原图后再试')), 15000)
      image.onload = () => finish()
      image.onerror = () => finish(new Error('无法读取画像，请重新下载并保存完整 PNG 原图'))
      try { image.src = source } catch (_) { finish(new Error('无法读取画像，请重新下载并保存完整 PNG 原图')) }
    })
    const context = canvas.getContext('2d')
    // Rare noisy images may still exceed the upload budget. Reduce the drawn
    // subject on the same transparent 512px canvas; server alpha bounds keep
    // its platform size unchanged. Never crop or stretch the pet.
    for (const side of [512, 448, 384, 320]) {
      checkActive()
      const ratio = side / Math.max(info.width, info.height)
      const width = info.width * ratio, height = info.height * ratio
      context.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
      context.drawImage(image, (OUTPUT_SIZE - width) / 2, (OUTPUT_SIZE - height) / 2, width, height)
      const result = await invoke(api, 'canvasToTempFilePath', { canvas, x: 0, y: 0,
        width: OUTPUT_SIZE, height: OUTPUT_SIZE, destWidth: OUTPUT_SIZE, destHeight: OUTPUT_SIZE, fileType: 'png' })
      if (!result.tempFilePath) throw new Error('画像整理失败，请重新选择原图')
      const exported = await invoke(fs, 'getFileInfo', { filePath: result.tempFilePath })
      if (!(exported.size > 0)) throw new Error('画像整理结果为空，请重新选择原图')
      checkActive()
      if (exported.size <= MAX_UPLOAD_BYTES) return { filePath: result.tempFilePath, size: exported.size }
    }
    throw new Error('画像整理后仍然过大，请选择内容更简洁的透明 PNG')
  } finally { canvas.width = 1; canvas.height = 1 }
}
module.exports = { preparePortraitImage, MAX_SOURCE_BYTES, MAX_UPLOAD_BYTES }
