// Keep both subpackage copies in sync; memorialPackaging.test.js checks parity.
const { getActiveEnvId } = require('../../../envList')
const { CLOUD_STORAGE_ROOTS } = require('../../../utils/cloud-assets')
const DIRECTORY = 'packageMemorial/v1'
const ENV_DIRECTORIES = Object.fromEntries(Object.keys(CLOUD_STORAGE_ROOTS).map(env => [env, 'memorial-cloud-v1/' + DIRECTORY]))
function memorialAssetID(key, env) {
  const activeEnv = env || getActiveEnvId(), root = CLOUD_STORAGE_ROOTS[activeEnv]
  if (!root) throw new Error('当前环境尚未配置纪念园云存储')
  return root + '/' + (ENV_DIRECTORIES[activeEnv] || DIRECTORY) + '/' + key
}
function monumentFileID(style) { return memorialAssetID('monuments-v1/' + (['arch', 'cottage', 'moon'].includes(style) ? style : 'arch') + '.png') }
module.exports = { DIRECTORY, ENV_DIRECTORIES, memorialAssetID, monumentFileID }
