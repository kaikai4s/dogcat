// Build an isolated browser harness using the SAME scene modules as WeChat.
// Serve output/memorial-scene-preview, never the repository (local credentials).
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '../..')
const out = path.join(root, 'output/memorial-scene-preview')
fs.mkdirSync(out, { recursive: true })
fs.cpSync(path.join(root, 'miniprogram/packageMemorial/assets'), path.join(out, 'packageMemorial/assets'), { recursive: true })
const modules = ['world-template', 'world-index', 'navigation', 'ground-cache', 'geometry', 'layout', 'chunks', 'terrain', 'engine', 'gestures', 'sound'].map(name => JSON.stringify('./' + name) + ':function(module,exports,require){\n' +
  fs.readFileSync(path.join(root, 'miniprogram/packageMemorial/scene', name + '.js'), 'utf8') + '\n}').join(',\n')
fs.writeFileSync(path.join(out, 'scene.js'), '(function(){const modules={' + modules + '};const cache={};function require(id){if(!cache[id]){const m=cache[id]={exports:{}};modules[id](m,m.exports,require)}return cache[id].exports}window.MemorialScene=require("./engine").MemorialScene;window.MapGestures=require("./gestures").MapGestures;window.GardenSound=require("./sound").GardenSound;})();')
fs.copyFileSync(path.join(root, 'docs/design/pet-memorial/scene-preview.html'), path.join(out, 'index.html'))
fs.copyFileSync(path.join(root, 'docs/design/pet-memorial/scene-preview-controls.js'), path.join(out, 'controls.js'))
console.log('Preview built: ' + out)

fs.writeFileSync(path.join(out, 'native-layout.css'), fs.readFileSync(path.join(root, 'miniprogram/packageMemorial/pages/garden.wxss'), 'utf8').replace(/\bpage\s*\{/g, '.preview-page {').replace(/\bview\b/g, 'div'))
