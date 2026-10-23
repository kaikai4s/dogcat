const { assetRoot } = require('./asset-environment')
const CLOUD_ASSET_BASE =
  assetRoot()

// Excretion (pee & poop) asset configuration and cloud image loader
const EXCRETION_ASSETS = {
  pee: {
    key: 'pee',
    label: '嘘嘘素材',
    fileID: `${CLOUD_ASSET_BASE}/pet_pee.png`,
    size: 2.4
  },
  poop: {
    key: 'poop',
    label: '便便素材',
    fileID: `${CLOUD_ASSET_BASE}/pet_poop.png`,
    size: 2.2
  }
}

function getExcretionAsset(type) {
  return EXCRETION_ASSETS[type] || null
}

function setExcretionAsset(type, fileID) {
  if (EXCRETION_ASSETS[type] && typeof fileID === 'string') {
    EXCRETION_ASSETS[type].fileID = fileID
  }
}

module.exports = {
  CLOUD_ASSET_BASE,
  EXCRETION_ASSETS,
  getExcretionAsset,
  setExcretionAsset
}
