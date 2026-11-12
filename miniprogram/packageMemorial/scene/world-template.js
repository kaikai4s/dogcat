// Parallel projection: one world unit has one constant display scale everywhere.
const WIDTH = 4608, HEIGHT = 3072, CHUNK = 384
// Plot IDs retain their original version; expanded chunk assets have a new path.
const CHUNK_DIRECTORY = 'world-v3/chunks'
const rect = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
const PROPS = {
  tree: { index: 0, width: 150, height: 186, radius: 14, clearance: 70 },
  shrub: { index: 1, width: 64, height: 64, radius: 22, clearance: 34 },
  fountain: { index: 2, width: 208, height: 184, radius: 79, clearance: 110 },
  gazebo: { index: 3, width: 200, height: 224, radius: 66, clearance: 106 },
  cottage: { index: 4, width: 224, height: 220, radius: 82, clearance: 118 },
  memorial: { index: 5, width: 112, height: 154, radius: 30, clearance: 56 }
}
const roadX = [768, 1536, 2304, 3072, 3840], roadY = [576, 1152, 1728, 2304], roadWidth = 96
const plaza = { x: 1536, y: 1152, radius: 170 }
const landmarks = [
  { id: 'fountain', kind: 'fountain', name: '思念之泉', x: 1536, y: 1152 },
  { id: 'gazebo-west', kind: 'gazebo', name: '静思亭', x: 1100, y: 880 },
  { id: 'gazebo-east', kind: 'gazebo', name: '静思亭', x: 1972, y: 1456 },
  { id: 'cottage', kind: 'cottage', name: '守望小屋', x: 2650, y: 830 },
  { id: 'gazebo-extension', kind: 'gazebo', name: '拾光亭', x: 3456, y: 1456 },
  { id: 'cottage-extension', kind: 'cottage', name: '听风小屋', x: 4200, y: 2630 }
]
const lawns = []
const xs = [96, 832, 1600, 2368], xe = [704, 1472, 2240, 2976]
const ys = [96, 640, 1216, 1792], ye = [512, 1088, 1664, 2208]
ys.forEach((y, r) => xs.forEach((x, c) => lawns.push({
  name: ['北苑', '花泉苑', '静思苑', '南苑'][r] + (c + 1), polygon: rect(x, y, xe[c] - x, ye[r] - y)
})))
// Keep all sixteen original lawn polygons and their names unchanged.
ys.forEach((y, r) => [3136, 3904].forEach((x, c) => lawns.push({
  name: '东苑' + (r * 2 + c + 1), polygon: rect(x, y, (c ? 4512 : 3776) - x, ye[r] - y)
})))
;[96, 832, 1600, 2368, 3136, 3904].forEach((x, c) => lawns.push({
  name: '听风苑' + (c + 1), polygon: rect(x, 2368, [704, 1472, 2240, 2976, 3776, 4512][c] - x, 608)
}))
function onRoad(x, y, margin) {
  margin = margin || 0
  return roadX.some(v => Math.abs(x - v) < roadWidth / 2 + margin) ||
    roadY.some(v => Math.abs(y - v) < roadWidth / 2 + margin) ||
    Math.hypot(x - plaza.x, y - plaza.y) < plaza.radius + margin
}
module.exports = { WIDTH, HEIGHT, CHUNK, CHUNK_DIRECTORY, PROPS, roadX, roadY, roadWidth, plaza,
  version: 'garden-ortho-v2', boundary: rect(64, 64, WIDTH - 128, HEIGHT - 128),
  spawn: { x: 1536, y: 1430 }, landmarks, lawns, onRoad, rect }
