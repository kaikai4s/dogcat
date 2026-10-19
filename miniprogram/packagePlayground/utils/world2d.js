const { AssetLoader2D } = require('./asset-loader-2d')
const { createNavigation } = require('./navigation')
const { CHARACTER_STYLE } = require('./character-assets')
const { PET_ATLASES } = require('./pet-assets')
const { validAppearance, atlasFor } = require('./appearance-assets')
const { sampleMotion } = require('./shared-motion')
const { PlayerCharacter, CHARACTER_RADIUS, INTERACTION_DISTANCE } = require('./player-character')
const {
  YARD_SIZE,
  VEHICLE_RADIUS,
  FOUNTAIN_FRAMES,
  YARD_EXTRAS,
  yardLayout
} = require('./yard-layout')
const { updatePetExcretion, drawSingleDecal } = require('./excretion-system')
const { getExcretionAsset, setExcretionAsset: configureExcretionAsset } = require('./excretion-assets')
const vehicleWorld = require('./vehicle-world')
const lifeWorld = require('./life-world')
const STEP = 56,
  SIZE = YARD_SIZE,
  CHUNK = 112
const PET_RADIUS = 0.8
const ROAM_WAIT = 3
const clamp = (n, a, b) => Math.max(a, Math.min(b, n))
function petStart(origin, plot, index) {
  const rowStep = plot ? Math.min(5, ((plot.size || SIZE) / 2 - 18) / 2) : 5
  return {
    x: origin.x + ((index % 3) - 1) * 5,
    z: origin.z + Math.floor(index / 3) * rowStep
  }
}
function yardObstacles(p) {
  const x = p.x,
    z = p.z,
    h = (p.size || SIZE) / 2,
    t = 0.65
  return [
    { minX: x - h - t, maxX: x - h + t, minZ: z - h, maxZ: z + h },
    { minX: x + h - t, maxX: x + h + t, minZ: z - h, maxZ: z + h },
    { minX: x - h, maxX: x + h, minZ: z - h - t, maxZ: z - h + t },
    { minX: x - h, maxX: x - 3, minZ: z + h - t, maxZ: z + h + t },
    { minX: x + 3, maxX: x + h, minZ: z + h - t, maxZ: z + h + t },
    { minX: x - 3.25, maxX: x - 2.75, minZ: z + h - 3, maxZ: z + h },
    { minX: x + 2.75, maxX: x + 3.25, minZ: z + h - 3, maxZ: z + h },
    ...yardLayout(p)
      .sprites.filter((item) => item.radius > 0)
      .map((item) => ({
        minX: item.x - item.radius,
        maxX: item.x + item.radius,
        minZ: item.z - item.radius,
        maxZ: item.z + item.radius
      }))
  ]
}
class World2D {
  constructor(page, onStatus, overview, onPetsChange) {
    this.page = page
    this.onStatus = onStatus || (() => {})
    this.onPetsChange = onPetsChange || (() => {})
    this.overviewData = overview || {}
    this.farmCatalog=this.overviewData.farmCatalog||{revision:0,crops:require('./farm-model').CROPS,soils:require('./farm-model').SOILS}
    this.config = { width: 2240, height: 2240, ...this.overviewData.world }
    this.plotSize = this.config.plotSize || SIZE
    this.bounds = {
      minX: 0,
      minZ: 0,
      maxX: this.config.width,
      maxZ: this.config.height
    }
    this.ownPlot = this.overviewData.plot
    this.startPoint = {
      x: Math.floor(this.config.width / (STEP * 2)) * STEP,
      z: Math.floor(this.config.height / (STEP * 2)) * STEP
    }
    this.camera = this.ownPlot
      ? { x: this.ownPlot.x, z: this.ownPlot.z }
      : { ...this.startPoint }
    this.assets = {}
    this.characterType = page.data && page.data.characterType === 'girl' ? 'girl' : 'boy'
    this.pets = []
    this.chunks = new Map()
    this.pending = new Map()
    this.queue = []
    this.activeLoads = 0
    this.regionGeneration = 0
    this.mapPlots = new Map()
    this.mapCursor = ''
    this.mapComplete = false
    this.zoom = Number.isFinite(page.sceneZoom) ? page.sceneZoom : 1
    this.manualZoom = Number.isFinite(page.sceneZoom)
    this.scale = 4
    this.width = 375
    this.height = 667
    this.follow = false
    this.destroyed = false
    this.placing = false
    this.elapsed = 0
    this.roamPlanning = 0
    this.random = Math.random
    this.character = null
    this.followCharacter = false
    this.foodBowls = { dog: 0, ...this.overviewData.foodBowls }
    this.scene = this.overviewData.scene
    this.setOwnAppearance(this.scene&&this.scene.appearance)
    this.customImages=new Map()
    this.customLoads=new Map()
    this.customRetry=new Map()
    this.customSizes=new Map()
    this.customUsed=new Map()
    this.social = this.scene && this.scene.social || {friends:[],visits:{}}
    this.sharedPlots = new Map()
    this.remoteCharacters = []
    this.vehicles = new Map()
    this.drivingVehicleId=this.scene&&this.scene.vehicleId||''
    this.vehicleRole=this.scene&&this.scene.vehicleRole||''
    this.vehicleSpeed=clamp(Number(this.scene&&this.scene.vehicleSpeed)||2,2,5)
    this.sceneTrail = []
    this.serverOffset = this.scene ? this.scene.serverTime - Date.now() : 0
    this.groundDecals = []
    this.excretionImages = {}
  }
  setExcretionAsset(type, fileIDOrPath) {
    configureExcretionAsset(type, fileIDOrPath)
    this.loadExcretionAssets()
  }
  loadExcretionAssets() {
    if (!this.loader) return
    if (!this.excretionLoads) this.excretionLoads = new Map()
    if (!this.excretionRetry) this.excretionRetry = new Map()
    const now = Date.now()
    for (const type of ['pee', 'poop']) {
      const asset = getExcretionAsset(type)
      if (!asset) continue
      const target = asset.fileID || asset.localPath
      if (!target || this.excretionImages[type] || this.excretionLoads.has(type)) continue
      if (now < (this.excretionRetry.get(type) || 0)) continue

      const p = this.loader.loadImage(target).then((img) => {
        if (!this.destroyed && img) {
          this.excretionImages[type] = img
        }
      }).catch(() => {
        if (!this.destroyed) this.excretionRetry.set(type, Date.now() + 10000)
      }).finally(() => {
        this.excretionLoads.delete(type)
      })
      this.excretionLoads.set(type, p)
    }
  }
  async init() {
    const item = await new Promise((resolve, reject) =>
      wx
        .createSelectorQuery()
        .in(this.page)
        .select('#worldCanvas')
        .fields({ node: true, size: true, rect: true })
        .exec((r) =>
          r && r[0] && r[0].node
            ? resolve(r[0])
            : reject(new Error('无法获取场景画布'))
        )
    )
    if (this.destroyed) return
    this.canvas = item.node
    this.canvasRect = { left: item.left || 0, top: item.top || 0 }
    this.ctx = this.canvas.getContext('2d')
    this.dpr = Math.min(
      (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync())
        .pixelRatio || 1,
      2
    )
    this.resize(item.width, item.height)
    this.loader = new AssetLoader2D(this.canvas)
    if (this.scene) this.characterType = this.scene.characterType
    const species = new Set(
      (this.overviewData.pets || []).map((p) =>
        p.species === 'cat' ? 'cat' : 'dog'
      )
    )
    const initialAssets = [
      'grass_tile',
      ...['idle', 'walk', 'run'].map((action) => this.characterType + '_' + action + '_sw'),
      ...[...species].map((s) => s + '_walk')
    ]
    this.assets = await this.loader.loadAll(
      (p) => this.onStatus('加载云端素材 ' + p + '%…'),
      initialAssets
    )
    if (this.destroyed) return
    this.pattern = this.ctx.createPattern(this.assets.grass_tile, 'repeat')
    this.buildWorld()
    this.focusCharacter()
    await this.prepareCharacterArea()
    await this.loadVisible()
    if (this.destroyed) return
    this.onStatus(this.scene && this.scene.hasAvatar === false
      ? '尚未安置庭院，可直接重新选择小区并建造'
      : '点击宠物选择操作 · 摇杆轻推行走、拉远奔跑')
    this.loadExcretionAssets()
    this.start()
  }
  async setCharacterType(type) {
    if (!['boy', 'girl'].includes(type) || this.destroyed) return false
    const generation = this.characterLoadGeneration = (this.characterLoadGeneration || 0) + 1
    this.setCharacterInput(0, 0)
    const images = await this.loader.loadAll(null,
      ['idle', 'walk', 'run'].map((action) => type + '_' + action + '_sw'))
    if (this.destroyed || generation !== this.characterLoadGeneration) return false
    Object.assign(this.assets, images)
    this.characterType = type
    return true
  }
  resize(w, h) {
    this.width = w
    this.height = h
    if (!this.initialViewSet && !this.manualZoom && this.ownPlot) this.zoom = this.yardZoom()
    this.initialViewSet = true
    if (this.canvas) {
      this.canvas.width = Math.round(w * this.dpr)
      this.canvas.height = Math.round(h * this.dpr)
    }
  }
  buildWorld() {
    const origin = this.ownPlot
      ? { x: this.ownPlot.x, z: this.ownPlot.z + 14 }
      : this.camera
    this.pets = (this.scene && !this.ownPlot ? [] : this.overviewData.pets || []).slice(0, 8).map((p, i) => ({
      id: p._id,
      name: p.name || '宠物',
      species: p.species,
      appearance:p.appearance||null,
      ownerId:this.scene&&this.scene.playerId,
      modelScale: clamp(Number(p.playgroundScale) || 1, 0.5, 2),
      savedModelScale: clamp(Number(p.playgroundScale) || 1, 0.5, 2),
      position: petStart(origin, this.ownPlot, i),
      route: [],
      moving: false,
      mode: 'idle',
      idleSeconds: 0,
      commandToken: 0
    }))
    this.selectedPetId = ''
    this.spawnCharacter()
    this.emitPets()
  }
  spawnCharacter() {
    if (this.scene && this.scene.hasAvatar === false) { this.character = null; return }
    const origin = this.scene && this.scene.position ? this.scene.position : this.ownPlot
      ? { x: this.ownPlot.x + 3, z: this.ownPlot.z + 14 }
      : this.startPoint
    this.character = new PlayerCharacter(origin)
    this.character.facing=this.scene&&this.scene.facing||'sw'
    this.character.mirrored=!!(this.scene&&this.scene.mirrored)
    this.character.vehicleSpeed=this.drivingVehicleId&&this.vehicleRole!=='passenger'?14*this.vehicleSpeed:0
    this.characterTerrain = null
    this.characterAreaPromise = null
    this.characterRetryAt = 0
    this.nearbyKey = null
  }
  focusCharacter() {
    this.clearPetSelection()
    if (!this.character || this.placing) return
    this.follow = false
    this.followCharacter = true
    this.camera = { ...this.character.position }
    this.prepareCharacterArea().catch(() => {})
    this.loadVisible().catch(() => this.onStatus('角色附近场景加载失败，请重试'))
  }
  setCharacterInput(x, y) {
    if(this.vehicleRole==='passenger'){x=0;y=0}
    if (!this.character) return
    this.characterRoute = null
    this.characterMoveToken = (this.characterMoveToken || 0) + 1
    if (this.destroyed || this.placing || this.recoveringScene || this.vehicleBusy) { x = 0; y = 0 }
    this.character.setInput(x, y)
    if (this.character.input.x || this.character.input.y) {
      this.clearPetSelection()
      if (!this.followCharacter) this.focusCharacter()
      this.prepareCharacterArea().catch(() => {})
    }
  }
  prepareCharacterArea() {
    if (!this.character || this.destroyed) return Promise.resolve()
    if (this.characterAreaPromise) return this.characterAreaPromise
    const character = this.character
    const p = character.position
    const b = this.characterTerrain
    if (b && !this.characterAreaLoaded(b)) this.characterTerrain = null
    const margin=this.drivingVehicleId?18:4, reach=this.drivingVehicleId?40:12
    if (this.characterTerrain && p.x >= b.minX + margin && p.x <= b.maxX - margin && p.z >= b.minZ + margin && p.z <= b.maxZ - margin)
      return Promise.resolve()
    if (this.elapsed < this.characterRetryAt) return Promise.resolve()
    const bounds = {
      minX: Math.max(0, p.x - reach), maxX: Math.min(this.config.width, p.x + reach),
      minZ: Math.max(0, p.z - reach), maxZ: Math.min(this.config.height, p.z + reach)
    }
    const generation = this.regionGeneration
    const promise = this.loadNavigationArea(bounds).then(() => {
      if (!this.destroyed && this.character === character && generation === this.regionGeneration)
        this.characterTerrain = bounds
    }).catch((error) => {
      if (!this.destroyed && this.character === character && generation === this.regionGeneration) {
        this.characterRetryAt = this.elapsed + 2
        this.onStatus('角色附近场景加载失败，暂时无法继续前进')
      }
      throw error
    }).finally(() => {
      if (this.characterAreaPromise === promise) this.characterAreaPromise = null
    })
    this.characterAreaPromise = promise
    return promise
  }
  characterAreaLoaded(bounds) {
    const margin = Math.max(SIZE, this.plotSize) / 2 + 4
    const minX = Math.floor(Math.max(0, bounds.minX - margin) / CHUNK)
    const maxX = Math.floor(Math.min(this.config.width - 0.001, bounds.maxX + margin) / CHUNK)
    const minZ = Math.floor(Math.max(0, bounds.minZ - margin) / CHUNK)
    const maxZ = Math.floor(Math.min(this.config.height - 0.001, bounds.maxZ + margin) / CHUNK)
    for (let x = minX; x <= maxX; x++)
      for (let z = minZ; z <= maxZ; z++)
        if (!this.chunks.has(this.chunkKey(x, z))) return false
    return true
  }
  characterNavigation() {
    const p = this.character.position
    const reach=this.drivingVehicleId?14:8
    const area = { minX: p.x - reach, maxX: p.x + reach, minZ: p.z - reach, maxZ: p.z + reach }
    const obstacles=this.plots().filter((plot)=>plot.x+(plot.size||SIZE)/2>=area.minX&&plot.x-(plot.size||SIZE)/2<=area.maxX&&plot.z+(plot.size||SIZE)/2>=area.minZ&&plot.z-(plot.size||SIZE)/2<=area.maxZ)
      .flatMap((plot)=>!this.drivingVehicleId&&this.canEnterPlot(plot)?yardObstacles(plot):this.solidPlot(plot))
    return createNavigation(this.bounds, obstacles, this.drivingVehicleId?VEHICLE_RADIUS:CHARACTER_RADIUS, 1.5)
  }
  canEnterPlot(plot) {
    if(!this.scene || plot.mine)return true
    const friends=this.social.friends||[]
    return friends.some((friend)=>friend.id===plot.ownerId) ||
      !!(this.social.visits && this.social.visits[plot.id] && this.social.visits[plot.id].expiresAt>Date.now()+this.serverOffset && this.social.visits[plot.id].instanceId===(plot.instanceId||''))
  }
  setSocial(state) {
    if((state.revision||0)<(this.social.revision||0))return
    this.social=state
    this.nearbyKey=null
    this.page.setData({socialFriends:state.friends||[],socialRequests:state.incoming||[],socialOutgoing:state.outgoing||[]})
    this.emitNearby()
  }
  nearbyInteractions() {
    const result = { pet: null, bowl: null }
    if(this.drivingVehicleId)return result
    if (!this.character || this.placing || this.destroyed || this.isMapOverview() || !this.characterTerrain || !this.characterAreaLoaded(this.characterTerrain))
      return result
    const p = this.character.position
    const nav = this.characterNavigation()
    let distance = INTERACTION_DISTANCE
    for (const pet of this.pets) {
      if (pet.mine === false) continue
      if (pet.id !== this.selectedPetId) continue
      const d = Math.hypot(p.x - pet.position.x, p.z - pet.position.z)
      if (d <= distance && nav.clearSegment(p, pet.position)) {
        distance = d
        result.pet = { id: pet.id, name: pet.name }
      }
    }
    if (this.ownPlot) {
      const stations=yardLayout(this.ownPlot).stations
      if (['dog','cat'].some((species)=>{
        const station=stations[species].eat
        return Math.hypot(p.x - station.x, p.z - station.z) <= INTERACTION_DISTANCE && nav.clearSegment(p, station)
      }))
        result.bowl = { plotId: this.ownPlot.id, food: Math.min(this.foodBowls.dog||0,this.foodBowls.cat||0) }
    }
    const nearbyPlayer=this.remoteCharacters.map((person)=>({...person,position:this.neighborPosition(person)}))
      .find((person)=>Math.hypot(p.x-person.position.x,p.z-person.position.z)<=5)
    if(nearbyPlayer)result.player={id:nearbyPlayer.id,name:nearbyPlayer.name,friend:(this.social.friends||[]).some((friend)=>friend.id===nearbyPlayer.id)}
    const gate=this.plots().find((plot)=>!this.canEnterPlot(plot)&&Math.hypot(p.x-plot.x,p.z-(plot.z+(plot.size||SIZE)/2+2))<=6)
    if(gate)result.gate={plotId:gate.id,playerId:gate.ownerId,name:gate.ownerName||String(gate.name||'邻居').replace(/的庭院$/,'')}
    if (this.groundDecals && this.groundDecals.length) {
      const poop = this.groundDecals.find((d) => d.type === 'poop' && Math.hypot(p.x - d.x, p.z - d.z) <= 3.8 && nav.clearSegment(p, d))
      if (poop) result.poop = { id: poop.id, x: poop.x, z: poop.z }
    }
    return result
  }
  async pickupPoop(id) {
    if (!this.character) return false
    const p = this.character.position
    const target = id
      ? this.groundDecals.find((d) => d.id === id && Math.hypot(p.x - d.x, p.z - d.z) <= 4.2)
      : this.groundDecals.find((d) => d.type === 'poop' && Math.hypot(p.x - d.x, p.z - d.z) <= 4.2)
    if (!target) {
      this.onStatus('离便便太远了，请走近一些再拾取')
      return false
    }
    this.groundDecals = this.groundDecals.filter((d) => d.id !== target.id)
    this.emitNearby()
    this.onStatus('已拾取便便，存入农场仓库化为有机肥！')
    if (this.page.recordPoopPickup) {
      await this.page.recordPoopPickup()
    }
    return true
  }
  emitNearby() {
    this.emitVehicleUi()
    this.emitFarmUi()
    const nearby = this.nearbyInteractions()
    const key = JSON.stringify(nearby)
    if (key === this.nearbyKey) return
    this.nearbyKey = key
    this.page.setData({
      nearbyPet: nearby.pet,
      nearbyBowl: nearby.bowl,
      nearbyPlayer: nearby.player || null,
      nearbyGate: nearby.gate || null,
      nearbyPoop: nearby.poop || null
    })
  }
  interactPet(id) {
    const nearby = this.nearbyInteractions().pet
    if (!nearby || nearby.id !== id) return false
    const pet = this.pets.find((p) => p.id === id)
    if (pet.mine === false) return false
    if (pet.sharedMotion) {
      this.onStatus(`${pet.name}开心地蹭了蹭你`)
      pet.interactingUntil=this.elapsed+2.5
      return true
    }
    if ((pet.interactingUntil || 0) > this.elapsed) return false
    pet.commandToken = (pet.commandToken || 0) + 1
    pet.planning = false
    pet.route = []
    pet.moving = false
    pet.destination = null
    pet.mode = 'idle'
    pet.idleSeconds = 0
    pet.interactingUntil = this.elapsed + 2.5
    this.selectedPetId = pet.id
    this.emitPets()
    this.onStatus(`${pet.name}开心地蹭了蹭你`)
    return true
  }
  applyBowlFood(result) {
    if (!this.ownPlot || result.plotId !== this.ownPlot.id) return false
    this.foodBowls.dog = result.food === 100 ? 100 : 0
    this.foodBowls.cat = this.foodBowls.dog
    this.emitNearby()
    return true
  }
  updateCharacter(dt) {
    if (!this.character || this.placing) return
    if(this.vehicleRole==='passenger') {
      const car=this.vehicles.get(this.drivingVehicleId)
      if(car)this.character.position={...this.vehiclePosition(car)}
      this.character.setInput(0,0)
      if(this.followCharacter)this.camera={...this.character.position}
      return
    }
    if(this.scene) {
      const plot=this.plots().find((p)=>!this.canEnterPlot(p)&&Math.abs(this.character.position.x-p.x)<(p.size||SIZE)/2&&Math.abs(this.character.position.z-p.z)<(p.size||SIZE)/2)
      if(plot) {
        this.characterRoute=null
        this.character.setInput(0,0)
        this.character.position={x:plot.x,z:plot.z+(plot.size||SIZE)/2+2}
        this.characterTerrain=null
        this.onStatus('当前没有庭院访问权限，已返回院门外')
      }
    }
    if (this.characterTerrain && !this.characterAreaLoaded(this.characterTerrain)) this.characterTerrain = null
    const route=this.characterRoute
    if(route && route.length && !this.recoveringScene) {
      const next=route[0],p=this.character.position,d=Math.hypot(next.x-p.x,next.z-p.z)
      if(d<.15)route.shift()
      if(route.length) {
        const dx=route[0].x-p.x,dz=route[0].z-p.z
        const sx=dx-dz,sy=(dx+dz)*.52,length=Math.hypot(sx,sy)
        const speed=this.drivingVehicleId?14*this.vehicleSpeed:7
        this.character.setInput(sx/length*(this.drivingVehicleId?1:.72),sy/length*(this.drivingVehicleId?1:.72))
        dt=Math.min(dt,Math.hypot(dx,dz)/speed)
      } else {this.character.setInput(0,0);this.characterRoute=null}
    }
    const input = this.character.input
    if (input.x || input.y) this.prepareCharacterArea().catch(() => {})
    const b = this.characterTerrain
    const known = (p) => Boolean(b && p.x >= b.minX && p.x <= b.maxX && p.z >= b.minZ && p.z <= b.maxZ)
    const steps=this.scene?[{...this.character.position}]:null
    this.character.update(dt, this.characterNavigation(), known, steps?(point)=>{
      // Preserve actual turns for both walking and driving; simplify only
      // consecutive collinear substeps inside this frame.
      const b=steps[steps.length-1],a=steps[steps.length-2]
      if(a&&Math.abs((b.x-a.x)*(point.z-b.z)-(b.z-a.z)*(point.x-b.x))<1e-8&&
        (b.x-a.x)*(point.x-b.x)+(b.z-a.z)*(point.z-b.z)>=0)steps[steps.length-1]={...point}
      else steps.push({...point})
    }:null)
    if (steps && this.character.moving) this.sceneTrail.push(...steps.slice(1))
    if (this.followCharacter) this.camera = { ...this.character.position }
  }
  emitPets() {
    const pets=this.pets.filter((p)=>p.mine!==false).map((p) => ({
        id: p.id,
        name: p.name,
        species: p.species,
        modelScale: p.modelScale,
        selected: p.id === this.selectedPetId,
        available: true,
        following:!!p.following,
        riding:!!p.ridingVehicleId,
        needs:this.petNeeds(p),
        fatigue:100-this.petNeeds(p)[0].value,
        activity:this.petActivity(p),
        status: p.moving
          ? p.mode === 'roaming'
            ? '自由活动'
            : '行走中'
          : '休息中'
      }))
    const signature=JSON.stringify(pets)
    if(signature===this.petUiSignature)return
    this.petUiSignature=signature
    this.onPetsChange(pets)
  }
  selectedPet() {
    return this.pets.find((p) => p.id === this.selectedPetId)
  }
  setPetScale(id, value, saved = false) {
    const pet = this.pets.find((p) => p.id === id)
    if (!pet || pet.mine === false || !Number.isFinite(Number(value))) return false
    pet.modelScale = clamp(Number(value), 0.5, 2)
    pet.scalePreview = !saved && pet.modelScale !== pet.savedModelScale
    if (saved) pet.savedModelScale = pet.modelScale
    this.emitPets()
    return true
  }
  selectPet(id) {
    if (!this.pets.some((p) => p.id === id && p.mine!==false)) return false
    if(this.selectedPetId!==id || this.characterSelected || this.selectedVehicleId) this.clearPetSelection()
    this.selectedPetId = id
    this.emitPets()
    return true
  }
  clearPetSelection() {
    if(this.selectedVehicleId) {this.selectedVehicleId='';this.characterTarget=null;this.emitVehicleUi()}
    if(this.characterSelected) {
      this.characterSelected=false
      this.characterTarget=null
      this.page.setData({characterSelected:false})
    }
    this.petTarget = null
    if (!this.selectedPetId) return
    this.selectedPetId = ''
    this.follow = false
    this.emitPets()
    this.emitNearby()
    this.page.setData({ showPetScale: false })
  }
  characterAt(point) {
    if(!this.character || this.drivingVehicleId)return false
    const p=this.project(this.character.position.x,this.character.position.z)
    const size=this.isMapOverview()?24:Math.max(24,CHARACTER_STYLE.size*this.scale*this.zoom)
    return Math.abs(point.x-p.x)<=size*.35 && point.y>=p.y-size*CHARACTER_STYLE.anchor && point.y<=p.y+10
  }
  selectCharacter() {
    if(!this.character)return
    this.clearPetSelection()
    this.characterSelected=true
    this.page.setData({characterSelected:true})
    this.onStatus('已选中自己的角色 · 点击空地移动，可连续更换目标')
  }
  async moveCharacterTo(target) {
    if(this.vehicleRole==='passenger'){this.onStatus('正在搭乘，先下车再步行');return false}
    if(!this.character || this.recoveringScene || this.vehicleBusy)return
    const start={...this.character.position}
    if(Math.hypot(target.x-start.x,target.z-start.z)>300)return this.onStatus('请选择附近的空地')
    const marker=this.characterTarget={...target,pending:true}
    const token=this.characterMoveToken=(this.characterMoveToken||0)+1
    this.characterRoute=null
    this.character.setInput(0,0)
    const bounds=this.routeBounds(start,target)
    try {
      await this.loadNavigationArea(bounds)
      if(this.destroyed || token!==this.characterMoveToken)return
      const blocks=this.plots().flatMap((plot)=>!this.drivingVehicleId&&this.canEnterPlot(plot)?yardObstacles(plot):this.solidPlot(plot))
      const route=await createNavigation(bounds,blocks,this.drivingVehicleId?VEHICLE_RADIUS:CHARACTER_RADIUS,1.5).pathAsync(start,target,()=>!this.destroyed && token===this.characterMoveToken)
      if(this.destroyed || token!==this.characterMoveToken)return
      if(!route) {if(this.characterTarget===marker)this.characterTarget=null;return this.onStatus('这里无法到达，请选择空地或从获准访问的院门进入')}
      this.characterRoute=route
      marker.pending=false
      this.follow=false
      this.onStatus((this.drivingVehicleId?'车辆':'角色')+'前往选定位置 · 可继续点击地图更换目标')
    } catch(error) {
      if(!this.destroyed && token===this.characterMoveToken) {
        if(this.characterTarget===marker)this.characterTarget=null
        this.onStatus('附近场景加载失败，请重新选择位置')
      }
    }
  }
  solidPlot(plot) {
    const h=(plot.size||SIZE)/2
    return [{minX:plot.x-h,maxX:plot.x+h,minZ:plot.z-h,maxZ:plot.z+h}]
  }
  routeBounds(a,b) {
    return {minX:Math.max(0,Math.min(a.x,b.x)-30),maxX:Math.min(this.config.width,Math.max(a.x,b.x)+30),
      minZ:Math.max(0,Math.min(a.z,b.z)-30),maxZ:Math.min(this.config.height,Math.max(a.z,b.z)+30)}
  }
  petAt(point) {
    const overview = this.isMapOverview()
    return this.pets.filter((p)=>!p.ridingVehicleId).sort((a,b)=>(b.position.x+b.position.z)-(a.position.x+a.position.z)).find((pet)=>{
      const p = this.project(pet.position.x,pet.position.z)
      const size = overview ? 24 : Math.max(24,7*(pet.modelScale||1)*this.scale*this.zoom)
      return Math.abs(point.x-p.x)<=size*.45 && point.y>=p.y-size*.9 && point.y<=p.y+Math.max(10,size*.1)
    })
  }
  screenCenter() {
    const data = this.page.data || {}
    const top = Math.min(this.height * 0.25, Number(data.top || 48) + 60)
    const bottom = Math.max(
      top + 80,
      this.height - Number(data.bottom || 20) - 150
    )
    return { x: this.width / 2, y: (top + bottom) / 2, top, bottom }
  }
  minimumZoom() {
    const center = this.screenCenter()
    const diagonal = (this.config.width + this.config.height) * this.scale
    return Math.min(
      1,
      Math.max(
        0.001,
        Math.min(
          (this.width - 32) / diagonal,
          (center.bottom - center.top - 24) / (diagonal * 0.52)
        )
      )
    )
  }
  yardZoom() {
    const center = this.screenCenter()
    const diagonal =
      (this.ownPlot ? this.ownPlot.size : this.plotSize) * 2 * this.scale
    return Math.max(
      this.minimumZoom(),
      Math.min(
        1,
        (this.width - 40) / diagonal,
        (center.bottom - center.top - 24) / (diagonal * 0.52)
      )
    )
  }
  isMapOverview() {
    const b = this.visibleBounds()
    const chunks =
      (Math.ceil((b.maxX - b.minX) / CHUNK) + 1) *
      (Math.ceil((b.maxZ - b.minZ) / CHUNK) + 1)
    return (
      chunks > 121 || (chunks > 36 && SIZE * 2 * this.scale * this.zoom < 100)
    )
  }
  project(x, z) {
    const center = this.screenCenter()
    const s = this.scale * this.zoom,
      dx = x - this.camera.x,
      dz = z - this.camera.z
    return {
      x: center.x + (dx - dz) * s,
      y: center.y + (dx + dz) * s * 0.52
    }
  }
  unproject(x, y) {
    const center = this.screenCenter()
    const s = this.scale * this.zoom,
      a = (x - center.x) / s,
      b = (y - center.y) / (s * 0.52)
    return { x: this.camera.x + (a + b) / 2, z: this.camera.z + (b - a) / 2 }
  }
  visibleBounds(margin = 60) {
    const pts = [
      [0, 0],
      [this.width, 0],
      [0, this.height],
      [this.width, this.height]
    ].map((p) => this.unproject(...p))
    return {
      minX: clamp(
        Math.min(...pts.map((p) => p.x)) - margin,
        0,
        this.config.width
      ),
      maxX: clamp(
        Math.max(...pts.map((p) => p.x)) + margin,
        0,
        this.config.width
      ),
      minZ: clamp(
        Math.min(...pts.map((p) => p.z)) - margin,
        0,
        this.config.height
      ),
      maxZ: clamp(
        Math.max(...pts.map((p) => p.z)) + margin,
        0,
        this.config.height
      )
    }
  }
  chunkKey(x, z) {
    return x + ',' + z
  }
  loadChunk(x, z) {
    const key = this.chunkKey(x, z)
    if (
      x < 0 ||
      z < 0 ||
      x * CHUNK >= this.config.width ||
      z * CHUNK >= this.config.height
    )
      return Promise.resolve()
    if (this.chunks.has(key)) return Promise.resolve(this.chunks.get(key))
    if (this.pending.has(key)) return this.pending.get(key)
    const promise = new Promise((resolve, reject) => {
      this.queue.push({ x, z, key, resolve, reject })
      this.pump()
    })
    this.pending.set(key, promise)
    return promise
  }
  pump() {
    while (!this.destroyed && this.activeLoads < 4 && this.queue.length) {
      const task = this.queue.shift()
      const generation = this.regionGeneration
      this.activeLoads++
      Promise.resolve()
        .then(() => this.page.fetchRegion(task.x, task.z))
        .then((r) => {
          if (!this.destroyed && generation === this.regionGeneration)
            this.chunks.set(task.key, r.plots || [])
          task.resolve(r)
        })
        .catch(task.reject)
        .finally(() => {
          this.pending.delete(task.key)
          this.activeLoads--
          this.pump()
        })
    }
  }
  async loadArea(b) {
    const tasks = []
    for (
      let x = Math.floor(b.minX / CHUNK);
      x <= Math.floor(b.maxX / CHUNK);
      x++
    )
      for (
        let z = Math.floor(b.minZ / CHUNK);
        z <= Math.floor(b.maxZ / CHUNK);
        z++
      )
        tasks.push(this.loadChunk(x, z))
    await Promise.all(tasks)
  }
  async loadVisible() {
    if (this.isMapOverview()) {
      await this.loadMapOverview()
      return
    }
    await this.loadArea(this.visibleBounds())
    if (this.destroyed) return
    if (this.plots().length && this.loader) await this.loadYardAssets()
    const b = this.visibleBounds(CHUNK)
    for (const [k] of this.chunks) {
      const [x, z] = k.split(',').map(Number)
      if (
        (x + 1) * CHUNK < b.minX ||
        x * CHUNK > b.maxX ||
        (z + 1) * CHUNK < b.minZ ||
        z * CHUNK > b.maxZ
      )
        this.chunks.delete(k)
    }
  }
  async loadMapOverview() {
    if (this.mapComplete || !this.page.fetchMapOverview) return
    if (this.mapLoading) return this.mapLoading
    const generation = this.regionGeneration
    this.mapLoading = (async () => {
      while (
        !this.destroyed &&
        generation === this.regionGeneration &&
        this.isMapOverview() &&
        !this.mapComplete
      ) {
        const result = await this.page.fetchMapOverview(this.mapCursor)
        if (this.destroyed || generation !== this.regionGeneration) return
        for (const p of result.plots || []) this.mapPlots.set(p.id, p)
        this.mapCursor = result.nextCursor || ''
        this.mapComplete = !this.mapCursor
      }
    })().finally(() => {
      this.mapLoading = null
    })
    return this.mapLoading
  }
  async loadYardAssets() {
    if (!this.yardAssetsPromise) {
      this.yardAssetsPromise = this.loader
        .loadAll(null, [
          'house',
          'tree',
          'flower_bush',
          'street_lamp',
          'stone_tile',
          'road_tile'
        ])
        .then((assets) => {
          if (!this.destroyed) Object.assign(this.assets, assets)
          this.loadYardExtras()
        })
        .catch((error) => {
          this.yardAssetsPromise = null
          throw error
        })
    }
    return this.yardAssetsPromise
  }
  loadYardExtras() {
    if (!this.yardExtrasPromise && !this.destroyed) {
      this.yardExtrasPromise = this.loader
        .loadAll(null, YARD_EXTRAS, { optional: true })
        .then((assets) => {
          if (!this.destroyed) Object.assign(this.assets, assets)
        })
        .catch(() => {
          this.yardExtrasPromise = null
        })
    }
    return this.yardExtrasPromise
  }
  plots() {
    const map = new Map()
    if (this.isMapOverview())
      for (const p of this.mapPlots.values()) map.set(p.id, p)
    for (const rows of this.chunks.values())
      for (const p of rows) map.set(p.id, p)
    if (this.ownPlot) map.set(this.ownPlot.id, this.ownPlot)
    for (const p of this.sharedPlots.values()) map.set(p.id,p)
    return [...map.values()]
  }
  obstacles(bounds) {
    return this.plots()
      .filter(
        (p) =>
          !bounds ||
          (p.x + (p.size || SIZE) / 2 >= bounds.minX &&
            p.x - (p.size || SIZE) / 2 <= bounds.maxX &&
            p.z + (p.size || SIZE) / 2 >= bounds.minZ &&
            p.z - (p.size || SIZE) / 2 <= bounds.maxZ)
      )
      .flatMap(yardObstacles)
  }
  loadNavigationArea(bounds) {
    // A fence may be visible while its yard's center is in the next chunk.
    const margin = Math.max(SIZE, this.plotSize) / 2 + 4
    return this.loadArea({
      minX: Math.max(0, bounds.minX - margin),
      maxX: Math.min(this.config.width, bounds.maxX + margin),
      minZ: Math.max(0, bounds.minZ - margin),
      maxZ: Math.min(this.config.height, bounds.maxZ + margin)
    })
  }
  async planRoam(pet) {
    if (this.destroyed || this.placing || pet.planning || pet.route.length)
      return
    const token = (pet.commandToken = (pet.commandToken || 0) + 1)
    const generation = this.regionGeneration
    pet.planning = true
    pet.idleSeconds = 0
    this.roamPlanning++
    const start = { ...pet.position }
    const bounds = {
      minX: Math.max(0, start.x - 28),
      maxX: Math.min(this.config.width, start.x + 28),
      minZ: Math.max(0, start.z - 28),
      maxZ: Math.min(this.config.height, start.z + 28)
    }
    try {
      await this.loadNavigationArea(bounds)
      if (
        this.destroyed ||
        generation !== this.regionGeneration ||
        token !== pet.commandToken
      )
        return
      const plots = this.plots().filter((p) => {
        const h = (p.size || SIZE) / 2
        return (
          p.x + h >= bounds.minX &&
          p.x - h <= bounds.maxX &&
          p.z + h >= bounds.minZ &&
          p.z - h <= bounds.maxZ
        )
      })
      const yard = plots.find(
        (p) =>
          Math.abs(start.x - p.x) <= (p.size || SIZE) / 2 &&
          Math.abs(start.z - p.z) <= (p.size || SIZE) / 2
      )
      const obstacles = plots.flatMap(yardObstacles)
      if (yard) {
        // Bounds close the open gate only for automatic walking.
        const h = (yard.size || SIZE) / 2
        bounds.minX = Math.max(bounds.minX, yard.x - h - PET_RADIUS)
        bounds.maxX = Math.min(bounds.maxX, yard.x + h + PET_RADIUS)
        bounds.minZ = Math.max(bounds.minZ, yard.z - h - PET_RADIUS)
        bounds.maxZ = Math.min(bounds.maxZ, yard.z + h + PET_RADIUS)
      } else {
        // Navigation inflates obstacles by PET_RADIUS, so inset the solid
        // rectangle to close exactly at the yard boundary, including its gate.
        for (const p of plots) {
          const h = (p.size || SIZE) / 2 - PET_RADIUS
          obstacles.push({
            minX: p.x - h,
            maxX: p.x + h,
            minZ: p.z - h,
            maxZ: p.z + h
          })
        }
      }
      const nav = createNavigation(bounds, obstacles, PET_RADIUS, 1.5)
      if (!nav.walkable(start)) return
      if (yard && this.ownPlot && yard.id === this.ownPlot.id && pet.mine !== false && !pet.following && !pet.ridingVehicleId) {
        const species = pet.species === 'cat' ? 'cat' : 'dog'
        const stations = yardLayout(yard).stations[species]
        const cooldown = (this.elapsed - (pet.lastCareActionAt || 0)) > 30
        if (cooldown && stations) {
          const food = (this.foodBowls && this.foodBowls[species]) || 0
          const needs = pet.needs || {}
          const hunger = (needs.satiety !== undefined ? needs.satiety : 100) < 80 || this.random() < 0.28
          const thirst = (needs.hydration !== undefined ? needs.hydration : 100) < 80 || this.random() < 0.28
          let targetStation = null, actionType = null
          if (food >= 10 && hunger && (!thirst || this.random() < 0.5)) {
            targetStation = stations.eat
            actionType = 'eat'
          } else if (thirst) {
            targetStation = stations.drink
            actionType = 'drink'
          }
          if (targetStation && nav.walkable(targetStation)) {
            const route = nav.path(start, targetStation)
            if (route && route.length) {
              pet.route = route
              pet.moving = true
              pet.mode = 'roaming'
              pet.roamPlotId = yard.id
              pet.pendingAutonomousCare = actionType
              pet.destination = null
              pet.arrivedAt = null
              this.emitPets()
              return
            }
          }
        }
      }
      for (let attempt = 0; attempt < 10; attempt++) {
        const angle = this.random() * Math.PI * 2
        const distance = 5 + this.random() * 15
        const target = {
          x: start.x + Math.cos(angle) * distance,
          z: start.z + Math.sin(angle) * distance
        }
        if (!nav.walkable(target)) continue
        const route = nav.path(start, target)
        if (!route || !route.length) continue
        pet.route = route
        pet.moving = true
        pet.mode = 'roaming'
        pet.roamPlotId = yard ? yard.id : null
        pet.destination = null
        pet.arrivedAt = null
        this.emitPets()
        return
      }
    } catch (_) {
      // Unknown terrain stays blocked; retry after the next rest period.
    } finally {
      if (token === pet.commandToken) pet.planning = false
      this.roamPlanning--
    }
  }
  async moveTo(target) {
    this.follow = false
    const pet = this.selectedPet()
    if (!pet) return this.onStatus(this.scene && this.scene.hasAvatar === false
      ? '请先选择小区并建造庭院，宠物档案会自动恢复到场景'
      : '请先点击地图上的自家宠物')
    if (
      target.x < 1 ||
      target.z < 1 ||
      target.x > this.config.width - 1 ||
      target.z > this.config.height - 1
    )
      return this.onStatus('不能走出场景边界')
    const marker = this.petTarget = { petId: pet.id, ...target, pending: true }
    if (this.scene && this.sceneSync) {
      try {
        await this.sceneSync.movePet(pet.id,target)
        if (this.petTarget === marker) {
          marker.pending = false
          this.onStatus('宠物前往选定位置 · 可继续点击地图更换目标')
        }
      } catch(error) {
        if (this.petTarget === marker) {
          this.petTarget = null
          this.onStatus(error.message||'宠物移动失败，请重试')
        }
      }
      return
    }
    const token = (pet.commandToken = (pet.commandToken || 0) + 1)
    const generation = this.regionGeneration
    pet.planning = true
    pet.idleSeconds = 0
    pet.route = []
    pet.moving = false
    pet.destination = null
    this.emitPets()
    const p = pet.position,
      b = {
        minX: clamp(Math.min(p.x, target.x) - 30, 0, this.config.width),
        maxX: clamp(Math.max(p.x, target.x) + 30, 0, this.config.width),
        minZ: clamp(Math.min(p.z, target.z) - 30, 0, this.config.height),
        maxZ: clamp(Math.max(p.z, target.z) + 30, 0, this.config.height)
      }
    if (b.maxX - b.minX > 400 || b.maxZ - b.minZ > 400) {
      pet.planning = false
      if (this.petTarget === marker) this.petTarget = null
      return this.onStatus('请先选择附近的草地，逐步前往远处')
    }
    try {
      await this.loadNavigationArea(b)
      if (
        this.destroyed ||
        generation !== this.regionGeneration ||
        token !== pet.commandToken
      )
        return
      const nav = createNavigation(b, this.obstacles(b), PET_RADIUS, 1.5)
      if (!nav.walkable(target))
        return this.onStatus('这里有房屋或栅栏，请选择空地')
      const route = await nav.pathAsync(p, target,()=>!this.destroyed && generation===this.regionGeneration && token===pet.commandToken)
      if(this.destroyed || generation!==this.regionGeneration || token!==pet.commandToken)return
      if (!route) return this.onStatus('暂时无法到达，请从院门进出')
      pet.route = route
      pet.moving = route.length > 0
      pet.mode = 'manual'
      this.follow = false
      pet.destination = { ...target }
      pet.arrivedAt = null
      marker.pending = false
      this.emitPets()
      this.onStatus('宠物前往选定位置 · 通过院门进出庭院')
    } catch (e) {
      if (
        !this.destroyed &&
        generation === this.regionGeneration &&
        token === pet.commandToken
      )
        this.onStatus('附近场景加载失败，请重新点击草地')
    } finally {
      if (token === pet.commandToken) pet.planning = false
      if (this.petTarget === marker && marker.pending) this.petTarget = null
    }
  }
  request(action) {
    const p = this.ownPlot
    if (!p) return false
    const pet = this.selectedPet()
    if (!pet) return false
    const stations =
      yardLayout(p).stations[pet.species === 'cat' ? 'cat' : 'dog']
    const target = stations[action === 'drink' ? 'eat' : action]
    if (!target) return false
    this.moveTo(target)
    return true
  }
  overview() {
    this.clearPetSelection()
    this.follow = false
    this.followCharacter = false
    this.camera = this.ownPlot
      ? { x: this.ownPlot.x, z: this.ownPlot.z }
      : { ...this.startPoint }
    this.loadVisible().catch(() => this.onStatus('场景加载失败，请稍后重试'))
  }
  fullOverview() {
    this.clearPetSelection()
    this.follow = false
    this.followCharacter = false
    this.setCharacterInput(0, 0)
    this.camera = { x: this.config.width / 2, z: this.config.height / 2 }
    this.onStatus('已定位地图中心 · 双指手动调整缩放')
    this.loadVisible().catch(() => this.onStatus('全景加载失败，请稍后重试'))
  }
  followPet() {
    this.followCharacter = false
    this.setCharacterInput(0, 0)
    this.follow = true
    const p = this.selectedPet()
    if (p) this.camera = { ...p.position }
  }
  beginPlacement() {
    this.clearPetSelection()
    if (this.ownPlot && !this.config.canRelocate) return
    this.placing = true
    this.setCharacterInput(0, 0)
    this.followCharacter = false
    this.emitNearby()
    this.candidate = null
    this.follow = false
    this.onStatus('点击位置作为别墅中心，预览围栏范围后确认')
    this.page.setData({ placing: true, canConfirm: false })
  }
  cancelPlacement() {
    this.pickToken = (this.pickToken || 0) + 1
    this.placing = false
    this.candidate = null
    this.page.setData({ placing: false, canConfirm: false })
  }
  async pickPlot(point) {
    this.candidate = null
    this.page.setData({ canConfirm: false })
    const token = (this.pickToken = (this.pickToken || 0) + 1)
    const x = Math.floor(point.x / STEP),
      z = Math.floor(point.z / STEP)
    const half = this.plotSize / 2
    if (
      point.x - half < 0 ||
      point.z - half < 0 ||
      point.x + half > this.config.width ||
      point.z + half > this.config.height
    )
      return this.onStatus('请在场景范围内选择')
    try {
      const radius = this.plotSize + 4
      await this.loadArea({
        minX: Math.max(0, point.x - radius),
        maxX: Math.min(this.config.width, point.x + radius),
        minZ: Math.max(0, point.z - radius),
        maxZ: Math.min(this.config.height, point.z + radius)
      })
      if (this.loader) await this.loadYardAssets()
      if (this.destroyed || !this.placing || token !== this.pickToken) return
      if (
        this.plots().some((p) => {
          if (p.mine || (this.ownPlot && p.id === this.ownPlot.id)) return false
          const separation = (this.plotSize + (p.size || 48)) / 2 + 4
          return (
            (p.cellX === x && p.cellZ === z) ||
            (Math.abs(point.x - p.x) < separation &&
              Math.abs(point.z - p.z) < separation)
          )
        })
      )
        return this.onStatus('庭院范围与邻居重叠，请选择更空旷的草坪')
      this.candidate = {
        cellX: x,
        cellZ: z,
        x: point.x,
        z: point.z,
        size: this.plotSize
      }
      this.page.setData({ canConfirm: true })
      this.onStatus('中心标记为别墅落点 · 绿色边框为实际围栏范围')
    } catch (e) {
      this.onStatus('位置读取失败，请重新选择')
    }
  }
  setPlot(plot) {
    this.moveToken = (this.moveToken || 0) + 1
    this.regionGeneration++
    this.chunks.clear()
    this.mapPlots.clear()
    this.mapCursor = ''
    this.mapComplete = false
    this.ownPlot = plot
    this.foodBowls = { dog: 0 }
    this.spawnCharacter()
    this.cancelPlacement()
    this.follow = false
    this.pets.forEach((p, i) => {
      p.position = petStart({ x: plot.x, z: plot.z + 14 }, plot, i)
      p.route = []
      p.moving = false
      p.destination = null
      p.commandToken = (p.commandToken || 0) + 1
      p.planning = false
      p.idleSeconds = 0
      p.mode = 'idle'
    })
    this.emitPets()
    this.onStatus('庭院位置已保存，临时开放重新选址')
    this.loadVisible().catch(() =>
      this.onStatus('房屋已保存，庭院素材加载失败，请重新进入')
    )
  }
  sceneState() {
    const p=this.character
    if(!p) return {trail:[],characterType:this.characterType,moving:false,running:false}
    const trail=this.sceneTrail.slice(0,600).map((point)=>({...point})),moreTrail=this.sceneTrail.length>trail.length
    return {position:{...(moreTrail?trail[trail.length-1]:p.position)},vehicleId:this.drivingVehicleId||'',trail,moreTrail,characterType:this.characterType,
      mirrored:p.mirrored,facing:p.facing||'sw',moving:moreTrail||p.moving,running:p.runRequested}
  }
  ackSceneTrail(count) { this.sceneTrail.splice(0,count) }
  setOwnAppearance(value,reset=false) {
    const id=this.scene&&this.scene.playerId
    if(validAppearance(value,'character',id,id)) {
      if(!this.characterAppearance||(value.revision||0)>=(this.characterAppearance.revision||0))this.characterAppearance=value
    } else if(reset||!validAppearance(this.characterAppearance,'character',id,id))this.characterAppearance=null
    const enabled=!!this.characterAppearance
    if(!this.page.data||this.page.data.hasCustomCharacter!==enabled)this.page.setData({hasCustomCharacter:enabled})
  }
  customSprite(value,type,targetId,ownerId,action) {
    if(!validAppearance(value,type,targetId,ownerId))return null
    const atlas=atlasFor(value,action)
    if(!atlas)return null
    const image=this.customImages.get(atlas.fileID)
    if(image){this.customUsed.set(atlas.fileID,Date.now());return {image,style:atlas}}
    const walk=action==='run'?atlasFor(value,'walk'):null
    const fallback=walk&&this.customImages.get(walk.fileID)?{image:this.customImages.get(walk.fileID),style:walk}:null
    if(fallback)this.customUsed.set(walk.fileID,Date.now())
    if(this.loader&&this.loader.loadAtlas&&this.customLoads.size<2&&!this.customLoads.has(atlas.fileID)&&Date.now()>=(this.customRetry.get(atlas.fileID)||0)) {
      const bytes=atlas.frameSize*atlas.frameSize*24*4
      let total=[...this.customSizes.values()].reduce((sum,size)=>sum+size,0)
      for(const [id,used] of [...this.customUsed].sort((a,b)=>a[1]-b[1])) {
        if(total+bytes<=64*1024*1024)break
        if(Date.now()-used<1000)continue
        total-=this.customSizes.get(id)||0
        this.customImages.delete(id);this.customSizes.delete(id);this.customUsed.delete(id)
        if(this.loader.cache)this.loader.cache.delete(id)
      }
      if(total+bytes>64*1024*1024)return fallback
      this.customSizes.set(atlas.fileID,bytes)
      const task=this.loader.loadAtlas(atlas).then((loaded)=>{
        if(!this.destroyed){this.customImages.set(atlas.fileID,loaded);this.customUsed.set(atlas.fileID,Date.now())}
      }).catch(()=>{if(!this.destroyed){this.customSizes.delete(atlas.fileID);this.customRetry.set(atlas.fileID,Date.now()+5000)}})
        .finally(()=>this.customLoads.delete(atlas.fileID))
      this.customLoads.set(atlas.fileID,task)
    }
    return fallback
  }
  async predictPetMove(id,target,token) {
    const pet=this.pets.find((p)=>p.id===id&&p.mine!==false)
    if(!pet || !pet.sharedMotion || Math.hypot(target.x-pet.position.x,target.z-pet.position.z)>300)return
    const pending={token,previous:pet.pendingMove?pet.pendingMove.previous:pet.authoritativePet}
    pet.pendingMove=pending
    const start={...pet.position},bounds=this.routeBounds(start,target)
    const blocks=this.plots().flatMap((plot)=>plot.mine?yardObstacles(plot):this.solidPlot(plot))
    try {
      const nav=createNavigation(bounds,blocks,PET_RADIUS,1.5)
      const route=await nav.pathAsync(start,target,()=>!this.destroyed && pet.pendingMove===pending)
      if(!route || this.destroyed || pet.pendingMove!==pending)return
      const current={...pet.position}
      if(!nav.clearSegment(current,route[0]))return
      pet.sharedMotion={epoch:Date.now()+this.serverOffset,approach:[current,...route],patrol:[target],speed:7}
      pet.reconcile=null
      pet.moving=true
      if(this.petTarget&&this.petTarget.petId===id) this.petTarget.pending=false
    } catch(error) { /* The authoritative command remains responsible for errors. */ }
  }
  rejectPetMove(id,token) {
    const pet=this.pets.find((p)=>p.id===id)
    if(!pet || !pet.pendingMove || pet.pendingMove.token!==token)return
    const previous=pet.pendingMove.previous
    pet.pendingMove=null
    if(previous)this.applySharedPet(previous,true)
  }
  applySharedPet(pet,mine,ownerName,ownerId,nameColor) {
    let target=this.pets.find((p)=>p.id===pet.id)
    if(!target) { target={id:pet.id,route:[],mode:'roaming',commandToken:0};this.pets.push(target) }
    // Appearance and ownership can change independently of an in-flight route.
    target.ownerId=ownerId||target.ownerId||(mine&&this.scene&&this.scene.playerId)||''
    if(nameColor)target.nameColor=nameColor
    if(validAppearance(pet.appearance,'pet',pet.id,target.ownerId)&&(!target.appearance||(pet.appearance.revision||0)>=(target.appearance.revision||0)))target.appearance=pet.appearance
    else if(!validAppearance(target.appearance,'pet',pet.id,target.ownerId))target.appearance=null
    if(mine && (pet.commandSeq||0)<(target.acceptedCommand||0))return target
    if(target.pendingMove && (pet.commandSeq||0)<target.pendingMove.token) {
      target.pendingMove.previous=pet
      return target
    }
    const changed=target.sharedMotion && JSON.stringify(target.sharedMotion)!==JSON.stringify(pet.motion)
    const previous=target.position
    target.pendingMove=null
    target.acceptedCommand=pet.commandSeq||0
    target.authoritativePet=pet
    const modelScale=target.scalePreview?target.modelScale:pet.modelScale
    Object.assign(target,{name:pet.name,species:pet.species,mine,sharedMotion:pet.motion,
      following:!!pet.following,ridingVehicleId:pet.ridingVehicleId||'',needs:pet.needs||target.needs,care:pet.care||null,
      modelScale,savedModelScale:pet.modelScale})
    if(ownerName)target.ownerName=ownerName
    // Keep the rendered position across route packets, including large network
    // discrepancies. Following pets walk along a legal connector each frame.
    target.followRender=previous&&pet.following&&!pet.ridingVehicleId?(target.followRender||{speed:0,stamp:Date.now()}):null
    if(changed&&target.followRender){target.followRender.nav=null;target.followRender.route=null}
    const sample=sampleMotion(pet.motion,Date.now()+this.serverOffset)
    if(changed)target.motionDistanceOffset=(target.walkDistance||0)-sample.distance
    if(changed)target.reconcile=null
    if(changed && previous && !target.followRender && Math.hypot(previous.x-sample.position.x,previous.z-sample.position.z)<3) {
      target.reconcile={x:previous.x-sample.position.x,z:previous.z-sample.position.z,start:Date.now()}
      // Check the small correction against current fences before drawing it.
      target.reconcileNav=createNavigation(this.bounds,this.plots().flatMap(yardObstacles),PET_RADIUS,1.5)
    }
    const state=this.sharedPetSample(target,0)
    target.position=state.position
    target.moving=state.moving
    target.walkDistance=state.distance+(target.motionDistanceOffset||0)
    target.walkFacingLeft=state.facingLeft
    if(pet.interactionUntil) target.interactingUntil=this.elapsed+Math.max(0,(pet.interactionUntil-Date.now()-this.serverOffset)/1000)
    return target
  }
  sharedPetSample(pet,dt) {
    const state=sampleMotion(pet.sharedMotion,Date.now()+this.serverOffset)
    if(pet.followRender)return this.smoothFollowSample(pet,state,dt)
    if(pet.reconcile) {
      const t=clamp(1-(Date.now()-pet.reconcile.start)/150,0,1)
      const corrected={x:state.position.x+pet.reconcile.x*t,z:state.position.z+pet.reconcile.z*t}
      if(pet.reconcileNav.clearSegment(state.position,corrected))state.position=corrected
      if(!t)pet.reconcile=null
    }
    return state
  }
  smoothFollowSample(pet,state,dt) {
    const render=pet.followRender,stamp=Date.now(),from=pet.position,to=state.position
    const seconds=clamp(dt===undefined?(stamp-render.stamp)/1000:dt,0,.1)
    render.stamp=stamp
    const gap=Math.hypot(to.x-from.x,to.z-from.z)
    if(!seconds)return {...state,position:{...from},moving:!!pet.moving,distance:(pet.walkDistance||0)-(pet.motionDistanceOffset||0),facingLeft:!!pet.walkFacingLeft}
    if(!render.nav) {
      const margin=120
      render.nav=createNavigation({minX:Math.max(this.bounds.minX,Math.min(from.x,to.x)-margin),maxX:Math.min(this.bounds.maxX,Math.max(from.x,to.x)+margin),minZ:Math.max(this.bounds.minZ,Math.min(from.z,to.z)-margin),maxZ:Math.min(this.bounds.maxZ,Math.max(from.z,to.z)+margin)},this.plots().flatMap(yardObstacles),PET_RADIUS,1.5)
    }
    const nav=render.nav
    // Only invalid ground (for example a newly built fence) permits the
    // authoritative safety recovery. Ordinary route changes never teleport.
    if(!nav.walkable(from)){render.nav=null;render.speed=0;return state}
    if(gap<.02){render.speed=0;return {...state,position:{...from},moving:false,distance:(pet.walkDistance||0)-(pet.motionDistanceOffset||0),facingLeft:!!pet.walkFacingLeft}}
    if(nav.clearSegment(from,to))render.route=[to]
    else if(!render.route||stamp-(render.plannedAt||0)>300||Math.hypot(to.x-render.goal.x,to.z-render.goal.z)>1.5) {
      render.route=nav.path(from,to)||[];render.goal={...to};render.plannedAt=stamp
    }
    const previousSpeed=render.speed||0,desired=Math.min(18,7+gap*.6,Math.sqrt(2*24*gap))
    render.speed=previousSpeed+clamp(desired-previousSpeed,-24*seconds,24*seconds)
    let budget=(previousSpeed+render.speed)*.5*seconds,travel=0,position={...from},facingLeft=!!pet.walkFacingLeft
    while(budget>0&&render.route&&render.route.length) {
      const point=render.route[0],dx=point.x-position.x,dz=point.z-position.z,d=Math.hypot(dx,dz)
      if(d<.001){render.route.shift();continue}
      if(!nav.clearSegment(position,point)){render.route=null;render.speed=0;break}
      const n=Math.min(d,budget)
      position={x:position.x+dx*n/d,z:position.z+dz*n/d}
      travel+=n;budget-=n
      if(Math.abs(dx-dz)>.00001)facingLeft=dx-dz<0
      if(n===d)render.route.shift()
    }
    return {...state,position,moving:travel>.0001,distance:(pet.walkDistance||0)+travel-(pet.motionDistanceOffset||0),facingLeft}
  }
  async applySceneRecords(records) {
    const ids=new Set(),plots=new Map(),characters=[]
    for(const record of records) {
      if(record.kind==='plot') plots.set(record.id,record)
      if(record.kind==='presence'&&!record.mine) characters.push(record)
      if(record.kind==='presence'&&record.mine){this.setOwnName(record);this.setOwnAppearance(record.appearance);this.applyOwnVehicleActor(record)}
      if(record.kind==='resident') for(const pet of record.pets) {ids.add(pet.id);this.applySharedPet(pet,record.mine,record.ownerName||record.name,record.ownerId,record.nameColor)}
    }
    this.pets=this.pets.filter((p)=>ids.has(p.id))
    this.sharedPlots=plots
    for(const pet of this.pets)if(pet.followRender){pet.followRender.nav=null;pet.followRender.route=null}
    this.replaceVehicles(records.filter((r)=>r.kind==='vehicle'))
    // Snapshot is authoritative: evict stale cached plots after a demolition.
    for(const [key,list] of this.chunks) this.chunks.set(key,list.filter((p)=>plots.has(p.id)))
    this.mapPlots=new Map(plots)
    const own=[...plots.values()].find((p)=>p.mine)
    this.ownPlot=own||null
    this.page.setData({hasPlot:!!own,residentCount:plots.size})
    this.foodBowls=own?own.foodBowls:{dog:0}
    this.replaceCharacters(characters)
    const species=[...new Set(this.pets.map((p)=>p.species==='cat'?'cat_walk':'dog_walk'))]
    const names=[...species,...new Set(characters.flatMap((p)=>['idle','walk','run'].map((a)=>(p.characterType==='girl'?'girl':'boy')+'_'+a+'_sw')))]
    if(this.loader) {
      const missing=names.filter((name)=>!this.assets[name])
      if(missing.length) {
        const assets=await this.loader.loadAll(null,missing)
        if(!this.destroyed) Object.assign(this.assets,assets)
      }
      if(plots.size) await this.loadYardAssets()
    }
    if(this.selectedPetId && !this.pets.some((p)=>p.id===this.selectedPetId&&p.mine!==false)) this.clearPetSelection()
    this.emitPets()
    this.emitNearby()
  }
  async applySceneChanges(changes) {
    const characters=new Map(this.remoteCharacters.map((person)=>[person.id,person]))
    for(const record of changes) {
      if(record.kind==='vehicle') {this.applyVehicle(record);continue}
      if(record.kind==='resident') {
        const ids=new Set((record.pets||[]).map((p)=>p.id))
        this.pets=this.pets.filter((p)=>p.ownerId!==record.ownerId||!record.deleted&&ids.has(p.id))
        if(!record.deleted)for(const pet of record.pets||[])this.applySharedPet(pet,record.mine,record.ownerName||record.name,record.ownerId,record.nameColor)
        this.emitPets();continue
      }
      if(record.mine) {if(!record.deleted)this.setOwnName(record);this.setOwnAppearance(record.deleted?null:record.appearance,!!record.deleted);this.applyOwnVehicleActor(record);continue}
      if(record.deleted)characters.delete(record.id)
      else characters.set(record.id,record)
    }
    this.replaceCharacters([...characters.values()])
    if(this.loader) {
      const missing=[...new Set(this.remoteCharacters.flatMap((p)=>['idle','walk','run'].map((a)=>(p.characterType==='girl'?'girl':'boy')+'_'+a+'_sw')))].filter((name)=>!this.assets[name])
      if(missing.length) {
        const assets=await this.loader.loadAll(null,missing)
        if(!this.destroyed)Object.assign(this.assets,assets)
      }
    }
  }
  replaceCharacters(characters) {
    const old=new Map(this.remoteCharacters.map((p)=>[p.id,p]))
    const stamp=Date.now()
    this.remoteCharacters=characters.map((record)=>{
      const previous=old.get(record.id)
      if(record===previous)return previous
      const unchanged=previous && record.lastSeen===previous.lastSeen && record.position.x===previous.position.x && record.position.z===previous.position.z && record.online===previous.online && record.moving===previous.moving
      if(unchanged)return {...previous,...record}
      const interval=previous?clamp(stamp-previous.received,80,1000):100
      const duration=record.moving?clamp(previous?previous.interval*.5+interval*.5:interval,80,600):100
      const seconds=previous?Math.max(.05,(record.lastSeen-previous.lastSeen)/1000):1
      let vx=previous?(record.position.x-previous.position.x)/seconds:0
      let vz=previous?(record.position.z-previous.position.z)/seconds:0
      const speed=Math.hypot(vx,vz)
      if(speed>14) {vx*=14/speed;vz*=14/speed}
      const person={...record,from:previous?this.neighborPosition(previous):record.position,received:stamp,interval:duration,
        velocity:{x:vx,z:vz}}
      person.predictionNav=createNavigation(this.bounds,this.plots().flatMap(yardObstacles),CHARACTER_RADIUS,1.5)
      return person
    })
  }
  neighborPosition(person) {
    if(!person.online || !person.from) return person.position
    const elapsed=Date.now()-(person.received||0),duration=person.interval||100
    const ahead=person.moving?Math.min(180,Math.max(0,elapsed))/1000:0
    let target={x:person.position.x+(person.velocity?person.velocity.x:0)*ahead,z:person.position.z+(person.velocity?person.velocity.z:0)*ahead}
    if(person.predictionNav&&!person.predictionNav.clearSegment(person.position,target))target=person.position
    const t=clamp(elapsed/duration,0,1)
    return {x:person.from.x+(target.x-person.from.x)*t,z:person.from.z+(target.z-person.from.z)*t}
  }
  drawNeighbor(person,overview) {
    if(person.vehicleId)return
    const position=this.neighborPosition(person)
    const p=this.project(position.x,position.z),c=this.ctx
    const size=CHARACTER_STYLE.size*this.scale*this.zoom
    if(p.x < -size || p.x>this.width+size || p.y < -size || p.y>this.height+size) return
    c.save()
    if(overview) {c.fillStyle=person.online?'#5688b4':'#8b9089';c.beginPath();c.arc(p.x,p.y,4,0,Math.PI*2);c.fill()}
    else {
      const prefix=person.characterType==='girl'?'girl':'boy'
      const moving=person.online&&person.moving&&Date.now()+this.serverOffset-person.lastSeen<3000
      const custom=this.customSprite(person.appearance,'character',person.id,person.ownerId,moving&&person.running?'run':'walk')
      const style=custom?custom.style:CHARACTER_STYLE
      const image=custom?custom.image:this.assets[prefix+(moving?(person.running?'_run_sw':'_walk_sw'):'_idle_sw')]
      if(image) {
        c.translate(p.x,p.y);if(person.mirrored)c.scale(-1,1)
        if(moving||custom) {
          const frame=moving?Math.floor((Date.now()+this.serverOffset)/(person.running?70:90))%style.frames:0
          const w=image.width/style.columns,h=image.height/style.rows
          c.drawImage(image,frame%style.columns*w,Math.floor(frame/style.columns)*h,w,h,-size/2,-size*style.anchor,size,size)
        } else c.drawImage(image,-size/2,-size*CHARACTER_STYLE.anchor,size,size)
      }
    }
    c.restore()
    if(!overview) this.markerLabel(person.name||'邻居',p.x,p.y-size*CHARACTER_STYLE.anchor-8,false,this.ownerNameColor(person.ownerId||person.id,person.nameColor))
  }
  pause() {
    this.paused=true
    this.setCharacterInput(0,0)
    if(this.canvas&&this.frame!==undefined) this.canvas.cancelAnimationFrame(this.frame)
    this.lastFrame=undefined
  }
  resume() {if(this.destroyed)return;this.paused=false;this.lastFrame=undefined;this.start()}
  line(a, b, color, width) {
    const c = this.ctx
    c.beginPath()
    c.moveTo(a.x, a.y)
    c.lineTo(b.x, b.y)
    c.strokeStyle = color
    c.lineWidth = width
    c.stroke()
  }
  diamond(x, z, h, fill) {
    const c = this.ctx,
      pts = [
        [x - h, z - h],
        [x + h, z - h],
        [x + h, z + h],
        [x - h, z + h]
      ].map((p) => this.project(...p))
    c.beginPath()
    pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)))
    c.closePath()
    c.fillStyle = fill
    c.fill()
  }
  fenceSegment(a, b, items) {
    const n = Math.ceil(Math.hypot(a.x - b.x, a.z - b.z) / 3)
    for (let i = 0; i < n; i++) {
      const p = {
          x: a.x + ((b.x - a.x) * i) / n,
          z: a.z + ((b.z - a.z) * i) / n
        },
        q = {
          x: a.x + ((b.x - a.x) * (i + 1)) / n,
          z: a.z + ((b.z - a.z) * (i + 1)) / n
        }
      items.push({
        depth: (p.x + q.x + p.z + q.z) / 2,
        draw: () => {
          const s = this.scale * this.zoom,
            A = this.project(p.x, p.z),
            B = this.project(q.x, q.z)
          this.line(A, { x: A.x, y: A.y - 2.5 * s }, '#795638', 1.1 * s)
          for (const h of [1, 2])
            this.line(
              { x: A.x, y: A.y - h * s },
              { x: B.x, y: B.y - h * s },
              '#e5c79a',
              0.65 * s
            )
          this.line(
            { x: A.x, y: A.y - 2.5 * s },
            { x: A.x, y: A.y - 2.7 * s },
            '#f6e5bf',
            1.25 * s
          )
        }
      })
    }
  }
  sprite(name, x, z, size, anchor = 0.86) {
    const img = this.assets[name]
    if (!img) return
    const p = this.project(x, z),
      w = size * this.scale * this.zoom
    if (
      p.x + w < 0 ||
      p.x - w > this.width ||
      p.y + w < 0 ||
      p.y - w > this.height
    )
      return
    this.ctx.drawImage(img, p.x - w / 2, p.y - w * anchor, w, w)
  }
  drawPet(pet) {
    if(pet.ridingVehicleId)return
    const point = this.project(pet.position.x, pet.position.z)
    const size = 7 * (pet.modelScale || 1) * this.scale * this.zoom
    if (point.x < -size || point.x > this.width + size || point.y < -size || point.y > this.height + size) return
    const name = (pet.species === 'cat' ? 'cat' : 'dog') + '_walk'
    const custom=this.customSprite(pet.appearance,'pet',pet.id,pet.ownerId,'walk')
    const image = custom?custom.image:this.assets[name]
    if (!image) {
      this.sprite((pet.species === 'cat' ? 'cat' : 'dog') + (pet.moving ? '_run' : '_stand'),
        pet.position.x, pet.position.z, 7 * (pet.modelScale || 1))
      return
    }
    const style = custom?{...custom.style,stride:PET_ATLASES[name].stride}:PET_ATLASES[name]
    const frame = pet.moving ? Math.floor((pet.walkDistance || 0) / style.stride * style.frames) % style.frames : 0
    const width = image.width / style.columns, height = image.height / style.rows
    const c = this.ctx
    c.save()
    c.translate(point.x, point.y)
    if (pet.walkFacingLeft) c.scale(-1, 1)
    c.drawImage(image, frame % style.columns * width, Math.floor(frame / style.columns) * height, width, height,
      -size / 2, -size * style.anchor, size, size)
    c.restore()
    const bubble = pet.relieving
      ? (pet.relieving.type === 'poop' ? '💩' : '💧')
      : (pet.autonomousAction && this.elapsed < pet.autonomousAction.until)
      ? (pet.autonomousAction.type === 'eat' ? '🥣' : '💧')
      : null
    if (bubble) {
      c.save()
      c.translate(point.x, point.y - size * (style ? style.anchor : 0.8) - 8)
      c.font = '15px sans-serif'
      c.textAlign = 'center'
      c.textBaseline = 'middle'
      c.fillText(bubble, 0, 0)
      c.restore()
    }
  }
  drawCharacter(overview) {
    if(this.drivingVehicleId)return
    const player = this.character
    if (!player) return
    const point = this.project(player.position.x, player.position.z)
    const c = this.ctx
    if (overview) {
      c.fillStyle = '#426fc0'
      c.beginPath()
      c.arc(point.x, point.y, 5, 0, Math.PI * 2)
      c.fill()
      return
    }
    const prefix = this.characterType || 'boy'
    const custom=this.customSprite(this.characterAppearance,'character',this.scene&&this.scene.playerId,this.scene&&this.scene.playerId,player.moving&&player.runRequested?'run':'walk')
    const style=custom?{...CHARACTER_STYLE,...custom.style}:CHARACTER_STYLE
    const walking = player.moving && (custom?custom.image:this.assets[prefix + (player.runRequested ? '_run_sw' : '_walk_sw')])
    const image = custom?custom.image:walking || this.assets[prefix + '_idle_sw']
    if (!image) return
    const size = style.size * this.scale * this.zoom
    if (point.x < -size || point.x > this.width + size || point.y < -size || point.y > this.height + size) return
    c.save()
    c.translate(point.x, point.y)
    if (player.mirrored) c.scale(-1, 1)
    if (walking||custom) {
      const index = walking?Math.floor(player.animationPhase * style.frames) % style.frames:0
      const w = image.width / style.columns, h = image.height / style.rows
      c.drawImage(image, index % style.columns * w, Math.floor(index / style.columns) * h, w, h,
        -size / 2, -size * style.anchor, size, size)
    } else c.drawImage(image, -size / 2, -size * style.anchor, size, size)
    c.restore()
    const name=this.scene&&this.scene.name||this.ownPlot&&this.ownPlot.ownerName
    if(name)this.markerLabel(name,point.x,point.y-size*style.anchor-8,false,this.ownerNameColor(this.scene&&this.scene.playerId))
  }
  drawInteractionFeedback() {
    const c = this.ctx
    c.save()
    c.textAlign = 'center'
    c.font = 'bold 20px sans-serif'
    c.fillStyle = '#e76d89'
    for (const pet of this.pets) {
      if (!(pet.interactingUntil > this.elapsed)) continue
      const p = this.project(pet.position.x, pet.position.z)
      const lift = (2.5 - (pet.interactingUntil - this.elapsed)) * 10
      c.fillText('♥', p.x, p.y - Math.max(24, 7 * pet.modelScale * this.scale * this.zoom) - lift)
    }
    if (this.ownPlot && this.foodBowls.dog >= 100 && !this.isMapOverview()) {
      const bowl = yardLayout(this.ownPlot).sprites.find((p) => p.name === 'dog_eat')
      const p = this.project(bowl.x, bowl.z)
      c.font = '11px sans-serif'
      c.fillStyle = '#4c682e'
      c.fillText('粮食已添满', p.x, p.y - 5 * this.scale * this.zoom)
    }
    c.restore()
  }
  drawMapPlots(bounds) {
    const c = this.ctx,
      occupied = new Set()
    for (const p of this.plots()) {
      if (this.candidate && this.ownPlot && p.id === this.ownPlot.id) continue
      if (
        p.x < bounds.minX ||
        p.x > bounds.maxX ||
        p.z < bounds.minZ ||
        p.z > bounds.maxZ
      )
        continue
      const point = this.project(p.x, p.z)
      const key = Math.floor(point.x / 6) + ',' + Math.floor(point.y / 6)
      if (occupied.has(key) && !p.mine) continue
      occupied.add(key)
      c.fillStyle = p.mine ? '#ef9257' : '#ffffff'
      c.strokeStyle = '#46674b'
      c.lineWidth = 1
      c.beginPath()
      c.arc(point.x, point.y, p.mine ? 5 : 3, 0, Math.PI * 2)
      c.fill()
      c.stroke()
    }
  }
  drawPlacement() {
    const p = this.candidate,
      c = this.ctx
    const corners = [
      [p.x - p.size / 2, p.z - p.size / 2],
      [p.x + p.size / 2, p.z - p.size / 2],
      [p.x + p.size / 2, p.z + p.size / 2],
      [p.x - p.size / 2, p.z + p.size / 2]
    ].map((q) => this.project(...q))
    c.save()
    c.beginPath()
    corners.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)))
    c.closePath()
    c.fillStyle = 'rgba(59,180,104,.22)'
    c.fill()
    c.strokeStyle = '#176b43'
    c.lineWidth = 2
    c.stroke()
    if (this.scale * this.zoom * p.size > 24) {
      const preview = []
      c.globalAlpha = 0.55
      this.drawYard(p, preview)
      preview.sort((a, b) => a.depth - b.depth).forEach((i) => i.draw())
      c.globalAlpha = 1
    }
    const center = this.project(p.x, p.z)
    c.strokeStyle = '#ffffff'
    c.lineWidth = 3
    c.beginPath()
    c.moveTo(center.x - 9, center.y)
    c.lineTo(center.x + 9, center.y)
    c.moveTo(center.x, center.y - 9)
    c.lineTo(center.x, center.y + 9)
    c.stroke()
    c.fillStyle = '#176b43'
    c.beginPath()
    c.arc(center.x, center.y, 4, 0, Math.PI * 2)
    c.fill()
    this.markerLabel(
      '别墅中心 · ' + p.size + '×' + p.size + '米',
      center.x,
      center.y + 26
    )
    c.restore()
  }
  drawDestination() {
    const controlled=this.characterSelected||!!this.drivingVehicleId&&this.selectedVehicleId===this.drivingVehicleId
    const pet = controlled ? this.character : this.selectedPet(),
      c = this.ctx
    const marker = controlled ? this.characterTarget : this.petTarget
    if (!pet || !marker || !controlled && marker.petId !== pet.id) return
    if (!marker.pending && Math.hypot(pet.position.x-marker.x, pet.position.z-marker.z) < .5)
      marker.arrived = true
    const arrived = !!marker.arrived
    const target = this.project(marker.x, marker.z)
    c.save()
    c.lineWidth = 2
    c.strokeStyle = arrived ? '#3c8a50' : '#f8b548'
    c.fillStyle = arrived ? 'rgba(68,154,91,.2)' : 'rgba(255,193,88,.25)'
    if (pet.moving && !marker.pending && !arrived) {
      c.setLineDash([5, 5])
      c.beginPath()
      const start = this.project(pet.position.x, pet.position.z)
      c.moveTo(start.x, start.y)
      for (const node of controlled ? this.characterRoute || [] : pet.sharedMotion ? pet.sharedMotion.approach || [] : pet.route) {
        const q = this.project(node.x, node.z)
        c.lineTo(q.x, q.y)
      }
      c.stroke()
      c.setLineDash([])
    }
    c.beginPath()
    c.ellipse(target.x, target.y, 14, 7, 0, 0, Math.PI * 2)
    c.fill()
    c.stroke()
    c.beginPath()
    c.moveTo(target.x, target.y - 4)
    c.lineTo(target.x, target.y - 26)
    c.stroke()
    c.beginPath()
    c.moveTo(target.x, target.y - 26)
    c.lineTo(target.x + 13, target.y - 21)
    c.lineTo(target.x, target.y - 16)
    c.fillStyle = arrived ? '#3c8a50' : '#f4ab37'
    c.fill()
    this.markerLabel(marker.pending ? '规划路线…' : arrived ? '已到达' : '前往这里', target.x, target.y - 34)
    c.restore()
  }
  setOwnName(record) {
    if(!this.scene)return
    if(record.name)this.scene.name=record.name
    if(record.nameColor)this.scene.nameColor=record.nameColor
  }
  ownerNameColor(ownerId, color) {
    const valid=(value)=>/^#[0-9a-f]{6}$/i.test(value||'')&&!/^#(?:ffffff|000000)$/i.test(value)
    if(valid(color))return color
    const plot=ownerId&&this.plots().find((p)=>p.ownerId===ownerId || p.mine&&this.scene&&ownerId===this.scene.playerId)
    if(plot&&valid(plot.nameColor))return plot.nameColor
    if(this.scene&&ownerId===this.scene.playerId&&valid(this.scene.nameColor))return this.scene.nameColor
    return '#354c39'
  }
  markerLabel(text, x, y, selected = false, nameColor) {
    const c = this.ctx
    c.save()
    c.font = (selected ? '600 ' : '') + '12px sans-serif'
    c.textAlign = 'center'
    c.lineJoin = 'round'
    c.lineWidth = 3
    c.strokeStyle = nameColor ? '#ffffff' : 'rgba(255,253,243,.85)'
    c.strokeText(text, x, y + 1)
    c.fillStyle = nameColor || (selected ? '#285b38' : '#354c39')
    c.fillText(text, x, y + 1)
    c.restore()
  }
  drawYard(p, items) {
    const layout = yardLayout(p)
    this.drawStonePath(
      { x: p.x, z: p.z + 11 },
      { x: p.x, z: p.z + layout.half - 1 }
    )
    this.sprite('road_tile', p.x, p.z + layout.half - 0.5, 6, 0.5)
    for (const species of ['dog', 'cat']) {
      const station = layout.stations[species].eat
      this.drawStonePath(
        { x: p.x, z: station.z },
        { x: station.x, z: station.z },
        4
      )
    }
    const fountain = layout.sprites.find((item) => item.name === 'fountain')
    this.drawStonePath(
      { x: p.x, z: fountain.z },
      { x: fountain.x - fountain.radius - 2, z: fountain.z },
      4
    )
    const frames = FOUNTAIN_FRAMES.filter((name) => this.assets[name])
    for (const item of layout.sprites)
      if(item.name==='car_road')this.sprite(item.name,item.x,item.z,item.size,item.anchor)
      else
      items.push({
        depth: item.x + item.z,
        draw: () => {
          this.sprite(
            item.name === 'fountain'
              ? frames[Math.floor(this.elapsed * 8) % frames.length]
              : item.name,
            item.x,
            item.z,
            item.size,
            item.anchor
          )
          const species=item.name==='cat_eat'?'cat':'dog'
          if (['dog_eat','cat_eat'].includes(item.name) && ((p.foodBowls && p.foodBowls[species] > 0) || (this.ownPlot && p.id === this.ownPlot.id && this.foodBowls[species] > 0))) {
            const point = this.project(item.x, item.z)
            const scale = this.scale * this.zoom * Math.min(1, layout.half / 48)
            this.ctx.fillStyle = '#a76834'
            for (const [dx, dy] of [[-0.5,0],[0,0.2],[0.5,0],[-0.25,-0.3],[0.25,-0.3]]) {
              this.ctx.beginPath()
              this.ctx.arc(point.x + dx * scale, point.y - 0.8 * scale + dy * scale, Math.max(0.6, 0.2 * scale), 0, Math.PI * 2)
              this.ctx.fill()
            }
          }
        }
      })
    const x = p.x,
      z = p.z,
      h = (p.size || SIZE) / 2
    this.fenceSegment({ x: x - h, z: z - h }, { x: x + h, z: z - h }, items)
    this.fenceSegment({ x: x - h, z: z - h }, { x: x - h, z: z + h }, items)
    this.fenceSegment({ x: x + h, z: z - h }, { x: x + h, z: z + h }, items)
    this.fenceSegment({ x: x - h, z: z + h }, { x: x - 3, z: z + h }, items)
    this.fenceSegment({ x: x + 3, z: z + h }, { x: x + h, z: z + h }, items)
    // Gate leaves remain open beside the entrance.
    this.fenceSegment({ x: x - 3, z: z + h }, { x: x - 3, z: z + h - 3 }, items)
    this.fenceSegment({ x: x + 3, z: z + h }, { x: x + 3, z: z + h - 3 }, items)
  }
  drawStonePath(a, b, width = 6) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 2.5))
    for (let i = 0; i <= steps; i++)
      this.sprite(
        'stone_tile',
        a.x + ((b.x - a.x) * i) / steps,
        a.z + ((b.z - a.z) * i) / steps,
        width,
        0.5
      )
  }
  drawPetNames() {
    const c = this.ctx,
      occupied = []
    if (this.character && this.assets[(this.characterType || 'boy') + '_idle_sw'] && !this.isMapOverview()) {
      const p = this.project(this.character.position.x, this.character.position.z)
      const size = CHARACTER_STYLE.size * this.scale * this.zoom
      occupied.push({ x: p.x, y: p.y - size * 0.48, width: size * 0.6, height: size * 0.85 })
    }
    c.save()
    c.font = '12px sans-serif'
    for (const pet of this.pets) {
      if(pet.ridingVehicleId)continue
      const point = this.project(pet.position.x, pet.position.z)
      if (
        point.x < -20 ||
        point.x > this.width + 20 ||
        point.y < 0 ||
        point.y > this.height + 40
      )
        continue
      const displayName=pet.name||'宠物'
      const width = c.measureText(displayName).width + 16
      const labelOffset = Math.max(16, 7 * (pet.modelScale || 1) * this.scale * this.zoom)
      let y = point.y - labelOffset
      while (
        occupied.some(
          (box) =>
            Math.abs(box.x - point.x) < (box.width + width) / 2 + 3 &&
            Math.abs(box.y - y) < ((box.height || 22) + 22) / 2 + 3
        )
      )
        y -= 25
      occupied.push({ x: point.x, y, width })
      if (point.y - y > labelOffset + 1)
        this.line(
          { x: point.x, y: point.y - 5 },
          { x: point.x, y: y + 8 },
          'rgba(255,253,243,.75)',
          1
        )
      this.markerLabel(displayName, point.x, y, pet.id === this.selectedPetId,this.ownerNameColor(pet.ownerId||(pet.mine!==false&&this.scene&&this.scene.playerId),pet.nameColor))
    }
    c.restore()
  }
  drawYardOwners(bounds) {
    if (!this.page.data || !this.page.data.showYardOwners) return
    this.ctx.save()
    for (const plot of this.plots()) {
      const half=(plot.size||SIZE)/2
      if(plot.x+half<bounds.minX || plot.x-half>bounds.maxX || plot.z+half<bounds.minZ || plot.z-half>bounds.maxZ) continue
      const point=this.project(plot.x-half,plot.z-half)
      this.markerLabel(plot.ownerName || String(plot.name||'邻居').replace(/的庭院$/,''),point.x,point.y-16,!!plot.mine,this.ownerNameColor(plot.ownerId,plot.nameColor))
    }
    this.ctx.restore()
  }
  drawPetSelection() {
    const pet=this.characterSelected?this.character:this.selectedPet()
    if(!pet||pet.ridingVehicleId) return
    const point=this.project(pet.position.x,pet.position.z),c=this.ctx
    const radius=Math.max(10,2.5*(pet.modelScale||1)*this.scale*this.zoom)
    c.save()
    c.beginPath()
    c.ellipse(point.x,point.y,radius,radius*.45,0,0,Math.PI*2)
    c.fillStyle='rgba(255,193,88,.22)'
    c.strokeStyle='#f3af40'
    c.lineWidth=2
    c.fill()
    c.stroke()
    c.restore()
  }
  draw() {
    const c = this.ctx
    if (!c) return
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    c.fillStyle = '#dce8cf'
    c.fillRect(0, 0, this.width, this.height)
    const s = this.scale * this.zoom,
      o = this.project(0, 0)
    c.save()
    c.transform(s, s * 0.52, -s, s * 0.52, o.x, o.y)
    c.scale(1 / 16, 1 / 16)
    c.fillStyle = this.pattern || '#7eb05b'
    const ground = this.visibleBounds(0)
    c.fillRect(
      ground.minX * 16,
      ground.minZ * 16,
      (ground.maxX - ground.minX) * 16,
      (ground.maxZ - ground.minZ) * 16
    )
    c.restore()
    const b = this.visibleBounds(50),
      items = []
    const overview = this.isMapOverview()
    if (overview) this.drawMapPlots(b)
    else
      for (const p of this.plots()) {
        if (this.candidate && this.ownPlot && p.id === this.ownPlot.id) continue
        const half = (p.size || SIZE) / 2
        if (
          p.x + half < b.minX ||
          p.x - half > b.maxX ||
          p.z + half < b.minZ ||
          p.z - half > b.maxZ
        )
          continue
        this.drawYard(p, items)
        this.drawFarm(p)
      }
    if (!overview && this.groundDecals && this.groundDecals.length) {
      this.loadExcretionAssets()
      for (const decal of this.groundDecals) {
        if (decal.x < b.minX || decal.x > b.maxX || decal.z < b.minZ || decal.z > b.maxZ) continue
        const pt = this.project(decal.x, decal.z)
        const decalSize = 14 * this.scale * this.zoom
        const img = this.excretionImages && this.excretionImages[decal.type]
        drawSingleDecal(c, decal, pt, decalSize, img)
      }
    }
    this.drawPetSelection()
    for (const p of this.pets.filter((pet)=>!pet.ridingVehicleId))
      items.push({
        depth: p.position.x + p.position.z,
        draw: () => {
          this.drawPet(p)
          if (overview) {
            const pt = this.project(p.position.x, p.position.z)
            c.fillStyle = p.id === this.selectedPetId ? '#f3af40' : '#648fbb'
            c.beginPath()
            c.arc(pt.x, pt.y, 4, 0, Math.PI * 2)
            c.fill()
          }
        }
      })
    if (this.character)
      items.push({ depth: this.character.position.x + this.character.position.z,
        draw: () => this.drawCharacter(overview) })
    for(const person of this.remoteCharacters) items.push({depth:person.position.x+person.position.z,draw:()=>this.drawNeighbor(person,overview)})
    for(const car of this.vehicles.values()) {
      const p=this.vehiclePosition(car)
      items.push({depth:p.x+p.z,draw:()=>this.drawVehicle(car,overview)})
    }
    items.sort((a, b) => a.depth - b.depth).forEach((i) => i.draw())
    this.drawYardOwners(b)
    this.drawDestination()
    this.drawPetNames()
    this.drawInteractionFeedback()
    if (this.candidate) this.drawPlacement()
  }

  update(dt) {
    this.elapsed += dt
    this.updateLifeUi()
    this.updateCharacter(dt)
    for (const pet of this.pets) {
      if (pet.mine !== false) {
        updatePetExcretion(pet, dt, {
          now: Date.now() + this.serverOffset,
          ownPlot: this.ownPlot,
          vehicles: this.vehicles,
          groundDecals: this.groundDecals,
          onStatus: (msg) => this.onStatus(msg),
          random: this.random,
          emitPets: () => this.emitPets()
        })
      }
      if (pet.relieving) {
        pet.moving = false
        pet.route = []
        continue
      }
      if(pet.sharedMotion) {
        const state=this.sharedPetSample(pet,dt)
        pet.position=state.position;pet.moving=state.moving;pet.walkDistance=state.distance+(pet.motionDistanceOffset||0);pet.walkFacingLeft=state.facingLeft
        continue
      }
      const wasMoving = pet.route.length > 0
      let budget = dt * (pet.mode === 'roaming' ? 3 : 7)
      pet.moving = pet.route.length > 0
      while (budget > 0 && pet.route.length) {
        const t = pet.route[0],
          p = pet.position,
          d = Math.hypot(t.x - p.x, t.z - p.z)
        if (d < 0.001) {
          pet.route.shift()
          continue
        }
        const n = Math.min(d, budget)
        const oldX = p.x, oldZ = p.z
        p.x = clamp(p.x + ((t.x - p.x) * n) / d, 1, this.config.width - 1)
        p.z = clamp(p.z + ((t.z - p.z) * n) / d, 1, this.config.height - 1)
        const dx = p.x - oldX, dz = p.z - oldZ
        pet.walkDistance = (pet.walkDistance || 0) + Math.hypot(dx, dz)
        if (Math.abs(dx - dz) > 0.00001) pet.walkFacingLeft = dx - dz < 0
        budget -= n
        if (n === d) pet.route.shift()
      }
      if (pet.moving && !pet.route.length) {
        pet.moving = false
        pet.arrivedAt = Date.now()
        pet.idleSeconds = 0
        if (pet.pendingAutonomousCare) {
          const action = pet.pendingAutonomousCare
          pet.pendingAutonomousCare = null
          pet.lastCareActionAt = this.elapsed
          pet.interactingUntil = this.elapsed + 5
          pet.autonomousAction = { type: action, until: this.elapsed + 5 }
          const species = pet.species === 'cat' ? 'cat' : 'dog'
          if (action === 'eat') {
            if (this.foodBowls && this.foodBowls[species] >= 10) {
              this.foodBowls[species] = Math.max(0, this.foodBowls[species] - 10)
              if (this.ownPlot && this.ownPlot.foodBowls) this.ownPlot.foodBowls[species] = this.foodBowls[species]
            }
            if (pet.needs) pet.needs.satiety = Math.min(100, (pet.needs.satiety || 0) + 25)
            this.onStatus(`${pet.name} 正在碗边香喷喷地进食~`)
          } else if (action === 'drink') {
            if (pet.needs) pet.needs.hydration = Math.min(100, (pet.needs.hydration || 0) + 30)
            this.onStatus(`${pet.name} 正在喷泉边饮水~`)
          }
        }
        this.emitPets()
        if (pet.mode === 'manual' && pet.id === this.selectedPetId)
          this.onStatus('已到达 · 休息 3 秒后在当前区域自由活动')
      }
      if (!wasMoving && !pet.planning && !(pet.interactingUntil > this.elapsed)) {
        pet.idleSeconds = (pet.idleSeconds || 0) + dt
        if (pet.idleSeconds >= ROAM_WAIT && !this.roamPlanning && !this.placing)
          this.planRoam(pet)
      }
    }
    const pet = this.selectedPet()
    if (this.follow && pet) this.camera = { ...pet.position }
    this.emitNearby()
  }
  start() {
    const tick = (t) => {
      if (this.destroyed || this.paused) return
      const dt =
        this.lastFrame === undefined
          ? 0
          : Math.min(0.05, Math.max(0, (t - this.lastFrame) / 1000))
      this.lastFrame = t
      this.update(dt)
      this.draw()
      if (!this.lastLoad || t - this.lastLoad > 600) {
        this.lastLoad = t
        this.loadVisible().catch(() =>
          this.onStatus('附近场景加载失败，正在重试')
        )
      }
      this.frame = this.canvas.requestAnimationFrame(tick)
    }
    this.frame = this.canvas.requestAnimationFrame(tick)
  }
  touchPoint(touch) {
    const rect = this.canvasRect || { left: 0, top: 0 }
    return {
      x: touch.clientX === undefined ? touch.x : touch.clientX - rect.left,
      y: touch.clientY === undefined ? touch.y : touch.clientY - rect.top
    }
  }
  touchStart(touches) {
    if (!touches.length) return
    const { x, y } = this.touchPoint(touches[0])
    this.gesture = {
      x,
      y,
      lastX: x,
      lastY: y,
      moved: false,
      camera: { ...this.camera },
      zoom: this.zoom
    }
    if (touches.length > 1) {
      this.clearPetSelection()
      const b = this.touchPoint(touches[1])
      this.gesture.distance = Math.hypot(x - b.x, y - b.y)
      this.gesture.moved = true
    }
  }
  touchMove(touches) {
    const g = this.gesture
    if (!g || !touches.length) return
    const { x, y } = this.touchPoint(touches[0])
    if (Math.hypot(x - g.x, y - g.y) > 6) g.moved = true
    if (touches.length > 1) this.clearPetSelection()
    if (touches.length > 1) {
      const b = this.touchPoint(touches[1]),
        d = Math.hypot(x - b.x, y - b.y)
      if (g.distance) {
        this.zoom = clamp((g.zoom * d) / g.distance, this.minimumZoom(), 2.5)
        this.manualZoom = true
        if(this.page.rememberZoom) this.page.rememberZoom(this.zoom)
        if (this.zoom <= this.minimumZoom() * 1.001)
          this.camera = { x: this.config.width / 2, z: this.config.height / 2 }
      } else {
        g.distance = d
        g.zoom = this.zoom
      }
      g.moved = true
    } else if (g.moved) {
      const s = this.scale * this.zoom,
        dx = (x - g.lastX) / s,
        dy = (y - g.lastY) / (s * 0.52)
      this.camera.x = clamp(this.camera.x - (dx + dy) / 2, 0, this.config.width)
      this.camera.z = clamp(
        this.camera.z - (dy - dx) / 2,
        0,
        this.config.height
      )
    }
    this.follow = false
    this.followCharacter = false
    g.lastX = x
    g.lastY = y
  }
  touchEnd(changedTouches) {
    const g = this.gesture
    this.gesture = null
    if (g && !g.moved) {
      const point =
        changedTouches && changedTouches.length
          ? this.touchPoint(changedTouches[0])
          : g
      const p = this.unproject(point.x, point.y)
      if (this.placing) this.pickPlot(p)
      else {
        if(this.vehicleBusy)return
        const farm=this.farmAt(point)
        if(farm&&!this.drivingVehicleId){this.moveToFarmBed(farm.id);return}
        const car=this.vehicleAt(point)
        if(car) {this.selectVehicle(car);return}
        if(this.drivingVehicleId) {
          if(this.selectedVehicleId===this.drivingVehicleId)this.moveCharacterTo(p)
          else this.clearPetSelection()
          return
        }
        const pet=this.petAt(point)
        if(pet && pet.mine!==false) { this.selectPet(pet.id); this.emitNearby() }
        else if(!pet && this.characterAt(point)) this.selectCharacter()
        else if(!pet && this.selectedPet()) this.moveTo(p)
        else if(!pet && this.characterSelected) this.moveCharacterTo(p)
        else { this.clearPetSelection(); if(pet) this.onStatus('这是邻居的宠物，只能操作自家宠物') }
      }
    }
  }
  destroy() {
    this.setCharacterInput(0, 0)
    this.destroyed = true
    this.moveToken = (this.moveToken || 0) + 1
    if (this.canvas && this.frame !== undefined)
      this.canvas.cancelAnimationFrame(this.frame)
    for (const t of this.queue) t.resolve()
    this.queue = []
    this.chunks.clear()
    this.assets = {}
    this.customImages.clear()
    this.customRetry.clear()
    this.customSizes.clear()
    this.customUsed.clear()
  }
}
module.exports = { World2D, yardObstacles, STEP, SIZE, CHUNK }
Object.assign(World2D.prototype, vehicleWorld)
Object.assign(World2D.prototype, lifeWorld)
