const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '../../miniprogram/packagePlayground')

test('playground entry exposes only 2D game actions', () => {
  const wxml = fs.readFileSync(path.join(root, 'pages/index.wxml'), 'utf8')
  const worldWxml = fs.readFileSync(path.join(root, 'pages/world.wxml'), 'utf8')
  const page = fs.readFileSync(path.join(root, 'pages/index.js'), 'utf8')
  const worldPage = fs.readFileSync(path.join(root, 'pages/world.js'), 'utf8')

  assert.match(wxml, /2D 互动/)
  assert.match(wxml, /打开庄园/)
  assert.match(wxml, /进入小区宠物庄园/)
  assert.match(worldWxml, /type="2d"/)
  assert.match(worldPage, /World2D/)
  assert.doesNotMatch(page, /generatePet3DModel|updatePetModel|bindPetCustomModel|customModel/)
  assert.doesNotMatch(worldPage, /World3D|webgl|模型待接入|activeModel/)
})
