const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const mini = path.join(root, 'miniprogram')
const app = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8'))
const packages = (app.subpackages || app.subPackages || []).map(item => item.root.replace(/\/$/, ''))
const totals = { main: 0, ...Object.fromEntries(packages.map(name => [name, 0])) }
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) scan(file)
    else {
      const relative = path.relative(mini, file).replace(/\\/g, '/')
      const owner = packages.find(name => relative.startsWith(`${name}/`)) || 'main'
      totals[owner] += fs.statSync(file).size
    }
  }
}
scan(mini)
const startupSamplesMs = []
for (let sample = 0; sample < 5; sample++) {
  const result = spawnSync(process.execPath, ['-e', "const t=performance.now(); require('./cloudfunctions/api/services/context')({db:{},cloud:{}}); console.log(performance.now()-t)"], { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  startupSamplesMs.push(Math.round(Number(result.stdout.trim()) * 100) / 100)
}
console.log(JSON.stringify({ measurement: 'localSourceOnly', packageSourceBytes: totals,
  contextAssemblySamplesMs: startupSamplesMs, cloudColdStartMeasured: false, wechatCompressedPackageMeasured: false }, null, 2))
