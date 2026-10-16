const GLTFLoader = require('../libs/three/GLTFLoader')

const CLOUD_CAT_ROOT = 'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/cat'
const CLOUD_MODELS = {
  cat: {
    gltf: `${CLOUD_CAT_ROOT}/bc1ca915bda44e16b0899e80871ea872.gltf`,
    bin: `${CLOUD_CAT_ROOT}/buffer.bin`,
    texture: `${CLOUD_CAT_ROOT}/猫.jpg`
  }
}

const MODEL_CACHE_SUBDIR = 'playground_models'

function getFileSystem() {
  return (typeof wx !== 'undefined' && typeof wx.getFileSystemManager === 'function')
    ? wx.getFileSystemManager()
    : null
}

function getUserDataDir() {
  return (typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH)
    ? wx.env.USER_DATA_PATH
    : ''
}

function hashString(str) {
  let hash = 5381
  const text = String(str || '')
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) + text.charCodeAt(i)
    hash = hash & hash
  }
  return (hash >>> 0).toString(16)
}

function getCacheFilePath(identifier) {
  const baseDir = getUserDataDir()
  if (!baseDir) return ''
  const cleanId = String(identifier || '').trim()
  const hash = hashString(cleanId)
  const ext = cleanId.toLowerCase().endsWith('.glb') ? '.glb' : '.bin'
  return `${baseDir}/${MODEL_CACHE_SUBDIR}/model_${hash}${ext}`
}

function ensureModelCacheDir() {
  const fs = getFileSystem()
  const baseDir = getUserDataDir()
  if (!fs || !baseDir) return false
  const dirPath = `${baseDir}/${MODEL_CACHE_SUBDIR}`
  try {
    fs.accessSync(dirPath)
    return true
  } catch (e) {
    try {
      fs.mkdirSync(dirPath, true)
      return true
    } catch (err) {
      console.warn('[model-loader] 创建模型缓存目录失败:', err)
      return false
    }
  }
}

function checkLocalCacheExists(filePath) {
  const fs = getFileSystem()
  if (!fs || !filePath) return false
  try {
    fs.accessSync(filePath)
    return true
  } catch (e) {
    return false
  }
}

function readLocalBuffer(filePath) {
  const fs = getFileSystem()
  return new Promise((resolve, reject) => {
    if (!fs) return reject(new Error('无法获取文件系统管理器'))
    fs.readFile({
      filePath,
      success: ({ data }) => resolve(data),
      fail: reject
    })
  })
}

function saveFileToCache(tempFilePath, targetCachePath) {
  const fs = getFileSystem()
  if (!fs) return Promise.resolve(tempFilePath)
  ensureModelCacheDir()
  return new Promise((resolve) => {
    fs.copyFile({
      srcPath: tempFilePath,
      destPath: targetCachePath,
      success: () => resolve(targetCachePath),
      fail: (err) => {
        console.warn('[model-loader] 写入模型缓存失败，使用临时文件:', err)
        resolve(tempFilePath)
      }
    })
  })
}

function downloadCloudFile(fileID) {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.downloadFile) {
      return reject(new Error('当前环境不支持 wx.cloud.downloadFile'))
    }
    wx.cloud.downloadFile({
      fileID,
      success: (res) => {
        if (res.tempFilePath) resolve(res.tempFilePath)
        else reject(new Error('云存储下载结果未返回文件路径'))
      },
      fail: reject
    })
  })
}

function downloadHttpFile(url) {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || !wx.downloadFile) {
      return reject(new Error('当前环境不支持 wx.downloadFile'))
    }
    wx.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode === 200 && res.tempFilePath) resolve(res.tempFilePath)
        else reject(new Error(`下载模型失败(状态码: ${res.statusCode})`))
      },
      fail: reject
    })
  })
}

function parseGlbBuffer(data) {
  return new Promise((resolve, reject) => {
    try {
      let buffer = data
      if (buffer && buffer.buffer && ArrayBuffer.isView(buffer)) {
        buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      }
      new GLTFLoader().parse(buffer, '', resolve, reject)
    } catch (error) {
      reject(error)
    }
  })
}

async function loadRemoteGlbModel(urlOrFileId) {
  const targetCachePath = getCacheFilePath(urlOrFileId)

  if (targetCachePath && checkLocalCacheExists(targetCachePath)) {
    try {
      const buffer = await readLocalBuffer(targetCachePath)
      const byteLen = (buffer && (buffer.byteLength || buffer.length)) || 0
      if (byteLen > 0) {
        return await parseGlbBuffer(buffer)
      }
      throw new Error('本地缓存文件大小为 0')
    } catch (readErr) {
      console.warn('[model-loader] 读取本地缓存失败，清理坏缓存并重新拉取:', readErr)
      const fs = getFileSystem()
      if (fs && fs.unlinkSync) {
        try { fs.unlinkSync(targetCachePath) } catch (e) {}
      }
    }
  }

  let tempFilePath = ''
  if (urlOrFileId.startsWith('cloud://')) {
    tempFilePath = await downloadCloudFile(urlOrFileId)
  } else if (/^https?:\/\//i.test(urlOrFileId)) {
    tempFilePath = await downloadHttpFile(urlOrFileId)
  } else {
    throw new Error(`不支持的远程模型地址格式: ${urlOrFileId}`)
  }

  let finalReadPath = tempFilePath
  if (targetCachePath) {
    finalReadPath = await saveFileToCache(tempFilePath, targetCachePath)
  }

  const buffer = await readLocalBuffer(finalReadPath)
  return parseGlbBuffer(buffer)
}

