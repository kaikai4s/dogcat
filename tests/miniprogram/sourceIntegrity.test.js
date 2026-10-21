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

function validateWxssBraces(source, filename) {
  let depth = 0
  let inComment = false
  let inString = null
  const lines = source.split('\n')
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]
    for (let i = 0; i < line.length; i++) {
      if (inComment) {
        if (line[i] === '*' && line[i + 1] === '/') {
          inComment = false
          i++
        }
        continue
      }
      if (inString) {
        if (line[i] === '\\' && i + 1 < line.length) {
          i++
          continue
        }
        if (line[i] === inString) {
          inString = null
        }
        continue
      }
      if (line[i] === '/' && line[i + 1] === '*') {
        inComment = true
        i++
        continue
      }
      if (line[i] === '"' || line[i] === '\'') {
        inString = line[i]
        continue
      }
      if (line[i] === '{') {
        depth++
      } else if (line[i] === '}') {
        depth--
        if (depth < 0) {
          throw new Error(`Unexpected closing brace '}' in ${filename} at line ${lineIdx + 1}, col ${i + 1}`)
        }
      }
    }
  }
  if (depth !== 0) {
    throw new Error(`Unclosed brace '{' in ${filename} (unbalanced depth: ${depth})`)
  }
}

test('shipped source contains no merge conflict markers, JavaScript parses and WXSS braces balance', () => {
  const root = path.resolve(__dirname, '../..')
  const files = ['miniprogram', 'cloudfunctions/api'].flatMap(dir => sourceFiles(path.join(root, dir)))
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /^(?:<{7}|={7}|>{7})(?: .*)?\r?$/m, path.relative(root, file))
    if (file.endsWith('.js')) new vm.Script(source, { filename: file })
    if (file.endsWith('.wxss')) validateWxssBraces(source, path.relative(root, file))
  }
})
