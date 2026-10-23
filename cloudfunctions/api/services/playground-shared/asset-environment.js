const { ASSET_ROOTS } = require('./asset-roots')
function assetRoot() {
  let env = ''
  try { env = require('wx-server-sdk').getWXContext().ENV || '' } catch (_) {}
  if (!env) env = process.env.TCB_ENV || process.env.WX_ENV_ID || process.env.SCF_NAMESPACE || ''
  // Plain local model tests have no cloud environment. Deployed unknown environments fail explicitly.
  if (!env) env = 'cloud1-5gnhqn4t0554c1d9'
  if (!ASSET_ROOTS[env]) throw new Error('当前环境尚未配置庄园素材目录')
  return ASSET_ROOTS[env]
}
function assetPath(path = '') { return assetRoot() + '/' + path.replace(/^\/+/, '') }
function resolveEnvironmentAsset(id) {
  if (typeof id !== 'string') return id
  for (const root of Object.values(ASSET_ROOTS)) {
    if (!id.startsWith(root + '/')) continue
    const relative = id.slice(root.length + 1)
    if (relative.split('/').includes('custom')) return id
    return assetPath(relative)
  }
  return id
}

module.exports = { assetRoot, assetPath, resolveEnvironmentAsset }
