const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(file)
    return /\.(js|json|wxml|wxs|wxss)$/.test(entry.name) ? [file] : []
  })
}

test('shipped source contains no merge conflict markers and JavaScript parses', () => {
  const root = path.resolve(__dirname, '../..')
  const files = ['miniprogram', 'cloudfunctions/api'].flatMap(dir => sourceFiles(path.join(root, dir)))
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /^(?:<{7}|={7}|>{7})(?: .*)?\r?$/m, path.relative(root, file))
    if (file.endsWith('.js')) new vm.Script(source, { filename: file })
  }
})
