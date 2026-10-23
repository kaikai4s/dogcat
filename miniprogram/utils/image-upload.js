// User-uploaded photos must fit the synchronous content-safety API before upload.
const MAX_BYTES = 900 * 1024
const MAX_SIDE = 750
function native(name, options) {
  return new Promise((resolve, reject) => {
    if (typeof wx[name] !== 'function') return reject(new Error('当前微信版本不支持图片处理，请更新后重试'))
    wx[name]({ ...options, success: resolve, fail: reject })
  })
}
function fileSize(path) {
  return new Promise((resolve, reject) => {
    const manager = wx.getFileSystemManager && wx.getFileSystemManager()
    if (!manager || typeof manager.getFileInfo !== 'function') return reject(new Error('无法读取图片大小，请更新微信后重试'))
    manager.getFileInfo({ filePath: path, success: result => resolve(Number(result.size)), fail: reject })
  })
}
async function prepareImage(filePath) {
  if (!filePath) throw new Error('请选择图片')
  let path = filePath
  for (let attempt = 0; attempt < 5; attempt++) {
    const info = await native('getImageInfo', { src: path })
    if (!['jpeg', 'jpg', 'png'].includes(String(info.type).toLowerCase())) throw new Error('请使用 JPG 或 PNG 格式图片')
    if (!(info.width > 0 && info.height > 0)) throw new Error('图片尺寸无效，请重新选择')
    const size = await fileSize(path)
    if (!(size > 0)) throw new Error('图片文件为空，请重新选择')
    if (size <= MAX_BYTES && Math.max(info.width, info.height) <= MAX_SIDE) {
      return { filePath: path, extension: String(info.type).toLowerCase() === 'png' ? '.png' : '.jpg', size }
    }
    if (attempt === 4) break
    const scale = Math.min(1, MAX_SIDE / Math.max(info.width, info.height)) * (attempt ? 0.75 : 1)
    const result = await native('compressImage', { src: path, quality: Math.max(30, 80 - attempt * 12),
      compressedWidth: Math.max(1, Math.floor(info.width * scale)), compressedHeight: Math.max(1, Math.floor(info.height * scale)) })
    if (!result.tempFilePath) throw new Error('图片压缩失败，请重新选择')
    path = result.tempFilePath
  }
  throw new Error('图片仍然过大，请选择较小的 JPG 或 PNG 图片')
}
function uploadImage(options) {
  let task, aborted = false
  const listeners = []
  const controls = {
    abort() { aborted = true; if (task && task.abort) task.abort() },
    onProgressUpdate(listener) { listeners.push(listener); if (task && task.onProgressUpdate) task.onProgressUpdate(listener) }
  }
  const promise = prepareImage(options.filePath).then(image => {
    if (aborted) throw new Error('已取消图片上传')
    const cloudPath = String(options.cloudPath || '').replace(/\.[^/.]+$/, '') + image.extension
    return new Promise((resolve, reject) => {
      const { success, fail, complete, ...original } = options
      task = wx.cloud.uploadFile({ ...original, filePath: image.filePath, cloudPath, success: resolve, fail: reject })
      if (task && task.onProgressUpdate) listeners.forEach(listener => task.onProgressUpdate(listener))
    })
  })
  if (options.success || options.fail || options.complete) {
    promise.then(result => {
      if (options.success) options.success(result)
      if (options.complete) options.complete(result)
    }, error => {
      if (options.fail) options.fail(error)
      if (options.complete) options.complete(error)
    }).catch(error => console.error('图片上传回调失败', error))
    return controls
  }
  return Object.assign(promise, controls)
}
module.exports = { prepareImage, uploadImage, MAX_BYTES, MAX_SIDE }
