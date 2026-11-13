const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../../miniprogram')
const scene = path.join(root, 'packageMemorial/scene')
const admin = path.join(root, 'pages/admin/memorial')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
const packages = manifest.subpackages.map(item => path.resolve(root, item.root)).sort((a, b) => b.length - a.length)
const owner = file => packages.find(directory => file.startsWith(directory + path.sep)) || root

test('memorial-only helpers stay inside their consuming subpackages and page dependencies resolve within package boundaries', () => {
  for (const name of ['memorial-portrait-layout', 'memorial-asset-path']) {
    assert.equal(fs.existsSync(path.join(root, 'utils', name + '.js')), false)
    assert.equal(owner(path.join(scene, name + '.js')), path.join(root, 'packageMemorial'))
    assert.equal(owner(path.join(admin, name + '.js')), path.join(root, 'pages/admin'))
  }
  const visited = new Set()
  function visit(file) {
    if (visited.has(file) || !file.endsWith('.js')) return
    visited.add(file)
    const source = fs.readFileSync(file, 'utf8')
    for (const [, request] of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!request.startsWith('.') && !request.startsWith('/')) continue
      const target = request.startsWith('/') ? path.resolve(root, '.' + request) : path.resolve(path.dirname(file), request)
      const resolved = [target + '.js', target + '.json', path.join(target, 'index.js'), target]
        .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      assert.ok(resolved, `${path.relative(root, file)} cannot resolve ${request}`)
      assert.ok(owner(resolved) === root || owner(resolved) === owner(file),
        `${path.relative(root, file)} imports another subpackage: ${request}`)
      visit(resolved)
    }
  }
  for (const directory of ['packageMemorial/pages', 'pages/admin/memorial']) {
    for (const file of fs.readdirSync(path.join(root, directory)).filter(name => name.endsWith('.js'))) {
      visit(path.join(root, directory, file))
    }
  }
})

test('garden rendering and admin preview keep identical portrait placement logic', () => {
  assert.equal(fs.readFileSync(path.join(scene, 'memorial-portrait-layout.js'), 'utf8'),
    fs.readFileSync(path.join(admin, 'memorial-portrait-layout.js'), 'utf8'))
})

test('both subpackages resolve identical assets when switching between development and production', () => {
  const gardenAssets = require(path.join(scene, 'memorial-asset-path'))
  const adminAssets = require(path.join(admin, 'memorial-asset-path'))
  const { setForceEnvId } = require('../../miniprogram/envList')
  const normalize = directory => fs.readFileSync(path.join(directory, 'memorial-asset-path.js'), 'utf8')
    .replace(/(?:\.\.\/)+/g, '<root>/')
  assert.equal(normalize(scene), normalize(admin))
  try {
    for (const env of ['cloud1-5gnhqn4t0554c1d9', 'production-d2g5jx277f41a81a6']) {
      setForceEnvId(env)
      for (const style of ['arch', 'cottage', 'moon', 'unknown', undefined]) {
        const expected = gardenAssets.monumentFileID(style)
        assert.equal(adminAssets.monumentFileID(style), expected)
        assert.ok(expected.startsWith('cloud://' + env + '.'))
        assert.ok(expected.endsWith('/monuments-v1/' + (['cottage', 'moon'].includes(style) ? style : 'arch') + '.png'))
      }
      for (const key of ['garden.jpg', 'audio/music.wav']) {
        assert.equal(adminAssets.memorialAssetID(key), gardenAssets.memorialAssetID(key))
        assert.equal(adminAssets.memorialAssetID(key, env), gardenAssets.memorialAssetID(key, env))
      }
    }
    for (const assets of [gardenAssets, adminAssets]) {
      assert.throws(() => assets.memorialAssetID('garden.jpg', 'unknown'), /未配置/)
    }
  } finally { setForceEnvId('') }
})
