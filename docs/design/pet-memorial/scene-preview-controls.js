const $ = id => document.getElementById(id)
const canvas = $('canvas')
canvas.createImage = () => new Image()
canvas.requestAnimationFrame = fn => requestAnimationFrame(fn)
canvas.cancelAnimationFrame = id => cancelAnimationFrame(id)
const sound = new GardenSound(() => {
  const node = new Audio()
  node.preload = 'auto'
  node.onCanplay = fn => node.addEventListener('canplay', fn)
  node.onError = fn => node.addEventListener('error', fn)
  node.seek = time => { node.currentTime = time }
  node.destroy = () => { node.pause(); node.removeAttribute('src'); node.load() }
  document.body.appendChild(node)
  return node
}, setting => {
  $(setting).textContent = (setting === 'music' ? '音乐' : '音效') + '重试'
  $(setting).classList.remove('enabled')
})
function updateView(view) {
  $('overview').textContent = view.overview ? '返回散步 ↘' : '大地图 ↗'
  $('follow').hidden = view.following || view.overview
  $('mapHelp').hidden = !view.overview
  $('walk').style.visibility = view.overview ? 'hidden' : 'visible'
  document.querySelector('.zoom-controls').hidden = view.overview
  if (!view.overview) $('selection').hidden = true
}
const scene = new MemorialScene(canvas, { width: canvas.clientWidth, height: canvas.clientHeight,
  createCanvas: (width,height) => { const c = document.createElement('canvas'); c.width=width; c.height=height; return c },
  onNavigation: state => { $('navigation').hidden = !state.active && !state.arrived; $('navText').textContent = (state.arrived ? '已到达：' : '跟随箭头：') + state.name },
  dpr: devicePixelRatio, onTravel: distance => sound.travel(distance), onViewChange: updateView,
  loadChunk: async id => {
    const response = await fetch('/packageMemorial/assets/world-v2/chunks/' + id + '.json')
    if (!response.ok) throw new Error('附近场景暂时无法加载')
    return response.json()
  },
  onStreamChange: status => {
    $('stream').hidden = !status.loading && !status.failed
    $('stream').textContent = status.failed ? '附近场景加载失败 · 点击重试' : '正在加载附近场景…'
  } })
$('stream').onclick = () => scene.retryChunks()
const drawTimes = []
const originalDraw = scene.draw.bind(scene)
scene.draw = () => { const start=performance.now(); originalDraw(); drawTimes.push(performance.now()-start); if(drawTimes.length>180)drawTimes.shift() }
const gestures = new MapGestures(scene)
let busy = true, held = false, mapTap = null, selected = null
const keys = new Set(), pointers = new Map()
scene.load().then(() => { busy = false; $('loading').style.display = 'none'; scene.start() })
  .catch(error => { $('loading').textContent = error.message })
