const { getActiveEnvId } = require('../envList')

const CLOUD_STORAGE_ROOTS = {
  'cloud1-5gnhqn4t0554c1d9': 'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236',
  'production-d2g5jx277f41a81a6': 'cloud://production-d2g5jx277f41a81a6.7072-production-d2g5jx277f41a81a6-1310870236'
}

/**
 * 获取当前环境对应的云存储根路径
 */
function getCloudStorageRoot() {
  let envId = 'cloud1-5gnhqn4t0554c1d9'
  try {
    if (typeof getActiveEnvId === 'function') {
      envId = getActiveEnvId() || envId
    }
  } catch (_) {}
  return CLOUD_STORAGE_ROOTS[envId] || CLOUD_STORAGE_ROOTS['cloud1-5gnhqn4t0554c1d9']
}

/**
 * 根据当前运行环境（开发/体验/正式版），自动解析素材对应的云存储 FileID
 * @param {string} relativePath 相对路径（如 'packagePlayground/dovlin-logo-dog.png'）或包含旧环境的完整 cloud:// URL
 * @returns {string} 当前生效环境的 cloud:// FileID
 */
function getCloudAssetUrl(relativePath = '') {
  if (!relativePath || typeof relativePath !== 'string') return ''
  const trimmed = relativePath.trim()

  // 若传入的是完整的 cloud:// 路径，提取相对路径并重定向至当前生效的环境
  if (trimmed.startsWith('cloud://')) {
    for (const root of Object.values(CLOUD_STORAGE_ROOTS)) {
      if (trimmed.startsWith(root + '/')) {
        const sub = trimmed.slice(root.length + 1)
        return `${getCloudStorageRoot()}/${sub}`
      }
    }
    return trimmed
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/')) {
    return trimmed
  }

  const clean = trimmed.replace(/^\/+/, '')
  return `${getCloudStorageRoot()}/${clean}`
}

const CLOUD_ASSETS = {
  DOVLIN_LOGO_DOG: 'packagePlayground/dovlin-logo-dog.png',
  LOADING_CAT: 'packagePlayground/loading-cat.gif'
}

function getDovlinLogoUrl() {
  return getCloudAssetUrl(CLOUD_ASSETS.DOVLIN_LOGO_DOG)
}

function getLoadingCatUrl() {
  return getCloudAssetUrl(CLOUD_ASSETS.LOADING_CAT)
}

module.exports = {
  CLOUD_STORAGE_ROOTS,
  getCloudStorageRoot,
  getCloudAssetUrl,
  getDovlinLogoUrl,
  getLoadingCatUrl,
  CLOUD_ASSETS
}
