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
    if(!world||!world.sceneSync||!petId||this.data.petCareBusy)return
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
    if(!world.ownPlot)return wx.showToast({title:'请先建造自己的庭院',icon:'none'})
    this.joystickEnd();this.clearPetSelection()
    const dataset=e&&e.currentTarget&&e.currentTarget.dataset||{},id=Number(dataset.bed)
    this.setData({farmOpen:true,farmLoading:true,farmTab:dataset.tab||'field',farmSelectedBed:Number.isInteger(id)?id:0})
    try {
      await this.ensureFarm(true)
    }catch(error){toast(error)}
    finally{if(this.world===world)this.setData({farmLoading:false})}
  },
  closeFarm(){this.setData({farmOpen:false})},
  ensureFarm(force=false) {
    const world=this.world
    if(!world||!world.sceneSync||!world.ownPlot)return Promise.resolve()
    if(this.farmRequest&&this.farmRequest.world===world)return this.farmRequest.promise
    if(!force&&this.farmSnapshot&&this.farmSnapshot.plotId===world.ownPlot.id&&Date.now()-this.farmReceived<15000)return Promise.resolve()
    if(!force&&Date.now()-(this.farmAttempt||0)<5000)return Promise.resolve()
    this.farmAttempt=Date.now()
    const request={world,revision:this.farmApplyRevision||0}
    request.promise=world.sceneSync.getFarm().then((farm)=>{
      if(this.world===world&&!world.destroyed&&world.ownPlot&&farm.plotId===world.ownPlot.id&&request.revision===(this.farmApplyRevision||0))this.applyFarm(farm)
    }).finally(()=>{if(this.farmRequest===request)this.farmRequest=null})
    this.farmRequest=request
    return request.promise
  },
  applyFarm(farm) {
    if(this.world&&this.world.setFarmCatalog) {
      this.world.setFarmCatalog(farm.catalog)
      const catalog=this.world.farmCatalog
      if(farm.catalog&&catalog&&catalog.revision>farm.catalog.revision) {
        farm={...farm,catalog,crops:catalog.crops.map((c)=>({...c,unlocked:c.enabled!==false&&c.level<=farm.level,
          seeds:(farm.seeds||{})[c.id]||0,stock:(farm.produce||{})[c.id]||0}))}
      }
    }
    this.farmApplyRevision=(this.farmApplyRevision||0)+1
    this.farmSnapshot=farm
    this.farmReceived=Date.now()
    this.setData({farm})
    this.refreshFarmClock()
    if(this.world)this.world.emitFarmUi()
  },
  refreshFarmClock() {
    if(!this.farmSnapshot)return
    const stamp=this.farmSnapshot.serverTime+Date.now()-this.farmReceived
    const beds=this.farmSnapshot.beds.map((b)=>{
      const view=b.state==='wild'?b:bedView(b,stamp,this.farmSnapshot.crops),remaining=view.remaining||0
      return {...b,...view,countdown:remaining>=3600?Math.ceil(remaining/3600)+'小时':remaining>=60?Math.ceil(remaining/60)+'分钟':remaining+'秒'}
    })
    const crop=(this.farmSnapshot.crops||[]).find((c)=>c.id===this.data.farmCropId)
    this.setData({'farm.beds':beds,farmBed:beds.find((b)=>b.id===this.data.farmSelectedBed)||beds[0],farmSeedAvailable:!!(crop&&crop.unlocked&&crop.seeds>0),
      farmReadyCount:beds.filter((b)=>b.state==='ready').length})
  },
  selectFarmBed(e){this.setData({farmSelectedBed:Number(e.currentTarget.dataset.id)});this.refreshFarmClock()},
  changeFarmTab(e){this.setData({farmTab:e.currentTarget.dataset.tab})},
  selectFarmCrop(e){this.setData({farmCropId:e.currentTarget.dataset.id});this.refreshFarmClock()},
  async goToFarm(e) {
    const world=this.world
    if(!world||!world.ownPlot)return
    if(world.drivingVehicleId)return wx.showToast({title:'请先下车',icon:'none'})
    const id=e&&e.currentTarget&&e.currentTarget.dataset.id
    const bedId=id===undefined?this.data.farmSelectedBed:Number(id)
    this.closeFarm()
    await world.moveToFarmBed(bedId)
  },
  async farmOperation(e) {
    const world=this.world,dataset=e.currentTarget.dataset
    if(!world||!world.sceneSync||this.data.farmBusy)return
    const field=['till','plant','water','fertilize','harvest'].includes(dataset.operation)
    const tile=field&&world.nearbyFarmTile()
    if(field&&(this.data.farmOpen||!tile||tile.id!==Number(dataset.bed)))return wx.showToast({title:'请先走到这块土地旁边',icon:'none'})
    if(field){this.joystickEnd();world.setCharacterInput(0,0);world.characterRoute=null;world.characterTarget=null;world.characterMoveToken=(world.characterMoveToken||0)+1}
    const payload={operation:dataset.operation,bedId:field?tile.id:undefined,cropId:dataset.crop||this.data.farmCropId||'carrot',quantity:dataset.quantity===undefined?1:Number(dataset.quantity)}
    const signature=JSON.stringify(payload)
    const packet=this.pendingFarm&&this.pendingFarm.signature===signature?this.pendingFarm.packet:
      {...payload,requestId:'farm_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,12)}
    this.pendingFarm={signature,packet}
    this.setData({farmBusy:true})
    try {
      const result=await world.sceneSync.farmAction(packet)
      this.pendingFarm=null
      if(this.world===world){this.applyFarm(result);world.onStatus(result.message);wx.showToast({title:result.message,icon:'none'})}
    }catch(error){toast(error)}
    finally{if(this.world===world)this.setData({farmBusy:false})}
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
