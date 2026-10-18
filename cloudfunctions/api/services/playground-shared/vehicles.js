const world = require('../playground-world')
const { transaction } = require('../playground-transaction')
const { createNavigation } = require('./navigation')
const { yardLayout, VEHICLE_RADIUS } = require('./yard-layout')
const COLLECTION = 'pet_playground_plots'
const vehicleId = (openid) => 'vehicle_' + world.hash(openid)
const presenceId = (openid) => 'presence_' + world.hash(openid)
const instance = (plot) => plot.instanceId || plot.createdAt || ''
const multiplier = (value) => Math.max(2, Math.min(5, Number(value) || 2))
function vehicleNavigation(cfg, plots) {
  return createNavigation({minX:0,minZ:0,maxX:cfg.width,maxZ:cfg.height}, plots.map((p)=>{
    const h=(p.size||48)/2
    return {minX:p.x-h,maxX:p.x+h,minZ:p.z-h,maxZ:p.z+h}
  }), VEHICLE_RADIUS, 1.5)
}
module.exports = function vehicles(context, hooks) {
  const {db}=context, {read,check,publish,rows,safePoint}=hooks
  const now=()=>context.nowMs?context.nowMs():Date.now()
  const save=async(tx,id,row)=>{const {_id,...data}=row;await tx.collection(COLLECTION).doc(id).set({data});return {...data,_id:id}}
  function parked(openid,plot,user,epoch) {
    return {kind:'vehicle',ownerOpenid:openid,communityId:plot.communityId,plotId:plot.plotId||plot._id,
      plotInstanceId:instance(plot),name:String(user.nickname||plot.ownerName||'邻居').slice(0,20),state:'parked',
      nameColor:plot.nameColor||'',
      position:yardLayout(plot).parking,mirrored:false,moving:false,online:false,lastSeen:now(),
      speedMultiplier:multiplier(user.playgroundVehicleSpeed),revision:epoch,seq:0,facing:'sw',passengers:[]}
  }
  async function ensure(openid) {
    const id=vehicleId(openid),stamp=now()
    const state=await transaction(db,async(tx)=>{
      const plot=await read(tx,world.ownerId(openid))
      if(!plot)return null
      const old=await read(tx,id)
      if(old&&old.communityId===plot.communityId&&old.plotId===plot.plotId&&old.plotInstanceId===instance(plot)) {
        if (old.nameColor === plot.nameColor) return {car:old}
        old.nameColor=plot.nameColor||'';old.revision=Math.max(stamp,(old.revision||0)+1)
        return {car:await save(tx,id,old)}
      }
      const users=(await tx.collection('users').where({openid}).limit(1).get()).data||[]
      const epoch=await hooks.nextEpoch(plot.communityId,id,Math.max(stamp,(old&&old.revision||0)+1))
      const car=await save(tx,id,parked(openid,plot,users[0]||{},epoch))
      const actor=await read(tx,presenceId(openid))
      let released=null
      if(actor&&actor.vehicleId) {
        actor.vehicleId='';actor.moving=false;actor.sessionStarted=Math.max(stamp,(actor.sessionStarted||0)+1)
        released=await save(tx,presenceId(openid),actor)
      }
      return {car,actor:released}
    })
    if(state){await publish(state.car);if(state.actor)await publish(state.actor)}
    return state&&state.car
  }
  // Entering another scene parks the home car; re-entering home restores a driver.
  async function onEnter(tx,openid,sceneId,actor,home,cfg,plots) {
    const car=await read(tx,vehicleId(openid))
    actor.vehicleId=''
    actor.vehicleRole=''
    if(!car||!home||car.plotId!==home.plotId||car.plotInstanceId!==instance(home))return null
    if(car.communityId!==sceneId) {
      if(car.state==='parked'&&car.name===actor.name)return null
      Object.assign(car,{state:'parked',position:yardLayout(home).parking,moving:false,online:false,lastSeen:now(),revision:Math.max(now(),car.revision+1),seq:0})
    } else if(car.state==='driving') {
      car.position=safePoint(vehicleNavigation(cfg,plots),car.position)
      actor.vehicleId=car._id;actor.vehicleRole='driver';actor.position={...car.position}
      actor.facing=car.facing||'sw';actor.mirrored=!!car.mirrored
      Object.assign(car,{moving:false,online:true,lastSeen:now(),revision:Math.max(now(),car.revision+1),seq:0})
    } else if(car.name===actor.name)return null
    else car.revision=Math.max(now(),car.revision+1)
    car.name=actor.name
    return save(tx,vehicleId(openid),car)
  }
  async function action(openid,user,data) {
    if(!['start','enter','exit','garage'].includes(data.operation))throw new Error('未知车辆操作')
    if(data.vehicleId!==vehicleId(openid))throw new Error('只能操作自己的车辆')
    const [cfg,plots]=await Promise.all([hooks.config(),rows(data.sceneId,'plot')])
    const result=await transaction(db,async(tx)=>{
      const actor=await check(openid,data,tx),car=await read(tx,data.vehicleId),home=await read(tx,world.ownerId(openid)),records=[]
      if(actor.active===false||!car||car.ownerOpenid!==openid||!home||home.communityId!==actor.communityId||car.communityId!==actor.communityId||car.plotId!==home.plotId||car.plotInstanceId!==instance(home))throw new Error('请回到自己的庭院操作车辆')
      const nav=vehicleNavigation(cfg,plots),stamp=now()
      const characterNav=hooks.publicNavigation(cfg,plots,await hooks.access(openid,plots,tx))
      const nearby=()=>Math.hypot(actor.position.x-car.position.x,actor.position.z-car.position.z)<=6&&characterNav.clearSegment(actor.position,car.position)
      if(data.operation==='start') {
        if(car.state!=='parked'||actor.vehicleId)throw new Error('车辆已经启动')
        car.position=safePoint(nav,{x:home.x,z:home.z+(home.size||48)/2+2});car.state='outside'
      } else if(data.operation==='enter') {
        if(car.state!=='outside'||actor.vehicleId||!nearby())throw new Error('请先走近自己的车辆再上车')
        actor.vehicleId=car._id;actor.vehicleRole='driver';actor.position={...car.position};car.state='driving'
        actor.facing=car.facing||'sw';actor.mirrored=!!car.mirrored
        records.push(await hooks.companions.transport(tx,actor,car,true,cfg,plots))
      } else if(data.operation==='exit') {
        if(car.state!=='driving'||actor.vehicleId!==car._id)throw new Error('你还没有进入车辆')
        // Exit onto public ground, even next to a friend's yard or at the map edge.
        let position=null
        for(const [dx,dz] of [[3.5,0],[-3.5,0],[0,3.5],[0,-3.5]]) {
          const p={x:car.position.x+dx,z:car.position.z+dz}
          if(nav.walkable(p)&&characterNav.clearSegment(car.position,p)) {position=p;break}
        }
        if(!position)throw new Error('车旁空间不足，请先驶到开阔处再下车')
        records.push(...await hooks.rides.releasePassengers(tx,car,cfg,plots))
        actor.position=position;actor.vehicleId='';actor.vehicleRole='';car.state='outside'
        records.push(await hooks.companions.transport(tx,actor,car,false,cfg,plots))
      } else {
        if(car.state!=='outside'||actor.vehicleId||!nearby())throw new Error('请先下车并走近车辆再入库')
        car.state='parked';car.position=yardLayout(home).parking
      }
      actor.moving=false;actor.running=false;actor.lastSeen=stamp;actor.online=true
      actor.movementCredit=0;actor.movementSpeed=0
      actor.sessionStarted=Math.max(stamp,(actor.sessionStarted||0)+1)
      Object.assign(car,{moving:false,online:car.state==='driving',lastSeen:stamp,revision:Math.max(stamp,(car.revision||0)+1),seq:0})
      return {actor:await save(tx,presenceId(openid),actor),car:await save(tx,vehicleId(openid),car),records:records.filter(Boolean)}
    })
    await Promise.all([publish(result.actor),publish(result.car),...result.records.map(publish)])
    return hooks.response(result)
  }
  async function speed(openid,user,data) {
    if(typeof data.multiplier!=='number'||!Number.isFinite(data.multiplier)||data.multiplier<2||data.multiplier>5)throw new Error('车速须为跑步速度的2～5倍')
    const value=Math.round(data.multiplier*10)/10
    const car=await transaction(db,async(tx)=>{
      await check(openid,data,tx)
      await tx.collection('users').doc(user._id).update({data:{playgroundVehicleSpeed:value}})
      const car=await read(tx,vehicleId(openid))
      if(!car)return null
      car.speedMultiplier=value;car.revision=Math.max(now(),(car.revision||0)+1)
      return save(tx,vehicleId(openid),car)
    })
    if(car)await publish(car)
    return {speedMultiplier:value,vehicle:car&&car.communityId===data.sceneId?hooks.publicRecord(car):null}
  }
  async function sync(tx,openid,actor,data,cfg,plots) {
    if((data.vehicleId||'')!==(actor.vehicleId||''))throw new Error('上下车状态已更新，请同步车辆')
    if(!actor.vehicleId)return null
    if(actor.vehicleRole==='passenger') {
      const car=await read(tx,actor.vehicleId)
      if(!car||car.state!=='driving'||car.communityId!==actor.communityId||!(car.passengers||[]).some((p)=>p.id===actor._id))throw new Error('上下车状态已更新，请同步车辆')
      return car
    }
    const car=await read(tx,vehicleId(openid)),home=await read(tx,world.ownerId(openid))
    if(!car||car._id!==actor.vehicleId||car.state!=='driving'||car.communityId!==actor.communityId||!home||car.plotId!==home.plotId||car.plotInstanceId!==instance(home))throw new Error('车辆状态已更新，请重新进入场景')
    return car
  }
  async function saveMovement(tx,car,actor) {
    Object.assign(car,{position:{...actor.position},mirrored:actor.mirrored,facing:actor.facing||car.facing||'sw',moving:actor.moving,online:actor.online,lastSeen:actor.lastSeen,seq:(car.seq||0)+1})
    return save(tx,car._id,car)
  }
  return {ensure,onEnter,action,speed,sync,saveMovement}
}
module.exports.vehicleId=vehicleId
module.exports.vehicleNavigation=vehicleNavigation
