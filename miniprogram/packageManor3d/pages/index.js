const { getActiveEnvId } = require('../../envList')
const { callFunction } = require('../../utils/cloud')
const { createCloudAssets, hasManorAssets } = require('../utils/cloud-assets')
const { THREE, createRenderer, loadGlb, disposeModel } = require('../utils/model-runtime')
const { createManorScene } = require('../utils/manor-scene')
const { createManorMinimap, projectManorMapPoint, projectManorMapTowers } = require('../utils/manor-minimap')
const ENTRY_STORAGE_PREFIX = 'manor3d:entry:'
const ENTRY_MAX_AGE_MS = 10 * 60 * 1000
// An enter request can still replace the server session after its page hides.
let communityEnterRequest = null

const FRAME_MS = 1000 / 30
const MAX_DRAW_PIXELS = 900000
const CHARACTER_KEY = 'dogcat-manor-3d-character'
const POSITION_PREFIX = 'dogcat-manor-3d-position:'
const POSITION_VERSION = 1
const POSITION_SAVE_MS = 650
const positionWrites = new Map()
const VEHICLE_MOVING_SYNC_MS = 900
const VEHICLE_IDLE_SYNC_MS = 8000
const MINIMAP_UPDATE_MS = 125
const CAMERA_SENSITIVITY_KEY = 'manor3d-camera-sensitivity'
const DEFAULT_CAMERA_SENSITIVITY = 50
const ELEVATOR_TITLE = {
  call: '电梯', ready: '电梯', calling: '正在呼梯', boarding: '正在进电梯', riding: '电梯运行中', leaving: '正在出电梯'
}
const COURTYARD_ID = 'songying_courtyard'
const BUILDINGS = [
  { id: 'red_tile_villa', name: '红瓦别墅', width: 18.63, depth: 10.851 },
  { id: COURTYARD_ID, name: '松影叠院', width: 26, depth: 36 }
]
const BUILD_MARGIN = 1
const BUILD_TAP_RADIUS = 7

function writePosition(key, checkpoint, onFailure) {
  if (typeof wx.setStorage !== 'function') {
    try { wx.setStorageSync(key, checkpoint) } catch (_) { onFailure() }
    return
  }
  const next = { checkpoint, onFailure }
  const active = positionWrites.get(key)
  if (active) {
    active.next = next
    return
  }
  const slot = { current: next, next: null }
  positionWrites.set(key, slot)
  function write() {
    const current = slot.current
    const finish = () => {
      if (slot.current !== current) return
      slot.current = slot.next
      slot.next = null
      if (slot.current) write()
      else positionWrites.delete(key)
    }
    const fail = () => {
      if (slot.current !== current) return
      current.onFailure()
      finish()
    }
    try { wx.setStorage({ key, data: current.checkpoint, success: finish, fail }) } catch (_) { fail() }
  }
  write()
}

function buildFootprint(building, rotation) {
  return rotation % 180 === 0 ? [building.width, building.depth] : [building.depth, building.width]
}

function buildRegion(plot, width, depth) {
  const dx = (plot.width - width) / 2 - BUILD_MARGIN
  const dz = (plot.depth - depth) / 2 - BUILD_MARGIN
  if (dx < 0 || dz < 0) return null
  return { plotId: plot.id, minX: plot.x - dx, maxX: plot.x + dx, minZ: plot.z - dz, maxZ: plot.z + dz }
}

function inBuildRegion(point, region) {
  return region && point.x >= region.minX && point.x <= region.maxX && point.z >= region.minZ && point.z <= region.maxZ
}

function normalizeCameraSensitivity(value) {
  return Number.isFinite(value) ? Math.max(25, Math.min(150, Math.round(value / 5) * 5))
    : DEFAULT_CAMERA_SENSITIVITY
}

function touchPoint(touch) {
  const x = touch.x ?? touch.clientX ?? touch.pageX
  const y = touch.y ?? touch.clientY ?? touch.pageY
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y, id: touch.identifier } : null
}

function sample(touches) {
  if (!touches?.length) return null
  const first = touchPoint(touches[0])
  if (!first) return null
  if (touches.length === 1) return { ...first, count: 1 }
  const second = touchPoint(touches[1])
  if (!second) return null
  return {
    count: 2,
    id: first.id,
    secondId: second.id,
    first,
    second,
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
    span: Math.hypot(first.x - second.x, first.y - second.y)
  }
}

function mapGesture(previous, current) {
  const firstX = current.first.x - previous.first.x, firstY = current.first.y - previous.first.y
  const secondX = current.second.x - previous.second.x, secondY = current.second.y - previous.second.y
  const firstTravel = Math.hypot(firstX, firstY), secondTravel = Math.hypot(secondX, secondY)
  const spanChange = Math.abs(current.span - previous.span)
  const centerTravel = Math.hypot(current.x - previous.x, current.y - previous.y)
  const sameDirection = firstX * secondX + firstY * secondY > .5 * firstTravel * secondTravel
  if (firstTravel >= 2 && secondTravel >= 2 && sameDirection && centerTravel >= Math.max(4, spanChange)) return 'pan'
  if (spanChange >= 8) return 'zoom'
  return null
}

function readLayout(text) {
  const layout = JSON.parse(text)
  const { width, depth } = layout?.world || {}
  if (width !== 1200 || depth !== 960 ||
      !Array.isArray(layout.plots) || !layout.plots.length || layout.plots.some(plot =>
        !plot || ![plot.x, plot.y, plot.z, plot.width, plot.depth].every(Number.isFinite) ||
        plot.width <= 0 || plot.depth <= 0)) throw new Error('庄园地图尺寸或布局无效')
  return layout
}

function statusText(error, fallback) {
  return typeof error?.code === 'string' && error.code.startsWith('MANOR_ASSET_') ? error.message : fallback
}

function validInteriorAnchor(anchor) {
  return anchor && Array.isArray(anchor.position) && anchor.position.length >= 3 &&
    anchor.position.slice(0, 3).every(Number.isFinite)
}

function validPlayerInterior(interior) {
  return interior?.kind === 'red' ||
    (['courtyard', 'tower'].includes(interior?.kind) && typeof interior.plotId === 'string')
}

function validInteriorMetadata(metadata) {
  return metadata && typeof metadata.model === 'string' && metadata.model.length > 0 &&
    validInteriorAnchor(metadata.anchors?.FrontDoor) && validInteriorAnchor(metadata.anchors?.InteriorSpawn) &&
    (!metadata.frontDoorOpening?.enterDirection ||
      Array.isArray(metadata.frontDoorOpening.enterDirection) &&
      metadata.frontDoorOpening.enterDirection.length >= 3 &&
      metadata.frontDoorOpening.enterDirection.slice(0, 3).every(Number.isFinite))
}

