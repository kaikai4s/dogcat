// Pure clock-based playback: a saved route keeps moving even with no clients.
function track(nodes, speed) {
  let duration = 0, distance = 0
  const segments = []
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i]
    const length = Math.hypot(b.x - a.x, b.z - a.z)
    if (!length) continue
    const seconds = length / speed
    segments.push({ a, b, start: duration, seconds, distance, length })
    duration += seconds
    distance += length
  }
  return { segments, duration, distance }
}
function at(route, seconds, fallback) {
  const segment = route.segments.find((s) => seconds < s.start + s.seconds)
  if (!segment) return { position: { ...fallback }, moving: false, distance: route.distance, facingLeft: false }
  const t = Math.max(0, Math.min(1, (seconds - segment.start) / segment.seconds))
  return { position: { x: segment.a.x + (segment.b.x - segment.a.x) * t,
    z: segment.a.z + (segment.b.z - segment.a.z) * t }, moving: true,
    facingLeft: segment.b.x - segment.a.x - segment.b.z + segment.a.z < 0,
    distance: segment.distance + segment.length * t }
}
const compiled = new WeakMap()
function compile(motion) {
  if(compiled.has(motion))return compiled.get(motion)
  const approach = motion.approach || [motion.origin]
  const end = approach[approach.length - 1]
  const first = track(approach, motion.speed || 7)
  const patrol = motion.patrol || [end]
  // Pause on every patrol segment, including the return to the starting point.
  const wait = motion.wait === undefined ? 3 : motion.wait
  let cycle = 0, length = 0
  const legs = []
  for (let i = 1; i < patrol.length; i++) {
    const route = track([patrol[i - 1], patrol[i]], motion.roamSpeed || 3)
    legs.push({ a: patrol[i - 1], b: patrol[i], route, start: cycle, distance: length })
    cycle += wait + route.duration
    length += route.distance
  }
  const result={end,first,wait,cycle,length,legs}
  compiled.set(motion,result)
  return result
}
function sampleMotion(motion, now) {
  if(now<motion.epoch)return {position:{...(motion.approach||[motion.origin])[0]},moving:false,distance:0,facingLeft:false}
  const {end,first,wait,cycle,length,legs}=compile(motion)
  let seconds = Math.max(0, (now - motion.epoch) / 1000)
  if (seconds < first.duration) return at(first, seconds, end)
  seconds -= first.duration
  if (!cycle) return { position: { ...end }, moving: false, distance: first.distance, facingLeft: false }
  const loops = Math.floor(seconds / cycle)
  seconds %= cycle
  for (const leg of legs) {
    if (seconds < leg.start + wait + leg.route.duration) {
      const base = first.distance + loops * length + leg.distance
      if (seconds < leg.start + wait) return { position: { ...leg.a }, moving: false, distance: base,
        facingLeft: leg.b.x - leg.a.x - leg.b.z + leg.a.z < 0 }
      const result = at(leg.route, seconds - leg.start - wait, leg.b)
      result.distance += base
      return result
    }
  }
  return { position: { ...end }, moving: false, distance: first.distance + (loops + 1) * length, facingLeft: false }
}
module.exports = { sampleMotion }
