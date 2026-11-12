// Keep both subpackage copies in sync; memorialPackaging.test.js checks parity.
const { getActiveEnvId } = require('../../envList')
const { CLOUD_STORAGE_ROOTS } = require('../../utils/cloud-assets')
const DIRECTORY = 'packageMemorial/v1'
const ENV_DIRECTORIES = { 'cloud1-5gnhqn4t0554c1d9': 'memorial-cloud-v1/packageMemorial/v1' }
function memorialAssetID(key, env) {
  const activeEnv = env || getActiveEnvId(), root = CLOUD_STORAGE_ROOTS[activeEnv]
  if (!root) throw new Error('当前环境尚未配置纪念园云存储')
  return root + '/' + (ENV_DIRECTORIES[activeEnv] || DIRECTORY) + '/' + key
}
function monumentFileID(style) { return memorialAssetID('monuments-v1/' + (['arch', 'cottage', 'moon'].includes(style) ? style : 'arch') + '.png') }
module.exports = { DIRECTORY, ENV_DIRECTORIES, memorialAssetID, monumentFileID }
