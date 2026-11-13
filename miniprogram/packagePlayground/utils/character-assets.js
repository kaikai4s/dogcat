const { memorialAssetPath } = require('./asset-environment')
const CHARACTER_DIRECTIONS = ['sw', 'se', 'nw', 'ne']
function characterAssetNames(type, actions = ['idle', 'walk', 'run']) {
  const person = type === 'girl' ? 'girl' : 'boy'
  return actions.flatMap((action) => CHARACTER_DIRECTIONS.map((direction) => `${person}_${action}_${direction}`))
}
const CHARACTER_ASSETS = {}
for(const person of ['boy','girl'])for(const action of ['idle','walk','run'])for(const direction of CHARACTER_DIRECTIONS) {
  CHARACTER_ASSETS[`${person}_${action}_${direction}`]=memorialAssetPath(`playground-four-directions/cloud-upload/${person}/${action}-${direction}.png`)
}
const CHARACTER_STYLE = { size: 12, anchor: 460 / 512, frames: 12, columns: 4, rows: 3 }
module.exports = { CHARACTER_ASSETS, CHARACTER_STYLE, characterAssetNames }
