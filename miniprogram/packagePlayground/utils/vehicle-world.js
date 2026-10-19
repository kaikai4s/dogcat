const { createNavigation } = require('./navigation')
const { yardLayout, VEHICLE_RADIUS } = require('./yard-layout')
const { VEHICLE_ATLAS:ATLAS,VEHICLE_REAR_ATLAS:REAR_ATLAS } = require('./vehicle-assets')
const { drawVehicleStains } = require('./excretion-system')
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
      vehicleSoiled:!!(car&&(car.soiled||(car.stains&&car.stains.length>0))),
      passengers:((this.vehicles.get(this.drivingVehicleId)||{}).passengers||[]),
      nearbyRide:this.nearbyRideCandidate(),nearbyInvite:this.nearbyRideInvite()}
    const key=JSON.stringify(state)
    if(key!==this.vehicleUiKey){this.vehicleUiKey=key;this.page.setData(state)}
  },
  cleanVehicle(car) {
    const target=car||this.ownVehicle()
    if(!target)return false
    target.stains=[]
    target.soiled=false
    this.onStatus('车辆已清洗干净，焕然一新！')
    this.emitVehicleUi()
    return true
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
      if(car.stains&&car.stains.length) {
        drawVehicleStains(c,car.stains,size,this.excretionImages)
      }
    }
    c.restore()
    if(!overview){
      const isSoiled=!!(car.soiled||(car.stains&&car.stains.length>0))
      const label=isSoiled?'小车（已脏）':'小车'
      const labelColor=isSoiled?'#ba392a':this.ownerNameColor(car.ownerId,car.nameColor)
      const labelY=point.y-size*.66-8
      this.markerLabel(label,point.x,labelY,selected,labelColor)
      const isCarOnline = car.online !== false && (Date.now() + this.serverOffset - (car.lastSeen || 0) < 15000)
      if(!car.mine && !isCarOnline && this.drawOfflineBadge) {
        this.drawOfflineBadge(point.x + Math.max(16, label.length * 6) + 8, labelY)
      }
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
  },
  drawRearVehicle(size,moving,phase) {
    const c=this.ctx,bounce=moving?Math.sin(phase*Math.PI*4)*.003:0
    const project=([length,width,height])=>[
      .60*(width-length)*size,
      (-.33*(length+width)-height-.235+bounce)*size
    ]
    const face=(points,fill,outline='#345371')=>{
      c.beginPath()
      points.map(project).forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y))
      c.closePath();c.fillStyle=fill;c.fill()
      if(outline){c.strokeStyle=outline;c.lineWidth=size*.004;c.stroke()}
    }
    const wheel=(length,width)=>{
      const [x,y]=project([length,width,.065])
      c.save();c.translate(x,y);c.rotate(.476)
      const oval=(rx,ry,color)=>{c.beginPath();c.ellipse(0,0,rx*size,ry*size,0,0,Math.PI*2);c.fillStyle=color;c.fill()}
      oval(.058,.078,'#24313e');oval(.037,.055,'#bec9d1');oval(.027,.043,'#6e8294')
      c.strokeStyle='#e0e6e9';c.lineWidth=size*.005
      const spin=moving?phase*Math.PI*24:0
      for(let i=0;i<5;i++) {
        const a=spin+i*Math.PI*2/5
        c.beginPath();c.moveTo(0,0);c.lineTo(Math.cos(a)*size*.027,Math.sin(a)*size*.043);c.stroke()
      }
      oval(.011,.014,'#e3e8eb');c.restore()
    }
    c.save()
    c.fillStyle='rgba(35,50,58,.16)';c.beginPath();c.ellipse(0,-size*.235,size*.44,size*.1,.476,0,Math.PI*2);c.fill()
    wheel(-.34,.255);wheel(.34,.255)
    face([[.54,-.22,.10],[.54,.22,.10],[.54,.22,.19],[.49,.23,.23],[.49,-.23,.23],[.54,-.22,.19]],'#6394bb')
    face([[.49,-.23,.23],[.49,.23,.23],[.20,.23,.24],[.20,-.23,.24]],'#9cbdd5')
    face([[.54,-.22,.10],[-.52,-.22,.10],[-.54,-.235,.21],[-.48,-.24,.24],[.49,-.23,.23],[.54,-.22,.19]],'#719fc4')
    face([[-.54,-.235,.21],[-.54,.235,.21],[-.48,.24,.24],[-.48,-.24,.24]],'#78a6c8')
    face([[-.48,-.24,.24],[-.48,.24,.24],[-.27,.23,.25],[-.27,-.23,.25]],'#a1c1d9')
    face([[.20,-.23,.24],[.20,.23,.24],[.08,.19,.34],[.08,-.19,.34]],'#56758e')
    face([[.20,-.23,.24],[.08,-.19,.34],[-.15,-.19,.34],[-.29,-.23,.25]],'#83adcc')
    face([[.08,-.19,.34],[.08,.19,.34],[-.15,.19,.34],[-.15,-.19,.34]],'#a9c9df')
    face([[-.15,-.19,.34],[-.15,.19,.34],[-.29,.23,.25],[-.29,-.23,.25]],'#7d9db6')
    face([[-.15,-.165,.324],[-.15,.165,.324],[-.265,.195,.267],[-.265,-.195,.267]],'#334e67')
    face([[.16,-.234,.257],[.065,-.198,.323],[-.025,-.198,.323],[-.025,-.235,.257]],'#3a556c')
    face([[-.045,-.235,.257],[-.045,-.198,.323],[-.14,-.198,.323],[-.255,-.234,.267]],'#3a556c')
    const rear=(width,height)=>[-.542,width,height]
    face([rear(-.235,.21),rear(.235,.21),rear(.22,.10),rear(-.22,.10)],'#5d8eb6')
    for(const [a,b] of [[-.215,-.115],[.115,.215]]) {
      face([rear(a,.158),rear(b,.158),rear(b,.199),rear(a,.199)],'#b74e52','#81494f')
      face([rear(a,.162),rear(b,.162),rear(b,.174),rear(a,.174)],'#f5b3a2',null)
    }
    face([rear(-.065,.112),rear(.065,.112),rear(.065,.15),rear(-.065,.15)],'#edf0e8','#567388')
    face([rear(-.205,.10),rear(.205,.10),rear(.205,.114),rear(-.205,.114)],'#456d91',null)
    const side=(length,height)=>[length,-.244,height]
    face([side(-.04,.12),side(-.04,.24),side(-.032,.24),side(-.032,.12)],'#5d85a6',null)
    face([side(.06,.22),side(.12,.22),side(.12,.23),side(.06,.23)],'#c6d8e3',null)
    face([side(-.22,.22),side(-.16,.22),side(-.16,.23),side(-.22,.23)],'#c6d8e3',null)
    wheel(.34,-.255);wheel(-.34,-.255)
    c.restore()
  }
}
