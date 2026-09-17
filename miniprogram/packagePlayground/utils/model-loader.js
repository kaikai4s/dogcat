const GLTFLoader = require('../libs/three/GLTFLoader')

const CLOUD_CAT_ROOT = 'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/cat'
const CLOUD_MODELS = {
  cat: {
    gltf: `${CLOUD_CAT_ROOT}/bc1ca915bda44e16b0899e80871ea872.gltf`,
    bin: `${CLOUD_CAT_ROOT}/buffer.bin`,
    texture: `${CLOUD_CAT_ROOT}/猫.jpg`
  }
}

// The sample GLBs embed their buffers and use vertex/material colors, not DOM image loaders.
function readFirst(paths, resolve, reject) {
  const fs = wx.getFileSystemManager()
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
  const json = JSON.parse(gltfText)
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

function loadModel(name) {
  if (CLOUD_MODELS[name]) return loadCloudGltfModel(CLOUD_MODELS[name])
  return new Promise((resolve, reject) => {
    readFirst([
      `/packagePlayground/assets/${name}.glb`,
      `packagePlayground/assets/${name}.glb`,
      `assets/${name}.glb`
    ], (data) => {
      try {
        new GLTFLoader().parse(data, '', resolve, reject)
      } catch (error) {
        reject(error)
      }
    }, reject)
  })
}

module.exports = { loadModel }
