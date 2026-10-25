const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../../miniprogram')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))
const packages = manifest.subpackages.map(item => path.resolve(root, item.root)).sort((a, b) => b.length - a.length)
const owner = file => packages.find(directory => file.startsWith(directory + path.sep)) || root

test('map utilities stay out of the main package and static imports respect subpackage boundaries', () => {
  assert.equal(fs.existsSync(path.join(root, 'utils/community-map.js')), false)
  assert.equal(owner(path.join(root, 'pages/common/community-map/utils.js')), path.join(root, 'pages/common/community-map'))
  assert.equal(owner(path.join(root, 'pages/admin/community-map/location.js')), path.join(root, 'pages/admin'))
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
  for (const entry of ['pages/common/community-map/index.js', 'pages/common/community-map/settings.js', 'pages/admin/community-map/index.js']) visit(path.join(root, entry))
})
