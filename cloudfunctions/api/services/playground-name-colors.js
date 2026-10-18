const crypto = require('crypto')
const COLLECTION = 'pet_playground_plots'
const registryId = (communityId) => 'name_colors_' + communityId
const validColor = (value) => /^#[0-9a-f]{6}$/i.test(value || '') && !/^#(?:ffffff|000000)$/i.test(value)

function candidate(index) {
  const hue = (index % 360) * 137 % 360 / 360
  const saturation = (60 + Math.floor(index / 360) % 26) / 100
  const lightness = (35 + Math.floor(index / 9360) % 16) / 100
  const a = saturation * Math.min(lightness, 1 - lightness)
  const channel = (n) => {
    const k = (n + hue * 12) % 12
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16).padStart(2, '0')
  }
  return '#' + channel(0) + channel(8) + channel(4)
}

// A community registry is the transaction lock for concurrent allocations.
async function allocate(tx, communityId, ownerKey, read) {
  const id = registryId(communityId)
  const registry = await read(tx, id) || { kind: 'name_colors', communityId, colors: {} }
  const colors = { ...registry.colors }
  if (validColor(colors[ownerKey])) return colors[ownerKey]
  const used = new Set(Object.values(colors).map((color) => String(color).toLowerCase()))
  const count = 149760, start = crypto.randomInt(count)
  for (let offset = 0; offset < count; offset++) {
    const color = candidate((start + offset) % count)
    if (used.has(color)) continue
    colors[ownerKey] = color
    await tx.collection(COLLECTION).doc(id).set({ data: { kind: 'name_colors', communityId, colors } })
    return color
  }
  throw new Error('小区名字颜色已用完，请联系管理员')
}

async function release(tx, communityId, ownerKey, read) {
  const id = registryId(communityId), registry = await read(tx, id)
  if (!registry || !registry.colors || !registry.colors[ownerKey]) return
  const colors = { ...registry.colors }
  delete colors[ownerKey]
  await tx.collection(COLLECTION).doc(id).set({ data: { kind: 'name_colors', communityId, colors } })
}

module.exports = { allocate, release, validColor }
