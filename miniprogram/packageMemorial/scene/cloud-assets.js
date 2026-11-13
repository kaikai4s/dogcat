const { WIDTH, HEIGHT, CHUNK, CHUNK_DIRECTORY } = require('./world-template')
const { validateChunk } = require('./chunks')
const { DIRECTORY, ENV_DIRECTORIES, memorialAssetID } = require('./memorial-asset-path')
const FILES = ['garden.jpg', 'audio/music.wav', 'audio/step.wav', 'audio/chime.wav']
FILES.push('world-v2/props.png', 'world-v2/grass.jpg', 'monuments-v1/atlas.png', 'monuments-v1/arch.png', 'monuments-v1/cottage.png', 'monuments-v1/moon.png')
FILES.push('seasons-v1/foliage.png')
for (let y = 0; y < HEIGHT / CHUNK; y++) for (let x = 0; x < WIDTH / CHUNK; x++) FILES.push(CHUNK_DIRECTORY + '/' + x + '-' + y + '.json')
;['boy', 'girl'].forEach(gender => ['walk', 'idle'].forEach(action =>
  ['sw', 'se', 'nw', 'ne'].forEach(direction => FILES.push(gender + '/' + action + '-' + direction + '.png'))))

function fileID(key, env) {
  if (!FILES.includes(key)) throw new Error('无效的纪念园资源路径')
  return memorialAssetID(key, env)
}

// Each page owns its cache. No signed URLs or persistent temporary paths.
function createCloudAssets(api) {
  const pending = new Map(), cached = new Map(), cancels = new Map()
  let disposed = false
  function invalidate(key) { cached.delete(fileID(key)) }
  function resolve(key) {
    if (disposed) return Promise.reject(new Error('纪念园页面已关闭'))
    let id
    try { id = fileID(key) } catch (error) { return Promise.reject(error) }
    if (cached.has(id)) {
      try {
        api.getFileSystemManager().accessSync(cached.get(id))
        return Promise.resolve(cached.get(id))
      } catch (_) { cached.delete(id) }
    }
    if (!pending.has(id)) {
      const promise = new Promise((accept, reject) => {
        let done = false
        const timer = setTimeout(() => finish(new Error('纪念园云资源下载超时，请重试')), 20000)
        function finish(error, path) {
          if (done) return
          done = true
          clearTimeout(timer)
          cancels.delete(id)
          if (disposed) return reject(new Error('纪念园页面已关闭'))
          if (error) reject(error)
          else { cached.set(id, path); accept(path) }
        }
        cancels.set(id, () => finish(new Error('纪念园页面已关闭')))
        try {
          if (!api.cloud || !api.cloud.downloadFile) throw new Error('云开发不可用')
          api.cloud.downloadFile({ fileID: id,
            success: result => {
              if (!result || !result.tempFilePath || (result.statusCode && result.statusCode !== 200)) {
                finish(new Error('纪念园云资源不可用，请确认已上传：' + key))
              } else finish(null, result.tempFilePath)
            },
            fail: () => finish(new Error('纪念园资源下载失败，请检查网络或云端文件：' + key))
          })
        } catch (_) { finish(new Error('无法读取纪念园云资源，请检查云开发初始化')) }
      }).finally(() => pending.delete(id))
      pending.set(id, promise)
    }
    return pending.get(id)
  }
  resolve.invalidate = invalidate
  resolve.dispose = () => { disposed = true; cached.clear(); Array.from(cancels.values()).forEach(cancel => cancel()) }
  return resolve
}
function createCloudChunks(resolve, api) {
  return id => {
    const key = CHUNK_DIRECTORY + '/' + id + '.json'
    return resolve(key).then(path => new Promise((accept, reject) => {
      api.getFileSystemManager().readFile({ filePath: path, encoding: 'utf8',
        success: result => { try { accept(validateChunk(JSON.parse(result.data), id)) } catch (_) { reject(new Error('园区区域数据不完整，请重试')) } },
        fail: () => reject(new Error('园区区域读取失败，请重试')) })
    })).catch(error => { resolve.invalidate(key); throw error })
  }
}
module.exports = { DIRECTORY, ENV_DIRECTORIES, FILES, fileID, createCloudAssets, createCloudChunks }