function readFirst(paths, resolve, reject) {
  const fs = getFileSystem()
  if (!fs) return reject(new Error('无法获取文件系统管理器'))
  const [filePath, ...rest] = paths
  fs.readFile({
    filePath,
    success: ({ data }) => resolve(data),
    fail: (error) => {
      if (rest.length) readFirst(rest, resolve, reject)
      else reject(error)
    }
  })
}

function requestTempUrls(fileIDs) {
  return wx.cloud.getTempFileURL({ fileList: fileIDs }).then((res) => {
    const urls = (res.fileList || []).map((item) => item.tempFileURL || '')
    if (urls.some((url) => !url)) throw new Error('云端模型资源临时链接为空')
    return urls
  })
}

function requestText(url) {
  return new Promise((resolve, reject) => {
    wx.request({ url, dataType: 'text', responseType: 'text', success: (res) => resolve(typeof res.data === 'string' ? res.data : JSON.stringify(res.data)), fail: reject })
  })
}

function requestArrayBuffer(url) {
  return new Promise((resolve, reject) => {
    wx.request({ url, responseType: 'arraybuffer', success: (res) => resolve(res.data), fail: reject })
  })
}

async function loadCloudGltfModel(config) {
  const [gltfUrl, binUrl, textureUrl] = await requestTempUrls([config.gltf, config.bin, config.texture])
  const [gltfText, binData] = await Promise.all([requestText(gltfUrl), requestArrayBuffer(binUrl)])
  let json
  try {
    json = JSON.parse(gltfText)
  } catch (error) {
    throw new Error('解析 3D 模型配置失败：数据格式不正确')
  }
  if (json.buffers && json.buffers[0]) json.buffers[0].uri = `data:application/octet-stream;base64,${wx.arrayBufferToBase64(binData)}`
  if (json.images && json.images[0]) json.images[0].uri = textureUrl
  return new Promise((resolve, reject) => {
    try {
      new GLTFLoader().parse(JSON.stringify(json), '', resolve, reject)
    } catch (error) {
      reject(error)
    }
  })
}

async function loadModel(source, options = {}) {
  const fallback = options.fallback || ''

  if (!source) {
    if (fallback) return loadModel(fallback, { fallback: '' })
    throw new Error('未指定要加载的 3D 模型')
  }

  if (typeof source === 'string' && CLOUD_MODELS[source]) {
    try {
      return await loadCloudGltfModel(CLOUD_MODELS[source])
    } catch (err) {
      if (fallback && fallback !== source) {
        console.warn(`[model-loader] 预设模型 ${source} 加载失败，降级使用 ${fallback}:`, err)
        return loadModel(fallback, { fallback: '' })
      }
      throw err
    }
  }

  const isRemote = typeof source === 'string' && (
    source.startsWith('cloud://') ||
    /^https?:\/\//i.test(source) ||
    source.includes('/custom_models/') ||
    source.includes('.glb')
  )

  if (isRemote) {
    try {
      return await loadRemoteGlbModel(source)
    } catch (err) {
      if (fallback && fallback !== source) {
        console.warn(`[model-loader] 专属云端模型 ${source} 加载失败，降级回退到 ${fallback}:`, err)
        return loadModel(fallback, { fallback: '' })
      }
      throw err
    }
  }

  return new Promise((resolve, reject) => {
    readFirst([
      `/packagePlayground/assets/${source}.glb`,
      `packagePlayground/assets/${source}.glb`,
      `assets/${source}.glb`
    ], (data) => {
      parseGlbBuffer(data).then(resolve).catch(reject)
    }, (err) => {
      if (fallback && fallback !== source) {
        console.warn(`[model-loader] 本地模型 ${source} 加载失败，降级回退到 ${fallback}:`, err)
        loadModel(fallback, { fallback: '' }).then(resolve).catch(reject)
      } else {
        reject(err)
      }
    })
  })
}

function clearModelCache() {
  const fs = getFileSystem()
  const baseDir = getUserDataDir()
  if (!fs || !baseDir) return false
  const dirPath = `${baseDir}/${MODEL_CACHE_SUBDIR}`
  try {
    const files = fs.readdirSync(dirPath) || []
    for (const f of files) {
      try { fs.unlinkSync(`${dirPath}/${f}`) } catch (e) {}
    }
    return true
  } catch (e) {
    return false
  }
}

function getModelCacheInfo() {
  const fs = getFileSystem()
  const baseDir = getUserDataDir()
  if (!fs || !baseDir) return { count: 0, size: 0 }
  const dirPath = `${baseDir}/${MODEL_CACHE_SUBDIR}`
  try {
    const files = fs.readdirSync(dirPath) || []
    let totalSize = 0
    for (const f of files) {
      try {
        const stat = fs.statSync(`${dirPath}/${f}`)
        totalSize += stat.size || 0
      } catch (e) {}
    }
    return { count: files.length, size: totalSize }
  } catch (e) {
    return { count: 0, size: 0 }
  }
}

module.exports = {
  loadModel,
  getCacheFilePath,
  ensureModelCacheDir,
  clearModelCache,
  getModelCacheInfo,
  hashString
}

