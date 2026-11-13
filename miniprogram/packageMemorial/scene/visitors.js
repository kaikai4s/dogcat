const MIN_BUFFER = 300, MAX_BUFFER = 1500, RECOVERY_GAP = 2000, TTL = 20000, MAX_SAMPLES = 32
const clamp = (n, min, max) => Math.max(min, Math.min(max, n))
function stamp(row, arrival) {
  if (Number.isSafeInteger(row.sampledAt) && row.sampledAt >= 0) return { value: row.sampledAt, kind: 'sample' }
  if (Number.isFinite(row.updatedAt)) return { value: row.updatedAt, kind: 'server' }
  return { value: arrival, kind: 'arrival' }
}

// A continuous playback clock follows confirmed positions. Its buffer adapts to
// each visitor's delivery cadence; packet arrival never directly moves the sprite.
class Visitors {
  constructor(now = Date.now) { this.now = now; this.actors = new Map() }
  apply(rows, removed = []) {
    removed.forEach(id => this.actors.delete(id))
    const arrival = this.now()
    for (const row of rows) {
      if (!Number.isFinite(row.x) || !Number.isFinite(row.y)) continue
      let actor = this.actors.get(row.id)
      const last = actor && actor.samples[actor.samples.length - 1]
      if (actor && (actor.epoch > row.epoch || actor.epoch === row.epoch &&
        Number.isFinite(row.seq) && Number.isFinite(last.seq) && row.seq <= last.seq)) continue
      const source = stamp(row, arrival)
      if (!actor || actor.epoch !== row.epoch || Math.hypot(last.x - row.x, last.y - row.y) > 240) {
        actor = { ...row, moving: false, samples: [{ ...row, time: 0 }], walkPhase: 0, idleTime: 0,
          cursor: 0, buffer: MIN_BUFFER, cadence: 250, gaps: [], rate: 1, receivedAt: arrival, source }
        this.actors.set(row.id, actor)
        continue
      }
      const gap = Math.max(0, arrival - actor.receivedAt)
      const sourceGap = source.value - actor.source.value
      const distance = Math.hypot(last.x - row.x, last.y - row.y)
      if (gap >= RECOVERY_GAP && last.moving) {
        // We no longer have a continuous path after a long outage. Bridge from
        // the displayed point to the confirmed point, without replaying silence
        // or teleporting a short distance on reconnect.
        const duration = Math.max(MIN_BUFFER, Math.hypot(actor.x - row.x, actor.y - row.y) / .12)
        actor.samples = [{ ...last, x: actor.x, y: actor.y, direction: actor.direction,
          gender: actor.gender, activity: actor.activity, time: 0 }, { ...row, time: duration }]
        actor.cursor = 0; actor.rate = 1
        actor.receivedAt = arrival; actor.source = source
        continue
      }
      // Only intervals from one sender clock matter. Clock corrections or an old
      // client switching timestamp format must not rewind/stretch the timeline.
      const elapsed = Math.max(distance / .16,
        source.kind === actor.source.kind && sourceGap > 0 && sourceGap <= TTL &&
          Math.abs(sourceGap - gap) < RECOVERY_GAP ? sourceGap : Math.max(1, gap))
      const time = last.time + elapsed
      if (last.moving && gap < 3000 && elapsed < 3000) {
        actor.gaps.push(Math.max(gap, elapsed))
        if (actor.gaps.length > 12) actor.gaps.shift()
        actor.cadence += (elapsed - actor.cadence) * .25
        actor.buffer = clamp(Math.max(...actor.gaps) * 1.2 + 60, MIN_BUFFER, MAX_BUFFER)
      }
      if (!last.moving && elapsed > actor.cadence * 1.5) {
        // Heartbeats contain no movement. Hold at the old position until near
        // the first new step, instead of spreading that step over four seconds.
        const start = time - Math.min(elapsed, Math.max(actor.cadence, distance / .12))
        actor.samples.push({ ...last, time: start })
        if (Math.hypot(actor.x - last.x, actor.y - last.y) < .01) actor.cursor = start
      } else if (!last.moving && distance < .01 && actor.cursor >= last.time) {
        actor.cursor = time
      }
      actor.samples.push({ ...row, time })
      // Bound storage even if the canvas was paused while subscriptions arrived.
      if (actor.samples.length > MAX_SAMPLES) actor.samples.splice(0, actor.samples.length - MAX_SAMPLES)
      actor.receivedAt = arrival; actor.source = source
    }
  }
  step(dt) {
    const now = this.now(), ms = clamp(Number.isFinite(dt) ? dt * 1000 : 0, 0, 250)
    for (const [id, actor] of this.actors) {
      if (now - actor.receivedAt >= TTL) { this.actors.delete(id); continue }
      const samples = actor.samples, latest = samples[samples.length - 1]
      const remaining = Math.max(0, latest.time - actor.cursor)
      const desired = latest.time + Math.max(0, now - actor.receivedAt) - actor.buffer
      let rate = clamp(1 + (desired - actor.cursor) / 1000, .75, 1.2)
      // A short delivery gap gently slows the last confirmed segment. Never
      // extrapolate past it or flip to idle at every exhausted 300 ms buffer.
      if (latest.moving) rate = Math.min(rate, remaining / Math.max(100, actor.cadence * .65))
      actor.rate += (rate - actor.rate) * (1 - Math.exp(-ms / 120))
      actor.cursor = Math.min(latest.time, Math.max(samples[0].time, actor.cursor + ms * actor.rate))
      if (latest.time - actor.cursor < .1) actor.cursor = latest.time
      while (samples.length > 2 && samples[1].time <= actor.cursor) samples.shift()
      const a = samples[0], b = samples[1] || a
      const mix = a === b ? 0 : clamp((actor.cursor - a.time) / Math.max(1, b.time - a.time), 0, 1)
      const x = a.x + (b.x - a.x) * mix, y = a.y + (b.y - a.y) * mix
      const dx = x - actor.x, dy = y - actor.y, distance = Math.hypot(dx, dy)
      actor.x = x; actor.y = y
      actor.moving = distance > .001
      const appearance = mix >= 1 ? b : a
      // Face the segment actually being played, including a buffered turn.
      actor.direction = actor.moving ?
        (Math.abs(dy) > Math.abs(dx) * .14 ? (dy < 0 ? 'n' : 's') : b.direction[0]) +
        (Math.abs(dx) > Math.abs(dy) * .14 ? (dx < 0 ? 'w' : 'e') : b.direction[1]) : appearance.direction
      actor.gender = appearance.gender; actor.activity = appearance.activity
      if (actor.moving) { actor.walkPhase = (actor.walkPhase + distance / 98 * 8) % 8; actor.idleTime = 0 }
      else actor.idleTime += ms / 1000
    }
  }
}
module.exports = { Visitors }
