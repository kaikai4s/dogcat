// Source audit only. Runtime processing is shared by every cloud-loaded scene.
// No local fence slicing or machine-specific image helper is required.
const fs = require('node:fs')
const path = require('node:path')
const {
  ASSET_NAMES
} = require('../miniprogram/packagePlayground/utils/asset-loader-2d')
const source = path.resolve(
  process.argv[2] || path.join(__dirname, '../baseImage')
)
for (const name of ASSET_NAMES) {
  const file = path.join(source, name + '.png')
  const data = fs.readFileSync(file)
  if (data.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a')
    throw new Error('Invalid PNG: ' + file)
  console.log(
    name + '.png: ' + data.readUInt32BE(16) + ' × ' + data.readUInt32BE(20)
  )
}
console.log(
  'Assets verified. Upload originals to packagePlayground/2d/baseImage/. Grass and sprite cleanup run on the canvas; fences are drawn procedurally.'
)