Page({
  data: {
    status: 'loading',
    mountCanvas: true,
    stage: '正在准备 3D 庄园',
    progress: -1,
    error: '',
    villaStatus: 'pending',
    villaProgress: -1,
    villaError: '',
    interiorStatus: 'idle',
    interiorProgress: -1,
    interiorError: '',
    doorPrompt: false,
    insideVilla: false,
    insideCourtyard: false,
    courtyardDoorLabel: '',
    doorBusy: false,
    roomDoor: null,
    restPrompt: null,
    restLocked: false,
    playerActions: null,
    elevator: null,
    characterType: 'boy',
    activeCharacter: '',
    vehicleLoadError: '',
    vehicleNearby: false,
    vehiclePanelOpen: false,
    vehicleSeats: [],
    vehicleState: 'walking',
    vehicleStatus: '',
    vehicleSeatLabel: '',
    vehicleSpeed: 0,
    vehicleCanExit: false,
    characterStatus: 'pending',
    characterProgress: -1,
    characterError: '',
    mapMode: false,
    minimap: null,
    mapPlayer: null,
    mapVehicle: null,
    mapNeighbors: [],
    minimapTop: 0,
    menuOpen: false,
    communityStatus: 'idle',
    communityError: '',
    communityName: '',
    canBuildManor3d: false,
    buildMode: false,
    buildCatalog: BUILDINGS,
    buildId: '',
    buildRotation: 0,
    buildFootprint: '',
    buildHint: '',
    buildError: '',
    buildCanConfirm: false,
    buildSaving: false,
    courtyardStatus: 'idle',
    courtyardProgress: -1,
    courtyardError: '',
    cameraSensitivity: DEFAULT_CAMERA_SENSITIVITY,
    firstPerson: false,
    stickX: 0,
    stickY: 0,
  stickActive: false,
  pets: [],
  selectedPetId: '',
  selectedPetName: '',
  selectedPet: null,
  nearbyPet: null,
  petRosterOpen: false,
  petCareBusy: false,
  petModelsStatus: 'pending',
  petModelsError: ''
  },

  onLoad(options = {}) {
    this._positionMinimap()
    this._vehicleSyncSeq = 0
    this._petCommandSeq = 0
    this._petModelSessions = new Map()
    this._petUiSignature = ''
    this._vehicleSyncSignature = ''
    this._nextVehicleSync = 0
    this._firstHomePromptSceneId = ''
    this._envId = getActiveEnvId()
    this._readEntryTicket(options)
    if (!this._entrySelected) {
      const user = require('../../utils/cloud').getCachedUser?.()
      this._openPositionSlot('local', user?._id || user?.openid || user?._openid || 'guest')
    }
    if (!hasManorAssets(this._envId)) {
      this.setData({ status: 'unavailable', mountCanvas: false })
      return
    }
    try {
      if (wx.getStorageSync(CHARACTER_KEY) === 'girl') this.setData({ characterType: 'girl' })
      this.setData({ cameraSensitivity: normalizeCameraSensitivity(wx.getStorageSync(CAMERA_SENSITIVITY_KEY)) })
    } catch (_) {}
  },

  onReady() {
    this._mounted = true
    this._beginLoad()
  },

  onShow() {
    this._shown = true
    this._highRiseUnavailable = false
    this._prepareCommunityEntry()
    if (this._hasLandscape) {
      const resumeToken = this._resumeToken = {}
      // The native canvas backing size can change while the page is hidden.
      this._viewport = null
      this.onResize().then(() => {
        if (this._shown && this._resumeToken === resumeToken) this._startFrames()
      })
      this._loadCharacter()
      this._loadVehicle()
      this._loadHighRises()
      this._loadPetModels()
      this._restorePlayerPosition()
    }
    this._beginLoad()
  },

  onHide() {
    this._savePlayerPosition(true)
    this._syncManor3dVehicle(true, false)
    this._shown = false
    this._resizeToken = null
    this._resumeToken = null
    if (!this._closed) this.closeMenu()
    this._endBuild()
    this._resetCanvasTouches()
    this._stopStick()
    this._scene?.clearVehicleInput?.()
    if (!this._closed) this.closeVehiclePanel()
    this._stopFrames()
    this._stopLoad()
    this._stopLoad('_characterSession')
    this._stopLoad('_interiorSession')
    this._stopLoad('_buildModelSession')
    this._stopLoad('_vehicleSession')
    this._stopLoad('_highRiseSession')
    this._stopLoad('_remoteCharacterSession')
    const petModelsPending = this._petModelsLoading || this.data.petModelsStatus === 'loading'
    this._petModelsGeneration = (this._petModelsGeneration || 0) + 1
    this._petModelsLoading = false
    for (const session of this._petModelSessions?.values?.() || []) session.assets?.cancel?.()
    this._petModelSessions?.clear?.()
    if (!this._closed && petModelsPending) this.setData({ petModelsStatus: 'pending', petModelsError: '' })
    if (!this._closed && this.data.courtyardStatus === 'loading') this.setData({ courtyardStatus: 'idle' })
    this._disconnectCommunity()
    if (!this._scene?.isInsideVilla) {
      this.setData({ interiorStatus: 'idle', interiorProgress: -1, interiorError: '', doorPrompt: false })
    }
  },

  onUnload() {
    this._closed = true
    this.onHide()
    this._releaseScene()
  },

  _queryCanvas() {
    return new Promise(resolve => {
      wx.createSelectorQuery().in(this).select('#manor-canvas').fields({ node: true, size: true })
        .exec(rows => resolve(rows?.[0]))
    })
  },

  _resize(view) {
    const { width, height } = view
    const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const ratio = Math.min(info.pixelRatio || 1, 1.5, Math.sqrt(MAX_DRAW_PIXELS / (width * height)))
    const previous = this._viewport
    if (previous?.width === width && previous.height === height && previous.ratio === ratio) return
    if (this._renderer.getPixelRatio() !== ratio) this._renderer.setPixelRatio(ratio)
    this._scene.resize(width, height)
    this._viewport = { width, height, ratio }
  },

  async onResize(event) {
    if (!this._shown || !this._scene) return
    this._resetCanvasTouches()
    this._stopStick()
    const scene = this._scene
    const resizeToken = this._resizeToken = {}
    try {
      const { windowWidth, windowHeight } = event?.size || {}
      const view = windowWidth > 0 && windowHeight > 0
        ? { width: windowWidth, height: windowHeight } : await this._queryCanvas()
      if (this._shown && scene === this._scene && resizeToken === this._resizeToken &&
          view?.width > 0 && view.height > 0) {
        this._resize(view)
        this._positionMinimap()
      }
    } catch (error) {
      if (this._shown && scene === this._scene && resizeToken === this._resizeToken) this._failRenderer(error)
    }
  },

  _isCurrent(session) {
    return this._shown && !this._closed && (this._session === session || this._characterSession === session ||
      this._interiorSession === session || this._buildModelSession === session || this._vehicleSession === session ||
      this._highRiseSession === session || this._remoteCharacterSession === session ||
      [...(this._petModelSessions?.values?.() || [])].some(item => item === session))
  },

  _stopLoad(field = '_session') {
    const session = this[field]
    this[field] = null
    session?.assets?.cancel?.()
  },

  _releaseScene() {
    if (!this._closed && this._scene && this._savePlayerPosition(true)) {
      this._pendingPlayerPosition = this._lastPlayerCheckpoint
    }
    this._positionScene = null
    this._endBuild()
    this._stopLoad('_buildModelSession')
    this._stopLoad('_vehicleSession')
    this._stopLoad('_highRiseSession')
    this._stopLoad('_remoteCharacterSession')
    this._remoteModelRetryAt = 0
    this._nextCommunityMapUpdate = 0
    this._hasVehicle = false
    this._hasHighRises = this._highRiseUnavailable = false
    this._vehicleStateSignature = ''
    this._placedBuildings = null
    this._resetCanvasTouches()
    this._nextMinimapUpdate = 0
    if (this._communityScene && this._communitySync?.records) {
      this._pendingSharedRecords = {
        records: [...this._communitySync.records.values()],
        ownPlayerId: this._communityScene.playerId
      }
    }
    this._scene?.dispose()
    this._renderer?.dispose()
    this._scene = null
    this._renderer = null
    this._canvas = null
    this._viewport = null
    this._hasLandscape = false
    this._hasVilla = false
    this._interiorModel = null
    this._interiorMetadata = null
    this._interiorFailureKind = ''
    if (!this._closed) this.setData({ doorPrompt: false, insideVilla: false, insideCourtyard: false,
      courtyardDoorLabel: '', doorBusy: false, roomDoor: null, elevator: null, interiorStatus: 'idle',
      interiorProgress: -1, interiorError: '', courtyardStatus: 'idle', courtyardProgress: -1, courtyardError: '',
      vehicleLoadError: '', vehicleNearby: false, vehiclePanelOpen: false, vehicleSeats: [], vehicleState: 'walking', mapVehicle: null,
      vehicleStatus: '', vehicleSeatLabel: '', vehicleSpeed: 0, vehicleCanExit: false,
      pets: [], selectedPetId: '', selectedPetName: '', selectedPet: null, nearbyPet: null,
      petRosterOpen: false, petCareBusy: false, petModelsStatus: 'pending', petModelsError: '' })
  },

  _readEntryTicket(options = {}) {
    const rawKey = typeof options.entryKey === 'string' ? options.entryKey : ''
    let entryKey = ''
    try { entryKey = decodeURIComponent(rawKey).trim() } catch (_) {}
    this._entrySelected = false
    this._entryCommunity = undefined
    if (!entryKey || !/^[a-z0-9]+$/i.test(entryKey)) return
    try {
      const payload = wx.getStorageSync(ENTRY_STORAGE_PREFIX + entryKey)
      wx.removeStorageSync(ENTRY_STORAGE_PREFIX + entryKey)
      const age = Number.isFinite(payload?.createdAt) ? Date.now() - payload.createdAt : Infinity
      if (!payload || typeof payload !== 'object' || age < 0 || age > ENTRY_MAX_AGE_MS ||
          !Object.prototype.hasOwnProperty.call(payload, 'community')) return
      this._entrySelected = true
      this._entryCommunity = payload.community || null
      this._entrySolo = payload.solo === true || payload.community === null
    } catch (_) {}
  },

  _openPositionSlot(sceneId, playerId) {
    const key = POSITION_PREFIX + [this._envId, sceneId, playerId].map(encodeURIComponent).join(':')
    if (this._positionKey === key) return
    this._positionKey = key
    this._positionScene = null
    this._pendingPlayerPosition = this._lastPlayerCheckpoint = null
    this._lastPositionSignature = ''
    this._nextPositionSave = 0
    try {
      const writing = positionWrites.get(key)
      const saved = writing?.next?.checkpoint || writing?.current?.checkpoint || wx.getStorageSync(key)
      const validInterior = !saved?.interior || validPlayerInterior(saved.interior)
      if (saved?.version === POSITION_VERSION && validInterior && [saved.x, saved.y, saved.z, saved.facing].every(Number.isFinite)) {
        this._pendingPlayerPosition = this._lastPlayerCheckpoint = saved
      }
    } catch (_) {}
  },

  _savePlayerPosition(force = false) {
    if (!this._positionKey || !this.data.activeCharacter || this._pendingPlayerPosition || this._pendingCommunityPosition ||
        (this._entrySelected && !this._communityPositionPlaced && this._positionScene !== this._scene)) return false
    const now = Date.now()
    if (!force && now < this._nextPositionSave) return false
    this._nextPositionSave = now + POSITION_SAVE_MS
    const position = this._scene?.getPlayerCheckpoint?.()
    if (!position || ![position.x, position.y, position.z, position.facing].every(Number.isFinite)) return false
    this._positionScene = this._scene
    const checkpoint = { version: POSITION_VERSION, ...position }
    const signature = JSON.stringify(checkpoint)
    this._lastPlayerCheckpoint = checkpoint
    if (signature === this._lastPositionSignature) return true
    const key = this._positionKey
    this._lastPositionSignature = signature
    writePosition(key, checkpoint, () => {
      if (this._positionKey === key && this._lastPositionSignature === signature) this._lastPositionSignature = ''
    })
    return true
  },

  _finishPlayerRestore(placed, saved = this._pendingPlayerPosition) {
    if (!saved || saved !== this._pendingPlayerPosition) return false
    this._pendingPlayerPosition = null
    if (!placed && saved.exterior) placed = this._scene?.placeCharacterAt(saved.exterior, saved.facing)
    if (!placed && this._communityScene?.position3d) {
      this._pendingCommunityPosition = this._communityScene.position3d
      return this._applyPendingCommunityPosition()
    }
    this._positionScene = this._scene
    this._communityPositionPlaced = this._communityPositionReady = true
    this._pendingCommunityPosition = null
    this._setCommunityReady()
    this._updateMinimapPlayer()
    if (placed) this._savePlayerPosition(true)
    return Boolean(placed)
  },

  _restorePlayerPosition() {
    const saved = this._pendingPlayerPosition
    if (!saved || !this._shown || !this._hasLandscape || !this.data.activeCharacter || !this._scene) return false
    if (saved.interior?.kind === 'red') {
      if (this.data.villaStatus === 'error' || (this.data.interiorStatus === 'error' && this._interiorFailureKind === 'metadata')) {
        return this._finishPlayerRestore(false, saved)
      }
      if (this._hasVilla && this._interiorMetadata) this._loadInterior(saved)
      return false
    }
    if (saved.interior?.kind === 'courtyard') {
      if (!this._placedBuildings) return false
      if (!this._placedBuildings.some(record => record.plotId === saved.interior.plotId && record.buildingId === COURTYARD_ID) ||
          this.data.courtyardStatus === 'error') return this._finishPlayerRestore(false, saved)
      if (this.data.courtyardStatus !== 'ready') return false
    }
    if (saved.interior?.kind === 'tower') {
      if (this._highRiseUnavailable) return this._finishPlayerRestore(false, saved)
      if (!this._hasHighRises) return false
    }
    return this._finishPlayerRestore(this._scene.restorePlayerPosition?.(saved), saved)
  },

  async _prepareCommunityEntry() {
    if (!this._shown || this._closed || this.data.status === 'unavailable' ||
        !hasManorAssets(this._envId) || !this._entrySelected || this._communityEntryPromise ||
        (this.data.communityStatus === 'ready' && this._communityScene)) return
    const generation = this._communityEntryGeneration = (this._communityEntryGeneration || 0) + 1
    const isCurrent = () => this._shown && !this._closed && generation === this._communityEntryGeneration
    this._communityEntryPromise = (async () => {
      this.setData({ communityStatus: 'loading', communityError: '' })
      try {
        const { ensureLogin, callFunction } = require('../../utils/cloud')
        await ensureLogin({ content: '登录后进入 3D 庄园。', isActive: isCurrent })
        while (isCurrent() && communityEnterRequest) await communityEnterRequest.catch(() => {})
        if (!isCurrent()) return
        const request = communityEnterRequest = callFunction('playground', 'enterScene', {
          manor3d: true,
          ...(this._entrySolo ? { solo: true, community: null } : { community: this._entryCommunity })
        })
        let overview
        try {
          overview = await request
        } finally {
          if (communityEnterRequest === request) communityEnterRequest = null
        }
        if (!isCurrent()) return
        const scene = overview?.scene
        if (![scene?.sceneId, scene?.session, scene?.playerId].every(value => typeof value === 'string' && value.trim())) {
          throw new Error('未取得庄园场景凭证，请重试')
        }
        this._communityScene = scene
        this._vehicleSyncSeq = Number.isSafeInteger(scene.manor3dVehicle?.seq) ? scene.manor3dVehicle.seq : 0
        this._vehicleSyncSignature = ''
        this._nextVehicleSync = 0
        this._openPositionSlot(scene.sceneId, scene.playerId)
        if (scene.manor3dVehicle) this._scene?.setVehicleRecord?.(scene.manor3dVehicle)
        const stayingHere = this._positionScene && this._positionScene === this._scene && !this._pendingPlayerPosition
        const position = scene.position3d
        const interior = scene.manor3dInterior
        if (!stayingHere && !this._pendingPlayerPosition && [position?.x, position?.y, position?.z].every(Number.isFinite) &&
            validPlayerInterior(interior)) {
          this._pendingPlayerPosition = { version: POSITION_VERSION, ...position, interior,
            facing: Number.isFinite(scene.manor3dFacing) ? scene.manor3dFacing : 0 }
        }
        this._communityConnected = false
        const startsAtSpawn = !position && !this._pendingPlayerPosition &&
          (scene.manor3dCanPublish === true || scene.hasAvatar !== true)
        this._communityPositionReady = this._communityPositionPlaced = Boolean(stayingHere || startsAtSpawn)
        this._pendingCommunityPosition = stayingHere || this._pendingPlayerPosition ? null : scene.position3d || null
        this.setData({ communityName: scene?.community?.name || '' })
        this._loadVehicle()
        this._loadHighRises()
        const sync = this._communitySync = new (require('../utils/manor-community-sync').ManorCommunitySync)(
          scene,
          (records, options) => {
            if (!isCurrent()) return
            if (this._scene && this._hasLandscape) this._applySharedRecords(records, scene.playerId, options)
            else this._pendingSharedRecords = { records: options?.replace === false ? [...sync.records.values()] : records,
              ownPlayerId: scene.playerId }
          },
          error => {
            if (!isCurrent()) return
            this._communityConnected = false
            this.setData({ communityStatus: 'error', communityError: error?.message || '邻居同步暂时中断', canBuildManor3d: false })
            this._refreshBuild()
          },
          state => {
            if (!isCurrent()) return
            this._communityConnected = state === 'connected'
            this._setCommunityReady()
            if (this._communityConnected && !this._communityPositionReady && !this._pendingCommunityPosition) {
              this._placeCommunityCharacter()
            }
          }
        )
        this._restorePlayerPosition()
        await sync.start()
        if (isCurrent() && this._communityConnected) this._placeCommunityCharacter()
      } catch (error) {
        if (isCurrent()) this.setData({ communityStatus: 'error', communityError: error?.message || '庄园场景连接失败，请重试' })
      } finally {
        if (generation === this._communityEntryGeneration) this._communityEntryPromise = null
      }
    })()
    await this._communityEntryPromise
  },

  retryCommunity() {
    if (!this._entrySelected || this.data.communityStatus !== 'error' || !this._shown) return
    this._disconnectCommunity()
    return this._prepareCommunityEntry()
  },

  _disconnectCommunity() {
    this._endBuild()
    this._communityEntryGeneration = (this._communityEntryGeneration || 0) + 1
    this._communityEntryPromise = null
    const sync = this._communitySync
    const position = this._getCommunityPositionState()
    this._communitySync = null
    this._communityScene = null
    this._communityConnected = false
    this._communityPositionReady = false
    this._communityPositionPlaced = false
    this._pendingCommunityPosition = null
    this._pendingSharedRecords = null
    if (!this._closed && this.data.canBuildManor3d) this.setData({ canBuildManor3d: false })
    sync?.stop({ position })
  },

  _setCommunityReady() {
    if (this._communityConnected && this._communityPositionReady && !this._pendingCommunityPosition &&
        this.data.communityStatus !== 'ready') this.setData({ communityStatus: 'ready', communityError: '',
      canBuildManor3d: this._communityScene?.canBuildManor3d === true })
    this._maybePromptFirstHome()
  },

  _maybePromptFirstHome() {
    const scene = this._communityScene
    if (!this._entrySelected || !scene || scene.hasAnyManor3dHome !== false || !this._communityConnected ||
        this.data.communityStatus !== 'ready' || !this.data.canBuildManor3d || !this._hasLandscape ||
        !this._hasVilla || !this.data.activeCharacter || this._firstHomePromptSceneId === scene.sceneId) return
    this._firstHomePromptSceneId = scene.sceneId
    wx.showModal?.({
      title: '打造你的第一栋房子',
      content: `你还没有在任何 3D 小区建造房子，要在${scene.community?.name ? `「${scene.community.name}」` : '当前小区'}打造红瓦别墅吗？`,
      confirmText: '开始打造',
      cancelText: '稍后再说',
      success: result => {
        if (result?.confirm && this._communityScene === scene && this.data.canBuildManor3d) this.openBuild()
      }
    })
  },

  _placeCommunityCharacter() {
    if (this._pendingPlayerPosition) return this._restorePlayerPosition()
    if (this._communityPositionPlaced) return true
    const position = this._communityScene?.position3d
    if (!position) {
      if (this._communityScene?.hasAvatar) this.setData({ communityStatus: 'error', communityError: '云端角色位置暂不可用，请重试连接' })
      return false
    }
    this._pendingCommunityPosition = position
    return this._applyPendingCommunityPosition()
  },

  _applyPendingCommunityPosition() {
    const position = this._pendingCommunityPosition
    if (!position || !this._scene?.placeCharacterAt || !this.data.activeCharacter || !this._hasLandscape) return false
    // The community position is an outdoor coordinate. Keep it pending while
    // the player is inside the villa; indoor navigation must not consume it.
    if (this._scene.isInsideVilla) return false
    const facing = this._communityScene?.manor3dFacing
    const placed = this._scene.placeCharacterAt(position, facing)
    if (!placed) {
      this.setData({ communityStatus: 'error', communityError: '当前位置无法落在可行走地面，请重试连接' })
      return false
    }
    this._pendingCommunityPosition = null
    this._communityPositionReady = true
    this._communityPositionPlaced = true
    this._positionScene = this._scene
    this._scene.focusCharacter?.()
    this._setCommunityReady()
    return placed
  },

  _syncCommunityPosition() {
    const state = this._getCommunityPositionState()
    if (!state) return false
    this._communitySync.syncPosition(state)
    return true
  },

  _syncManor3dVehicle(force = false, online = true) {
    const community = this._communityScene
    const state = this._scene?.getVehicleSyncState?.()
    if (!community || !state || !this._communitySync || !this._communityConnected) return false
    const moving = online && state.moving === true
    const payload = { ...state, moving, online }
    const signature = JSON.stringify(payload)
    const now = Date.now()
    const intervalDue = now >= this._nextVehicleSync
    const changed = signature !== this._vehicleSyncSignature
    // Frames keep replacing the pending sample, so the next sync sends the latest pose.
    if (!force && !intervalDue) {
      if (changed) this._pendingVehicleSync = payload
      return false
    }
    this._pendingVehicleSync = null
    this._vehicleSyncSignature = signature
    this._nextVehicleSync = now + (moving ? VEHICLE_MOVING_SYNC_MS : VEHICLE_IDLE_SYNC_MS)
    const seq = this._vehicleSyncSeq = (this._vehicleSyncSeq || 0) + 1
    const { callFunction } = require('../../utils/cloud')
    Promise.resolve(callFunction('playground', 'syncManor3dVehicle', {
      sceneId: community.sceneId, session: community.session, seq, ...payload
    })).then(result => {
      if (this._communityScene !== community || this._vehicleSyncSeq !== seq) return
      if (result?.vehicle) community.manor3dVehicle = result.vehicle
      if (Number.isSafeInteger(result?.ackSeq)) this._vehicleSyncSeq = Math.max(this._vehicleSyncSeq, result.ackSeq)
    }).catch(error => {
      if (this._communityScene !== community || this._vehicleSyncSeq !== seq) return
      this._vehicleSyncSignature = ''
      this._nextVehicleSync = Date.now() + 2000
      console.warn('[manor3d] 车辆位置同步失败', error?.message)
    })
    return true
  },

  _getCommunityPositionState() {
    const community = this._communityScene
    if (!this._communitySync || !this._communityConnected || !(community?.manor3dCanPublish === true || community?.hasAvatar === true) ||
        !this.data.activeCharacter || this._communityPositionReady === false ||
        this.data.communityStatus === 'error' || this._pendingCommunityPosition || this._pendingPlayerPosition) return null
    const state = this._scene?.getPlayerSyncState?.()
    if (!state || (this._scene?.isInsideVilla && !state.interior)) return null
    return { ...state, characterType: this.data.activeCharacter }
  },

  _applyPendingSharedRecords() {
    if (!this._pendingSharedRecords || !this._scene || !this._hasLandscape) return
    const { records, ownPlayerId } = this._pendingSharedRecords
    this._applySharedRecords(records, ownPlayerId)
    this._pendingSharedRecords = null
  },

  _applySharedRecords(records, ownPlayerId, { replace = true } = {}) {
    this._scene.setSharedRecords?.(records, ownPlayerId, { replace })
    this._scene.setPetRecords?.(records.filter(record => record.kind === 'resident'), { replace, ownPlayerId })
    this._refreshPetUi()
    if (replace || records.some(record => record.kind === 'presence')) this._refreshCommunityPlayers()
    const previous = this._placedBuildings
    let buildings
    if (replace) {
      buildings = records.filter(record => record.kind === 'manor3dBuilding' && !record.deleted)
    } else {
      const changes = records.filter(record => record.kind === 'manor3dBuilding')
      if (!changes.length) return
      const byId = new Map((previous || []).map(record => [record.id, record]))
      for (const record of changes) {
        if (record.deleted) byId.delete(record.id)
        else byId.set(record.id, record)
      }
      buildings = [...byId.values()]
    }
    if (previous && buildings.length === previous.length && buildings.every(record => previous.includes(record))) return
    this._placedBuildings = buildings
    this._scene.setPlacedBuildings?.(this._placedBuildings)
    this._refreshBuild()
    if (this.data.courtyardStatus === 'idle' && this._placedBuildings.some(record => record.buildingId === COURTYARD_ID)) {
      this._loadCourtyard()
    }
    this._restorePlayerPosition()
  },

  async _loadPetModels() {
    if (!this._shown || this._closed || !this._hasLandscape || !this._scene?.setPetModel ||
        this._petModelsLoading || this.data.petModelsStatus === 'ready') return
    this._petModelsLoading = true
    const generation = this._petModelsGeneration = (this._petModelsGeneration || 0) + 1
    this.setData({ petModelsStatus: 'loading', petModelsError: '' })
    try {
      await Promise.all(['dog', 'cat'].map(type => this._loadPetModel(type)))
      if (this._petModelsGeneration === generation && this._shown && !this._closed) {
        this.setData({ petModelsStatus: 'ready' })
      }
    } catch (error) {
      if (this._petModelsGeneration === generation && this._shown && !this._closed) {
        this.setData({ petModelsStatus: 'error', petModelsError: error?.message || '宠物模型加载失败' })
      }
    } finally {
      if (this._petModelsGeneration === generation) this._petModelsLoading = false
    }
  },

  retryPetModels() {
    if (this.data.petModelsStatus !== 'error') return
    this._petModelSessions?.clear?.()
    this.setData({ petModelsStatus: 'pending', petModelsError: '' })
    this._loadPetModels()
  },

  async _loadPetModel(type) {
    if (this._petModelSessions?.has(type)) return this._petModelSessions.get(type).promise
    const session = { assets: createCloudAssets({ wx, envId: this._envId }) }
    session.promise = this._attach(session, type, null, () => {}, model => {
      const attached = this._scene?.setPetModel?.(type, model)
      return attached !== false
    })
    this._petModelSessions.set(type, session)
    try {
      return await session.promise
    } finally {
      if (this._petModelSessions.get(type) === session) this._petModelSessions.delete(type)
    }
  },

  _refreshPetUi() {
    const state = this._scene?.getPetUiState?.() || {}
    const pets = Array.isArray(state) ? state : (Array.isArray(state.pets) ? state.pets : [])
    const selected = (Array.isArray(state) ? null : state.selected) ||
      pets.find(pet => pet.id === this.data.selectedPetId) || null
    const interaction = this._scene?.getPetInteractionState?.() || {}
    const nearby = interaction.nearby || (interaction.id && pets.find(pet => pet.id === interaction.id)) || null
    const displayPet = pet => {
      if (!pet) return null
      const { position3d, position, ...display } = pet
      if (Array.isArray(display.waste)) display.waste = display.waste.filter(item => item?.type !== 'poop' || !item.vehicleId)
      display.hasCleanableWaste = display.waste?.some(item => item?.type === 'poop' && !item.vehicleId) === true
      return display
    }
    const displayPets = pets.map(displayPet)
    const selectedPet = displayPet(selected)
    const nearbyPet = displayPet(nearby)
    const signature = JSON.stringify([displayPets, selectedPet, nearbyPet])
    if (signature === this._petUiSignature) return
    this._petUiSignature = signature
    this.setData({
      pets: displayPets,
      selectedPetId: selectedPet?.id || '',
      selectedPetName: selectedPet?.name || '',
      selectedPet,
      nearbyPet
    })
  },

  _petPosition(petId) {
    return this._scene?.getPetPosition?.(petId) ||
      this.data.selectedPet?.position3d || this.data.selectedPet?.position || null
  },

  _nextPetCommand() {
    const latest = Math.max(0, ...(this.data.pets || []).map(pet => Number(pet.commandSeq || 0)))
    this._petCommandSeq = Math.max(this._petCommandSeq || 0, latest) + 1
    return this._petCommandSeq
  },

  _petCredentials() {
    const scene = this._communityScene
    return scene ? { sceneId: scene.sceneId, session: scene.session } : null
  },

  _applyPetResult(result) {
    if (result?.pet) this._scene?.applyPetRecord?.(result.pet)
    this._refreshPetUi()
    this._communitySync?.snapshot?.().catch(() => {})
  },

  async petAction(event) {
    const operation = event?.currentTarget?.dataset?.operation
    const petId = event?.currentTarget?.dataset?.petId || this.data.selectedPetId
    if (!petId || !['follow', 'stay', 'eat', 'sleep', 'drink', 'feed'].includes(operation) || this.data.petCareBusy) return
    const credentials = this._petCredentials()
    if (!credentials) return wx.showToast?.({ title: '庄园连接中，请稍后重试', icon: 'none' })
    this._stopStick()
    this.setData({ petCareBusy: true })
    try {
      const manor3dPosition = this._petPosition(petId)
      const result = await callFunction('playground', 'petAction', {
        ...credentials,
        petId,
        operation,
        commandSeq: this._nextPetCommand(),
        ...(manor3dPosition ? { manor3dPosition } : {})
      })
      this._scene?.petAction?.(petId, operation)
      this._applyPetResult(result)
      const messages = {
        follow: '宠物会跟在你身边，停下后会在周围自由活动',
        stay: '已取消跟随，宠物会在当前位置附近活动',
        feed: '喂食完成，饱腹值已恢复',
        eat: '宠物正前往碗边吃饭',
        drink: '宠物正前往喷泉喝水',
        sleep: '宠物正回窝休息'
      }
      wx.showToast?.({ title: messages[operation], icon: 'none' })
    } catch (error) {
      wx.showToast?.({ title: error?.message || '宠物操作失败，请重试', icon: 'none' })
    } finally {
      if (!this._closed) this.setData({ petCareBusy: false })
    }
  },

  async interactPet() {
    const petId = this.data.nearbyPet?.id || this.data.selectedPetId
    const credentials = this._petCredentials()
    if (!petId || !credentials || this.data.petCareBusy) return
    this._stopStick()
    this.setData({ petCareBusy: true })
    try {
      const manor3dPosition = this._petPosition(petId)
      const result = await callFunction('playground', 'interactPet', {
        ...credentials,
        petId,
        commandSeq: this._nextPetCommand(),
        ...(manor3dPosition ? { manor3dPosition } : {})
      })
      this._scene?.petInteract?.(petId)
      this._applyPetResult(result)
      wx.showToast?.({ title: `${this.data.nearbyPet?.name || '宠物'}开心地蹭了蹭你`, icon: 'none' })
    } catch (error) {
      wx.showToast?.({ title: error?.message || '请先走近自己的宠物', icon: 'none' })
    } finally {
      if (!this._closed) this.setData({ petCareBusy: false })
    }
  },

  async clearPetWaste() {
    const pet = this.data.selectedPet || this.data.nearbyPet
    const waste = pet?.waste?.find(item => item.type === 'poop' && !item.vehicleId)
    const credentials = this._petCredentials()
    if (!pet || !waste || !credentials || this.data.petCareBusy) return
    this.setData({ petCareBusy: true })
    try {
      await callFunction('playground', 'farmAction', {
        ...credentials,
        operation: 'pickupPoop',
        poopId: waste.id,
        quantity: 1,
        requestId: 'manor3d_poop_' + Date.now().toString(36)
      })
      this._scene?.clearPetWaste?.(pet.id, waste.id)
      this._communitySync?.snapshot?.().catch(() => {})
      this._refreshPetUi()
      wx.showToast?.({ title: '便便已清理', icon: 'none' })
    } catch (error) {
      wx.showToast?.({ title: error?.message || '清理失败，请重试', icon: 'none' })
    } finally {
      if (!this._closed) this.setData({ petCareBusy: false })
    }
  },

  togglePetRoster() {
    this.setData({ petRosterOpen: !this.data.petRosterOpen })
  },

  selectPet(event) {
    const id = event?.currentTarget?.dataset?.petId
    if (!id) return
    this._scene?.selectPet?.(id)
    this.setData({ petRosterOpen: false })
    this._refreshPetUi()
  },

  clearSelectedPet() {
    if (this._scene?.clearPetSelection) this._scene.clearPetSelection()
    else this._scene?.selectPet?.('')
    this.setData({ selectedPetId: '', selectedPetName: '', selectedPet: null })
  },

  swallowPetTouch() {},

  _progress(session, field) {
    if (!field) return undefined
    let last = -1
    return event => {
      const written = event.totalBytesExpectedToWrite > 0
        ? event.totalBytesWritten / event.totalBytesExpectedToWrite * 100 : 0
      const percent = Math.min(100, Math.floor(Math.max(Number(event.progress) || 0, written)))
      if (!this._isCurrent(session) || percent <= 0 || (percent !== 100 && percent - last < 2) || percent === last) return
      last = percent
      this.setData({ [field]: percent })
    }
  },

  async _attach(session, key, progressField, beforeParse, attach) {
    const buffer = await session.assets.read(key, { onProgress: this._progress(session, progressField) })
    if (!this._isCurrent(session)) return false
    beforeParse()
    let group
    try {
      group = await loadGlb(buffer, this._canvas, wx, { isCancelled: () => !this._isCurrent(session) })
    } catch (error) {
      if (this._isCurrent(session)) session.assets.invalidate(key)
      throw error
    }
    if (!this._isCurrent(session)) {
      disposeModel(group)
      return false
    }
    try {
      if (attach(group) === false) {
        if (!group.parent) disposeModel(group)
        return false
      }
    } catch (error) {
      if (!group.parent) disposeModel(group)
      throw error
    }
    return true
  },

  async _beginLoad() {
    if (!this._shown || !this._mounted || this._closed || this._session ||
        this.data.status === 'unavailable' || this.data.status === 'error' ||
        (this._hasLandscape && (this.data.villaStatus === 'error' ||
          this._hasVilla && (this._interiorMetadata || this.data.interiorStatus === 'error')))) return
    const session = { assets: createCloudAssets({ wx, envId: this._envId }) }
    this._session = session
    try {
      if (!this._scene) {
        try {
          const view = await this._queryCanvas()
          if (!this._isCurrent(session)) return
          if (!view?.node || !(view.width > 0 && view.height > 0)) throw new Error('无法获取庄园画布')
          this._canvas = view.node
          this._renderer = createRenderer(view.node)
          this._scene = createManorScene({ THREE, renderer: this._renderer, disposeModel })
          this._resize(view)
        } catch (error) {
          if (this._isCurrent(session)) this._failRenderer(error)
          return
        }
      } else if (!this._hasLandscape) {
        // The canvas may have rotated while the terrain download was paused.
        await this.onResize()
        if (!this._isCurrent(session)) return
      }
      if (!this._hasLandscape) {
        this.setData({ stage: '正在读取庄园地图', progress: -1 })
        const text = await session.assets.read('layout')
        if (!this._isCurrent(session)) return
        let layout
        try { layout = readLayout(text) } catch (error) {
          session.assets.invalidate('layout')
          throw error
        }
        this.setData({ stage: '正在下载地形（约 56 MB）' })
        const attached = await this._attach(session, 'manor', 'progress',
          () => this.setData({ stage: '正在绘制草坪、树林和溪流', progress: -1 }),
          model => {
            this._scene.showLandscape(model, layout)
            this.setData({ minimap: createManorMinimap(layout, model), mapPlayer: null, mapVehicle: null, mapNeighbors: [] })
          })
        if (!attached || !this._isCurrent(session)) return
        try { this._draw() } catch (error) {
          this._failRenderer(error)
          return
        }
        this._hasLandscape = true
        this.setData({ status: 'ready' })
        this._startFrames()
        this._applyPendingSharedRecords()
        this._applyPendingCommunityPosition()
        this._loadPetModels()
        // Give the player priority over the optional villa on first entry.
        await this._loadCharacter()
        this._loadVehicle()
        this._loadHighRises()
      }
      if (!this._isCurrent(session) || this.data.villaStatus === 'error') return
      if (this._hasVilla) {
        this._loadPetModels()
        if (!this._interiorMetadata && this.data.interiorStatus !== 'error') await this._loadVillaInteriorMetadata(session)
        this._restorePlayerPosition()
        return
      }
      this.setData({ villaStatus: 'loading', villaProgress: -1, villaError: '' })
      const attached = await this._attach(session, 'villa', 'villaProgress',
        () => this.setData({ villaStatus: 'drawing', villaProgress: -1 }),
        model => this._scene.showVilla(model))
      if (attached && this._isCurrent(session)) {
        this._hasVilla = true
        this.setData({ villaStatus: 'ready' })
        this._refreshBuild()
        this._updateMinimapPlayer()
        this._maybePromptFirstHome()
        await this._loadVillaInteriorMetadata(session)
        this._loadPetModels()
      }
    } catch (error) {
      if (!this._isCurrent(session)) return
      console.warn('[manor3d] 加载失败', error?.message)
      if (this._hasLandscape) {
        this.setData({ villaStatus: 'error', villaError: statusText(error, '示范别墅加载失败') })
        this._restorePlayerPosition()
        this._refreshBuild()
      } else {
        this._releaseScene()
        this.setData({ status: 'error', error: statusText(error, '庄园地形加载失败，请重试') })
      }
    } finally {
      if (this._session === session) this._stopLoad()
    }
  },

  async _loadCharacter() {
    const { characterType: type, activeCharacter, characterStatus } = this.data
    if (!this._shown || !this._hasLandscape || this._closed || this._characterSession ||
        type === activeCharacter || characterStatus === 'error') return
    const session = { assets: createCloudAssets({ wx, envId: this._envId }) }
    this._characterSession = session
    const name = type === 'girl' ? '女孩' : '男孩'
    try {
      this.setData({ characterStatus: 'loading', characterProgress: -1, characterError: '' })
      const attached = await this._attach(session, type, 'characterProgress',
        () => this.setData({ characterStatus: 'drawing', characterProgress: -1 }),
        model => this._scene.showCharacter(model, type))
      if (attached && this._isCurrent(session)) {
        this.setData({ activeCharacter: type, characterStatus: 'ready' })
        this._restorePlayerPosition()
        this._applyPendingCommunityPosition()
        this._updateMinimapPlayer()
        this._maybePromptFirstHome()
        try { wx.setStorageSync(CHARACTER_KEY, type) } catch (_) {}
      }
    } catch (error) {
      if (!this._isCurrent(session)) return
      console.warn('[manor3d] 角色加载失败', error?.message)
      this.setData({ characterStatus: 'error', characterError: name + '加载失败，请重试' })
    } finally {
      if (this._characterSession === session) this._stopLoad('_characterSession')
    }
  },

  _refreshCommunityPlayers() {
    if (!this._shown || !this._scene?.getCommunityPlayers) return
    const now = Date.now()
    if (now < (this._nextCommunityMapUpdate || 0)) return
    this._nextCommunityMapUpdate = now + 200
    const players = this._scene.getCommunityPlayers()
    const mapNeighbors = this.data.minimap ? players.filter(player => !player.interior).map(player => ({
      id: player.id, ...projectManorMapPoint(this.data.minimap, player.x, player.z)
    })) : []
    const previous = this.data.mapNeighbors
    if (mapNeighbors.length !== previous.length || mapNeighbors.some((player, index) => {
      const old = previous[index]
      return old.id !== player.id || old.x !== player.x || old.y !== player.y
    })) this.setData({ mapNeighbors })
    if (!this.data.activeCharacter || this._characterSession || this._remoteCharacterSession ||
        now < (this._remoteModelRetryAt || 0) || !this._scene.hasRemoteCharacterModel) return
    const type = players.find(player => player.visible && !this._scene.hasRemoteCharacterModel(player.characterType))?.characterType
    if (type === 'boy' || type === 'girl') this._loadRemoteCharacter(type)
  },

  async _loadRemoteCharacter(type) {
    if (!this._shown || !this._scene || this._scene.hasRemoteCharacterModel?.(type) || this._remoteCharacterSession) return
    const session = { assets: createCloudAssets({ wx, envId: this._envId }) }
    this._remoteCharacterSession = session
    try {
      await this._attach(session, type, null, () => {},
        model => this._scene.setRemoteCharacterModel(type, model))
    } catch (error) {
      if (!this._isCurrent(session)) return
      this._remoteModelRetryAt = Date.now() + 15000
      console.warn('[manor3d] 邻居角色加载失败', error?.message)
    } finally {
      if (this._remoteCharacterSession === session) this._stopLoad('_remoteCharacterSession')
    }
  },

  async _loadVehicle() {
    if (!this._shown || this._closed || !this._hasLandscape || this._hasVehicle || this._vehicleSession ||
        this.data.vehicleLoadError || !this._scene?.showVehicle) return
    const vehicle = this._communityScene?.manor3dVehicle
    const session = { assets: createCloudAssets({ wx, envId: this._envId }) }
    this._vehicleSession = session
    try {
      const attached = await this._attach(session, 'car', null, () => {}, model => this._entrySelected
        ? this._scene.setVehicleModel(model, this._communityScene?.manor3dVehicle || vehicle)
        : this._scene.showVehicle(model, vehicle))
      if (attached && this._isCurrent(session)) {
        this._hasVehicle = true
        this._updateVehicleState()
        this._updateMinimapPlayer()
      }
    } catch (error) {
      if (!this._isCurrent(session)) return
      console.warn('[manor3d] 车辆加载失败', error?.message)
      this.setData({ vehicleLoadError: 'Copper GT 加载失败' })
    } finally {
      if (this._vehicleSession === session) this._stopLoad('_vehicleSession')
    }
  },

  async _loadHighRises() {
    // Use the canonical ID returned by enterScene; the session token and
    // player ID differ between visitors to the same neighborhood.
    const neighborhoodId = this._entrySelected ? this._communityScene?.sceneId : 'local'
    if (!neighborhoodId || !this._shown || this._closed || !this._hasLandscape || !this._scene?.showHighRises ||
        this._hasHighRises || this._highRiseUnavailable || this._highRiseSession) return
    const session = { assets: createCloudAssets({ wx, envId: this._envId }) }
    this._highRiseSession = session
    try {
      let footprints
      const attached = await this._attach(session, 'highRise', null, () => {}, model => {
        footprints = this._scene.showHighRises(model, neighborhoodId)
        if (!footprints) return false
        disposeModel(model)
      })
      if (!this._isCurrent(session)) return
      this._hasHighRises = attached
      this._highRiseUnavailable = !attached
      if (attached && this.data.minimap) {
        this.setData({ 'minimap.towers': projectManorMapTowers(this.data.minimap, footprints) })
        this._updateMinimapPlayer()
      }
    } catch (error) {
      if (!this._isCurrent(session)) return
      this._highRiseUnavailable = true
      console.warn('[manor3d] 小区住宅楼加载失败', error?.message)
    } finally {
      if (this._highRiseSession === session) {
        this._stopLoad('_highRiseSession')
        this._restorePlayerPosition()
      }
    }
  },

  retryVehicle() {
    if (!this._shown || !this.data.vehicleLoadError) return
    this.setData({ vehicleLoadError: '' })
    this._loadVehicle()
  },

  _updateVehicleState() {
    const state = this._hasVehicle && this._scene?.getVehicleState()
    if (!state && !this._vehicleStateSignature) return
    const visible = !this.data.mapMode && !this.data.buildMode && !this._pendingPlayerPosition && !this._interiorSession
    const nearby = Boolean(visible && state?.nearby)
    const mode = state?.mode || 'walking'
    const signature = JSON.stringify([nearby, mode, state?.status, state?.speed, state?.canExit, state?.seatLabel,
      state?.seats.map(item => item.occupied)])
    if (!nearby) this.closeVehiclePanel()
    if (signature === this._vehicleStateSignature) return
    this._vehicleStateSignature = signature
    this.setData({ vehicleNearby: nearby, vehicleState: mode, vehicleStatus: state?.status || '',
      vehicleSeatLabel: state?.seatLabel || '', vehicleSpeed: state?.speed || 0,
      vehicleCanExit: Boolean(state?.canExit), vehicleSeats: state?.seats || [] })
    this._updateMinimapPlayer()
  },

  openVehiclePanel() {
    if (!this._shown || !this.data.vehicleNearby || !this._scene?.getVehicleState()?.nearby) return
    this._stopStick()
    this._resetCanvasTouches()
    this.setData({ vehiclePanelOpen: true, menuOpen: false })
  },

  closeVehiclePanel() {
    if (this.data.vehiclePanelOpen) this.setData({ vehiclePanelOpen: false })
  },

  selectVehicleSeat(event) {
    const id = event.currentTarget?.dataset?.seat
    if (!this._shown || !this.data.vehiclePanelOpen || !this.data.vehicleSeats.some(seat => seat.id === id && !seat.occupied)) return
    if (!this._scene?.enterVehicle(id)) {
      wx.showToast?.({ title: '请走到车旁再上车', icon: 'none' })
      return
    }
    this.closeVehiclePanel()
    this._updateVehicleState()
  },

  brakeVehicle() {
    if (!this._shown || this.data.vehicleState !== 'driver') return
    this._stopStick()
    this._scene?.brakeVehicle()
  },

  exitVehicle() {
    if (!this._shown || !this.data.vehicleCanExit) return
    this._stopStick()
    if (this._scene?.exitVehicle()) this._updateVehicleState()
    else wx.showToast?.({ title: '车门旁空间不足，请换个位置停车', icon: 'none' })
  },

  _draw(dt = 0) {
    if (this._renderer.getContext().isContextLost?.()) throw new Error('3D 渲染已中断')
    this._scene.render(this._timeSeconds || 0, dt)
    const playerState = this._scene.getPlayerSyncState?.()
    if (playerState?.position3d) this._scene.setPetPlayerPosition?.(playerState.position3d)
    this._refreshPetUi()
    this._updateVehicleState()
    this._updateDoorState()
    this._updateElevatorState()
    this._updateRoomDoorState()
    this._updateRestState()
    this._savePlayerPosition()
    this._syncCommunityPosition()
    this._syncManor3dVehicle()
    if (this._communitySync) this._refreshCommunityPlayers()
    if (this._stick || this._hasVehicle) {
      const now = Date.now()
      if (now >= (this._nextMinimapUpdate || 0)) {
        this._nextMinimapUpdate = now + MINIMAP_UPDATE_MS
        this._updateMinimapPlayer()
      }
    }
  },

  _updateDoorState() {
    const insideVilla = Boolean(this._scene?.isInsideVilla)
    const insideCourtyard = Boolean(this._scene?.isInsideCourtyard)
    const doorBusy = Boolean(this._scene?.isCourtyardDoorBusy)
    const courtyardDoorLabel = this._scene?.getCourtyardDoor?.()?.label || ''
    const status = this.data.interiorStatus
    const doorPrompt = !insideVilla && !doorBusy && !this._pendingPlayerPosition && status !== 'loading' && status !== 'drawing' &&
      Boolean(courtyardDoorLabel || (status !== 'error' && this._interiorMetadata && this._scene?.getVillaEntryState?.()?.nearDoor))
    const changedInterior = insideVilla !== this.data.insideVilla
    if (changedInterior || insideCourtyard !== this.data.insideCourtyard || doorBusy !== this.data.doorBusy ||
        courtyardDoorLabel !== this.data.courtyardDoorLabel || doorPrompt !== this.data.doorPrompt) {
      this.setData({ insideVilla, insideCourtyard, doorBusy, courtyardDoorLabel, doorPrompt })
    }
    if (changedInterior) {
      if (!insideVilla) this._applyPendingCommunityPosition()
      this._updateMinimapPlayer()
      this._savePlayerPosition(true)
    }
  },

  _updateElevatorState() {
    const next = this.data.insideVilla ? this._scene?.getElevatorState?.() : null
    const previous = this.data.elevator
    if (previous?.phase === next?.phase && previous?.targetFloor === next?.targetFloor &&
        previous?.floor === next?.floor && previous?.busy === next?.busy) return
    const floorName = floor => ['','一楼','二楼','三楼'][floor] || floor + '楼'
    this.setData({ elevator: next ? {
      ...next, title: ELEVATOR_TITLE[next.phase], destination: floorName(next.targetFloor),
      buttons: next.busy ? [] : (next.destinations || [next.targetFloor]).map(floor => ({
        floor, label: floorName(floor), up: next.floor ? floor > next.floor : floor === 2
      }))
    } : null })
  },

  _updateRoomDoorState() {
    const next = this.data.insideCourtyard && !this.data.elevator && this._canUsePlayerActions()
      ? this._scene?.getRoomDoor?.() || null : null
    const previous = this.data.roomDoor
    if (previous?.id === next?.id && previous?.open === next?.open && previous?.busy === next?.busy) return
    this.setData({ roomDoor: next })
  },

  useRoomDoor(event) {
    const id = event?.currentTarget?.dataset?.doorId
    if (!this.data.insideCourtyard || this.data.elevator || !this._canUsePlayerActions() || typeof id !== 'string') return
    if (this._scene?.interactRoomDoor?.(id)) this._updateRoomDoorState()
  },

  _canUsePlayerActions() {
    const data = this.data
    return Boolean(this._shown && !this._closed && this._scene && data.status === 'ready' && data.activeCharacter &&
      !data.menuOpen && !data.mapMode && !data.buildMode && !this._exitPromptOpen && !data.vehiclePanelOpen &&
      data.vehicleState === 'walking' && !data.doorBusy && !this._scene.isCourtyardDoorBusy && !data.elevator?.busy &&
      !this._pendingPlayerPosition && data.interiorStatus !== 'loading' && data.interiorStatus !== 'drawing')
  },

  _updateRestState() {
    const state = this._scene?.getRestState?.()
    const toPrompt = rest => rest ? { kind: rest.kind, name: rest.name, label: rest.label, busy: Boolean(rest.busy) } : null
    const restPrompt = toPrompt(state)
    const restLocked = Boolean(state?.busy || state?.resting)
    const playerActions = this._canUsePlayerActions() ? {
      jump: Boolean(this._scene.canJumpPlayer?.()),
      sit: state?.kind === 'sit' ? restPrompt : toPrompt(this._scene.getRestState?.('sit')),
      lie: state?.kind === 'lie' ? restPrompt : toPrompt(this._scene.getRestState?.('lie'))
    } : null
    const signature = JSON.stringify([restPrompt, restLocked, playerActions])
    if (signature === this._restStateSignature) return
    this._restStateSignature = signature
    this.setData({ restPrompt, restLocked, playerActions })
  },

  jumpPlayer() {
    if (!this._canUsePlayerActions() || !this._scene.canJumpPlayer?.()) return
    if (this._scene.jumpPlayer?.()) this._updateRestState()
  },

  interactRest(event) {
    const kind = event?.currentTarget?.dataset?.restKind
    if (!this._canUsePlayerActions() || (kind !== undefined && kind !== 'sit' && kind !== 'lie')) return
    const state = this._scene.getRestState?.(kind)
    if (!state || state.busy || (kind && state.kind !== kind) || !this._scene.interactRest?.(kind)) return
    this._stopStick()
    this._resetCanvasTouches()
    if (this.data.firstPerson) {
      this._scene.setFirstPerson(false)
      this.setData({ firstPerson: false })
    }
    this.closeMenu()
    this._updateRestState()
  },

  _positionMinimap() {
    const bottom = wx.getMenuButtonBoundingClientRect?.()?.bottom
    const minimapTop = Number.isFinite(bottom) && bottom > 0 ? Math.ceil(bottom) + 8 : 0
    if (this.data.minimapTop !== minimapTop) this.setData({ minimapTop })
  },

  _updateMinimapPlayer() {
    const { minimap } = this.data
    const position = this._scene?.getMapPlayerPosition()
    const car = this._scene?.getVehicleSyncState?.()?.position3d
    const mapPlayer = projectManorMapPoint(minimap, position?.x, position?.z)
    const mapVehicle = projectManorMapPoint(minimap, car?.x, car?.z)
    const updates = {}
    if (mapPlayer?.x !== this.data.mapPlayer?.x || mapPlayer?.y !== this.data.mapPlayer?.y) updates.mapPlayer = mapPlayer
    if (mapVehicle?.x !== this.data.mapVehicle?.x || mapVehicle?.y !== this.data.mapVehicle?.y) updates.mapVehicle = mapVehicle
    if (Object.keys(updates).length) this.setData(updates)
  },

  _failRenderer(error) {
    console.warn('[manor3d] 渲染失败', error?.message)
    this._stopStick()
    this._stopFrames()
    this._stopLoad()
    this._stopLoad('_characterSession')
    this._stopLoad('_interiorSession')
    this._releaseScene()
    this.setData({ status: 'error', activeCharacter: '', mountCanvas: false, mapMode: false, menuOpen: false, firstPerson: false,
      error: '无法显示 3D 庄园，请重试或返回 2D 庄园' })
  },

  _startFrames() {
    if (!this._shown || !this._hasLandscape || this._loop) return
    const canvas = this._canvas
    const native = typeof canvas.requestAnimationFrame === 'function' && typeof canvas.cancelAnimationFrame === 'function'
    const loop = { cancel: native ? id => canvas.cancelAnimationFrame(id) : clearTimeout, handle: null }
    this._loop = loop
    let last = Date.now()
    const schedule = () => {
      loop.handle = native ? canvas.requestAnimationFrame(frame) : setTimeout(frame, Math.ceil(FRAME_MS))
    }
    const frame = () => {
      if (this._loop !== loop || !this._shown) return
      const now = Date.now()
      const elapsed = now - last
      if (elapsed >= FRAME_MS - 2 || elapsed < 0) {
        last = now
        const dt = Math.max(0, Math.min(elapsed, 100)) / 1000
        this._timeSeconds = (this._timeSeconds || 0) + dt
        try { this._draw(dt) } catch (error) {
          this._failRenderer(error)
          return
        }
      }
      schedule()
    }
    schedule()
  },

  _stopFrames() {
    const loop = this._loop
    this._loop = null
    if (loop?.handle != null) loop.cancel(loop.handle)
  },

  retryLandscape() {
    if (this.data.status !== 'error' || !this._shown) return
    this.setData({ status: 'loading', mountCanvas: true, stage: '正在准备 3D 庄园', error: '', progress: -1,
      villaStatus: 'pending', villaProgress: -1, villaError: '', activeCharacter: '', characterStatus: 'pending',
      characterProgress: -1, characterError: '', interiorStatus: 'idle', interiorProgress: -1, interiorError: '',
      doorPrompt: false, insideVilla: false, insideCourtyard: false, courtyardDoorLabel: '', doorBusy: false,
      elevator: null, mapMode: false, menuOpen: false, minimap: null, mapPlayer: null }, () => this._beginLoad())
  },

  retryVilla() {
    if (this.data.villaStatus !== 'error' || !this._shown) return
    this.setData({ villaStatus: 'pending' })
    this._beginLoad()
  },

  async readInteriorModel(session = this._interiorSession) {
    if (!session || !this._isCurrent(session)) throw new Error('室内加载已取消')
    const text = await session.assets.read('interiorModel', { onProgress: this._progress(session, 'interiorProgress') })
    if (!this._isCurrent(session)) throw new Error('室内加载已取消')
    try {
      const metadata = JSON.parse(String(text).replace(/^﻿/, ''))
      if (!validInteriorMetadata(metadata)) {
        throw new Error('invalid metadata')
      }
      return metadata
    } catch (_) {
      session.assets.invalidate('interiorModel')
      throw new Error('别墅内部配置无效，请重试')
    }
  },

  async _loadVillaInteriorMetadata(session) {
    if (this._interiorMetadata || !this._isCurrent(session)) return
    this.setData({ interiorStatus: 'loading', interiorProgress: -1, interiorError: '' })
    try {
      const metadata = await this.readInteriorModel(session)
      if (!this._isCurrent(session)) return
      this._interiorMetadata = metadata
      this._interiorFailureKind = ''
      this._scene.setVillaInteriorMetadata?.(metadata)
      this.setData({ interiorStatus: 'idle', interiorProgress: -1, interiorError: '' })
      this._restorePlayerPosition()
    } catch (error) {
      if (!this._isCurrent(session)) return
      this._interiorFailureKind = 'metadata'
      console.warn('[manor3d] 别墅门口配置读取失败', error?.message)
      this.setData({ interiorStatus: 'error', interiorError: statusText(error, '别墅门口配置读取失败，请重试') })
      this._restorePlayerPosition()
    }
  },

  async _loadInterior(saved = null) {
    if (!this._shown || this._closed || !this._scene || !this._hasVilla || this.data.insideVilla || this._interiorSession) return
    const entry = this._scene.getVillaEntryState?.()
    if (!saved && (!entry?.available || !entry.nearDoor)) {
      this.setData({ interiorStatus: 'error', interiorError: '请走到别墅门口再重试' })
      return
    }
    if (this._interiorModel && this._interiorMetadata) {
      try {
        this._scene.setVillaInteriorMetadata?.(this._interiorMetadata)
        if (this._scene.enterInterior(this._interiorModel, this._interiorMetadata, saved) === false) {
          if (saved) this._finishPlayerRestore(false, saved)
          return
        }
        this._interiorFailureKind = ''
        this.setData({ interiorStatus: 'ready', interiorProgress: 100, interiorError: '', doorPrompt: false, insideVilla: true })
        if (saved) this._finishPlayerRestore(true, saved)
        else this._savePlayerPosition(true)
      } catch (error) {
        this._interiorFailureKind = 'entry'
        console.warn('[manor3d] 进入别墅失败', error?.message)
        this.setData({ interiorStatus: 'error', interiorError: '别墅内部进入失败，请重试', doorPrompt: true, insideVilla: false })
        if (saved) this._finishPlayerRestore(false, saved)
      }
      return
    }
    this.closeMenu()
    this._stopStick()
    this._resetCanvasTouches()
    const session = { assets: createCloudAssets({ wx, envId: this._envId }) }
    this._interiorSession = session
    try {
      this.setData({ interiorStatus: 'loading', interiorProgress: -1, interiorError: '', doorPrompt: false })
      const metadata = this._interiorMetadata || await this.readInteriorModel(session)
      if (!this._isCurrent(session)) return
      this._interiorMetadata = metadata
      this._scene.setVillaInteriorMetadata?.(metadata)
      const attached = await this._attach(session, 'interior', 'interiorProgress',
        () => this.setData({ interiorStatus: 'drawing', interiorError: '' }),
        model => {
          if (this._scene.enterInterior(model, metadata, saved) === false) return false
          this._interiorModel = model
        })
      if (this._isCurrent(session) && attached) {
        this._interiorFailureKind = ''
        this.setData({ interiorStatus: 'ready', interiorProgress: 100, interiorError: '', doorPrompt: false, insideVilla: true })
        if (saved) this._finishPlayerRestore(true, saved)
        else this._savePlayerPosition(true)
      } else if (this._isCurrent(session)) {
        this.setData({ interiorStatus: 'idle', interiorProgress: -1 })
        if (saved) this._finishPlayerRestore(false, saved)
      }
    } catch (error) {
      if (!this._isCurrent(session)) return
      this._interiorFailureKind = 'model'
      this._interiorModel = null
      console.warn('[manor3d] 别墅内部加载失败', error?.message)
      this.setData({ interiorStatus: 'error', interiorError: statusText(error, '别墅内部加载失败，请重试'), doorPrompt: true, insideVilla: false })
      if (saved) this._finishPlayerRestore(false, saved)
    } finally {
      if (this._interiorSession === session) this._stopLoad('_interiorSession')
    }
  },

  enterVilla() {
    if (!this._shown || this.data.insideVilla || this.data.mapMode || this.data.buildMode ||
        this._pendingPlayerPosition || this._scene?.isCourtyardDoorBusy || this._interiorSession) return
    const courtyardDoor = this._scene?.getCourtyardDoor?.()
    if (courtyardDoor && !courtyardDoor.inside) return this._useCourtyardDoor(courtyardDoor)
    if (!this._hasVilla) return
    const entry = this._scene?.getVillaEntryState?.()
    if (!entry?.available || !entry.nearDoor) return
    this._loadInterior()
  },

  _useCourtyardDoor(door) {
    this.closeMenu()
    this._stopStick()
    this._resetCanvasTouches()
    if (this._scene?.interactCourtyardDoor?.(door.plotId, door.doorId)) this._updateDoorState()
  },

  exitVilla() {
    if (!this._shown || !this.data.insideVilla || this.data.restLocked || this.data.elevator?.busy || !this._scene) return
    if (this._scene.isInsideCourtyard) {
      const door = this._scene.getCourtyardDoor?.()
      if (door?.inside) this._useCourtyardDoor(door)
      return
    }
    this._stopStick()
    this._resetCanvasTouches()
    try {
      if (this._scene.exitInterior?.() === false) return
      const entry = this._scene.getVillaEntryState?.()
      this.setData({ insideVilla: false, doorPrompt: Boolean(entry?.nearDoor), elevator: null, interiorError: '' })
      this._applyPendingCommunityPosition()
      this._savePlayerPosition(true)
      this._syncCommunityPosition()
    } catch (error) {
      console.warn('[manor3d] 离开别墅失败', error?.message)
    }
  },

  useElevator(event) {
    const choice = event?.currentTarget?.dataset?.floor
    const floor = choice === undefined ? undefined : Number(choice)
    if ((floor !== undefined && !Number.isInteger(floor)) || !this._shown || !this.data.insideVilla ||
        this.data.restLocked || this.data.doorBusy || this.data.elevator?.busy || !this._scene?.useElevator?.(floor)) return
    this._stopStick()
    this.closeMenu()
    this._updateElevatorState()
  },

  retryInterior() {
    if (this.data.interiorStatus !== 'error' || !this._shown) return
    if (this._interiorFailureKind === 'metadata') {
      if (this._interiorSession) return
      const session = { assets: createCloudAssets({ wx, envId: this._envId }) }
      this._interiorSession = session
      this.setData({ interiorStatus: 'loading', interiorProgress: -1, interiorError: '' })
      this._loadVillaInteriorMetadata(session).finally(() => {
        if (this._interiorSession === session) this._stopLoad('_interiorSession')
      })
      return
    }
    const entry = this._scene?.getVillaEntryState?.()
    if (!entry?.available || !entry.nearDoor) {
      this.setData({ interiorError: '请走到别墅门口再重试' })
      return
    }
    this.setData({ interiorStatus: 'idle', interiorProgress: -1, interiorError: '' })
    this._loadInterior()
  },

  selectCharacter(event) {
    this.closeMenu()
    const type = event.currentTarget.dataset.character
    if (!this._hasLandscape || !this._shown || this.data.vehicleState !== 'walking' || this.data.vehiclePanelOpen ||
        (type !== 'boy' && type !== 'girl') || type === this.data.characterType) return
    this._stopLoad('_characterSession')
    this.setData({ characterType: type, characterProgress: -1, characterError: '',
      characterStatus: type === this.data.activeCharacter ? 'ready' : 'pending' })
    this._loadCharacter()
  },

  retryCharacter() {
    if (this.data.characterStatus !== 'error' || !this._shown || !this._hasLandscape) return
    this.setData({ characterStatus: 'pending' })
    this._loadCharacter()
  },

  openBuild() {
    if (!this._shown || !this._hasLandscape || !this._communityConnected || !this.data.canBuildManor3d ||
        this.data.mapMode || this.data.insideVilla || this._build || this._pendingPlayerPosition ||
        this.data.vehicleState !== 'walking' || this.data.vehiclePanelOpen ||
        this._scene?.isCourtyardDoorBusy || this._interiorSession) return
    this._stopStick()
    this._resetCanvasTouches()
    this.setData({ buildMode: true, menuOpen: false })
    this.chooseBuilding({ currentTarget: { dataset: { buildingId: BUILDINGS[0].id } } })
  },

  chooseBuilding(event) {
    if (!this.data.buildMode || this.data.buildSaving) return
    const building = BUILDINGS.find(item => item.id === event.currentTarget.dataset.buildingId)
    if (!building || this._build?.building === building) return
    this._build = { building, rotation: 0, point: this._build?.point || null }
    this.setData({ buildError: '' })
    this._refreshBuild()
    if (building.id === COURTYARD_ID && this.data.courtyardStatus === 'idle') this._loadCourtyard()
  },

  rotateBuilding(event) {
    if (!this._build || this.data.buildSaving) return
    const delta = Number(event.currentTarget.dataset.delta)
    if (delta !== -90 && delta !== 90) return
    this._build.rotation = (this._build.rotation + delta + 360) % 360
    this.setData({ buildError: '' })
    this._refreshBuild()
  },

  _buildOptions() {
    const { building, rotation } = this._build
    const [width, depth] = buildFootprint(building, rotation)
    const plots = this._scene.getBuildPlots()
    const occupied = new Set((this._placedBuildings || []).map(record => record.plotId))
    const regions = plots.filter(plot => !occupied.has(plot.id)).map(plot => buildRegion(plot, width, depth)).filter(Boolean)
    return { width, depth, plots, occupied, regions }
  },

  _refreshBuild() {
    if (!this._build || !this._scene) return
    const { building, rotation, point } = this._build
    const { width, depth, occupied, regions } = this._buildOptions()
    const valid = Boolean(point && inBuildRegion(point, regions.find(region => region.plotId === point.plotId)))
    const courtyard = building.id === COURTYARD_ID
    const loaded = courtyard ? this.data.courtyardStatus === 'ready' : this._hasVilla
    const connected = this.data.canBuildManor3d && this._communityConnected
    let buildHint = valid ? '位置合适，可以确认建造' : '点击绿色地块选址'
    if (!regions.length) buildHint = '当前朝向没有合适的空地，试试旋转建筑'
    if (point && !valid) buildHint = occupied.has(point.plotId) ? '这块地已被占用，请重新选址' : '当前位置放不下，请旋转或重新选址'
    if (valid && !loaded) buildHint = '模型准备好后即可确认建造'
    if (!connected) buildHint = '场景连接中断，恢复后可继续建造'
    this._scene.setBuildPreview({ buildingId: building.id, rotation, ...point, valid, regions })
    this.setData({ buildId: building.id, buildRotation: rotation, buildFootprint: Number(width.toFixed(2)) + ' × ' +
      Number(depth.toFixed(2)) + ' 米', buildHint, buildCanConfirm: Boolean(valid && loaded && connected) })
  },

  _pickBuildPoint(touch) {
    if (!this._build || this.data.buildSaving || !this._viewport) return
    const point = this._scene.pickBuildGround(touch.x, touch.y, this._viewport.width, this._viewport.height)
    const { plots, regions } = this._buildOptions()
    const plot = point && plots.find(item => Math.abs(point.x - item.x) <= item.width / 2 &&
      Math.abs(point.z - item.z) <= item.depth / 2)
    const region = plot && regions.find(item => item.plotId === plot.id)
    this._build.point = plot ? {
      plotId: plot.id,
      x: region ? Math.max(region.minX, Math.min(region.maxX, point.x)) : point.x,
      z: region ? Math.max(region.minZ, Math.min(region.maxZ, point.z)) : point.z
    } : null
    this.setData({ buildError: plot ? '' : '请选择地图上的可建地块' })
    this._refreshBuild()
  },

  async _loadCourtyard() {
    if (!this._shown || !this._hasLandscape || this._buildModelSession || this.data.courtyardStatus === 'ready') return
    const session = this._buildModelSession = { assets: createCloudAssets({ wx, envId: this._envId }) }
    this.setData({ courtyardStatus: 'loading', courtyardProgress: -1, courtyardError: '' })
    try {
      const attached = await this._attach(session, 'courtyardVilla', 'courtyardProgress', () => {},
        model => this._scene.setBuildModel(COURTYARD_ID, model))
      if (attached && this._isCurrent(session)) this.setData({ courtyardStatus: 'ready' })
    } catch (error) {
      if (this._isCurrent(session)) this.setData({ courtyardStatus: 'error',
        courtyardError: statusText(error, '松影叠院加载失败，请重试') })
    } finally {
      if (this._buildModelSession === session) {
        this._stopLoad('_buildModelSession')
        this._refreshBuild()
        this._restorePlayerPosition()
      }
    }
  },

  retryCourtyard() {
    if (this.data.courtyardStatus === 'error') return this._loadCourtyard()
  },

  async confirmBuilding() {
    const build = this._build
    const sync = this._communitySync
    if (!build?.point || !sync || this.data.buildSaving || !this._shown) return
    this._refreshBuild()
    if (!this.data.buildCanConfirm) return
    const { sceneId, session } = this._communityScene
    const current = () => this._shown && !this._closed && sync === this._communitySync && build === this._build
    this.setData({ buildSaving: true, buildError: '' })
    try {
      const { callFunction } = require('../../utils/cloud')
      const result = await callFunction('playground', 'placeManor3dBuilding', {
        sceneId, session, buildingId: build.building.id, rotation: build.rotation, ...build.point
      })
      if (!current()) return
      if (!result?.record?.id) throw new Error('建筑保存结果暂不可用，请重试')
      if (result.vehicle && this._communityScene) {
        this._communityScene.manor3dVehicle = result.vehicle
        this._vehicleSyncSeq = Number.isSafeInteger(result.vehicle.seq) ? result.vehicle.seq : 0
        this._vehicleSyncSignature = ''
        this._nextVehicleSync = 0
        this._scene?.setVehicleRecord?.(result.vehicle)
      }
      sync.merge(result.record)
      sync.applyRecords([result.record], { replace: false })
      this._endBuild()
      this._loadVehicle()
      wx.showToast?.({ title: '建造成功', icon: 'success' })
    } catch (error) {
      if (!current()) return
      this.setData({ buildSaving: false, buildError: error?.message || '建造失败，请重试' })
      if (error?.message?.includes('场景已切换')) sync.scheduleRetry?.(sync.generation, error)
      else sync.snapshot?.().catch(snapshotError => sync.scheduleRetry?.(sync.generation, snapshotError))
    }
  },

  cancelBuild() {
    if (!this.data.buildSaving) this._endBuild()
  },

  _endBuild() {
    if (!this._build && !this.data.buildMode) return
    this._build = null
    this._resetCanvasTouches()
    this._scene?.setBuildPreview(null)
    if (!this._closed) this.setData({ buildMode: false, buildCanConfirm: false, buildSaving: false, buildError: '' })
  },

  _resetCanvasTouches() {
    this._canvasTouchIds = null
    this._gesture = null
    this._mapGesture = null
    this._buildTap = null
  },

  _canvasTouches(event) {
    const ids = this._canvasTouchIds
    return ids?.size ? event.touches?.filter(touch => ids.has(touch.identifier))
      .sort((a, b) => a.identifier - b.identifier) : null
  },

  onTouchStart(event) {
    if (!this._shown || !this._hasLandscape) return
    this.closeMenu()
    const ids = this._canvasTouchIds ??= new Set()
    const newGesture = !ids.size
    for (const touch of event.changedTouches || []) {
      if (touch.identifier != null) ids.add(touch.identifier)
    }
    this._gesture = sample(this._canvasTouches(event))
    this._buildTap = this._build && newGesture && this._gesture?.count === 1 ? this._gesture : null
    this._mapGesture = null
  },

  onTouchMove(event) {
    const previous = this._gesture
    const current = sample(this._canvasTouches(event))
    if (!this._hasLandscape) return
    if (this._buildTap) {
      const tap = this._buildTap
      if (current?.count === 1 && current.id === tap.id && Math.hypot(current.x - tap.x, current.y - tap.y) <= BUILD_TAP_RADIUS) return
      this._buildTap = null
    }
    if (!previous || !current || previous.id !== current.id ||
        previous.count !== current.count || previous.secondId !== current.secondId) {
      this._gesture = current
      this._mapGesture = null
      return
    }
    const dx = current.x - previous.x, dy = current.y - previous.y
    const surveying = this.data.mapMode || this.data.buildMode
    if (current.count === 2 && surveying && !this._mapGesture) {
      this._mapGesture = mapGesture(previous, current)
      if (!this._mapGesture) return
    }
    this._gesture = current
    if (current.count === 1) {
      const sensitivity = this.data.cameraSensitivity / 100
      this._scene.orbit(dx * sensitivity, dy * sensitivity)
    }
    else if (surveying && this._mapGesture === 'pan') this._scene.pan(dx, dy)
    else if (current.span > 5 && previous.span > 5 && current.span !== previous.span) {
      this._scene.zoom(current.span / previous.span)
    }
  },

  onTouchEnd(event) {
    const tap = this._buildTap
    this._buildTap = null
    if (tap && !event?.touches?.length) {
      const ended = event?.changedTouches?.find(touch => touch.identifier === tap.id)
      const point = ended && touchPoint(ended)
      if (point && Math.hypot(point.x - tap.x, point.y - tap.y) <= BUILD_TAP_RADIUS) this._pickBuildPoint(point)
    }
    if (!event?.touches?.length) return this._resetCanvasTouches()
    for (const touch of event.changedTouches || []) this._canvasTouchIds?.delete(touch.identifier)
    this._gesture = sample(this._canvasTouches(event))
    this._mapGesture = null
  },

  onTouchCancel(event) { this._buildTap = null; this.onTouchEnd(event) },

  onStickStart(event) {
    if (this._stick || !this._shown || !this.data.activeCharacter || this.data.mapMode || this.data.buildMode ||
        this.data.vehiclePanelOpen || !['walking', 'driver'].includes(this.data.vehicleState) ||
        this.data.restLocked || this._pendingPlayerPosition || this._scene?.isCourtyardDoorBusy || this.data.interiorStatus === 'loading' ||
        this.data.interiorStatus === 'drawing' || this.data.elevator?.busy) return
    const touch = event.changedTouches?.[0] || event.touches?.[0]
    if (!touch) return
    this.closeMenu()
    const stick = this._stick = { id: touch.identifier, touch }
    wx.createSelectorQuery().in(this).select('#manor-stick').boundingClientRect().exec(rows => {
      if (this._stick !== stick) return
      const rect = rows?.[0]
      if (!rect || !(rect.width > 0 && rect.height > 0)) return this._stopStick()
      stick.rect = rect
      this._applyStick(stick)
    })
  },

  onStickMove(event) {
    const stick = this._stick
    if (!stick) return
    const touch = event.touches?.find(item => item.identifier === stick.id)
    if (!touch) return
    stick.touch = touch
    if (stick.rect) this._applyStick(stick)
  },

  _applyStick(stick) {
    const { touch, rect } = stick
    const x = (touch.clientX ?? touch.pageX ?? touch.x) - rect.left - rect.width / 2
    const y = (touch.clientY ?? touch.pageY ?? touch.y) - rect.top - rect.height / 2
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const radius = Math.min(rect.width, rect.height) * 0.30
    const divisor = Math.max(radius, Math.hypot(x, y))
    const inputX = x / divisor, inputY = y / divisor
    this._scene.setPlayerInput(inputX, inputY)
    const stickX = Math.round(inputX * radius)
    const stickY = Math.round(inputY * radius)
    if (!this.data.stickActive || this.data.stickX !== stickX || this.data.stickY !== stickY) {
      this.setData({ stickX, stickY, stickActive: true })
    }
  },

  onStickEnd(event) {
    if (!this._stick) return
    if (event?.changedTouches?.length && !event.changedTouches.some(touch => touch.identifier === this._stick.id)) return
    this._stopStick()
  },

  onStickCancel(event) { this.onStickEnd(event) },

  _stopStick() {
    if (!this._stick && !this.data.stickActive) return
    this._stick = null
    this._scene?.setPlayerInput(0, 0)
    if (!this._closed) {
      this.setData({ stickX: 0, stickY: 0, stickActive: false })
      this._updateMinimapPlayer()
      if (this._shown) this._savePlayerPosition(true)
    }
  },

  toggleMenu() { this.setData({ menuOpen: !this.data.menuOpen }) },
  closeMenu() { if (this.data.menuOpen) this.setData({ menuOpen: false }) },

  toggleFirstPerson() {
    if (!this._shown || !this.data.activeCharacter || this.data.mapMode || this.data.buildMode || this.data.restLocked) return
    const firstPerson = !this.data.firstPerson
    if (!this._scene?.setFirstPerson(firstPerson)) return
    this._resetCanvasTouches()
    this.setData({ firstPerson, menuOpen: false })
  },

  onCameraSensitivityChanging(event) {
    const cameraSensitivity = normalizeCameraSensitivity(Number(event.detail.value))
    if (cameraSensitivity !== this.data.cameraSensitivity) this.setData({ cameraSensitivity })
  },

  onCameraSensitivityChange(event) {
    const cameraSensitivity = normalizeCameraSensitivity(Number(event.detail.value))
    this.setData({ cameraSensitivity })
    try { wx.setStorageSync(CAMERA_SENSITIVITY_KEY, cameraSensitivity) } catch (_) {}
  },

  openMap() {
    if (!this._shown || !this._hasLandscape || this.data.mapMode || this.data.buildMode || this.data.insideVilla ||
        this.data.vehicleState !== 'walking' || this.data.vehiclePanelOpen ||
        this._pendingPlayerPosition || this._scene?.isCourtyardDoorBusy || this._interiorSession) return
    this._stopStick()
    this._resetCanvasTouches()
    this._scene.enterMapView()
    this.setData({ mapMode: true, menuOpen: false })
  },

  closeMap() {
    if (!this._hasLandscape || !this.data.mapMode) return
    this._resetCanvasTouches()
    this._scene.exitMapView()
    this.setData({ mapMode: false })
    this._updateMinimapPlayer()
  },

  focusVilla() {
    if (!this._shown || !this._hasVilla || this.data.insideVilla) return
    this.openMap()
    if (this.data.mapMode) this._scene.focusVilla()
  },

  focusVehicle() {
    if (!this._shown || !this._hasLandscape || this.data.mapMode || this.data.buildMode || this.data.insideVilla ||
        this.data.vehicleState !== 'walking' || this.data.vehiclePanelOpen ||
        this._pendingPlayerPosition || this._scene?.isCourtyardDoorBusy || this._interiorSession ||
        !this._scene?.focusVehicle?.()) return
    this._stopStick()
    this._resetCanvasTouches()
    this.setData({ mapMode: true, menuOpen: false })
  },

  focusCharacter() {
    this.closeMenu()
    if (this.data.activeCharacter) this._scene.focusCharacter(true)
  },

  goBack() {
    if (this.data.buildMode) return this.cancelBuild()
    if (this.data.mapMode) return this.closeMap()
    if (this._exitPromptOpen) return
    this._exitPromptOpen = true
    this._stopStick()
    wx.showModal({
      title: '退出 3D 庄园？',
      content: '退出后会回到宠物庄园。',
      cancelText: '继续游览',
      confirmText: '退出',
      confirmColor: '#2f6a57',
      success: ({ confirm }) => {
        if (!confirm || !this._shown || this._closed) return
        this._savePlayerPosition?.(true)
        wx.navigateBack({ fail: () => wx.redirectTo({ url: '/packagePlayground/pages/index' }) })
      },
      complete: () => { this._exitPromptOpen = false }
    })
  }
})
