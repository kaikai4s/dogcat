const { assetPath } = require('./asset-environment')
const PET_ATLASES = {
  dog_walk: {
    fileID: assetPath('dog/walk.png'),
    frames: 24,
    columns: 4,
    rows: 6,
    anchor: 460 / 512,
    stride: 7.2
  },
  cat_walk: {
    fileID: assetPath('cat/walk.png'),
    frames: 20,
    columns: 4,
    rows: 5,
    anchor: 460 / 512,
    stride: 6
  }
}
module.exports = { PET_ATLASES }
