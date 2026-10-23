const { assetPath } = require('./asset-environment')
const CHARACTER_ASSETS = {
  girl_idle_sw: assetPath('people/girl/idle-sw.png'),
  girl_walk_sw: assetPath('people/girl/walk-sw.png'),
  girl_run_sw: assetPath('people/girl/run-sw.png'),
  boy_idle_sw: assetPath('people/boy/boy-walk-sw-end/boy-walk-sw-stop.png'),
  boy_walk_sw: assetPath('people/boy/boy-walk-sw-end/walk-sw.png'),
  boy_run_sw: assetPath('people/boy/boy-walk-sw-end/run-sw.png')
}
const CHARACTER_STYLE = { size: 12, anchor: 460 / 512, frames: 12, columns: 4, rows: 3 }
module.exports = { CHARACTER_ASSETS, CHARACTER_STYLE }
