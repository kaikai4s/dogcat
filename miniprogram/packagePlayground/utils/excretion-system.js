const { sampleNeeds, settleNeeds, relieveWaste } = require('./pet-needs')
const { getExcretionAsset } = require('./excretion-assets')
const { YARD_SIZE } = require('./yard-layout')

const YARD_DEFAULT_SIZE = YARD_SIZE || 112

function isOutsideYard(pos, plot) {
  if (!plot || !Number.isFinite(plot.x) || !Number.isFinite(plot.z)) return true
  const size = plot.size || YARD_DEFAULT_SIZE
  const half = size / 2
  return Math.abs(pos.x - plot.x) > half || Math.abs(pos.z - plot.z) > half
}

function triggerRelief(pet, type, amount, context, reason) {
  const now = context.now || Date.now()
  relieveWaste(pet, type, amount, now)

  // 3 秒停顿状态：禁止移动
  pet.relieving = {
    type,
    start: now,
    until: now + 3000
  }
  pet.moving = false
  pet.route = []
  pet.pendingAutonomousCare = null

  const actionName = type === 'poop' ? '便便' : '嘘嘘'
  const isRiding = !!pet.ridingVehicleId
  const car = isRiding && context.vehicles && context.vehicles.get(pet.ridingVehicleId)

  if (car) {
    // 发生在车上：记录污渍
    car.stains = car.stains || []
    const rand = context.random || Math.random
    car.stains.push({
      type,
      at: now,
      x: (rand() - 0.5) * 0.4,
      y: (rand() - 0.5) * 0.2
    })
    car.soiled = true
    if (context.onStatus) {
      context.onStatus(`${pet.name || '宠物'}在车上${actionName}了，车子脏了！需洗车清洁`)
    }
  } else {
    // 发生在地面：生成地贴痕迹
    if (context.groundDecals) {
      context.groundDecals.push({
        id: `decal_${now}_${Math.floor((context.random || Math.random)() * 10000)}`,
        type,
        x: pet.position.x,
        z: pet.position.z,
        createdAt: now
      })
      while (context.groundDecals.length > 60) {
        context.groundDecals.shift()
      }
    }
    if (context.onStatus) {
      const msg = reason === 'burst'
        ? `${pet.name || '宠物'}憋不住了，在原地${actionName}了`
        : `${pet.name || '宠物'}${actionName}了，一身轻松~`
      context.onStatus(msg)
    }
  }

  if (context.emitPets) {
    context.emitPets()
  }
  if (context.onRelief) {
    context.onRelief(pet, type, amount)
  }
}

function updatePetExcretion(pet, dt, context) {
  const now = context.now || Date.now()

  // 1. 处理正在进行的排泄停顿（3秒禁止移动）
  if (pet.relieving) {
    if (now < pet.relieving.until) {
      pet.moving = false
      pet.route = []
      return
    }
    pet.relieving = null
  }

  // 2. 获取当前体内生理累积值
  const needs = sampleNeeds(pet, now)
  const rules=pet.needsRules||{}
  const poopVal = Number.isFinite(needs.poop) ? needs.poop : 0
  const peeVal = Number.isFinite(needs.pee) ? needs.pee : 0

  // 3. 满 100 极限憋不住规则（无论院内院外，立即排泄）
  if (poopVal >= 100) {
    triggerRelief(pet, 'poop', 40, context, 'burst')
    pet.outsidePoopTimer = 0
    return
  }
  if (peeVal >= 100) {
    triggerRelief(pet, 'pee', 20, context, 'burst')
    pet.nextPeeCooldown = null
    return
  }

  // 4. 庭院外机制判定
  const outside = isOutsideYard(pet.position, context.ownPlot)
  if (!outside) {
    // 庭院内：重置院外计时
    pet.outsideSeconds = 0
    pet.outsidePoopTimer = 0
    pet.nextPeeCooldown = null
    return
  }

  pet.outsideSeconds = (pet.outsideSeconds || 0) + dt

  // 4.1 便便规则：值 >= 40 且在院外待满 2 分钟 (120 秒)
  if (poopVal >= (rules.poopThreshold||40)) {
    pet.outsidePoopTimer = (pet.outsidePoopTimer || 0) + dt
    if (pet.outsidePoopTimer >= (rules.poopDelaySeconds||120)) {
      triggerRelief(pet, 'poop', 40, context, 'outside')
      pet.outsidePoopTimer = 0
      return
    }
  } else {
    pet.outsidePoopTimer = 0
  }

  // 4.2 嘘嘘规则：值 >= 20，随机 30~60 秒排泄一次
  if (peeVal >= (rules.peeThreshold||20)) {
    if (pet.nextPeeCooldown === undefined || pet.nextPeeCooldown === null) {
      const rand = context.random ? context.random() : Math.random()
      pet.nextPeeCooldown = rules.peeDelaySeconds || (30 + rand * 30)
    }
    pet.nextPeeCooldown -= dt
    if (pet.nextPeeCooldown <= 0) {
      triggerRelief(pet, 'pee', 20, context, 'outside')
      const rand = context.random ? context.random() : Math.random()
      pet.nextPeeCooldown = rules.peeDelaySeconds || (30 + rand * 30)
      return
    }
  } else {
    pet.nextPeeCooldown = null
  }
}

