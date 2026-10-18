const { createNavigation } = require('./navigation')
const { yardLayout, VEHICLE_RADIUS } = require('./yard-layout')
const { VEHICLE_ATLAS:ATLAS,VEHICLE_REAR_ATLAS:REAR_ATLAS } = require('./vehicle-assets')
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n))
module.exports={
  setVehicleSpeed(value) {
    this.vehicleSpeed=clamp(Number(value)||2,2,5)
    if(this.character)this.character.vehicleSpeed=this.drivingVehicleId&&this.vehicleRole!=='passenger'?14*this.vehicleSpeed:0
    if(!this.page.data||this.page.data.vehicleSpeed!==this.vehicleSpeed)this.page.setData({vehicleSpeed:this.vehicleSpeed})
  },
  applyOwnVehicleActor(actor,force=false) {
    if(!this.character)return
    const id=actor.deleted?'':actor.vehicleId||''
    const role=id?(actor.vehicleRole||'driver'):''
    if(force||id!==this.drivingVehicleId||role!==this.vehicleRole) {
      this.setCharacterInput(0,0)
      this.clearPetSelection()
      if(actor.position)this.character.position={...actor.position}
      if(actor.facing)this.character.facing=actor.facing
      if(typeof actor.mirrored==='boolean')this.character.mirrored=actor.mirrored
      this.sceneTrail=[];this.characterTerrain=null
      this.drivingVehicleId=id
      this.vehicleRole=role
      this.character.vehicleSpeed=id&&role!=='passenger'?14*this.vehicleSpeed:0
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
    return car.mine&&this.vehicleRole!=='passenger'&&this.drivingVehicleId===car.id&&this.character?this.character.position:this.neighborPosition(car)
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
      ownVehicleId:car?car.id:'',riding:this.vehicleRole==='passenger',
      passengers:((this.vehicles.get(this.drivingVehicleId)||{}).passengers||[]),
      nearbyRide:this.nearbyRideCandidate(),nearbyInvite:this.nearbyRideInvite()}
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
    if(!this.loader)return
    for(const [atlas,key] of [[ATLAS,'vehicleImage'],[REAR_ATLAS,'vehicleRearImage']]) {
      if(!atlas||this[key]||this[key+'Promise']||Date.now()<(this[key+'RetryAt']||0))continue
      this[key+'Promise']=this.loader.loadAtlas(atlas).then((img)=>{if(!this.destroyed)this[key]=img})
        .catch(()=>{this[key+'RetryAt']=Date.now()+15000}).finally(()=>{this[key+'Promise']=null})
    }
  },
  drawVehicle(car,overview) {
    const position=this.vehiclePosition(car),point=this.project(position.x,position.z),c=this.ctx
    const size=this.vehicleSize(car)*this.scale*this.zoom
    if(point.x < -size||point.x>this.width+size||point.y < -size||point.y>this.height+size)return
    this.loadVehicleAtlas()
    const selected=car.id===this.selectedVehicleId
    const mineDriving=car.mine&&this.vehicleRole!=='passenger'&&car.id===this.drivingVehicleId&&this.character
    const moving=mineDriving?this.character.moving:car.moving&&car.online&&Date.now()+this.serverOffset-car.lastSeen<3000
    if(car.renderPosition&&moving)car.renderDistance=(car.renderDistance||0)+Math.hypot(position.x-car.renderPosition.x,position.z-car.renderPosition.z)
    car.renderPosition={...position}
    const phase=mineDriving?this.character.animationPhase:(car.renderDistance||0)/20%1
    c.save();c.translate(point.x,point.y)
    if(selected){c.strokeStyle='#efae36';c.lineWidth=2;c.beginPath();c.ellipse(0,0,Math.max(12,size*.4),Math.max(6,size*.14),0,0,Math.PI*2);c.stroke()}
    if(overview){c.fillStyle=selected?'#efae36':'#5b8bb3';c.fillRect(-5,-4,10,6)}
    else {
      const facing=mineDriving?this.character.facing:car.facing
      const rear=facing==='nw'||facing==='ne'
      const mirrored=rear?facing==='ne':mineDriving?this.character.mirrored:car.mirrored
      if(mirrored)c.scale(-1,1)
      const atlas=rear?REAR_ATLAS:ATLAS,img=rear?this.vehicleRearImage:this.vehicleImage
      if(img&&atlas){
        const frame=moving?Math.floor(phase*atlas.frames)%atlas.frames:0,w=img.width/atlas.columns,h=img.height/atlas.rows
        c.drawImage(img,frame%atlas.columns*w,Math.floor(frame/atlas.columns)*h,w,h,-size/2,-size*atlas.anchor,size,size)
      }else if(rear)this.drawRearVehicle(size,moving,phase)
      else{
        // A small blue vehicle marker remains usable while the atlas downloads.
        c.fillStyle='#273641';c.fillRect(-size*.32,-size*.32,size*.64,size*.16)
        c.fillStyle='#6299c5';c.fillRect(-size*.38,-size*.46,size*.76,size*.24)
        c.fillStyle='#244864';c.fillRect(-size*.18,-size*.43,size*.36,size*.1)
      }
    }
    c.restore()
    if(!overview){
      const online=mineDriving||car.online&&Date.now()+this.serverOffset-car.lastSeen<15000
      const label=(car.name||'邻居')+(car.state==='driving'?(online?'':' · 离线'):'的车')+((car.passengers||[]).length?' · '+car.passengers.length+'/3位乘客':'')
      this.markerLabel(label,point.x,point.y-size*.66-8,selected)
    }
  },
  nearbyRideCandidate() {
    if(this.drivingVehicleId||!this.character)return null
    const p=this.character.position
    const car=[...this.vehicles.values()].find((v)=>!v.mine&&v.state==='driving'&&v.online&&Date.now()+this.serverOffset-v.lastSeen<15000&&!v.moving&&(v.passengers||[]).length<3&&Math.hypot(p.x-v.position.x,p.z-v.position.z)<=7&&this.characterNavigation().clearSegment(p,v.position))
    return car?{id:car.id,playerId:car.ownerId,name:car.name}:null
  },
  nearbyRideInvite() {
    if(!this.drivingVehicleId||this.vehicleRole==='passenger'||!this.character||this.character.moving)return null
    const car=this.vehicles.get(this.drivingVehicleId)
    if(!car||(car.passengers||[]).length>=3)return null
    const p=this.character.position
    const person=this.remoteCharacters.find((v)=>!v.vehicleId&&v.online&&Date.now()+this.serverOffset-v.lastSeen<15000&&Math.hypot(p.x-v.position.x,p.z-v.position.z)<=7&&this.characterNavigation().clearSegment(p,v.position))
    return person?{id:person.id,name:person.name}:null
  }
}
