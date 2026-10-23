const test = require('node:test')
const assert = require('node:assert/strict')
const env = require('../../miniprogram/envList')
const { assetRoot, assetPath, resolveEnvironmentAsset, ASSET_ROOTS } = require('../../miniprogram/packagePlayground/utils/asset-environment')

test('production default assets use the supplied production bucket and keep the same relative paths', () => {
  try {
    env.setForceEnvId('production-d2g5jx277f41a81a6')
    assert.equal(assetRoot(), 'cloud://production-d2g5jx277f41a81a6.7072-production-d2g5jx277f41a81a6-1310870236/packagePlayground/2d/baseImage')
    assert.equal(resolveEnvironmentAsset(ASSET_ROOTS['cloud1-5gnhqn4t0554c1d9'] + '/dog/walk.png'), assetPath('dog/walk.png'))
    assert.equal(resolveEnvironmentAsset(ASSET_ROOTS['cloud1-5gnhqn4t0554c1d9'] + '/farm/custom/crop/upload.png'), ASSET_ROOTS['cloud1-5gnhqn4t0554c1d9'] + '/farm/custom/crop/upload.png')
    assert.equal(resolveEnvironmentAsset('cloud://custom.env/packagePlayground/custom/user/walk.png'), 'cloud://custom.env/packagePlayground/custom/user/walk.png')
  } finally { env.setForceEnvId('') }
})

test('development assets stay in development and unknown environments cannot silently read trial assets', () => {
  try {
    env.setForceEnvId('cloud1-5gnhqn4t0554c1d9')
    assert.equal(assetPath('farm/carrot-stages.png'), ASSET_ROOTS['cloud1-5gnhqn4t0554c1d9'] + '/farm/carrot-stages.png')
    env.setForceEnvId('unknown-env')
    assert.throws(assetRoot, /尚未配置/)
  } finally { env.setForceEnvId('') }
})

test('client and server asset root maps remain identical', () => {
  assert.deepEqual(ASSET_ROOTS, require('../../cloudfunctions/api/services/playground-shared/asset-roots').ASSET_ROOTS)
})
