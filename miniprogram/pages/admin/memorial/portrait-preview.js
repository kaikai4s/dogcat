// Native image events can be missed when a cached image is reused. Decode the
// exact preview sources as well, so approval never depends on that event alone.
function createPlacementImages(api) {
  const pending = new Map(), cancels = new Set()
  let disposed = false
  function invoke(target, name, options) {
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (error, value) => {
        if (done) return
        done = true; clearTimeout(timer); cancels.delete(cancel)
        error ? reject(error) : resolve(value)
      }
      const cancel = () => finish(new Error('页面已关闭'))
      const timer = setTimeout(() => finish(new Error('图片加载超时，请重试预览')), 15000)
      cancels.add(cancel)
      if (disposed) return cancel()
      try {
        if (!target || typeof target[name] !== 'function') throw new Error('无法读取预览图片，请重试')
        target[name]({ ...options, success: value => finish(null, value), fail: () => finish(new Error('图片加载失败，请检查网络后重试预览')) })
      } catch (error) { finish(error) }
    })
  }
  async function decode(source) {
    if (!source) throw new Error('缺少预览图片地址')
    let path = source
    if (/^cloud:\/\//.test(source)) {
      const result = await invoke(api.cloud, 'downloadFile', { fileID: source })
      if (!result.tempFilePath || result.statusCode && result.statusCode !== 200) throw new Error('云端预览图片不可用，请检查素材是否已上传')
      path = result.tempFilePath
    }
    if (disposed) throw new Error('页面已关闭')
    const info = await invoke(api, 'getImageInfo', { src: path })
    if (!(info.width > 0 && info.height > 0)) throw new Error('预览图片无法解码，请重试')
    return info.path || path
  }
  return {
    resolve(source) {
      if (disposed) return Promise.reject(new Error('页面已关闭'))
      // Share concurrent downloads of the same platform, but recheck local
      // temporary files on each later attempt instead of caching them forever.
      if (!pending.has(source)) {
        const work = decode(source).finally(() => { if (pending.get(source) === work) pending.delete(source) })
        pending.set(source, work)
      }
      return pending.get(source)
    },
    dispose() { disposed = true; Array.from(cancels).forEach(cancel => cancel()); pending.clear() }
  }
}
module.exports = { createPlacementImages }