// Canvas 矢量兜底及贴图绘制辅助函数
function drawSingleDecal(ctx, decal, pt, size, customImage) {
  if (customImage) {
    const imgW = customImage.width || 1
    const imgH = customImage.height || 1
    const aspect = imgW / imgH
    let drawW = size
    let drawH = size
    if (aspect >= 1) {
      drawH = size / aspect
    } else {
      drawW = size * aspect
    }
    const anchorY = decal.type === 'poop' ? 0.78 : 0.5
    ctx.drawImage(customImage, pt.x - drawW / 2, pt.y - drawH * anchorY, drawW, drawH)
    return
  }
  ctx.save()
  ctx.translate(pt.x, pt.y)
  if (decal.type === 'pee') {
    // 嘘嘘：淡黄色水渍光晕与微波
    ctx.fillStyle = 'rgba(238, 201, 78, 0.45)'
    ctx.beginPath()
    ctx.ellipse(0, 0, size * 0.7, size * 0.4, 0.2, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(245, 218, 110, 0.65)'
    ctx.beginPath()
    ctx.ellipse(size * 0.1, size * 0.05, size * 0.45, size * 0.25, -0.1, 0, Math.PI * 2)
    ctx.fill()
  } else {
    // 便便：精致三层螺旋与高光
    ctx.fillStyle = '#7a4823'
    ctx.beginPath()
    ctx.ellipse(0, 0, size * 0.45, size * 0.25, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#8b5329'
    ctx.beginPath()
    ctx.ellipse(0, -size * 0.15, size * 0.32, size * 0.2, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#9c6032'
    ctx.beginPath()
    ctx.arc(0, -size * 0.3, size * 0.14, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
    ctx.beginPath()
    ctx.arc(-size * 0.1, -size * 0.18, size * 0.05, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function drawVehicleStains(ctx, stains, size, customImages) {
  if (!stains || !stains.length) return
  for (const stain of stains) {
    const ox = stain.x * size
    const oy = (stain.y || 0) * size - size * 0.2
    const stainSize = size * 0.22
    const img = customImages && customImages[stain.type]
    if (img) {
      ctx.drawImage(img, ox - stainSize / 2, oy - stainSize / 2, stainSize, stainSize)
    } else {
      ctx.save()
      ctx.translate(ox, oy)
      if (stain.type === 'pee') {
        ctx.fillStyle = 'rgba(245, 218, 110, 0.75)'
        ctx.beginPath()
        ctx.ellipse(0, 0, stainSize * 0.6, stainSize * 0.35, 0.25, 0, Math.PI * 2)
        ctx.fill()
      } else {
        ctx.fillStyle = '#7a4823'
        ctx.beginPath()
        ctx.arc(0, 0, stainSize * 0.4, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#8b5329'
        ctx.beginPath()
        ctx.arc(stainSize * 0.1, -stainSize * 0.1, stainSize * 0.25, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }
  }
}

module.exports = {
  YARD_DEFAULT_SIZE,
  isOutsideYard,
  triggerRelief,
  updatePetExcretion,
  drawSingleDecal,
  drawVehicleStains
}
