const { getActiveEnvId } = require('../../envList')
const { ASSET_ROOTS } = require('./asset-roots')
function assetRoot() {
  const env = getActiveEnvId()
  if (!ASSET_ROOTS[env]) throw new Error('当前环境尚未配置庄园素材目录')
  return ASSET_ROOTS[env]
}
function assetPath(path = '') {
  if (/(?:^|\/)\.\.(?:\/|$)/.test(path)) throw new Error('无效的素材路径')
  return assetRoot() + '/' + path.replace(/^\/+/, '')
}
function memorialRoot(base) {
  return base.replace(/\/packagePlayground\/2d\/baseImage$/, '/memorial-cloud-v1/packageMemorial/v1')
}
function memorialAssetPath(path = '') {
  if (/(?:^|\/)\.\.(?:\/|$)/.test(path)) throw new Error('无效的素材路径')
  const base=assetRoot()
  const root=memorialRoot(base)
  if(root===base)throw new Error('当前环境尚未配置纪念园素材目录')
  return root+'/'+path.replace(/^\/+/,'')
}
// Migrate only bundled default assets; custom appearance/building uploads retain their full IDs.
function resolveEnvironmentAsset(id) {
  if (typeof id !== 'string') return id
  for (const root of Object.values(ASSET_ROOTS)) {
    const characterRoot=memorialRoot(root)+'/playground-four-directions/'
    if(id.startsWith(characterRoot))return memorialAssetPath('playground-four-directions/'+id.slice(characterRoot.length))
    if (!id.startsWith(root + '/')) continue
    const relative = id.slice(root.length + 1)
    if (relative.split('/').includes('custom')) return id
    return assetPath(relative)
  }
  return id
}

module.exports = { assetRoot, assetPath, memorialAssetPath, resolveEnvironmentAsset, ASSET_ROOTS }
