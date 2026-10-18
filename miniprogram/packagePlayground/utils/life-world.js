const {needsView}=require('./pet-needs')
const {farmLayout,bedReach,bedView}=require('./farm-model')
module.exports={
  ...require('./vehicle-rear'),
  petNeeds(pet) {return needsView(pet,Date.now()+this.serverOffset)},
  petActivity(pet) {
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
  nearbyFarmTile() {
    if(!this.ownPlot||!this.character||this.drivingVehicleId||this.placing||this.destroyed||this.isMapOverview()||!this.characterTerrain||!this.characterAreaLoaded(this.characterTerrain))return null
    const p=this.character.position,nav=this.characterNavigation()
    const tiles=farmLayout(this.ownPlot).filter((t)=>Math.hypot(t.x-p.x,t.z-p.z)<=bedReach(t)&&nav.clearSegment(p,t))
    return tiles.find((t)=>t.id===this.farmTargetBed)||tiles.sort((a,b)=>Math.hypot(a.x-p.x,a.z-p.z)-Math.hypot(b.x-p.x,b.z-p.z))[0]||null
  },
  emitFarmUi() {
    const tile=this.nearbyFarmTile(),page=this.page
    if(tile&&page.ensureFarm)page.ensureFarm().catch(()=>{})
    const farm=page.data&&page.data.farm
    const bed=tile&&farm&&farm.plotId===this.ownPlot.id?farm.beds.find((b)=>b.id===tile.id):null
    const nearby=tile?{...tile,...(bed||{}),loaded:!!bed}:null,key=JSON.stringify(nearby)
    if(key!==this.farmUiKey){this.farmUiKey=key;page.setData({nearbyFarm:nearby})}
  },
  async moveToFarmBed(id) {
    if(!this.ownPlot||!this.character||this.drivingVehicleId)return false
    const tile=farmLayout(this.ownPlot).find((t)=>t.id===id)
    if(!tile)return false
    this.farmTargetBed=id
    if(this.page.ensureFarm)this.page.ensureFarm().catch(()=>{})
    this.selectCharacter()
    const nav=this.characterNavigation(),offset=tile.size*.65
    const target=[{x:tile.x,z:tile.z+offset},{x:tile.x-offset,z:tile.z},{x:tile.x+offset,z:tile.z},{x:tile.x,z:tile.z-offset},tile].find((p)=>nav.walkable(p)&&nav.clearSegment(p,tile))
    if(!target){this.onStatus('这块土地暂时无法靠近');return false}
    const result=await this.moveCharacterTo(target)
    this.emitFarmUi()
    return result
  },
  farmAt(point) {
    if(!this.ownPlot)return null
    const p=this.unproject(point.x,point.y)
    return farmLayout(this.ownPlot).find((tile)=>Math.abs(p.x-tile.x)<tile.size*.6&&Math.abs(p.z-tile.z)<tile.size*.6)
  },
  drawFarm(plot) {
    const stamp=Date.now()+this.serverOffset,c=this.ctx,s=this.scale*this.zoom
    if(s<.55)return
    const beds=new Map((plot.farmBeds||[]).map((b)=>[b.id,b]))
    for(const tile of farmLayout(plot)) {
      const bed=bedView(beds.get(tile.id),stamp),p=this.project(tile.x,tile.z),size=tile.size*s
      this.diamond(tile.x,tile.z,tile.size*.46,bed.state==='wild'?'#8ca76e':bed.state==='ready'?'#b49c65':'#947453')
      if(plot.mine&&this.page.data&&this.page.data.nearbyFarm&&this.page.data.nearbyFarm.id===tile.id) {
        c.save();c.strokeStyle='#fff4c7';c.lineWidth=2;c.stroke();c.restore()
      }
      if(bed.cropId) {
        const growth=.35+bed.progress/155
        c.save();c.translate(p.x,p.y)
        c.strokeStyle='#52764b';c.lineWidth=Math.max(1,size*.07)
        c.beginPath();c.moveTo(0,0);c.lineTo(0,-size*.65*growth);c.stroke()
        c.fillStyle='#77a261';c.beginPath();c.ellipse(-size*.13,-size*.25*growth,size*.2*growth,size*.09,Math.PI/6,0,Math.PI*2);c.fill()
        c.beginPath();c.ellipse(size*.13,-size*.35*growth,size*.2*growth,size*.09,-Math.PI/6,0,Math.PI*2);c.fill()
        if(bed.progress>45){c.fillStyle=bed.color;c.beginPath();c.arc(0,-size*.58*growth,size*.17*growth,0,Math.PI*2);c.fill()}
        if(bed.state==='ready'){c.fillStyle='#fff0b3';c.font=Math.max(10,size*.45)+'px sans-serif';c.textAlign='center';c.fillText('✦',0,-size*.95)}
        if(bed.watered){c.fillStyle='#89c9dc';c.beginPath();c.arc(size*.28,-size*.08,Math.max(1,size*.055),0,Math.PI*2);c.fill()}
        c.restore()
      }
    }
    if(plot.mine) {const p=this.project(plot.x+17.5,plot.z-31);this.markerLabel('我的菜园 · 走近土地照料',p.x,p.y-10)}
  }
}
