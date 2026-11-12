// Keep the copies in packageMemorial/scene and pages/admin/memorial identical.
// Each subpackage bundles its own copy; memorialPackaging.test.js checks parity.
// Coordinates are world units; transparent padding never changes portrait size.
const MIN_SCALE = .5, MAX_SCALE = 1.4
const poseLabel = pose => pose === 'sleeping' ? '安心趴睡' : '乖巧坐着'
function portraitLayout(memorial, asset = memorial.portrait || {}) {
  const ratio = memorial.legacy ? 64 / 112 : 1
  const x = memorial.x || 0, groundY = (memorial.y || 0) + (memorial.legacy ? 3 : 6)
  const b = asset.bounds
  const valid = asset.layoutVersion === 1 && b && [b.x, b.y, b.width, b.height, asset.width, asset.height].every(Number.isFinite) &&
    b.x >= 0 && b.y >= 0 && b.width > 0 && b.height > 0 && b.x + b.width <= asset.width && b.y + b.height <= asset.height
  if (!valid) {
    // Existing approved artwork keeps its original framing until replaced.
    const size = memorial.legacy ? 50 : 88
    return { x: x - size / 2, y: groundY - size * .88, width: size, height: size, groundY, shadowWidth: size * .4, shadowHeight: size * .09 }
  }
  const scale = Number.isFinite(asset.scale) ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, asset.scale)) : 1
  const fit = Math.min(56 / b.width, 48 / b.height) * ratio * scale
  const width = b.width * fit, height = b.height * fit
  return { x: x - width / 2, y: groundY - height, width, height, groundY, crop: b,
    shadowWidth: width * .78, shadowHeight: Math.min(5 * ratio * scale, height * .1) }
}
function drawPortrait(c, image, memorial) {
  const box = portraitLayout(memorial)
  c.save(); c.fillStyle = 'rgba(40,55,30,.14)'; c.beginPath()
  c.ellipse(memorial.x, box.groundY - 1, box.shadowWidth / 2, box.shadowHeight / 2, 0, 0, Math.PI * 2); c.fill(); c.restore()
  if (box.crop) {
    const b = box.crop
    // The scene caches a 256px texture; bounds refer to the original PNG.
    const sx = (image.width || memorial.portrait.width) / memorial.portrait.width
    const sy = (image.height || memorial.portrait.height) / memorial.portrait.height
    c.drawImage(image, b.x * sx, b.y * sy, b.width * sx, b.height * sy, box.x, box.y, box.width, box.height)
  } else c.drawImage(image, box.x, box.y, box.width, box.height)
}
function placementPreview(memorial, asset) {
  const ratio = memorial.legacy ? 64 / 112 : 1
  const viewWidth = 168 * ratio, viewHeight = 192 * ratio
  const m = { ...memorial, x: viewWidth / 2, y: 147 * ratio }
  const box = portraitLayout(m, asset)
  const style = (x, y, width, height) => `left:${x / viewWidth * 100}%;top:${y / viewHeight * 100}%;width:${width / viewWidth * 100}%;height:${height / viewHeight * 100}%;`
  const b = box.crop
  return {
    monument: style(m.x - 56 * ratio, m.y - 154 * ratio * .84, 112 * ratio, 154 * ratio),
    pet: style(box.x, box.y, box.width, box.height),
    image: b ? `left:${-b.x / b.width * 100}%;top:${-b.y / b.height * 100}%;width:${asset.width / b.width * 100}%;height:${asset.height / b.height * 100}%;` : 'left:0;top:0;width:100%;height:100%;',
    shadow: style(m.x - box.shadowWidth / 2, box.groundY - 1 - box.shadowHeight / 2, box.shadowWidth, box.shadowHeight),
    name: style(m.x - 56 * ratio * .48, m.y - 154 * ratio * (.84 - .43) - 6 * ratio, 112 * ratio * .48, 12 * ratio),
    scalePercent: Math.round((Number.isFinite(asset.scale) ? asset.scale : 1) * 100)
  }
}
module.exports = { MIN_SCALE, MAX_SCALE, poseLabel, portraitLayout, drawPortrait, placementPreview }
