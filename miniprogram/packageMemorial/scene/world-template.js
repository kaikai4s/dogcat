// Parallel projection: one world unit has one constant display scale everywhere.
const WIDTH = 3072, HEIGHT = 2304, CHUNK = 384
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
const PROPS = {
  tree: { index: 0, width: 150, height: 186, radius: 14, clearance: 70 },
  shrub: { index: 1, width: 64, height: 64, radius: 22, clearance: 34 },
  fountain: { index: 2, width: 208, height: 184, radius: 79, clearance: 110 },
  gazebo: { index: 3, width: 200, height: 224, radius: 66, clearance: 106 },
  cottage: { index: 4, width: 224, height: 220, radius: 82, clearance: 118 },
  memorial: { index: 5, width: 60, height: 62, radius: 21, clearance: 36 }
}
const roadX = [768, 1536, 2304], roadY = [576, 1152, 1728], roadWidth = 96
const plaza = { x: 1536, y: 1152, radius: 170 }
const landmarks = [
  { id: 'fountain', kind: 'fountain', name: '思念之泉', x: 1536, y: 1152 },
  { id: 'gazebo-west', kind: 'gazebo', name: '静思亭', x: 1100, y: 880 },
  { id: 'gazebo-east', kind: 'gazebo', name: '静思亭', x: 1972, y: 1456 },
  { id: 'cottage', kind: 'cottage', name: '守望小屋', x: 2650, y: 830 }
]
const lawns = []
const xs = [96, 832, 1600, 2368], xe = [704, 1472, 2240, 2976]
const ys = [96, 640, 1216, 1792], ye = [512, 1088, 1664, 2208]
ys.forEach((y, r) => xs.forEach((x, c) => lawns.push({
  name: ['北苑', '花泉苑', '静思苑', '南苑'][r] + (c + 1), polygon: rect(x, y, xe[c] - x, ye[r] - y)
})))
function onRoad(x, y, margin) {
  margin = margin || 0
  return roadX.some(v => Math.abs(x - v) < roadWidth / 2 + margin) ||
    roadY.some(v => Math.abs(y - v) < roadWidth / 2 + margin) ||
    Math.hypot(x - plaza.x, y - plaza.y) < plaza.radius + margin
}
module.exports = { WIDTH, HEIGHT, CHUNK, PROPS, roadX, roadY, roadWidth, plaza,
  version: 'garden-ortho-v2', boundary: rect(64, 64, WIDTH - 128, HEIGHT - 128),
  spawn: { x: 1536, y: 1430 }, landmarks, lawns, onRoad, rect }
