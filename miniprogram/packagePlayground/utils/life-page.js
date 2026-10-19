const {bedView}=require('./farm-model')
const toast=(error)=>wx.showToast({title:error.message||'操作失败，请重试',icon:'none'})
module.exports={
  togglePetRoster(){this.setData({petRosterOpen:!this.data.petRosterOpen})},
  selectCompanion(e) {
    if(this.world)this.world.selectPet(e.currentTarget.dataset.id)
    this.setData({petRosterOpen:false})
  },
  viewPetAlert(e) {
    const id=e.currentTarget.dataset.id||(this.data.petAlerts[0]||{}).id
    if(this.world&&id){this.world.selectPet(id);this.world.followPet()}
  },
  async petCare(e) {
    const world=this.world,operation=e.currentTarget.dataset.operation,petId=this.data.selectedPetId
    if(!world||!petId||this.data.petCareBusy)return
    if(!world.sceneSync) {
      world.request(operation)
      return
    }
    this.setData({petCareBusy:true})
    try {
      await world.sceneSync.petAction(petId,operation)
      const messages={follow:'宠物会跟在你身边，停下后会在周围自由活动',stay:'已取消跟随，宠物在当前位置附近活动',feed:'喂食完成，饱腹值 +25',eat:'宠物正前往碗边吃饭',sleep:'宠物正回窝休息',drink:'宠物正前往喷泉饮水'}
      if(this.world===world)world.onStatus(messages[operation])
    } catch(error){toast(error)}
    finally {if(this.world===world)this.setData({petCareBusy:false})}
  },
  async openFarm(e) {
    const world=this.world
    if(!world||!world.sceneSync)return
    const plots=world.gardenPlots()
    if(!plots.length)return wx.showToast({title:'请先建造自己的庭院',icon:'none'})
    this.joystickEnd();this.clearPetSelection()
    const dataset=e&&e.currentTarget&&e.currentTarget.dataset||{}
    const plotId=dataset.plot||this.data.farmPlotId||plots[0].id
    this.setData({farmOpen:true,farmLoading:true,gardenPlots:plots.map((p,i)=>({id:p.id,name:p.buildingName||p.name||'我的地皮 '+(i+1)})),farmPlotId:plotId})
    try {await this.ensureFarm(true,plotId)}catch(error){toast(error)}
    finally{if(this.world===world)this.setData({farmLoading:false})}
  },
  closeFarm(){this.setData({farmOpen:false})},
  async selectGardenPlot(e) {
    const plotId=e.currentTarget.dataset.id
    this.setData({farmPlotId:plotId,farmLoading:true})
    try{await this.ensureFarm(true,plotId)}catch(error){toast(error)}
    finally{this.setData({farmLoading:false})}
  },
  startGardenEdit() {
    this.closeFarm();this.joystickEnd()
    this.setData({farmEditMode:true})
    if(this.world){this.world.selectCharacter();this.world.emitFarmUi();this.world.onStatus('点击自家庭院或新地皮里的草块，走近后布置植物')}
  },
  endGardenEdit(){this.setData({farmEditMode:false});if(this.world)this.world.emitFarmUi()},
  ensureFarm(force=false,plotId) {
    const world=this.world
    plotId=plotId||this.data.farmPlotId||world&&world.ownPlot&&world.ownPlot.id
    if(!world||!world.sceneSync||!plotId)return Promise.resolve()
    this.farmWantedPlot=plotId
    if(this.farmRequest&&this.farmRequest.world===world&&this.farmRequest.plotId===plotId)return this.farmRequest.promise
    if(!force&&this.farmSnapshot&&this.farmSnapshot.plotId===plotId&&Date.now()-this.farmReceived<15000)return Promise.resolve()
    const request={world,plotId,revision:this.farmApplyRevision||0}
    request.promise=world.sceneSync.getFarm(plotId).then((farm)=>{
      if(this.world===world&&!world.destroyed&&farm.plotId===this.farmWantedPlot&&request.revision===(this.farmApplyRevision||0))this.applyFarm(farm)
    }).finally(()=>{if(this.farmRequest===request)this.farmRequest=null})
    this.farmRequest=request
    return request.promise
  },
  applyFarm(farm) {
    if(this.world&&this.world.setFarmCatalog)this.world.setFarmCatalog(farm.catalog)
    const latest=this.world&&this.world.farmCatalog
    if(latest&&farm.catalog&&latest.revision>farm.catalog.revision)farm={...farm,catalog:latest,crops:latest.crops.map((c)=>({...c,unlocked:c.enabled!==false&&(!(c.unlockLevelIds||[]).length||c.unlockLevelIds.includes(farm.memberLevel))}))}
    this.farmApplyRevision=(this.farmApplyRevision||0)+1
    this.farmSnapshot=farm;this.farmReceived=Date.now()
    this.setData({farm,farmPlotId:farm.plotId})
    this.refreshFarmClock()
    if(this.world)this.world.emitFarmUi()
  },
  refreshFarmClock() {
    if(!this.farmSnapshot)return
    const stamp=this.farmSnapshot.serverTime+Date.now()-this.farmReceived
    const beds=this.farmSnapshot.beds.map((b)=>({...b,...(b.state==='grass'?b:bedView(b,stamp,this.farmSnapshot.crops))}))
    const crops=this.farmSnapshot.crops||[],crop=crops.find((c)=>c.id===this.data.farmCropId)
    const selected=crop&&crop.unlocked?crop:crops.find((c)=>c.unlocked)
    this.setData({'farm.beds':beds,farmCultivated:beds.filter((b)=>b.state!=='grass'),farmCropId:selected&&selected.id||'',farmSeedAvailable:!!selected,
      farmBed:beds.find((b)=>b.id===this.data.farmSelectedBed)||null})
  },
  selectFarmBed(e){this.setData({farmSelectedBed:Number(e.currentTarget.dataset.id)});this.refreshFarmClock()},
  selectFarmCrop(e){this.setData({farmCropId:e.currentTarget.dataset.id});this.refreshFarmClock()},
  async goToFarm(e) {
    const world=this.world
    if(!world)return
    if(world.drivingVehicleId)return wx.showToast({title:'请先下车',icon:'none'})
    const dataset=e&&e.currentTarget&&e.currentTarget.dataset||{}
    const bedId=dataset.id===undefined?this.data.farmSelectedBed:Number(dataset.id)
    this.closeFarm()
    await world.moveToFarmBed(bedId,dataset.plot||this.data.farmPlotId)
  },
  async farmOperation(e) {
    const world=this.world,dataset=e.currentTarget.dataset
    if(!world||!world.sceneSync||this.data.farmBusy)return
    const tile=world.nearbyFarmTile()
    if(this.data.farmOpen||!tile||tile.id!==Number(dataset.bed)||tile.plotId!==dataset.plot)return wx.showToast({title:'请先走到这块土地旁边',icon:'none'})
    this.joystickEnd();world.setCharacterInput(0,0);world.characterRoute=null;world.characterTarget=null;world.characterMoveToken=(world.characterMoveToken||0)+1
    const payload={operation:dataset.operation,plotId:tile.plotId,bedId:tile.id,cropId:dataset.crop||this.data.farmCropId||''}
    const signature=JSON.stringify(payload)
    const packet=this.pendingFarm&&this.pendingFarm.signature===signature?this.pendingFarm.packet:
      {...payload,requestId:'farm_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,12)}
    this.pendingFarm={signature,packet};this.setData({farmBusy:true})
    try {
      const result=await world.sceneSync.farmAction(packet)
      this.pendingFarm=null
      if(this.world===world&&!world.destroyed){
        // Reflect the acknowledged layout while realtime publication arrives.
        const plot=world.gardenPlots().find((p)=>p.id===result.plotId)
        if(plot){plot.farmBeds=result.beds.filter((b)=>b.state!=='grass');plot.gardenVersion=2}
        this.applyFarm(result);world.onStatus(result.message);wx.showToast({title:result.message,icon:'none'})
      }
    }catch(error){toast(error)}
    finally{if(this.world===world)this.setData({farmBusy:false})}
  },
  async pickupPoop(e) {
    const world=this.world
    if(!world||this.data.pickupBusy)return
    this.setData({pickupBusy:true})
    try {
      await world.pickupPoop()
    } finally {
      this.setData({pickupBusy:false})
    }
  },
  async recordPoopPickup(poopId) {
    const world=this.world
    if(!world||!world.sceneSync)return
    try {
      const packet={
        operation:'pickupPoop',
        poopId: poopId || ('poop_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8)),
        quantity:1,
        requestId:'poop_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,12)
      }
      const result=await world.sceneSync.farmAction(packet)
      if(this.world===world)world.onStatus(result.message)
    }catch(error){console.error('recordPoopPickup error',error);throw error}
  },
  async rideOperation(e) {
    const world=this.world,data=e.currentTarget.dataset
    if(!world||!world.sceneSync||this.data.rideBusy)return
    this.joystickEnd();this.setData({rideBusy:true})
    try {
      let action='rideRequest',payload={operation:data.operation,playerId:data.player}
      if(data.operation==='leave'){action='rideLeave';payload={}}
      if(data.operation==='respond'){action='rideRespond';payload={requestId:data.id,accept:data.accept===true||data.accept==='true'}}
      const result=await world.sceneSync.rideAction(action,payload)
      if(this.world===world){world.onStatus(result.message);wx.showToast({title:result.message||'操作完成',icon:'none'})}
    }catch(error){toast(error)}
    finally{if(this.world===world)this.setData({rideBusy:false})}
  }
}
