const test = require('node:test')
const assert = require('node:assert/strict')
const { setForceEnvId } = require('../../miniprogram/envList')
const {
  getCloudAssetUrl,
  getDovlinLogoUrl,
  getLoadingCatUrl,
  CLOUD_STORAGE_ROOTS
} = require('../../miniprogram/utils/cloud-assets')

test('cloud-assets: 开发环境默认返回 cloud1 环境的云存储 FileID', () => {
  setForceEnvId('cloud1-5gnhqn4t0554c1d9')
  const dogUrl = getDovlinLogoUrl()
  assert.equal(
    dogUrl,
    'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/dovlin-logo-dog.png'
  )

  const catUrl = getLoadingCatUrl()
  assert.equal(
    catUrl,
    'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/loading-cat.gif'
  )
})

test('cloud-assets: 正式版环境自动切换至 production 环境的云存储 FileID', () => {
  setForceEnvId('production-d2g5jx277f41a81a6')
  const dogUrl = getDovlinLogoUrl()
  assert.equal(
    dogUrl,
    'cloud://production-d2g5jx277f41a81a6.7072-production-d2g5jx277f41a81a6-1310870236/packagePlayground/dovlin-logo-dog.png'
  )

  const catUrl = getLoadingCatUrl()
  assert.equal(
    catUrl,
    'cloud://production-d2g5jx277f41a81a6.7072-production-d2g5jx277f41a81a6-1310870236/packagePlayground/loading-cat.gif'
  )
  setForceEnvId('') // 恢复
})

test('cloud-assets: 传入开发版的完整 cloud:// 路径，在正式版环境下自动映射至正式版', () => {
  setForceEnvId('production-d2g5jx277f41a81a6')
  const devFullUrl = 'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/dovlin-logo-dog.png'
  const resolved = getCloudAssetUrl(devFullUrl)
  assert.equal(
    resolved,
    'cloud://production-d2g5jx277f41a81a6.7072-production-d2g5jx277f41a81a6-1310870236/packagePlayground/dovlin-logo-dog.png'
  )
  setForceEnvId('')
})
