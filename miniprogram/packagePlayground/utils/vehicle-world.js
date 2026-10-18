const { createNavigation } = require('./navigation')
const { yardLayout, VEHICLE_RADIUS } = require('./yard-layout')
const { VEHICLE_ATLAS:ATLAS } = require('./vehicle-assets')
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n))
module.exports={
  setVehicleSpeed(value) {
    this.vehicleSpeed=clamp(Number(value)||2,2,5)
    if(this.character)this.character.vehicleSpeed=this.drivingVehicleId?14*this.vehicleSpeed:0
    if(!this.page.data||this.page.data.vehicleSpeed!==this.vehicleSpeed)this.page.setData({vehicleSpeed:this.vehicleSpeed})
  },
  applyOwnVehicleActor(actor,force=false) {
    if(!this.character)return
    const id=actor.deleted?'':actor.vehicleId||''
    if(force||id!==this.drivingVehicleId) {
      this.setCharacterInput(0,0)
      this.clearPetSelection()
      if(actor.position)this.character.position={...actor.position}
      this.sceneTrail=[];this.characterTerrain=null
      this.drivingVehicleId=id
      this.character.vehicleSpeed=id?14*this.vehicleSpeed:0
      this.prepareCharacterArea().catch(()=>{})
    }
    this.emitVehicleUi()
  },
  applyVehicle(record) {
    if(record.deleted) {this.vehicles.delete(record.id);this.emitVehicleUi();return}
    const previous=this.vehicles.get(record.id)
    const same=previous&&previous.lastSeen===record.lastSeen&&previous.state===record.state&&previous.position.x===record.position.x&&previous.position.z===record.position.z&&previous.moving===record.moving
    if(same) {this.vehicles.set(record.id,{...previous,...record})}
    else {
      const stamp=Date.now(),seconds=previous?Math.max(.05,(record.lastSeen-previous.lastSeen)/1000):1
      let vx=previous?(record.position.x-previous.position.x)/seconds:0,vz=previous?(record.position.z-previous.position.z)/seconds:0
      const speed=Math.hypot(vx,vz),limit=14*clamp(record.speedMultiplier||2,2,5)
      if(speed>limit) {vx*=limit/speed;vz*=limit/speed}
      const transition=!previous||record.state!==previous.state
      this.vehicles.set(record.id,{...record,from:transition?record.position:this.neighborPosition(previous),received:stamp,
        interval:previous?clamp((stamp-previous.received)*.5+(previous.interval||100)*.5,80,600):100,
        velocity:transition?{x:0,z:0}:{x:vx,z:vz},renderDistance:previous&&previous.renderDistance||0,renderPosition:!transition&&previous.renderPosition,
        predictionNav:createNavigation(this.bounds,this.plots().flatMap((p)=>this.solidPlot(p)),VEHICLE_RADIUS,1.5)})
    }
    if(record.mine)this.setVehicleSpeed(record.speedMultiplier)
    this.emitVehicleUi()
  },
  replaceVehicles(records) {
    const ids=new Set(records.map((r)=>r.id))
    for(const id of this.vehicles.keys())if(!ids.has(id))this.vehicles.delete(id)
    for(const row of records)this.applyVehicle(row)
    this.emitVehicleUi()
  },
  ownVehicle() {return [...this.vehicles.values()].find((r)=>r.mine)},
  vehiclePosition(car) {
    return car.mine&&this.drivingVehicleId===car.id&&this.character?this.character.position:this.neighborPosition(car)
  },
  vehicleSize(car) {
    const plot=car.state==='parked'&&this.plots().find((p)=>p.id===car.plotId)
    return plot?yardLayout(plot).vehicleSize:ATLAS.size
  },
  emitVehicleUi() {
    if(!this.vehicles)return
    const car=this.ownVehicle(),driving=!!this.drivingVehicleId,selected=!!car&&car.id===this.selectedVehicleId
    const p=this.character&&this.character.position
    const nearby=!!car&&car.state==='outside'&&!driving&&!!p&&Math.hypot(p.x-car.position.x,p.z-car.position.z)<=6&&
      !!this.characterTerrain&&this.characterAreaLoaded(this.characterTerrain)&&this.characterNavigation().clearSegment(p,car.position)
    const state={driving,vehicleSelected:selected,vehicleParked:!!car&&car.state==='parked',nearbyVehicle:nearby,
      ownVehicleId:car?car.id:''}
    const key=JSON.stringify(state)
    if(key!==this.vehicleUiKey){this.vehicleUiKey=key;this.page.setData(state)}
  },
  selectVehicle(car) {
    this.clearPetSelection()
    if(!car.mine) {this.onStatus('这是邻居的车辆，只能操作自己的车');return false}
    this.selectedVehicleId=car.id
    this.emitVehicleUi()
    this.onStatus(car.state==='parked'?'已选中自己的车 · 启动后车辆停在院门外':this.drivingVehicleId===car.id?'已选中车辆 · 点击空地驾驶，或使用摇杆':'请走近车辆上车，或将车辆入库')
    return true
  },
  vehicleAt(point) {
    return [...this.vehicles.values()].sort((a,b)=>{
      const p=this.vehiclePosition(a),q=this.vehiclePosition(b);return q.x+q.z-p.x-p.z
    }).find((car)=>{
      const p=this.vehiclePosition(car),s=this.project(p.x,p.z)
      const size=this.isMapOverview()?22:Math.max(28,this.vehicleSize(car)*this.scale*this.zoom)
      return Math.abs(point.x-s.x)<=size*.47&&point.y>=s.y-size*ATLAS.anchor&&point.y<=s.y+size*.08
    })
  },
  loadVehicleAtlas() {
    if(!this.loader||this.vehicleImage||this.vehicleImagePromise||Date.now()<(this.vehicleRetryAt||0))return
    this.vehicleImagePromise=this.loader.loadAtlas(ATLAS).then((img)=>{if(!this.destroyed)this.vehicleImage=img})
      .catch(()=>{this.vehicleRetryAt=Date.now()+15000}).finally(()=>{this.vehicleImagePromise=null})
  },
  drawVehicle(car,overview) {
    const position=this.vehiclePosition(car),point=this.project(position.x,position.z),c=this.ctx
    const size=this.vehicleSize(car)*this.scale*this.zoom
    if(point.x < -size||point.x>this.width+size||point.y < -size||point.y>this.height+size)return
    this.loadVehicleAtlas()
    const selected=car.id===this.selectedVehicleId
    const mineDriving=car.mine&&car.id===this.drivingVehicleId&&this.character
    const moving=mineDriving?this.character.moving:car.moving&&car.online&&Date.now()+this.serverOffset-car.lastSeen<3000
    if(car.renderPosition&&moving)car.renderDistance=(car.renderDistance||0)+Math.hypot(position.x-car.renderPosition.x,position.z-car.renderPosition.z)
    car.renderPosition={...position}
    const phase=mineDriving?this.character.animationPhase:(car.renderDistance||0)/20%1
    c.save();c.translate(point.x,point.y)
    if(selected){c.strokeStyle='#efae36';c.lineWidth=2;c.beginPath();c.ellipse(0,0,Math.max(12,size*.4),Math.max(6,size*.14),0,0,Math.PI*2);c.stroke()}
    if(overview){c.fillStyle=selected?'#efae36':'#5b8bb3';c.fillRect(-5,-4,10,6)}
    else {
      if(mineDriving?this.character.mirrored:car.mirrored)c.scale(-1,1)
      const img=this.vehicleImage
      if(img){
        const frame=moving?Math.floor(phase*ATLAS.frames)%ATLAS.frames:0,w=img.width/ATLAS.columns,h=img.height/ATLAS.rows
        c.drawImage(img,frame%ATLAS.columns*w,Math.floor(frame/ATLAS.columns)*h,w,h,-size/2,-size*ATLAS.anchor,size,size)
      }else{
        // A small blue vehicle marker remains usable while the atlas downloads.
        c.fillStyle='#273641';c.fillRect(-size*.32,-size*.32,size*.64,size*.16)
        c.fillStyle='#6299c5';c.fillRect(-size*.38,-size*.46,size*.76,size*.24)
        c.fillStyle='#244864';c.fillRect(-size*.18,-size*.43,size*.36,size*.1)
      }
    }
    c.restore()
    if(!overview){
      const online=mineDriving||car.online&&Date.now()+this.serverOffset-car.lastSeen<15000
      const label=(car.name||'邻居')+(car.state==='driving'?(online?'':' · 离线'):'的车')
      this.markerLabel(label,point.x,point.y-size*.66-8,selected)
    }
  }
}
