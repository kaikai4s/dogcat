// Build an isolated browser harness using the SAME scene modules as WeChat.
// Serve output/memorial-scene-preview, never the repository (local credentials).
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '../..')
const out = path.join(root, 'output/memorial-scene-preview')
fs.mkdirSync(out, { recursive: true })
fs.cpSync(path.join(root, 'miniprogram/packageMemorial/assets'), path.join(out, 'packageMemorial/assets'), { recursive: true })
const modules = ['memorial-portrait-layout', 'portrait-images', 'saved-position', 'visitors', 'plot-layout', 'plot-number', 'world-template', 'world-index', 'navigation', 'ground-cache', 'geometry', 'environment', 'environment-renderer', 'grass', 'layout', 'chunks', 'terrain', 'engine', 'gestures', 'sound'].map(name => JSON.stringify('./' + name) + ':function(module,exports,require){\n' +
  fs.readFileSync(path.join(root, 'miniprogram/packageMemorial/scene', name + '.js'), 'utf8') + '\n}').join(',\n')
fs.writeFileSync(path.join(out, 'scene.js'), '(function(){const modules={' + modules + '};const cache={};function require(id){if(!cache[id]){const m=cache[id]={exports:{}};modules[id](m,m.exports,require)}return cache[id].exports}window.MemorialScene=require("./engine").MemorialScene;window.MapGestures=require("./gestures").MapGestures;window.GardenSound=require("./sound").GardenSound;})();')
fs.copyFileSync(path.join(root, 'docs/design/pet-memorial/scene-preview.html'), path.join(out, 'index.html'))
fs.copyFileSync(path.join(root, 'docs/design/pet-memorial/scene-preview-controls.js'), path.join(out, 'controls.js'))
console.log('Preview built: ' + out)

fs.writeFileSync(path.join(out, 'native-layout.css'), fs.readFileSync(path.join(root, 'miniprogram/packageMemorial/pages/garden.wxss'), 'utf8').replace(/(^|\n)page\s*\{/g, '$1.preview-page {').replace(/\bview\b/g, 'div'))

// Adapt the real WXML pages for local interaction review; all data is explicitly mocked.
for (const [kind, entry] of Object.entries({ garden: 'packageMemorial/pages/garden', memory: 'packageMemorial/pages/memory', admin: 'pages/admin/memorial/index', gardens: 'pages/admin/memorial/gardens', archive: 'pages/admin/memorial/user-archive' })) {
  const sources = Object.fromEntries(['js', 'wxml', 'wxss'].map(ext => [ext, fs.readFileSync(path.join(root, 'miniprogram', entry + '.' + ext), 'utf8')]))
  sources.wxss = sources.wxss.replace(/@import "\.\/index.wxss";/g, () => fs.readFileSync(path.join(root, 'miniprogram/pages/admin/memorial/index.wxss'), 'utf8'))
  sources.global = fs.readFileSync(path.join(root, 'miniprogram/app.wxss'), 'utf8').replace(/@import[^;]+;/g, '')
  fs.writeFileSync(path.join(out, kind + '-sources.json'), JSON.stringify(sources))
}
const nativeModules = {}
for (const file of fs.readdirSync(path.join(root, 'miniprogram/packageMemorial/scene')).filter(f => f.endsWith('.js'))) nativeModules['scene/' + file.slice(0,-3)] = fs.readFileSync(path.join(root, 'miniprogram/packageMemorial/scene', file), 'utf8')
for (const name of ['format', 'subscription-options']) nativeModules['utils/' + name] = fs.readFileSync(path.join(root, 'miniprogram/utils', name + '.js'), 'utf8')
nativeModules['admin/portrait-preview'] = fs.readFileSync(path.join(root, 'miniprogram/pages/admin/memorial/portrait-preview.js'), 'utf8')
nativeModules['admin/portrait-upload'] = fs.readFileSync(path.join(root, 'miniprogram/pages/admin/memorial/portrait-upload.js'), 'utf8')
nativeModules['admin/portrait-prompt'] = fs.readFileSync(path.join(root, 'miniprogram/pages/admin/memorial/portrait-prompt.js'), 'utf8')
nativeModules['admin/memorial-portrait-layout'] = fs.readFileSync(path.join(root, 'miniprogram/pages/admin/memorial/memorial-portrait-layout.js'), 'utf8')
nativeModules['admin/plot-number'] = fs.readFileSync(path.join(root, 'miniprogram/pages/admin/memorial/plot-number.js'), 'utf8')
fs.writeFileSync(path.join(out, 'modules.json'), JSON.stringify(nativeModules))
fs.copyFileSync(path.join(root, 'docs/design/pet-memorial/native-preview.js'), path.join(out, 'native.js'))
fs.copyFileSync(path.join(root, 'docs/design/pet-memorial/native-preview.html'), path.join(out, 'native.html'))
fs.copyFileSync(path.join(root, 'miniprogram/assets/fonts/remixicon.wxss'), path.join(out, 'remixicon.css'))
fs.copyFileSync(path.join(root, 'miniprogram/assets/fonts/remixicon.woff2'), path.join(out, 'remixicon.woff2'))

// Optional local-only finished portrait example; never bundled into the app.
const portraitDemo = path.join(root, 'output/imagegen/memorial-portrait-demo/shiba-portrait-512.png')
if (fs.existsSync(portraitDemo)) {
  fs.copyFileSync(portraitDemo, path.join(out, 'portrait-demo.png'))
  const { width, height, bounds, digest } = require('../../cloudfunctions/api/services/playground-appearance-png').inspectPortrait(fs.readFileSync(portraitDemo))
  fs.writeFileSync(path.join(out, 'portrait-demo.json'), JSON.stringify({ layoutVersion: 1, width, height, bounds, previewDigest: digest, scale: 1 }))
}
