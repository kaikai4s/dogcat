const {needsView}=require('./pet-needs')
const {farmLayout,savedBeds,bedReach,bedView,cropById,growthStage,SOILS}=require('./farm-model')
module.exports={
  setFarmCatalog(catalog) {
    if(!catalog||!Array.isArray(catalog.crops)||this.farmCatalog&&catalog.revision<this.farmCatalog.revision)return
    this.farmCatalog=catalog
  },
  farmImage(atlas) {
    if(!this.loader||!atlas)return null
    if(!this.farmImages){this.farmImages=new Map();this.farmLoads=new Map();this.farmRetry=new Map()}
    const key=JSON.stringify(atlas),cached=this.farmImages.get(key)
    if(cached){this.farmImages.delete(key);this.farmImages.set(key,cached);return cached.image}
    if(this.farmLoads.size<3&&!this.farmLoads.has(key)&&Date.now()>=(this.farmRetry.get(key)||0)) {
      const task=this.loader.loadAtlas(atlas).then((image)=>{
        if(this.destroyed)return
        this.farmImages.set(key,{image,fileID:atlas.fileID})
        while(this.farmImages.size>12) {
          const oldest=this.farmImages.keys().next().value,entry=this.farmImages.get(oldest)
          this.farmImages.delete(oldest)
          if(this.loader.cache)this.loader.cache.delete(entry.fileID)
        }
        this.farmRetry.delete(key)
      }).catch(()=>{if(!this.destroyed)this.farmRetry.set(key,Date.now()+10000)})
        .finally(()=>this.farmLoads.delete(key))
      this.farmLoads.set(key,task)
    }
    return null
  },
  buildingImage(fileID) {
    if(!fileID||!this.loader)return null
    if(!this.buildingImages){this.buildingImages=new Map();this.buildingLoads=new Map();this.buildingRetry=new Map()}
    if(this.buildingImages.has(fileID))return this.buildingImages.get(fileID)
    if(this.buildingLoads.size<3&&!this.buildingLoads.has(fileID)&&Date.now()>=(this.buildingRetry.get(fileID)||0)) {
      const task=this.loader.loadImage(fileID).then((image)=>{
        if(this.destroyed)return
        this.buildingImages.set(fileID,image)
        if(this.buildingImages.size>32){const first=this.buildingImages.keys().next().value;this.buildingImages.delete(first);this.loader.cache&&this.loader.cache.delete(first)}
        if(typeof this.onAssetLoaded==='function')this.onAssetLoaded(fileID,image)
      }).catch(()=>this.buildingRetry.set(fileID,Date.now()+10000)).finally(()=>this.buildingLoads.delete(fileID))
      this.buildingLoads.set(fileID,task)
    }
    return null
  },
  petNeeds(pet) {return needsView(pet,Date.now()+this.serverOffset)},
  petActivity(pet) {
    if(pet.relieving)return pet.relieving.type==='poop'?'便便中...':'嘘嘘中...'
    if(pet.autonomousAction&&this.elapsed<pet.autonomousAction.until) {
      return pet.autonomousAction.type==='eat'?'正在碗边进食':'正在喷泉饮水'
    }
    if(pet.ridingVehicleId)return '同行乘车中'
    if(pet.following)return '跟随主人 · 到身边后自由活动'
    const now=Date.now()+this.serverOffset,care=pet.care
    if(care&&now<care.endsAt) {
      const labels={sleep:'窝里休息',eat:'碗边进食',drink:'喷泉饮水'}
      return (now<care.startsAt?'正在前往':'正在')+(labels[care.type]||'休息')
    }
    return pet.moving?'自由活动':'休息中'
  },
  updateLifeUi() {
    const stamp=Date.now()
    if(stamp-(this.lastLifeUi||0)<1000)return
    this.lastLifeUi=stamp
    this.page.setData({socialClock:stamp+this.serverOffset})
    const incoming=(this.social.incoming||[]).filter((r)=>!r.expiresAt||r.expiresAt>stamp+this.serverOffset)
    const mailKey=incoming.map((r)=>r.id).join(',')
    if(mailKey!==this.lifeMailKey){this.lifeMailKey=mailKey;this.page.setData({socialRequests:incoming})}
    this.emitPets()
    const alerts=[]
    for(const pet of this.pets.filter((p)=>p.mine!==false)) {
      for(const need of this.petNeeds(pet))if(need.low)alerts.push({id:pet.id,key:pet.id+need.key,name:pet.name,message:need.message})
    }
    const key=JSON.stringify(alerts)
    if(key!==this.alertUiKey){this.alertUiKey=key;this.page.setData({petAlerts:alerts})}
    // Announce once per low-state episode, without interrupting joystick input.
    const active=new Set(alerts.map((a)=>a.key)),previous=this.lowPetKeys||new Set()
    const fresh=alerts.find((a)=>!previous.has(a.key))
    this.lowPetKeys=active
    if(fresh)this.onStatus(fresh.name+'：'+fresh.message)
    if(this.page.refreshFarmClock)this.page.refreshFarmClock()
    this.emitFarmUi()
  },
  gardenPlots() {
    return this.plots().filter((p)=>p.mine&&!p.demolished)
  },
  nearbyFarmTile() {
    if(!this.character||this.drivingVehicleId||this.placing||this.destroyed||this.isMapOverview()||!this.characterTerrain||!this.characterAreaLoaded(this.characterTerrain))return null
    const p=this.character.position,nav=this.characterNavigation(),edit=Boolean(this.page&&this.page.data&&this.page.data.farmEditMode)
    const tiles=this.gardenPlots().flatMap((plot)=>{
      const saved=savedBeds(plot)
      return farmLayout(plot).filter((t)=>(edit||saved[t.id])&&Math.hypot(t.x-p.x,t.z-p.z)<=bedReach(t)&&nav.clearSegment(p,t)).map((t)=>({...t,plotId:plot.id}))
    })
    return tiles.find((t)=>t.id===this.farmTargetBed&&t.plotId===this.farmTargetPlot)||tiles.sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0]||null
  },
  emitFarmUi() {
    const tile=this.nearbyFarmTile(),page=this.page
    if(tile&&page&&page.ensureFarm&&!(page.data&&page.data.farmOpen))page.ensureFarm(false,tile.plotId).catch(()=>{})
    const farm=page.data&&page.data.farm
    const bed=tile&&farm&&farm.plotId===tile.plotId?farm.beds.find((b)=>b.id===tile.id):null
    const nearby=tile?{...tile,...(bed||{}),loaded:!!bed}:null,key=JSON.stringify(nearby)
    if(key!==this.farmUiKey){this.farmUiKey=key;page.setData({nearbyFarm:nearby})}
  },
  async moveToFarmBed(id,plotId) {
    if(!this.character||this.drivingVehicleId)return false
    const plot=this.gardenPlots().find((p)=>p.id===(plotId||this.ownPlot&&this.ownPlot.id))
    const tile=plot&&farmLayout(plot).find((t)=>t.id===id)
    if(!tile)return false
    this.farmTargetBed=id;this.farmTargetPlot=plot.id
    if(this.page.ensureFarm)this.page.ensureFarm(false,plot.id).catch(()=>{})
    this.selectCharacter()
    const nav=this.characterNavigation(),offset=tile.size*.65
    const target=[{x:tile.x,z:tile.z+offset},{x:tile.x-offset,z:tile.z},{x:tile.x+offset,z:tile.z},{x:tile.x,z:tile.z-offset},tile].find((p)=>nav.walkable(p)&&nav.clearSegment(p,tile))
    if(!target){this.onStatus('这块土地暂时无法靠近');return false}
    const result=await this.moveCharacterTo(target)
    this.emitFarmUi()
    return result
  },
  farmAt(point) {
    const edit=this.page.data.farmEditMode
    if(!edit&&!this.characterSelected)return null
    const p=this.unproject(point.x,point.y)
    for(const plot of this.gardenPlots()) {
      const saved=savedBeds(plot)
      const tile=farmLayout(plot).find((t)=>(edit||saved[t.id])&&Math.abs(p.x-t.x)<=t.size/2&&Math.abs(p.z-t.z)<=t.size/2)
      if(tile)return {...tile,plotId:plot.id}
    }
    return null
  },
  drawFarm(plot) {
    const stamp=Date.now()+this.serverOffset,c=this.ctx,s=this.scale*this.zoom
    if(s<.55)return
    const beds=savedBeds(plot)
    for(const tile of farmLayout(plot)) {
      if(!beds[tile.id]) {
        if(plot.mine&&this.page.data.farmEditMode) {
          const point=this.project(tile.x,tile.z),margin=tile.size*s*2
          if(point.x>=-margin&&point.x<=this.width+margin&&point.y>=-margin&&point.y<=this.height+margin) {
            const nearby=this.page.data.nearbyFarm,selected=nearby&&nearby.plotId===plot.id&&nearby.id===tile.id
            c.save();this.diamond(tile.x,tile.z,tile.size*.46,selected?'rgba(255,244,199,.22)':'rgba(255,255,255,.035)')
            c.strokeStyle=selected?'#fff4c7':'rgba(255,255,255,.25)';c.lineWidth=selected?2:1;c.stroke();c.restore()
          }
        }
        continue
      }
      const crops=this.farmCatalog&&this.farmCatalog.crops,bed=bedView(beds[tile.id],stamp,crops),p=this.project(tile.x,tile.z),size=tile.size*s
      const soils=this.farmCatalog&&this.farmCatalog.soils||SOILS
      const soil=this.farmImage({fileID:soils[bed.stage||'tilled'],columns:1,rows:1,frameSize:256})
      const width=size*2.1
      if(soil)c.drawImage(soil,p.x-width*.5,p.y-width*.75,width,width)
      else this.diamond(tile.x,tile.z,tile.size*.46,bed.stage==='watered'?'#70573e':'#947453')
      if(plot.mine&&this.page.data&&this.page.data.nearbyFarm&&this.page.data.nearbyFarm.plotId===plot.id&&this.page.data.nearbyFarm.id===tile.id) {
        this.diamond(tile.x,tile.z,tile.size*.46,'transparent')
        c.save();c.strokeStyle='#fff4c7';c.lineWidth=2;c.stroke();c.restore()
      }
      if(bed.cropId) {
        const crop=cropById(bed.cropId,crops)||bed.crop,atlas=crop&&crop.atlas,image=this.farmImage(atlas)
        if(image) {
          const frame=growthStage(crop,bed.progress),cell=atlas.frameSize
          c.drawImage(image,frame*cell,0,cell,cell,p.x-width*atlas.anchorX,p.y-width*atlas.anchorY,width,width)
          continue
        }
        const growth=.35+bed.progress/155
        c.save();c.translate(p.x,p.y)
        c.strokeStyle='#52764b';c.lineWidth=Math.max(1,size*.07)
        c.beginPath();c.moveTo(0,0);c.lineTo(0,-size*.65*growth);c.stroke()
        c.fillStyle='#77a261';c.beginPath();c.ellipse(-size*.13,-size*.25*growth,size*.2*growth,size*.09,Math.PI/6,0,Math.PI*2);c.fill()
        c.beginPath();c.ellipse(size*.13,-size*.35*growth,size*.2*growth,size*.09,-Math.PI/6,0,Math.PI*2);c.fill()
        if(bed.progress>45){c.fillStyle=bed.color;c.beginPath();c.arc(0,-size*.58*growth,size*.17*growth,0,Math.PI*2);c.fill()}
        if(bed.watered){c.fillStyle='#89c9dc';c.beginPath();c.arc(size*.28,-size*.08,Math.max(1,size*.055),0,Math.PI*2);c.fill()}
        c.restore()
      }
    }
  }
}