for (const gender of ['boy', 'girl']) $(gender).onclick = async () => {
  if (busy) return
  busy = true; stop()
  try {
    await scene.setGender(gender)
    $('boy').classList.toggle('selected', gender === 'boy')
    $('girl').classList.toggle('selected', gender === 'girl')
  } finally { busy = false }
}
for (const setting of ['music', 'effects']) $(setting).onclick = () => {
  const enabled = sound.toggle(setting)
  $(setting).textContent = (setting === 'music' ? '音乐 ' : '音效 ') + (enabled ? '开' : '关')
  $(setting).classList.toggle('enabled', enabled)
}
$('overview').onclick = () => { $('selection').hidden = true; stop(); scene.toggleOverview(); sound.chime() }
$('follow').onclick = () => { stop(); scene.followPlayer(); sound.chime() }
$('grid').onclick = () => {
  if (!scene.overview) scene.toggleOverview()
  scene.showGrid = !scene.showGrid
  $('grid').textContent = scene.showGrid ? '收起墓位' : '查看可申请墓位'
  $('note').hidden = !scene.showGrid
  scene.draw(); sound.chime()
}
for (const [id, delta] of [['plus', .3], ['minus', -.3]]) $(id).onclick = () => scene.setZoom(delta)
$('reset').onclick = () => { stop(); scene.reset(); sound.chime() }
function input() {
  scene.setInput((keys.has('d') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('a') || keys.has('ArrowLeft') ? 1 : 0),
    (keys.has('s') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('w') || keys.has('ArrowUp') ? 1 : 0))
}
onkeydown = event => {
  if (!['w', 'a', 's', 'd', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || busy) return
  event.preventDefault()
  if (!keys.size) { cancelMap(); scene.followPlayer() }
  keys.add(event.key); input()
}
onkeyup = event => { keys.delete(event.key); input() }
function cancelMap() { pointers.clear(); gestures.reset() }
function stop() { held = false; keys.clear(); cancelMap(); scene.setInput(0, 0); $('knob').style.transform = 'none' }
const pad = $('pad')
function move(event) {
  if (!held || busy) return
  const b = pad.getBoundingClientRect(), radius = b.width * .32
  let x = event.clientX - b.left - b.width / 2, y = event.clientY - b.top - b.height / 2
  const length = Math.hypot(x, y)
  if (length > radius) { x *= radius / length; y *= radius / length }
  scene.setInput(x / radius, y / radius)
  $('knob').style.transform = `translate(${x}px,${y}px)`
}
pad.onpointerdown = event => {
  if (busy) return
  cancelMap(); scene.followPlayer(); held = true; pad.setPointerCapture(event.pointerId); move(event)
}
pad.onpointermove = move
pad.onpointerup = pad.onpointercancel = pad.onlostpointercapture = stop
function mapPoint(event) {
  const rect = canvas.getBoundingClientRect()
  return { id: event.pointerId, x: event.clientX - rect.left, y: event.clientY - rect.top }
}
canvas.onpointerdown = event => {
  if (busy || held) return
  canvas.setPointerCapture(event.pointerId)
  if (scene.overview) { mapTap = mapPoint(event); return }
  pointers.set(event.pointerId, mapPoint(event)); gestures.update(Array.from(pointers.values()))
}
canvas.onpointermove = event => {
  if (mapTap && Math.hypot(mapPoint(event).x-mapTap.x, mapPoint(event).y-mapTap.y)>8) mapTap=null
  if (!pointers.has(event.pointerId)) return
  pointers.set(event.pointerId, mapPoint(event)); gestures.update(Array.from(pointers.values()))
}
canvas.onpointerup = canvas.onpointercancel = canvas.onlostpointercapture = event => {
  if (mapTap && scene.overview && event.type === 'pointerup') {
    const p = scene.screenToMap(mapTap)
    if (p.x>64 && p.y>64 && p.x<3008 && p.y<2240) {
      const landmark = scene.map.landmarks.find(q => Math.hypot(q.x-p.x,q.y-p.y)<130)
      selected = landmark || p; scene.selectedPoint = selected
      $('selectedName').textContent = landmark ? landmark.name : '所选位置'
      $('selection').hidden = false
    }
  }
  mapTap=null
  pointers.delete(event.pointerId); gestures.update(Array.from(pointers.values()))
}
canvas.addEventListener('wheel', event => {
  event.preventDefault()
  if (!busy) scene.zoomAt(Math.exp(-Math.max(-200, Math.min(200, event.deltaY)) * .003), mapPoint(event))
}, { passive: false })
onblur = () => { stop(); scene.pause(); sound.pause() }
onfocus = () => { if (!document.hidden) { scene.start(); sound.resume() } }
document.onvisibilitychange = () => {
  if (document.hidden) { stop(); scene.pause(); sound.pause() }
  else { scene.start(); sound.resume() }
}
new ResizeObserver(() => { stop(); scene.resize(canvas.clientWidth, canvas.clientHeight, devicePixelRatio) }).observe(canvas)
$('view').onclick = () => {
  const wide = document.querySelector('main').classList.toggle('wide')
  $('view').textContent = wide ? '切换竖屏' : '切换横屏'
}
setInterval(() => {
  $('status').textContent = `人物 ${scene.gender} / ${scene.direction}\n动作 ${scene.moving ? 'walk' : 'idle'} · 帧 ${scene.getFrame() + 1}/8\n附近草坪 ${scene.cells.length} 格 · 区域 ${scene.chunks.cache.size}/48\n绘制 ${drawTimes.length ? (drawTimes.reduce((a,b)=>a+b,0)/drawTimes.length).toFixed(2) : 0} ms / 峰值 ${Math.max(0,...drawTimes).toFixed(2)} ms\n镜头 ${scene.following ? '跟随人物' : '自由浏览'} · 缩放 ${scene.zoom.toFixed(2)}\n坐标 ${scene.player.x.toFixed(1)}, ${scene.player.y.toFixed(1)}`
}, 250)

$('settings').onclick = () => { stop(); $('settingsPanel').hidden=false }
$('closeSettings').onclick = () => { $('settingsPanel').hidden=true }
$('clearSelection').onclick = () => { $('selection').hidden=true; scene.selectedPoint=null }
$('navigate').onclick = () => { if(selected && scene.navigate(selected,selected.name || '所选位置')) scene.followPlayer() }
$('cancelNav').onclick = () => scene.cancelNavigation()
let preferences = { music: true, effects: true }
try { preferences = Object.assign(preferences, JSON.parse(localStorage.getItem('memorial-sound-v1') || '{}')) } catch (_) {}
sound.configure(preferences)
for (const setting of ['music','effects']) {
  $(setting).textContent = (setting==='music'?'音乐 ':'音效 ') + (preferences[setting]?'开':'关')
  $(setting).onclick = () => { preferences[setting]=!preferences[setting]; if(sound[setting]!==preferences[setting]) sound.toggle(setting); $(setting).textContent=(setting==='music'?'音乐 ':'音效 ')+(preferences[setting]?'开':'关'); localStorage.setItem('memorial-sound-v1',JSON.stringify(preferences)) }
}
document.addEventListener('pointerdown',()=>{ sound.configure(preferences); for(const key of ['music','effects']) $(key).textContent=(key==='music'?'音乐 ':'音效 ')+(preferences[key]?'开':'关') },{once:true})
