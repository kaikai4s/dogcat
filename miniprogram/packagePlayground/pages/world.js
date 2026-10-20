const { ensureLogin, callFunction, chooseSelectedLocation } = require('../../utils/cloud')
const { World2D } = require('../utils/world2d')
const { SceneSync } = require('../utils/scene-sync')
const lifePage = require('../utils/life-page')

Page({
  ...lifePage,
  data: {
    petRosterOpen:false,petAlerts:[],petCareBusy:false,selectedPet:null,
    disputesOpen: false, disputes: [], isCommittee: false, committeeOwnerName: '', disputesLoading: false,
    justiceOpen: false, justiceLoading: false, accidents: [], myJailStatus: null, isHumanInjured: false,
    buildOpen: false, buildLoading: false, buildBusy: false, buildingCatalog: [], filteredBuildingCatalog: [], selectedBuilding: null, nearbyBuilding: null,
    buildCategories: [
      { key: 'all', label: '全部' },
      { key: 'public', label: '公共配套' },
      { key: 'residential', label: '居住木屋' },
      { key: 'floor', label: '地板素材' },
      { key: 'tree', label: '景观树木' }
    ],
    activeBuildCategory: 'all',
    farmEditMode:false,farmPlotId:'',plotSizes:[],farmCultivated:[],farmOpen:false,farmLoading:false,farmBusy:false,farm:null,farmBed:null,nearbyFarm:null,farmSeedAvailable:false,farmCropId:'carrot',farmSelectedBed:0,
    riding:false,rideBusy:false,nearbyRide:null,nearbyInvite:null,passengers:[],
    loading: true,
    characterType: 'boy',
    characterChanging: false,
    hasAvatar: false,
    hasCustomCharacter: false,
    driving:false,
    vehicleSelected:false,
    vehicleParked:false,
    nearbyVehicle:false,
    ownVehicleId:'',
    vehicleSpeed:2,
    vehicleSpeedSaving:false,
    vehicleOperating:false,
    residentCount: 0,
    settingsOpen: false,
    socialOpen: false,
    socialBusy: false,
    socialFriends: [],
    socialRequests: [],
    socialOutgoing: [],
    nearbyPlayer: null,
    nearbyGate: null,
    joystickMode: 'always',
    joystickHand: 'left',
    joystickOpacity: 100,
    showYardOwners: false,
    error: '',
    status: '准备庄园…',
    connectionMessage: '',
    syncSceneState: '连接中',
    syncMailState: '连接中',
    characterSelected: false,
    top: 48,
    bottom: 20,
    pets: [],
    selectedPetId: '',
    selectedPetName: '',
    petScalePercent: 100,
    showPetScale: false,
    petScaleSaving: false,
    nearbyPet: null,
    nearbyBowl: null,
    nearbyPoop: null,
    feeding: false,
    joystickX: 0,
    joystickY: 0,
    joystickActive: false,
    joystickLeft: 0,
    joystickTop: 0,
    joystickRunning: false,
    hasCommunity: false,
    communityName: '',
    hasPlot: false,
    visiting: false,
    hasHomeElsewhere: false,
    canRelocate: false,
    placing: false,
    isPlacingNewPlot: false,
    gateDirection: 'south',
    gateDirectionText: '南门',
    selectedPlotSize: 48,
    menuCollapsed: true,
    statusMessage: '',
    messageHistory: [],
    historyModalOpen: false,
    canConfirm: false,
    claiming: false,
    worldSize: '',
    activeService: null,
    hasServiceDiary: false,
    serviceDiaryOpen: false,
    serviceDiaryLoading: false,
    serviceDiary: null,
    mallSuppliesOpen: false,
    mallSuppliesLoading: false,
    mallSupplies: [],
    groupBuyTab: 'sanitation',
    communityGroupBuy: null,
    communityGroupBuyLoading: false,
    rewardsOpen: false,
    rewardsLoading: false,
    rewardsData: null,
    exchangingCouponId: ''
  },
  onLoad() {
    try {
      const saved=wx.getStorageSync('playground-controls') || {}
      this.setData({joystickMode:saved.joystickMode==='hold'?'hold':'always',
        joystickHand:saved.joystickHand==='right'?'right':'left',
        joystickOpacity:Number.isFinite(saved.joystickOpacity)?Math.max(10,Math.min(100,saved.joystickOpacity)):100,
        showYardOwners:saved.showYardOwners===true})
      const zoom=wx.getStorageSync('playground-zoom')
      if(typeof zoom==='number' && Number.isFinite(zoom) && zoom>=.001 && zoom<=2.5) this.sceneZoom=zoom
    } catch(error) {}
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    const menu = wx.getMenuButtonBoundingClientRect()
    this.setData({
      top: menu.bottom + 12,
      bottom: Math.max(
        16,
        info.screenHeight -
          (info.safeArea ? info.safeArea.bottom : info.screenHeight) +
          12
      )
    })
    this.windowHeight=info.windowHeight || info.screenHeight
    this.windowWidth=info.windowWidth || info.screenWidth || 375
    this.joystickInsetLeft=Math.max(20,(info.safeArea&&info.safeArea.left||0)+12)
    this.joystickInsetRight=Math.max(20,this.windowWidth-(info.safeArea&&info.safeArea.right||this.windowWidth)+12)
    this.positionJoystick()
  },
  onShow() {
    this.visible = true
    const version = this.world && !this.world.destroyed && this.world.paused
      ? this.version : (this.version = (this.version || 0) + 1)
    ensureLogin({ content: '登录后进入全屏庄园。' })
      .then(() => {
        if (this.visible && version === this.version && this.world && !this.world.destroyed && this.world.paused) {
          this.authorized=true
          this.world.resume()
          if(this.world.sceneSync) this.world.sceneSync.start()
          this.loadServiceTwin(false)
          this.checkInitialJailStatus()
        } else if (this.visible && version === this.version && this.ready)
          this.initialize()
        else if (version === this.version) this.authorized = true
      })
      .catch((error) => {
        if (this.visible && version === this.version)
          this.setData({ loading: false, error: error.message || '请先登录' })
      })
  },
  onReady() {
    this.ready = true
    if (this.visible && this.authorized) this.initialize()
  },
  onHide() {
    this.clearPetSelection()
    this.joystickEnd()
    if (this.jailTimer) clearInterval(this.jailTimer)
    if (this.statusFadeTimer) clearTimeout(this.statusFadeTimer)
    if (this.humanInjuredTimer) clearTimeout(this.humanInjuredTimer)
    this.visible=false
    if(this.world && !this.data.loading) {
      this.world.pause()
      if(this.world.sceneSync) this.world.sceneSync.stop().catch(()=>{})
    } else this.stop()
  },
  onUnload() {
    this.stop()
  },
  stop() {
    this.joystickEnd()
    if (this.jailTimer) clearInterval(this.jailTimer)
    if (this.statusFadeTimer) clearTimeout(this.statusFadeTimer)
    if (this.humanInjuredTimer) clearTimeout(this.humanInjuredTimer)
    this.visible = false
    this.authorized = false
    this.version = (this.version || 0) + 1
    if(this.world && this.world.sceneSync) this.world.sceneSync.stop().catch(()=>{})
    if (this.world) this.world.destroy()
    this.world = null
  },
  initialize() {
    if (this.statusFadeTimer) clearTimeout(this.statusFadeTimer)
    this.pendingFarm=null;this.farmSnapshot=null;this.farmRequest=null;this.farmAttempt=0
    if(this.world && this.world.manualZoom) this.sceneZoom=this.world.zoom
    this.joystickEnd()
    if(this.world && this.world.sceneSync) this.world.sceneSync.stop().catch(()=>{})
    if (this.world) this.world.destroy()
    let instance = null
    const version = (this.version = (this.version || 0) + 1)
    this.setData(
      {
        loading: true,
        characterChanging: false,
        hasCustomCharacter: false,
        driving:false,vehicleSelected:false,vehicleParked:false,nearbyVehicle:false,ownVehicleId:'',vehicleOperating:false,
        riding:false,rideBusy:false,nearbyRide:null,nearbyInvite:null,passengers:[],petAlerts:[],selectedPet:null,petCareBusy:false,petRosterOpen:false,
        farmEditMode:false,farmPlotId:'',plotSizes:[],farmCultivated:[],farmOpen:false,farmLoading:false,farmBusy:false,farm:null,nearbyFarm:null,
        claiming: false,
        error: '',
        status: '读取宠物档案…',
        connectionMessage: '',
        characterSelected: false,
        syncSceneState: '连接中',
        syncMailState: '连接中',
        pets: [],
        petScaleSaving: false,
        selectedPetId: '',
        selectedPetName: '',
        residentCount: 0,
        showPetScale: false,
        settingsOpen: false,
        socialOpen: false,
        nearbyPlayer: null,
        nearbyGate: null,
        nearbyPet: null,
        nearbyBowl: null,
        feeding: false
      },
      () => {
        if (!this.visible || version !== this.version) return
        callFunction('playground', 'enterScene', {community:this.selectedCommunity})
          .then((overview) => {
            if (!this.visible || version !== this.version) return
            this.setData({
              activeService: overview.activeService || null,
              hasCommunity: Boolean(overview.hasCommunity),
              communityName:
                (overview.userCommunity && overview.userCommunity.name) || '',
              hasPlot: Boolean(overview.plot),
              hasAvatar: Boolean(overview.scene && overview.scene.hasAvatar),
              vehicleSpeed:overview.scene&&overview.scene.vehicleSpeed||2,
              visiting: Boolean(overview.scene && overview.scene.visiting),
              hasHomeElsewhere: Boolean(overview.scene && overview.scene.hasHomeElsewhere),
              characterType: overview.scene ? overview.scene.characterType : this.data.characterType,
              canRelocate: overview.world.canRelocate === true,
              plotSizes:overview.world.plotSizes || [],
              placing: false,
              canConfirm: false,
              worldSize: `${overview.world.width} × ${overview.world.height} 米`
            })
            this.loadServiceTwin(false)
            const world = new World2D(
              this,
              (status) => {
                if (version === this.version && this.visible)
                  this.pushStatusMessage(status)
              },
              overview,
              (pets) => {
                if (version !== this.version || !this.visible) return
                const selected = pets.find((pet) => pet.selected)
                this.setData({
                  pets,
                  selectedPetId: selected ? selected.id : '',
                  selectedPetName: selected ? selected.name : '',
                  selectedPet:selected||null,
                  petScalePercent: selected ? Math.round(selected.modelScale * 100) : 100
                })
                if(!selected) this.setData({showPetScale:false})
                this.positionJoystick()
              }
            )
            this.world = world
            instance = world
            return world.init().then(async()=>{
              if(!world.destroyed && overview.scene) {
                world.sceneSync=new SceneSync(world,overview.scene,(error)=>{
                  if(this.world===world && this.visible) {
                    if((error.message||'').includes('场景已切换')) {
                      this.joystickEnd()
                      world.sceneSync.stop().catch(()=>{})
                      this.setData({error:'此账号已在其他设备进入场景，请点击重新加载',loading:false})
                    } else this.setData({status:(error.message||'').includes('实时连接')?error.message:'同步暂时中断，正在重试…'})
                  }
                },(connection)=>{
                  if(this.world===world && this.visible) this.setData({
                    connectionMessage:connection.message,
                    syncSceneState:connection.scene,syncMailState:connection.mail
                  })
                })
                await world.sceneSync.snapshot()
                if(this.world===world && this.visible) world.sceneSync.start()
              }
            })
          })
          .then(() => {
            if (version === this.version && this.visible) {
              this.setData({ loading: false })
              this.positionJoystick()
              this.checkInitialJailStatus()
              if(this.placeAfterLoad) {this.placeAfterLoad=false;this.world.beginPlacement()}
            }
            else if (instance) instance.destroy()
          })
          .catch((error) => {
            if (instance) instance.destroy()
            if (version === this.version && this.visible)
              this.setData({
                loading: false,
                error: error.message || error.errMsg || '场景加载失败'
              })
          })
      }
    )
  },
  fetchRegion(chunkX, chunkZ) {
    return callFunction('playground', 'getRegion', { chunkX, chunkZ, community:this.selectedCommunity })
  },
  async switchCharacter() {
    this.clearPetSelection()
    const world = this.world
    if (!world || this.data.characterChanging) return
    this.joystickEnd()
    const type = this.data.characterType === 'girl' ? 'boy' : 'girl'
    this.setData({ characterChanging: true })
    try {
      if (await world.setCharacterType(type)) {
        if (this.world === world) this.setData({ characterType: type })
      }
    } catch (error) {
      if (this.world === world) wx.showToast({ title: '角色素材加载失败，请重试', icon: 'none' })
    } finally {
      if (this.world === world) this.setData({ characterChanging: false })
    }
  },
  fetchMapOverview(cursor) {
    return callFunction('playground', 'getMapOverview', { cursor, community:this.selectedCommunity })
  },
  fullOverview() {
    this.joystickEnd()
    if (this.world) this.world.fullOverview()
  },
  pushStatusMessage(msg) {
    if (!msg) return
    const text = String(msg).trim()
    if (!text) return
    const d = new Date()
    const time = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
    const history = (this.data.messageHistory || []).slice(-49)
    history.push({ time, text })
    this.setData({
      status: text,
      statusMessage: text,
      messageHistory: history
    })
    if (this.statusFadeTimer) clearTimeout(this.statusFadeTimer)
    this.statusFadeTimer = setTimeout(() => {
      this.setData({ statusMessage: '' })
    }, 5000)
  },
  toggleMenuCollapse() {
    this.joystickEnd()
    this.clearPetSelection()
    this.setData({ menuCollapsed: !this.data.menuCollapsed })
  },
  openHistoryModal() {
    this.setData({ historyModalOpen: true })
  },
  closeHistoryModal() {
    this.setData({ historyModalOpen: false })
  },
  clearHistoryMessages() {
    this.setData({ messageHistory: [] })
    wx.showToast({ title: '历史消息已清空', icon: 'none' })
  },
  selectPlotSize(e) {
    const size = Number(e.currentTarget.dataset.size) || 48
    const option=(this.data.plotSizes||[]).find((p)=>p.size===size)
    if(this.data.isPlacingNewPlot&&(!option||!option.unlocked))return wx.showToast({title:option&&option.unlockText||'该规格未解锁',icon:'none'})
    this.setData({ selectedPlotSize: size })
    if (this.world) {
      this.world.setPlotSize(size)
    }
    this.pushStatusMessage(`已选择 ${size}×${size} 米绿地规格，指示框已同步`)
  },
  choosePlot(isNewPlot = false) {
    isNewPlot=isNewPlot===true
    this.joystickEnd()
    if(this.data.hasHomeElsewhere) return
    if(!this.data.hasCommunity) return this.chooseCommunityAndBuild()
    if(this.data.visiting) return this.settleCommunity(true)
    const dir = this.data.gateDirection || 'south'
    const options=(this.data.plotSizes||[]).filter((p)=>p.unlocked)
    if(isNewPlot&&!options.length)return wx.showToast({title:'当前会员尚未解锁新地皮',icon:'none'})
    const size = isNewPlot ? (options.find((p)=>p.size===this.data.selectedPlotSize)||options[0]).size : (this.world && this.world.ownPlot && this.world.ownPlot.size) || this.data.selectedPlotSize || 112
    this.setData({
      selectedPlotSize:size,
      isPlacingNewPlot: Boolean(isNewPlot),
      gateDirection: dir,
      gateDirectionText: dir === 'north' ? '北门' : dir === 'east' ? '东门' : dir === 'west' ? '西门' : '南门'
    })
    if (this.world) {
      this.world.setPlotSize(size)
      this.world.setGateDirection(dir)
      this.world.beginPlacement(Boolean(isNewPlot), size)
    }
  },
  async buyNewPlotAction() {
    this.clearPetSelection()
    this.joystickEnd()
    if (this.data.hasHomeElsewhere) {
      wx.showModal({ title: '提示', content: '请回到常住小区规划新地皮', showCancel: false })
      return
    }
    if (!this.data.hasPlot) {
      return this.choosePlot(false)
    }
    try {const catalog=await callFunction('playground','getBuildingCatalog');this.setData({plotSizes:catalog.plotSizes||[]})}
    catch(error){return wx.showToast({title:error.message||'无法读取会员解锁配置',icon:'none'})}
    const confirmed = await new Promise((resolve) =>
      wx.showModal({
        title: '认领专属爱心绿地',
        content: '认领一块全新的专属爱心绿地（草坪及四周生态木栅栏），原别墅完好保留在原地不移动。可按会员等级选择多种规格，是否立即前往选址？',
        confirmText: '去选址',
        cancelText: '取消',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false)
      })
    )
    if (!confirmed) return
    this.choosePlot(true)
  },
  cycleGateDirection() {
    const dirs = [
      { key: 'south', text: '南门' },
      { key: 'east', text: '东门' },
      { key: 'north', text: '北门' },
      { key: 'west', text: '西门' }
    ]
    const current = this.data.gateDirection || 'south'
    const idx = dirs.findIndex((d) => d.key === current)
    const next = dirs[(idx + 1) % dirs.length]
    this.setData({
      gateDirection: next.key,
      gateDirectionText: next.text
    })
    if (this.world) {
      this.world.setGateDirection(next.key)
    }
    this.pushStatusMessage(`栅栏门口已设为：${next.text}`)
  },
  cancelPlot() {
    this.pendingBuilding = null
    this.targetPlotForBuilding = null
    this.setData({ isPlacingNewPlot: false })
    if (this.world) this.world.cancelPlacement()
  },
  async confirmPlot() {
    const world = this.world
    if (!world || !world.candidate || this.data.claiming) return
    const candidate = { ...world.candidate }
    const building = this.pendingBuilding || null
    const isNewPlot = Boolean(this.data.isPlacingNewPlot)
    const gateDirMap = { south: '南门', north: '北门', east: '东门', west: '西门' }
    const currentGateDir = candidate.gateDirection || this.data.gateDirection || 'south'
    const gateText = gateDirMap[currentGateDir] || '南门'

    const plotSize = Number(candidate.size) || this.data.selectedPlotSize || 48

    // 情况 A：在已购买的地皮内部建造房子建筑
    if (building) {
      const targetPlot = this.targetPlotForBuilding || world.ownPlot
      if (!targetPlot) {
        wx.showModal({ title: '提示', content: '公共设施只能选在您已认领的爱心绿地内部建造，请点击自家庭院草坪！', showCancel: false })
        return
      }
      const confirmed = await new Promise((resolve) =>
        wx.showModal({
          title: `确认建造【${building.name}】`,
          content: `将在您的【${targetPlot.name || '自家庭院'}】内部建造该建筑房屋（不含额外地皮）。\n当前会员已解锁，无需支付代币。`,
          confirmText: '确认建造',
          success: (r) => resolve(r.confirm),
          fail: () => resolve(false)
        })
      )
      if (!confirmed || this.world !== world || world.destroyed) return

      this.setData({ claiming: true })
      try {
        const result = await callFunction('playground', 'buildInYard', {
          plotId: targetPlot.id || targetPlot._id,
          buildingId: building.id || '',
          buildingType: building.type || 'residential',
          buildingName: building.name || '',
          buildingImage: building.image || '',
          buildingWidth: building.width || 7,
          buildingDepth: building.depth || 7,
          sceneId: world.scene && world.scene.sceneId
        })
        this.pendingBuilding = null
        this.targetPlotForBuilding = null
        this.setData({ isPlacingNewPlot: false })
        if (this.world === world && !world.destroyed) {
          if (world.scene) this.initialize()
          else {
            world.cancelPlacement()
            this.pushStatusMessage(`【${building.name}】已成功落座于地皮内！`)
          }
        }
        wx.showToast({ title: '建筑落座成功！', icon: 'success' })
      } catch (e) {
        const message = e.message || e.errMsg || '建造失败'
        wx.showModal({ title: '建造失败', content: message, showCancel: false })
      } finally {
        if (this.world === world) this.setData({ claiming: false })
      }
      return
    }

    // 情况 B：认领纯绿地（草坪 + 四周生态木栅栏）
    const confirmed = await new Promise((resolve) =>
      wx.showModal({
        title: isNewPlot ? '确认认领专属爱心绿地' : this.data.hasPlot ? '调整庭院位置' : '安置庭院',
        content: isNewPlot
          ? `绿地规格 ${plotSize}×${plotSize} 米，四周用生态木栅栏围护，栅栏大门朝向【${gateText}】。\n当前会员已解锁此规格，无需支付代币。\n原别墅完整保留在原地不移动。`
          : `庭院范围 ${plotSize}×${plotSize} 米并由栅栏围护，大门朝向【${gateText}】。${this.data.hasPlot ? '保存后原位置会腾空。' : ''}${this.data.canRelocate ? '目前临时开放重新选址。' : '确认后不能搬迁。'}`,
        confirmText: isNewPlot ? '确认认领' : '确认位置',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false)
      })
    )
    if (!confirmed || this.world !== world || world.destroyed) return
    this.setData({ claiming: true })
    try {
      const result = await callFunction('playground', 'claimPlot', {
        cellX: candidate.cellX,
        cellZ: candidate.cellZ,
        x: candidate.x,
        z: candidate.z,
        size: plotSize,
        gateDirection: currentGateDir,
        isNewPlot: isNewPlot,
        buildingType: isNewPlot ? 'yard' : 'residential',
        buildingName: isNewPlot ? '专属爱心绿地' : '',
        sceneId: world.scene && world.scene.sceneId
      })
      this.pendingBuilding = null
      this.targetPlotForBuilding = null
      this.setData({ isPlacingNewPlot: false })
      if (this.world === world && !world.destroyed) {
        if (!isNewPlot) {
          if (world.scene) this.initialize()
          else world.setPlot(result.plot)
        } else {
          world.addNewPlot(result.plot)
          this.setData({ hasPlot: true })
          if (world.sceneSync && world.sceneSync.snapshot) {
            world.sceneSync.snapshot().catch(() => {})
          }
        }
      }
      wx.showToast({ title: isNewPlot ? '专属绿地认领成功！' : '位置已保存！', icon: 'success' })
    } catch (e) {
      if (this.world === world && !world.destroyed) {
        world.chunks.delete(
          world.chunkKey(
            Math.floor(candidate.cellX / 2),
            Math.floor(candidate.cellZ / 2)
          )
        )
        world.candidate = null
        this.setData({ canConfirm: false })
        const message = e.message || e.errMsg || '选址失败，请重新选择'
        const code = e.code || e.errCode
        wx.showModal({
          title: isNewPlot ? '专属绿地认领失败' : '庭院位置保存失败',
          content:
            message +
            (code && !message.includes(String(code))
              ? `\n错误码：${code}`
              : ''),
          showCancel: false
        })
      }
    } finally {
      if (this.world === world) this.setData({ claiming: false })
    }
  },
  communityActions() {
    this.clearPetSelection()
    this.joystickEnd()
    const actions=[{title:this.data.hasAvatar?'访问其他小区':'重新选择小区并建造',run:()=>this.data.hasAvatar?this.visitCommunity():this.chooseCommunityAndBuild()},
      {title:'回到常住小区',run:()=>{this.selectedCommunity=null;this.initialize()}}]
    if(this.data.visiting) actions.push({title:'迁入当前小区',run:()=>this.settleCommunity()})
    if(this.data.hasPlot) actions.push({title:'拆除我的庭院',run:()=>this.demolishPlot()})
    wx.showActionSheet({itemList:actions.map((a)=>a.title),success:(r)=>actions[r.tapIndex].run()})
  },
  async visitCommunity() {
    try {
      const location=await chooseSelectedLocation()
      if(!location || !location.name) return
      this.selectedCommunity={name:location.name,address:location.address||'',latitude:location.latitude||0,longitude:location.longitude||0}
      this.initialize()
    } catch(error) {
      if(!(error.errMsg||'').includes('cancel')) wx.showToast({title:error.message||'选择小区失败',icon:'none'})
    }
  },
  async chooseCommunityAndBuild() {
    this.clearPetSelection()
    this.joystickEnd()
    try {
      const location=await chooseSelectedLocation()
      if(!location || !location.name) return
      const community={name:location.name,address:location.address||'',latitude:location.latitude||0,longitude:location.longitude||0}
      await callFunction('playground','saveCommunity',{community})
      this.selectedCommunity=null
      this.placeAfterLoad=true
      this.initialize()
    } catch(error) {
      if(!(error.errMsg||'').includes('cancel')) wx.showToast({title:error.message||'选择小区失败',icon:'none'})
    }
  },
  async settleCommunity(autoPlace=false) {
    if(this.data.hasHomeElsewhere) {
      wx.showModal({title:'请先拆除原庭院',content:'请先回到常住小区，拆除自己的庭院，再迁入当前小区。访问不会影响原庭院。',showCancel:false})
      return
    }
    const confirmed=await new Promise((resolve)=>wx.showModal({title:'迁入当前小区',content:`将常住小区更新为“${this.data.communityName}”，随后可选择空地新建庭院。`,success:(r)=>resolve(r.confirm),fail:()=>resolve(false)}))
    if(!confirmed) return
    try {await callFunction('playground','saveCommunity',{community:this.selectedCommunity});this.selectedCommunity=null;this.placeAfterLoad=autoPlace===true;this.initialize()}
    catch(error) {wx.showToast({title:error.message||'迁入失败',icon:'none'})}
  },
  async demolishPlot() {
    const world=this.world
    if(!world || !world.ownPlot) return
    this.joystickEnd()
    const confirmed=await new Promise((resolve)=>wx.showModal({title:'拆除我的庭院',content:'原位置将腾空，庭院布置与碗中粮食将清除，角色和宠物将退出场景，宠物档案保留。之后可直接重新选择小区建造庭院。',confirmText:'确认拆除',success:(r)=>resolve(r.confirm),fail:()=>resolve(false)}))
    if(!confirmed || this.world!==world) return
    try {
      if(world.sceneSync) await world.sceneSync.stop().catch(()=>{})
      await callFunction('playground','demolishPlot',{plotId:world.ownPlot.id,sceneId:world.scene&&world.scene.sceneId})
      if(this.world===world){this.selectedCommunity=null;this.initialize()}
    } catch(error) {
      if(this.world===world && this.visible && world.sceneSync) world.sceneSync.start()
      wx.showToast({title:error.message||'拆除失败',icon:'none'})
    }
  },
  onResize() {
    this.joystickEnd()
    if (!this.world) return
    this.createSelectorQuery()
      .select('#worldCanvas')
      .boundingClientRect((rect) => {
        if (rect && this.world) {
          this.windowHeight=rect.height
          this.windowWidth=rect.width
          const info=wx.getWindowInfo?wx.getWindowInfo():{}
          this.joystickInsetLeft=Math.max(20,(info.safeArea&&info.safeArea.left||0)+12)
          this.joystickInsetRight=Math.max(20,rect.width-(info.safeArea&&info.safeArea.right||rect.width)+12)
          this.positionJoystick()
          this.world.canvasRect = { left: rect.left, top: rect.top }
          this.world.resize(rect.width, rect.height)
        }
      })
      .exec()
  },
  touchStart(e) {
    if (!this.world) return
    const touches = e.touches || []
    if (touches.length > 1) {
      this.joystickEnd()
      this.suppressTouchTap = true
      this.world.touchStart(touches)
      return
    }
    this.suppressTouchTap = false
    this.world.touchStart(touches)
    if(this.data.joystickMode!=='hold' || !this.world.character || this.data.settingsOpen || this.data.socialOpen || this.data.farmOpen || this.data.riding) return
    const touch = touches[0]
    if (!touch || this.data.loading || this.data.error || this.data.placing || this.data.feeding || this.data.characterChanging) return
    this.joystickEnd()
    this.suppressTouchTap = false
    const center = this.touchCoordinates(touch)
    if (!center) return
    this.joystickTouch = touch.identifier
    this.joystickCenter = center
    const token = this.joystickToken
    const world = this.world
    this.joystickTimer = setTimeout(() => {
      if (token !== this.joystickToken || this.world !== world || world.destroyed ||
          this.data.loading || this.data.error || this.data.placing || this.data.feeding || this.data.characterChanging) return
      this.joystickTimer = null
      this.joystickHeld = true
      this.clearPetSelection()
      this.suppressTouchTap = true
      world.gesture = null
      world.focusCharacter()
      world.setCharacterInput(0, 0)
      this.setData({ joystickActive: true, joystickLeft: center.x - 72,
        joystickTop: center.y - 72, joystickRunning: false })
    }, 1000)
  },
  touchCoordinates(touch) {
    const rect = this.world && this.world.canvasRect || { left: 0, top: 0 }
    // Native Canvas touches may contain only canvas-local x/y.
    const x = Number.isFinite(touch.clientX) ? touch.clientX
      : Number.isFinite(touch.pageX) ? touch.pageX : touch.x + rect.left
    const y = Number.isFinite(touch.clientY) ? touch.clientY
      : Number.isFinite(touch.pageY) ? touch.pageY : touch.y + rect.top
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
  },
  touchMove(e) {
    if (!this.world) return
    const touches = e.touches || []
    if (touches.length > 1) {
      if (this.joystickHeld || this.joystickTimer != null) {
        this.joystickEnd()
        this.world.touchStart(touches)
      }
      this.suppressTouchTap = true
      this.world.touchMove(touches)
      return
    }
    const touch = touches.find(t => t.identifier === this.joystickTouch)
    if (this.joystickHeld) {
      if (touch) this.updateJoystick(touch)
      return
    }
    if (touch && this.joystickCenter) {
      const point = this.touchCoordinates(touch)
      if (point && Math.hypot(point.x - this.joystickCenter.x, point.y - this.joystickCenter.y) > 6)
        this.joystickEnd()
    }
    this.world.touchMove(touches)
  },
  touchEnd(e) {
    if (!this.world) return
    const touches = e.touches || []
    const suppressed = this.suppressTouchTap || this.joystickHeld
    this.joystickEnd()
    if (touches.length) {
      this.suppressTouchTap = true
      this.world.touchStart(touches)
      if (this.world.gesture) this.world.gesture.moved = true
    } else {
      if (suppressed) this.world.gesture = null
      else this.world.touchEnd(e.changedTouches)
      this.suppressTouchTap = false
    }
  },
  touchCancel() {
    this.joystickEnd()
    this.suppressTouchTap = false
    if (this.world) this.world.gesture = null
  },
  focusCharacter() {
    this.joystickEnd()
    if (this.world) this.world.focusCharacter()
  },
  updateJoystick(touch) {
    if (!this.world || !this.joystickCenter || !touch) return
    const point = this.touchCoordinates(touch)
    if (!point) return
    const dx = point.x - this.joystickCenter.x, dy = point.y - this.joystickCenter.y
    const length = Math.hypot(dx, dy)
    const ratio = length > 48 ? 48 / length : 1
    const joystickX = dx * ratio, joystickY = dy * ratio
    this.world.setCharacterInput(joystickX / 48, joystickY / 48)
    this.setData({ joystickX: Math.round(joystickX), joystickY: Math.round(joystickY),
      joystickRunning: Boolean(this.world.character && this.world.character.runRequested) })
  },
  joystickEnd() {
    const wasHeld=this.joystickHeld
    if (this.joystickTimer != null) clearTimeout(this.joystickTimer)
    this.joystickTimer = null
    this.joystickToken = (this.joystickToken || 0) + 1
    // A UI action during a hold must not turn the eventual release into a pet command.
    if (this.joystickHeld) this.suppressTouchTap = true
    this.joystickHeld = false
    this.joystickTouch = null
    this.joystickCenter = null
    if (this.world && (wasHeld || this.world.character && this.world.character.input && !this.world.characterRoute &&
        (this.world.character.input.x || this.world.character.input.y))) this.world.setCharacterInput(0, 0)
    this.setData({ joystickX: 0, joystickY: 0, joystickActive: false, joystickRunning: false })
    this.positionJoystick()
  },
  positionJoystick() {
    const left=this.joystickInsetLeft||20,right=this.joystickInsetRight||20
    if(this.data.joystickMode==='always' && !this.joystickHeld) this.setData({
      joystickLeft:this.data.joystickHand==='right'?Math.max(left,(this.windowWidth||375)-right-144):left,
      joystickTop:Math.max(this.data.top+80,(this.windowHeight||667)-this.data.bottom-330-(this.data.selectedPetId?110:0))})
  },
  fixedJoystickStart(e) {
    if(!this.world || !this.world.character || this.data.loading || this.data.placing) return
    this.joystickEnd()
    const touches=e.touches||[]
    if(touches.length!==1) return
    this.joystickTouch=touches[0].identifier
    this.joystickCenter={x:this.data.joystickLeft+72,y:this.data.joystickTop+72}
    this.joystickHeld=true
    this.clearPetSelection()
    this.world.gesture=null
    this.world.focusCharacter()
    this.setData({joystickActive:true})
    this.updateJoystick(touches[0])
  },
  fixedJoystickMove(e) {
    if((e.touches||[]).length!==1) return this.joystickEnd()
    if(this.joystickHeld) this.updateJoystick(e.touches.find((t)=>t.identifier===this.joystickTouch))
  },
  fixedJoystickEnd() { this.joystickEnd() },
  clearPetSelection() {
    if(this.world && this.world.clearPetSelection) this.world.clearPetSelection()
  },
  openSettings() {
    this.joystickEnd()
    this.clearPetSelection()
    this.setData({settingsOpen:true})
  },
  closeSettings() { this.setData({settingsOpen:false}) },
  async operateVehicle(e) {
    const world=this.world,operation=e.currentTarget.dataset.operation
    if(!world||!world.sceneSync||this.data.vehicleOperating)return
    const car=world.ownVehicle()
    if(!car)return
    this.joystickEnd()
    this.setData({vehicleOperating:true})
    try {
      await world.sceneSync.vehicleAction(operation,car.id)
      const messages={start:'车辆已停在院门外，走近即可上车',enter:'已上车 · 摇杆驾驶，或点击车辆后点地移动',exit:'已下车 · 靠近车辆可再次上车或入库',garage:'车辆已返回庭院车位'}
      if(this.world===world)world.onStatus(messages[operation])
    } catch(error) {wx.showToast({title:error.message||'车辆操作失败',icon:'none'})}
    finally {if(this.world===world)this.setData({vehicleOperating:false})}
  },
  async cleanVehicleAction() {
    const world=this.world,car=world&&world.ownVehicle()
    if(!world||!world.sceneSync||!car||this.data.washingVehicle)return
    this.joystickEnd();this.setData({washingVehicle:true})
    try {
      await world.sceneSync.send(true)
      const result=await callFunction('playground','washVehicle',{...world.sceneSync.credentials(),vehicleId:car.id})
      if(this.world===world&&!world.destroyed){world.cleanVehicle(car);world.onStatus(result.message)}
    }catch(error){wx.showToast({title:error.message||'洗车失败',icon:'none'})}
    finally{if(this.world===world)this.setData({washingVehicle:false})}
  },
  previewVehicleSpeed(e) {this.setData({vehicleSpeed:Number(e.detail.value)/10})},
  async changeVehicleSpeed(e) {
    const world=this.world,value=Number(e.detail.value)/10
    if(!world||!world.sceneSync||this.data.vehicleSpeedSaving)return
    const previous=world.vehicleSpeed
    this.setData({vehicleSpeed:value,vehicleSpeedSaving:true})
    try {await world.sceneSync.setVehicleSpeed(value)}
    catch(error){this.setData({vehicleSpeed:previous});wx.showToast({title:error.message||'车速保存失败',icon:'none'})}
    finally{if(this.world===world)this.setData({vehicleSpeedSaving:false})}
  },
  customizeAppearance() {
    this.joystickEnd()
    this.clearPetSelection()
    this.setData({settingsOpen:false})
    wx.navigateTo({url:'/packagePlayground/pages/customize'})
  },
  async openSocial() {
    this.joystickEnd();this.clearPetSelection()
    this.setData({settingsOpen:false,socialOpen:true})
    if(this.world&&this.world.sceneSync) {
      try {await this.world.sceneSync.social('getSocial')}
      catch(error){wx.showToast({title:error.message||'读取申请失败',icon:'none'})}
    }
  },
  closeSocial() {this.setData({socialOpen:false})},
  async socialAction(action,data) {
    const world=this.world
    if(!world || !world.sceneSync || this.data.socialBusy)return
    this.joystickEnd();this.clearPetSelection();this.setData({socialBusy:true})
    try {await world.sceneSync.social(action,data);wx.showToast({title:action==='respondRequest'?'申请已处理':action==='removeFriend'?'已解除好友':'申请已发送',icon:'none'})}
    catch(error){wx.showToast({title:error.message||'操作失败，请重试',icon:'none'})}
    finally {if(this.world===world)this.setData({socialBusy:false})}
  },
  async requestFriend() {
    const player=this.data.nearbyPlayer
    if(!player||player.friend)return
    const yes=await new Promise((resolve)=>wx.showModal({title:'添加好友',content:`向“${player.name}”发送好友申请？成为好友后可互相进入庭院。`,success:(r)=>resolve(r.confirm),fail:()=>resolve(false)}))
    if(yes)return this.socialAction('requestFriend',{playerId:player.id})
  },
  async requestVisit() {
    const gate=this.data.nearbyGate
    if(!gate)return
    const yes=await new Promise((resolve)=>wx.showModal({title:'申请访问庭院',content:`是否申请访问“${gate.name}”的庭院？主人同意后可访问至今天24点（北京时间）。`,success:(r)=>resolve(r.confirm),fail:()=>resolve(false)}))
    if(yes)return this.socialAction('requestVisit',{playerId:gate.playerId,plotId:gate.plotId})
  },
  respondRequest(e) {return this.socialAction('respondRequest',{requestId:e.currentTarget.dataset.id,accept:e.currentTarget.dataset.accept===true || e.currentTarget.dataset.accept==='true'})},
  async removeFriend(e) {
    const id=e.currentTarget.dataset.id
    const yes=await new Promise((resolve)=>wx.showModal({title:'解除好友',content:'解除后将取消双方互访权限，需重新申请访问庭院。',success:(r)=>resolve(r.confirm),fail:()=>resolve(false)}))
    if(yes)return this.socialAction('removeFriend',{playerId:id})
  },
  swallowTouch() {},
  saveSettings() {
    try {wx.setStorageSync('playground-controls',{joystickMode:this.data.joystickMode,
      joystickHand:this.data.joystickHand,
      joystickOpacity:this.data.joystickOpacity,showYardOwners:this.data.showYardOwners})} catch(error) {}
  },
  changeJoystickMode(e) {
    this.joystickEnd()
    this.setData({joystickMode:e.detail.value?'hold':'always'})
    this.positionJoystick()
    this.saveSettings()
  },
  changeJoystickOpacity(e) {
    this.setData({joystickOpacity:Math.max(10,Math.min(100,Number(e.detail.value)||100))})
    this.saveSettings()
  },
  changeJoystickHand(e) {
    this.joystickEnd()
    this.clearPetSelection()
    this.setData({joystickHand:e.currentTarget.dataset.hand==='right'?'right':'left'})
    this.positionJoystick()
    this.saveSettings()
  },
  changeYardOwners(e) {
    this.setData({showYardOwners:e.detail.value===true})
    this.saveSettings()
  },
  rememberZoom(zoom) {
    this.sceneZoom=zoom
    try {wx.setStorageSync('playground-zoom',zoom)} catch(error) {}
  },
  async interactPet() {
    const pet = this.data.nearbyPet
    if (!this.world || !pet) return
    this.joystickEnd()
    const world=this.world
    if(world.sceneSync) {
      try {await world.sceneSync.interactPet(pet.id)}
      catch(error) {if(this.world===world)wx.showToast({title:error.message||'互动失败，请重试',icon:'none'});return}
      if(this.world!==world || world.destroyed)return
    }
    if (!this.world.interactPet(pet.id))
      wx.showToast({ title: '请靠近宠物，稍等一下再互动', icon: 'none' })
  },
  async fillBowl() {
    const world = this.world
    if (!world || this.data.feeding) return
    const bowl = world.nearbyInteractions().bowl
    if (!bowl) return wx.showToast({ title: '请先走近自家猫狗碗', icon: 'none' })
    this.clearPetSelection()
    if (bowl.food >= 100) return
    this.joystickEnd()
    this.setData({ feeding: true })
    try {
      const result = await callFunction('playground', 'fillBowl', { plotId: bowl.plotId })
      if (this.world === world && !world.destroyed && world.applyBowlFood(result)) {
        const msg = result && result.pointsAwarded
          ? `食盆已添满！获得每日关爱打卡 +${result.pointsAwarded}积分`
          : (result && result.message ? result.message : '猫狗碗的粮食已添满')
        wx.showToast({ title: msg, icon: 'none' })
        this.pushStatusMessage(msg)
      }
    } catch (error) {
      if (this.world === world && !world.destroyed)
        wx.showToast({ title: error.message || '添粮失败，请重试', icon: 'none' })
    } finally {
      if (this.world === world) this.setData({ feeding: false })
    }
  },
  overview() {
    this.joystickEnd()
    if (this.world) this.world.overview()
  },
  follow() {
    this.joystickEnd()
    if (this.world) this.world.followPet()
  },
  togglePetScale() {
    this.setData({ showPetScale: !this.data.showPetScale })
  },
  previewPetScale(e) {
    if (this.data.petScaleSaving || !this.world) return
    this.world.setPetScale(this.data.selectedPetId, Number(e.detail.value) / 100)
  },
  async savePetScale(e) {
    const world = this.world
    const pet = world && world.selectedPet()
    if (!pet || this.data.petScaleSaving) return
    const scale = Number(e.detail.value) / 100
    if (!Number.isFinite(scale)) return
    const previous = pet.savedModelScale
    world.setPetScale(pet.id, scale)
    this.setData({ petScaleSaving: true })
    try {
      const result = await callFunction('playground', 'setPetScale', { petId: pet.id, scale })
      if (this.world === world && !world.destroyed)
        world.setPetScale(pet.id, result.scale, true)
    } catch (error) {
      if (this.world === world && !world.destroyed) {
        world.setPetScale(pet.id, previous)
        wx.showToast({ title: error.message || '大小保存失败，请重试', icon: 'none' })
      }
    } finally {
      if (this.world === world) this.setData({ petScaleSaving: false })
    }
  },
  resetPetScale() {
    return this.savePetScale({ detail: { value: 100 } })
  },
  activity(e) {
    if (this.world && !this.world.request(e.currentTarget.dataset.action))
      wx.showToast({ title: '暂时无法到达，请稍后再试', icon: 'none' })
  },
  back() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.redirectTo({ url: '/packagePlayground/pages/index' })
  },
  async reportPoopAction() {
    const world = this.world
    if (!world || !this.data.nearbyPoop) return
    const poop = this.data.nearbyPoop
    const confirmed = await new Promise((resolve) =>
      wx.showModal({
        title: '向居委会反馈便便',
        content: '发现未清理的便便，是否向社区居委会提交保洁提醒？有效反馈可获得会员积分，同一份便便只奖励一次。',
        confirmText: '立即反馈',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false)
      })
    )
    if (!confirmed) return
    try {
      await world.sceneSync.send(true)
      const result = await callFunction('playground', 'reportPoop', {
        ...world.sceneSync.credentials(),
        poopId: poop.id,
        x: poop.x,
        z: poop.z,
        sceneId: world.scene && world.scene.sceneId
      })
      wx.showToast({ title: result.message || '举报成功', icon: 'success' })
    } catch (err) {
      wx.showToast({ title: err.message || '举报失败', icon: 'none' })
    }
  },
  async openDisputes() {
    const world = this.world
    if (!world) return
    this.setData({ disputesOpen: true, disputesLoading: true })
    if (!this.data.communityGroupBuy) this.loadCommunityGroupBuy()
    try {
      await world.sceneSync.send(true)
      const result = await callFunction('playground', 'listDisputes', {
        ...world.sceneSync.credentials(),
        sceneId: world.scene && world.scene.sceneId
      })
      this.setData({
        disputes: result.disputes || [],
        isCommittee: result.isCommittee || false,
        committeeOwnerName: result.committeeOwnerName || '暂未设立',weeklyPoints:result.weeklyPoints||0
      })
    } catch (err) {
      wx.showToast({ title: err.message || '加载纠纷列表失败', icon: 'none' })
    } finally {
      this.setData({ disputesLoading: false })
    }
  },
  closeDisputes() {
    this.setData({ disputesOpen: false })
  },
  async resolveDisputeAction(e) {
    const world = this.world
    const disputeId = e.currentTarget.dataset.id
    if (!world || !disputeId) return
    try {
      await world.sceneSync.send(true)
      const result = await callFunction('playground', 'resolveDispute', {
        ...world.sceneSync.credentials(),
        disputeId,
        sceneId: world.scene && world.scene.sceneId
      })
      wx.showToast({ title: result.message || '调解完成', icon: 'success' })
      this.openDisputes()
    } catch (err) {
      wx.showToast({ title: err.message || '调解失败', icon: 'none' })
    }
  },
  async claimWeeklySalaryAction() {
    const world = this.world
    if (!world) return
    try {
      await world.sceneSync.send(true)
      const result = await callFunction('playground', 'claimWeeklySalary', {
        ...world.sceneSync.credentials(),
        sceneId: world.scene && world.scene.sceneId
      })
      wx.showToast({ title: result.message || '周薪领取成功', icon: 'success' })
      this.pushStatusMessage(result.message || '已成功领取居委会每周津贴')
      if (this.data.rewardsOpen) this.openRewards(true)
    } catch (err) {
      wx.showToast({ title: err.message || '领取失败', icon: 'none' })
    }
  },
  getAvailableEmptyPlots() {
    if (Array.isArray(this.data.emptyPlots) && this.data.emptyPlots.length) {
      return this.data.emptyPlots
    }
    const world = this.world
    if (!world) return []
    const allPlots = world.plots ? world.plots() : []
    const homePlotId = world.ownPlot ? (world.ownPlot.id || world.ownPlot._id) : null
    return allPlots.filter((p) => {
      if (!p.mine) return false
      if (homePlotId && (p.id === homePlotId || p._id === homePlotId)) return false
      if (!p.isNewPlot) return false
      return true
    })
  },
  filterBuildCatalog(buildings, category) {
    if (!category || category === 'all') return buildings || []
    return (buildings || []).filter((b) => (b.category || 'public') === category)
  },
  switchBuildCategory(e) {
    const key = e.currentTarget.dataset.key
    const filtered = this.filterBuildCatalog(this.data.buildingCatalog, key)
    this.setData({
      activeBuildCategory: key,
      filteredBuildingCatalog: filtered,
      selectedBuilding: filtered.find((b) => b.unlocked) || filtered[0] || null
    })
  },
  async openBuild() {
    this.setData({ buildOpen: true, buildLoading: true })
    try {
      const result = await callFunction('playground', 'getBuildingCatalog')
      const buildings = (result.buildings || []).filter((b) => b.enabled !== false)
      const filtered = this.filterBuildCatalog(buildings, this.data.activeBuildCategory)
      const serverEmptyPlots = Array.isArray(result.emptyPlots) ? result.emptyPlots : []
      const localEmptyPlots = this.getAvailableEmptyPlots()
      const finalEmptyPlots = serverEmptyPlots.length > 0 ? serverEmptyPlots : localEmptyPlots
      this.setData({
        buildingCatalog: buildings,
        filteredBuildingCatalog: filtered,
        selectedBuilding: filtered.find((b) => b.unlocked) || filtered[0] || null,
        plotSizes: result.plotSizes || this.data.plotSizes,
        emptyPlots: finalEmptyPlots,
        availableEmptyPlotCount: finalEmptyPlots.length
      })
    } catch (err) {
      wx.showToast({ title: err.message || '加载建筑列表失败', icon: 'none' })
    } finally {
      this.setData({ buildLoading: false })
    }
  },
  closeBuild() {
    this.setData({ buildOpen: false })
  },
  selectBuilding(e) {
    const id = e.currentTarget.dataset.id
    const b = (this.data.filteredBuildingCatalog || this.data.buildingCatalog || []).find((item) => item.id === id)
    if (b) this.setData({ selectedBuilding: b })
  },
  async buildInYardAction() {
    const building = this.data.selectedBuilding
    if (!building || this.data.buildBusy) return
    if (!building.unlocked) return wx.showToast({ title: building.unlockText || '当前会员未解锁', icon: 'none' })
    const world = this.world
    if (!world) return

    const emptyPlots = this.getAvailableEmptyPlots()
    if (emptyPlots.length === 0) {
      wx.showModal({
        title: '需要空余专属绿地',
        content: '最初的自家庭院为温馨住宅别墅，不可改建或覆盖。\n建造新建筑必须先认领一块空余专属绿地，是否立即前往认领？',
        confirmText: '去认领绿地',
        cancelText: '取消',
        success: (r) => {
          if (r.confirm) {
            this.closeBuild()
            this.buyNewPlotAction()
          }
        }
      })
      return
    }

    let targetPlot = emptyPlots[0]
    const dirMap = { south: '南门', north: '北门', east: '东门', west: '西门' }
    if (emptyPlots.length > 1) {
      const itemList = emptyPlots.map((p, idx) => {
        const size = p.size || 48
        const dir = dirMap[p.gateDirection] || '南门'
        const posText = p.x !== undefined ? ` · 坐标 (${Math.round(p.x)}, ${Math.round(p.z)})` : ''
        const statusText = p.buildingType && p.buildingType !== 'yard' ? ` · 已建【${p.buildingName || '建筑'}】可改建` : ' · 空余绿地'
        return `专属地皮 ${idx + 1} (${size}×${size}m · 栅栏${dir}${statusText}${posText})`
      })
      const selectedIndex = await new Promise((resolve) => {
        wx.showActionSheet({
          itemList,
          success: (res) => resolve(res.tapIndex),
          fail: () => resolve(-1)
        })
      })
      if (selectedIndex < 0) return
      targetPlot = emptyPlots[selectedIndex]
    }

    const sizeText = `${targetPlot.size || 48}×${targetPlot.size || 48}米`
    const dirText = dirMap[targetPlot.gateDirection] || '南门'
    const isRebuild = targetPlot.buildingType && targetPlot.buildingType !== 'yard'

    if (isRebuild) {
      const choice = await new Promise((resolve) => {
        wx.showActionSheet({
          itemList: [`直接替换改建为【${building.name}】`, `拆除原【${targetPlot.buildingName || '建筑'}】还原为纯草块`],
          success: (r) => resolve(r.tapIndex),
          fail: () => resolve(-1)
        })
      })
      if (choice === 1) {
        this.closeBuild()
        return this.dismantleBuildingAction({ currentTarget: { dataset: { plotid: targetPlot.id || targetPlot._id } } })
      }
      if (choice !== 0) return
    }

    const rebuildNotice = isRebuild ? `\n⚠️ 当前绿地已落座【${targetPlot.buildingName || '原建筑'}】，本次建造将替换改建为【${building.name}】。` : ''
    const confirmed = await new Promise((resolve) =>
      wx.showModal({
        title: isRebuild ? `确认改建【${building.name}】` : `确认建造【${building.name}】`,
        content: `已选定专属绿地（${sizeText} · 栅栏${dirText}）。\n将在该绿地落座建造【${building.name}】。${rebuildNotice}\n★ 您的自家庭院（原住别墅）完好保留，不受任何影响。是否确认建造？`,
        confirmText: isRebuild ? '确认改建' : '立即建造',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false)
      })
    )
    if (!confirmed) return
    this.setData({ buildBusy: true })
    try {
      const result = await callFunction('playground', 'buildInYard', {
        plotId: targetPlot.id || targetPlot._id,
        buildingId: building.id,
        buildingType: building.type,
        buildingName: building.name,
        buildingImage: building.image,
        buildingWidth: building.width,
        buildingDepth: building.depth,
        costCoins: building.costCoins || 0,
        sceneId: world.scene && world.scene.sceneId
      })
      wx.showToast({ title: '建筑落座成功！', icon: 'success' })
      this.closeBuild()
      if (this.world === world && !world.destroyed) {
        if (world.scene) this.initialize()
        else {
          const updated = result.plot || {
            ...targetPlot,
            buildingId: building.id,
            buildingType: building.type,
            buildingCategory: building.category || '',
            buildingName: building.name,
            buildingImage: building.image || '',
            buildingWidth: building.width || 7,
            buildingDepth: building.depth || 7,
            name: `${targetPlot.ownerName || '我'}的${building.name}`
          }
          if (world.sharedPlots) world.sharedPlots.set(updated.id, updated)
          world.loadVisible().catch(() => {})
          this.pushStatusMessage(`【${building.name}】已成功落座于地皮内！`)
        }
      }
    } catch (err) {
      wx.showToast({ title: err.message || '建造失败', icon: 'none' })
    } finally {
      this.setData({ buildBusy: false })
    }
  },
  async buildOutYardAction() {
    this.closeBuild()
    this.buyNewPlotAction()
  },
  async dismantleBuildingAction(e) {
    const world = this.world
    if (!world) return
    const plotId = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.plotid) ||
                   (this.data.nearbyBuilding && this.data.nearbyBuilding.plotId)
    if (!plotId) return wx.showToast({ title: '未找到对应建筑', icon: 'none' })

    const targetPlot = (world.plots ? world.plots() : []).find((p) => p.id === plotId || p._id === plotId)
    const buildingName = (targetPlot && targetPlot.buildingName) || (this.data.nearbyBuilding && this.data.nearbyBuilding.name) || '建筑'

    const confirmed = await new Promise((resolve) =>
      wx.showModal({
        title: '确认拆除建筑',
        content: `确定要拆除【${buildingName}】吗？\n拆除后该地皮将恢复为原来的初始纯草块，您可以随时重新规划或建造其他建筑。`,
        confirmText: '拆除建筑',
        confirmColor: '#e04f5f',
        cancelText: '保留建筑',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false)
      })
    )
    if (!confirmed) return

    try {
      const result = await callFunction('playground', 'dismantleBuilding', {
        plotId,
        sceneId: world.scene && world.scene.sceneId
      })
      wx.showToast({ title: result.message || '建筑已拆除，恢复为初始草块！', icon: 'success' })
      if (this.world === world && !world.destroyed) {
        if (world.scene) this.initialize()
        else {
          if (targetPlot) {
            targetPlot.buildingType = 'yard'
            targetPlot.buildingId = ''
            targetPlot.buildingName = ''
            targetPlot.buildingCategory = ''
            targetPlot.buildingImage = ''
            targetPlot.buildingWidth = 0
            targetPlot.buildingDepth = 0
            targetPlot.name = `${targetPlot.ownerName || '邻居'}的专属爱心绿地`
            if (world.sharedPlots) world.sharedPlots.set(targetPlot.id, targetPlot)
          }
          world.loadVisible().catch(() => {})
          if (typeof world.renderFrame === 'function') world.renderFrame()
          this.pushStatusMessage(`【${buildingName}】已拆除，地皮已恢复为纯草块！`)
        }
      }
    } catch (err) {
      wx.showToast({ title: err.message || '拆除建筑失败', icon: 'none' })
    }
  },
  async repairVehicleAction() {
    const world = this.world
    if (!world) return
    try {
      await world.sceneSync.send(true)
      const result = await callFunction('playground', 'repairVehicle', {
        ...world.sceneSync.credentials(),
        sceneId: world.scene && world.scene.sceneId
      })
      wx.showModal({
        title: '车辆保养完成',
        content: result.message || '经过全面维护，车辆机械与安全性能已完全达标！',
        showCancel: false
      })
    } catch (err) {
      wx.showToast({ title: err.message || '检修失败', icon: 'none' })
    }
  },
  async hospitalCareAction(e) {
    const type = e.currentTarget.dataset.type || 'wash'
    const world = this.world
    if (!world) return
    const pet = this.data.selectedPet || (this.data.pets && this.data.pets[0])
    try {
      const result = await callFunction('playground', 'hospitalCare', {
        careType: type,
        petId: pet ? (pet.id || pet._id) : '',
        sceneId: world.scene && world.scene.sceneId
      })
      if (pet) {
        if (type === 'treat') {
          pet.sick = false
          pet.injured = false
          pet.sickReason = ''
        }
        if (pet.needs) {
          pet.needs.energy = 100
          if (type === 'treat') {
            pet.needs.satiety = 100
            pet.needs.hydration = 100
          }
        }
        pet.fatigue = 0
        if (this.world) this.world.emitPets()
      }
      wx.showModal({
        title: type === 'wash' ? '爱宠洗护完成' : '健康体检与治疗完成',
        content: result.message || '爱宠状态已焕然一新！',
        showCancel: false
      })
    } catch (err) {
      wx.showToast({ title: err.message || '护理失败', icon: 'none' })
    }
  },
  woodCabinAction() {
    const world = this.world
    const pet = this.data.selectedPet || (this.data.pets && this.data.pets[0])
    if (pet && pet.needs) {
      pet.needs.energy = Math.min(100, (pet.needs.energy || 80) + 15)
      pet.fatigue = Math.max(0, (pet.fatigue || 20) - 15)
      if (this.world) this.world.emitPets()
    }
    const msg = '您在田园小木屋前静享微风与舒适时光，心情愉悦，爱宠精力充沛～'
    wx.showToast({ title: '木屋营地·静享舒适', icon: 'none' })
    this.pushStatusMessage(msg)
  },
  treeAction() {
    const pet = this.data.selectedPet || (this.data.pets && this.data.pets[0])
    if (pet && pet.needs) {
      pet.needs.energy = Math.min(100, (pet.needs.energy || 80) + 10)
      pet.fatigue = Math.max(0, (pet.fatigue || 20) - 10)
      if (this.world) this.world.emitPets()
    }
    const msg = '您在景观树荫下小憩，微风吹拂，落英缤纷，心情愉悦～'
    wx.showToast({ title: '树荫休憩·微风拂面', icon: 'none' })
    this.pushStatusMessage(msg)
  },
  async reportTrafficAccident(accidentData) {
    const world = this.world
    try {
      await callFunction('playground', 'reportAccident', {
        sceneId: world && world.scene && world.scene.sceneId,
        ...accidentData
      })
      wx.showToast({ title: '慢速出行提醒已通报文明督导所', icon: 'none' })
    } catch (err) {
      console.error('reportTrafficAccident error:', err)
    }
  },
  onHumanInjured() {
    this.setData({ isHumanInjured: true })
    if (this.humanInjuredTimer) clearTimeout(this.humanInjuredTimer)
    this.humanInjuredTimer = setTimeout(() => {
      this.setData({ isHumanInjured: false })
    }, 8000)
  },
  async openJustice() {
    const world = this.world
    this.setData({ justiceOpen: true, justiceLoading: true })
    try {
      const result = await callFunction('playground', 'listAccidents', {
        sceneId: world && world.scene && world.scene.sceneId
      })
      this.setData({
        accidents: result.accidents || [],
        myJailStatus: result.isJailed ? {
          isJailed: true,
          remainingSeconds: result.jailRemainingSeconds,
          bailCoins: result.bailCoins
        } : null
      })
      if (result.isJailed) {
        this.syncJailRestriction(result)
        this.startJailTimer()
      } else {
        if (this.jailTimer) clearInterval(this.jailTimer)
      }
    } catch (err) {
      wx.showToast({ title: err.message || '加载自省记录失败', icon: 'none' })
    } finally {
      this.setData({ justiceLoading: false })
    }
  },
  startJailTimer() {
    if (this.jailTimer) clearInterval(this.jailTimer)
    this.jailTimer = setInterval(() => {
      const status = this.data.myJailStatus
      if (!status || !status.isJailed || status.remainingSeconds <= 0) {
        if (this.jailTimer) clearInterval(this.jailTimer)
        if (status && status.isJailed) {
          this.payBailAction({ currentTarget: { dataset: { paybail: false } } })
        }
        return
      }
      this.setData({
        'myJailStatus.remainingSeconds': Math.max(0, status.remainingSeconds - 1)
      })
    }, 1000)
  },
  async checkInitialJailStatus() {
    const world = this.world
    if (!world) return
    try {
      const result = await callFunction('playground', 'listAccidents', {
        sceneId: world.scene && world.scene.sceneId
      })
      if (result && result.isJailed) {
        this.setData({
          myJailStatus: {
            isJailed: true,
            remainingSeconds: result.jailRemainingSeconds,
            bailCoins: result.bailCoins
          }
        })
        this.syncJailRestriction(result)
        this.startJailTimer()
      } else {
        if (this.jailTimer) clearInterval(this.jailTimer)
        if (this.data.myJailStatus) {
          this.setData({ myJailStatus: null })
          this.syncJailRestriction(null)
        }
      }
    } catch (_) {}
  },
  closeJustice() {
    this.setData({ justiceOpen: false })
  },
  syncJailRestriction(jailStatus) {
    if (!this.world) return
    if (!jailStatus || !jailStatus.isJailed) {
      this.world.setJailedStatus(false, null)
      return
    }
    const prisonPlot = (this.world.plots() || []).find((p) => p.buildingType === 'prison')
    if (prisonPlot) {
      const half = (prisonPlot.size || 48) / 2
      const bounds = {
        minX: prisonPlot.x - half,
        maxX: prisonPlot.x + half,
        minZ: prisonPlot.z - half,
        maxZ: prisonPlot.z + half
      }
      this.world.setJailedStatus(true, bounds)
    } else {
      this.world.setJailedStatus(true, null)
    }
  },
  async arrestDriverAction(e) {
    const id = e.currentTarget.dataset.id
    const world = this.world
    if (!world || !id) return
    const accident = (this.data.accidents || []).find((a) => a._id === id || a.id === id)
    if (!accident) return
    try {
      const result = await callFunction('playground', 'arrestDriver', {
        accidentId: accident._id || accident.id,
        sceneId: world.scene && world.scene.sceneId
      })
      wx.showToast({ title: result.message || '已安排前往自省室宣教学习！', icon: 'success' })
      this.openJustice()
    } catch (err) {
      wx.showToast({ title: err.message || '安排自省失败', icon: 'none' })
    }
  },
  async payBailAction(e) {
    const payBail = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.paybail === false ? false : true
    const world = this.world
    try {
      const result = await callFunction('playground', 'releaseDriver', {
        payBail,
        sceneId: world && world.scene && world.scene.sceneId
      })
      if (this.jailTimer) clearInterval(this.jailTimer)
      wx.showModal({
        title: '自省完成',
        content: result.message || '已完成宣教自省，欢迎继续参与社区文明互动！',
        showCancel: false
      })
      this.setData({ myJailStatus: null })
      if (this.world) this.world.setJailedStatus(false, null)
      if (this.data.justiceOpen) this.openJustice()
    } catch (err) {
      wx.showToast({ title: err.message || '结束自省失败', icon: 'none' })
    }
  },
  async loadServiceTwin(openModal = false) {
    if (this.data.serviceDiaryLoading) return
    this.setData({ serviceDiaryLoading: true })
    try {
      const res = await callFunction('playground', 'getServiceTwinInfo')
      this.setData({
        serviceDiary: res || null,
        activeService: (res && res.activeOrder) || this.data.activeService || null,
        hasServiceDiary: Boolean(res && res.latestCheckins && res.latestCheckins.length > 0)
      })
      if (res && res.bowlAutoRefilled && this.world && !this.world.destroyed) {
        this.world.applyBowlFood({ food: 100 })
      }
      if (openModal) {
        this.setData({ serviceDiaryOpen: true })
      }
    } catch (err) {
      if (openModal) {
        wx.showToast({ title: err.message || '加载照料记录失败', icon: 'none' })
      }
    } finally {
      this.setData({ serviceDiaryLoading: false })
    }
  },
  openServiceDiary() {
    this.setData({ serviceDiaryOpen: true })
    this.loadServiceTwin(false)
  },
  closeServiceDiary() {
    this.setData({ serviceDiaryOpen: false })
  },
  previewDiaryPhoto(e) {
    const url = e.currentTarget.dataset.url
    const urls = (this.data.serviceDiary && this.data.serviceDiary.latestCheckins ? this.data.serviceDiary.latestCheckins.map(c => c.mediaFileId).filter(Boolean) : [url]).filter(Boolean)
    if (url && urls.length) {
      wx.previewImage({ urls, current: url, fail: () => wx.showToast({ title: '照片暂时无法预览', icon: 'none' }) })
    }
  },
  goToOrderDetail(e) {
    const orderId = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id) ||
      (this.data.serviceDiary && this.data.serviceDiary.activeOrder && this.data.serviceDiary.activeOrder.id)
    if (orderId) {
      wx.navigateTo({ url: `/pages/client/orders/detail/index?id=${orderId}` })
    }
  },
  async openMallSupplies() {
    this.setData({ mallSuppliesOpen: true, mallSuppliesLoading: true })
    try {
      const res = await callFunction('playground', 'getMallSupplies')
      this.setData({ mallSupplies: (res && res.products) || [] })
    } catch (err) {
      wx.showToast({ title: err.message || '加载口粮商品失败', icon: 'none' })
    } finally {
      this.setData({ mallSuppliesLoading: false })
    }
  },
  closeMallSupplies() {
    this.setData({ mallSuppliesOpen: false })
  },
  goToMallDetail(e) {
    const id = e.currentTarget.dataset.id
    if (id) {
      wx.navigateTo({ url: `/pages/client/mall/detail/index?id=${id}` })
    }
  },
  goToMallHome() {
    wx.navigateTo({ url: '/pages/client/mall/list/index' })
  },
  setGroupBuyTab(e) {
    const tab = e.currentTarget.dataset.tab || 'sanitation'
    this.setData({ groupBuyTab: tab })
    if (tab === 'groupbuy' && !this.data.communityGroupBuy) {
      this.loadCommunityGroupBuy()
    }
  },
  async loadCommunityGroupBuy() {
    if (this.data.communityGroupBuyLoading) return
    this.setData({ communityGroupBuyLoading: true })
    try {
      const res = await callFunction('playground', 'getCommunityGroupBuy', { community: this.selectedCommunity })
      this.setData({ communityGroupBuy: res || null })
    } catch (e) {
    } finally {
      this.setData({ communityGroupBuyLoading: false })
    }
  },
  startGroupBuyOrder() {
    wx.navigateTo({ url: '/pages/client/orders/create/index?source=community_groupbuy' })
  },
  bookSitterAction(e) {
    const staffId = e.currentTarget.dataset.id
    if (staffId) {
      wx.navigateTo({ url: `/pages/client/orders/create/index?publishMode=direct&staffProfileId=${staffId}` })
    } else {
      wx.navigateTo({ url: '/pages/client/orders/create/index' })
    }
  },
  viewSitterDetail(e) {
    const sitterId = e.currentTarget.dataset.id
    if (sitterId) {
      wx.navigateTo({ url: `/pages/client/sitters/detail/index?id=${sitterId}` })
    }
  },
  async openRewards(silent = false) {
    if (!silent) this.setData({ rewardsOpen: true, rewardsLoading: true })
    try {
      const res = await callFunction('playground', 'getPlaygroundRewards')
      this.setData({ rewardsData: res || null, rewardsOpen: true })
    } catch (err) {
      if (!silent) wx.showToast({ title: err.message || '加载关爱权益失败', icon: 'none' })
    } finally {
      this.setData({ rewardsLoading: false })
    }
  },
  closeRewards() {
    this.setData({ rewardsOpen: false })
  },
  async exchangeCouponAction(e) {
    const item = e.currentTarget.dataset.item
    if (!item || !item.id) return
    const modalRes = await new Promise((resolve) => {
      wx.showModal({
        title: '兑换优惠券',
        content: `确定消耗 ${item.requiredPoints} 关爱积分兑换【${item.name}】吗？`,
        confirmText: '确定兑换',
        cancelText: '再想想',
        success: (res) => resolve(res.confirm)
      })
    })
    if (!modalRes) return
    this.setData({ exchangingCouponId: item.id })
    try {
      const res = await callFunction('playground', 'exchangeCoupon', { templateId: item.id })
      wx.showToast({ title: res.message || '兑换成功！', icon: 'success' })
      this.pushStatusMessage(res.message || '成功兑换优惠券')
      this.openRewards(true)
    } catch (err) {
      wx.showToast({ title: err.message || '兑换失败', icon: 'none' })
    } finally {
      this.setData({ exchangingCouponId: '' })
    }
  },
  goToCouponsList() {
    wx.navigateTo({ url: '/pages/client/coupons/list/index' })
  },
  goToServiceBooking() {
    wx.navigateTo({ url: '/pages/client/orders/create/index' })
  }
})
