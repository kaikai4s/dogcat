const CLOUD_ASSET_BASE =
  'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/2d/baseImage'

// Excretion (pee & poop) asset configuration and custom image loader
const EXCRETION_ASSETS = {
  pee: {
    key: 'pee',
    label: '嘘嘘素材',
    fileID: `${CLOUD_ASSET_BASE}/pet_pee.png`,
    localPath: '/packagePlayground/assets/pee.png',
    size: 20
  },
  poop: {
    key: 'poop',
    label: '便便素材',
    fileID: `${CLOUD_ASSET_BASE}/pet_poop.png`,
    localPath: '/packagePlayground/assets/poop.png',
    size: 22
  }
}

function getExcretionAsset(type) {
  return EXCRETION_ASSETS[type] || null
}

function setExcretionAsset(type, fileIDOrPath) {
  if (EXCRETION_ASSETS[type]) {
    if (typeof fileIDOrPath === 'string' && fileIDOrPath.startsWith('cloud://')) {
      EXCRETION_ASSETS[type].fileID = fileIDOrPath
    } else if (typeof fileIDOrPath === 'string') {
      EXCRETION_ASSETS[type].localPath = fileIDOrPath
    }
  }
}

module.exports = {
  EXCRETION_ASSETS,
  getExcretionAsset,
  setExcretionAsset
}
