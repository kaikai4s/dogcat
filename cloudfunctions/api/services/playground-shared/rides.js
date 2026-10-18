const {transaction}=require('../playground-transaction')
const world=require('../playground-world')
const {vehicleNavigation}=require('./vehicles')
const COLLECTION='pet_playground_plots'
const playerId=(openid)=>'presence_'+world.hash(openid)
const CAPACITY=3
module.exports=function createRides(context,hooks) {
  const {db}=context,now=()=>context.nowMs?context.nowMs():Date.now()
  async function save(tx,row,kind='presence') {
    const {_id,...data}=row
    if(kind==='presence')data.sessionStarted=Math.max(now(),(row.sessionStarted||0)+1)
    else data.revision=Math.max(now(),(row.revision||0)+1)
    await tx.collection(COLLECTION).doc(_id).set({data})
    return {...data,_id}
  }
  function available(actor) {return actor&&actor.active&&actor.online&&now()-actor.lastSeen<15000}
  async function pair(tx,driver,passenger,cfg,plots) {
    if(!available(driver)||!available(passenger)||driver.communityId!==passenger.communityId||passenger.vehicleId||driver.vehicleRole==='passenger')throw new Error('对方已离开、下车或正在乘车，请重新靠近')
    const car=driver.vehicleId&&await hooks.read(tx,driver.vehicleId)
    if(!car||car.ownerOpenid!==driver.ownerOpenid||car.state!=='driving'||car.communityId!==driver.communityId)throw new Error('对方当前没有驾驶车辆')
    if(car.moving&&now()-car.lastSeen<1000)throw new Error('请先停车，再邀请或申请上车')
    const nav=hooks.publicNavigation(cfg,plots,await hooks.social.access(passenger.ownerOpenid,plots,tx))
    if(Math.hypot(passenger.position.x-car.position.x,passenger.position.z-car.position.z)>7||!nav.clearSegment(passenger.position,car.position))throw new Error('距离太远，请先走到车旁')
    if((car.passengers||[]).length>=CAPACITY)throw new Error('车内已满员，最多搭载3位乘客')
    return car
  }
  async function response(openid,records=[],message='') {
    await Promise.all(records.filter(Boolean).map(hooks.publish))
    return {social:await hooks.social.state(openid),records:records.filter(Boolean).map(hooks.publicRecord),serverTime:now(),message}
  }
  async function request(openid,data) {
    if(!['invite','request'].includes(data.operation))throw new Error('未知乘车操作')
    if(!/^presence_[a-f0-9]{32}$/.test(data.playerId||'')||data.playerId===playerId(openid))throw new Error('请选择附近的其他角色')
    const cfg=await hooks.config(),plots=await hooks.rows(data.sceneId,'plot')
    const other=await transaction(db,async(tx)=>{
      const a=await hooks.check(openid,data,tx),b=await hooks.read(tx,data.playerId)
      const driver=data.operation==='invite'?a:b,passenger=data.operation==='invite'?b:a
      const car=await pair(tx,driver,passenger,cfg,plots)
      const own=await hooks.social.book(openid,tx),target=await hooks.social.book(b.ownerOpenid,tx)
      const type=data.operation==='invite'?'rideInvite':'rideRequest',id=type+'_'+playerId(openid)+'_'+world.hash(car._id)
      const previous=target.incoming[id]
      if(previous&&previous.status==='pending'&&previous.expiresAt>now())return b.ownerOpenid
      if(previous&&now()-previous.createdAt<10000)throw new Error('邀请刚处理过，请稍后再试')
      for(const book of [own,target])if(Object.values(book===own?book.outgoing:book.incoming).filter((r)=>r.status==='pending'&&(!r.expiresAt||r.expiresAt>now())).length>=100)throw new Error('待处理申请较多，请稍后再试')
      const common={id,type,status:'pending',vehicleId:car._id,plotInstanceId:car.plotInstanceId,createdAt:now(),expiresAt:now()+60000,
        driverId:driver._id,passengerId:passenger._id,driverSession:driver.session,passengerSession:passenger.session}
      own.outgoing[id]={...common,playerId:b._id,name:b.name}
      target.incoming[id]={...common,openid,playerId:a._id,name:a.name}
      await hooks.social.save(tx,openid,own);await hooks.social.save(tx,b.ownerOpenid,target)
      return b.ownerOpenid
    })
    await hooks.social.state(other)
    return response(openid,[],'已发送，等待对方同意')
  }
  async function respond(openid,data) {
    const cfg=await hooks.config(),plots=await hooks.rows(data.sceneId,'plot')
    const result=await transaction(db,async(tx)=>{
      await hooks.check(openid,data,tx)
      const mine=await hooks.social.book(openid,tx),r=mine.incoming[String(data.requestId||'')]
      if(!r||!['rideInvite','rideRequest'].includes(r.type))throw new Error('乘车申请不存在')
      if(r.status!=='pending')return {other:r.openid,records:[]}
      if(r.expiresAt<=now())throw new Error('乘车申请已过期，请重新申请')
      const sender=await hooks.social.book(r.openid,tx),records=[]
      if(data.accept===true) {
        const driver=await hooks.read(tx,r.driverId),passenger=await hooks.read(tx,r.passengerId)
        const car=await pair(tx,driver,passenger,cfg,plots)
        if(car._id!==r.vehicleId||car.plotInstanceId!==r.plotInstanceId||driver.session!==r.driverSession||passenger.session!==r.passengerSession)throw new Error('车辆或场景已变化，请重新发起邀请')
        passenger.vehicleId=car._id;passenger.vehicleRole='passenger';passenger.position={...car.position}
        passenger.moving=false;passenger.running=false;passenger.lastSeen=now();passenger.movementCredit=0
        const resident=await hooks.companions.transport(tx,passenger,car,true,cfg,plots)
        car.passengers=[...(car.passengers||[]),{id:passenger._id,openid:passenger.ownerOpenid,name:passenger.name}]
        records.push(await save(tx,passenger),await save(tx,car,'vehicle'),resident)
      }
      r.status=data.accept===true?'accepted':'rejected'
      if(sender.outgoing[r.id])sender.outgoing[r.id].status=r.status
      await hooks.social.save(tx,openid,mine);await hooks.social.save(tx,r.openid,sender)
      return {other:r.openid,records}
    })
    await hooks.social.state(result.other)
    return response(openid,result.records,data.accept===true?'已一起上车':'已婉拒乘车申请')
  }
  function exitPosition(car,cfg,plots,index=0) {
    const nav=vehicleNavigation(cfg,plots)
    const preferred={x:car.position.x+3.5+(index%2)*2,z:car.position.z+Math.floor(index/2)*2}
    const point=hooks.safePoint(nav,preferred)
    // A safe endpoint on the other side of a wall is not a safe exit.
    if(nav.clearSegment(car.position,point))return point
    for(const [dx,dz] of [[-3.5,0],[0,3.5],[0,-3.5]]) {
      const p={x:car.position.x+dx,z:car.position.z+dz}
      if(nav.walkable(p)&&nav.clearSegment(car.position,p))return p
    }
    throw new Error('车旁空间不足，请先驶到开阔处再下车')
  }
  async function releaseOne(tx,actor,car,cfg,plots,index=0) {
    actor.position=exitPosition(car,cfg,plots,index);actor.vehicleId='';actor.vehicleRole=''
    actor.moving=false;actor.running=false;actor.movementCredit=0;actor.lastSeen=now()
    const resident=await hooks.companions.transport(tx,actor,car,false,cfg,plots)
    return [await save(tx,actor),resident].filter(Boolean)
  }
  async function releasePassengers(tx,car,cfg,plots) {
    const records=[]
    for(const [index,member] of (car.passengers||[]).entries()) {
      const actor=await hooks.read(tx,member.id)
      if(actor&&actor.vehicleId===car._id&&actor.communityId===car.communityId)records.push(...await releaseOne(tx,actor,car,cfg,plots,index+1))
    }
    car.passengers=[]
    return records
  }
  async function leave(openid,data) {
    const cfg=await hooks.config(),plots=await hooks.rows(data.sceneId,'plot')
    const records=await transaction(db,async(tx)=>{
      const actor=await hooks.check(openid,data,tx)
      if(actor.vehicleRole!=='passenger'||!actor.vehicleId)throw new Error('你当前没有搭乘车辆')
      const car=await hooks.read(tx,actor.vehicleId)
      const current=car||{_id:actor.vehicleId,position:actor.position,passengers:[]}
      const rows=await releaseOne(tx,actor,current,cfg,plots)
      if(car) {car.passengers=(car.passengers||[]).filter((p)=>p.id!==actor._id);rows.push(await save(tx,car,'vehicle'))}
      return rows
    })
    return response(openid,records,'已与同行宠物一起下车')
  }
  async function prepareEntry(openid,nextSceneId) {
    const actor=await hooks.read(db,playerId(openid))
    if(!actor||!actor.vehicleId||actor.vehicleRole!=='passenger'&&actor.communityId===nextSceneId)return
    const cfg=await hooks.config(),plots=await hooks.rows(actor.communityId,'plot')
    const records=await transaction(db,async(tx)=>{
      const current=await hooks.read(tx,playerId(openid))
      if(!current||!current.vehicleId)return []
      const car=await hooks.read(tx,current.vehicleId)
      if(!car)return releaseOne(tx,current,{_id:current.vehicleId,position:current.position},cfg,plots)
      if(current.vehicleRole==='passenger') {
        const records=await releaseOne(tx,current,car,cfg,plots)
        car.passengers=(car.passengers||[]).filter((p)=>p.id!==current._id)
        records.push(await save(tx,car,'vehicle'));return records
      }
      const records=await releasePassengers(tx,car,cfg,plots)
      const resident=await hooks.companions.transport(tx,current,car,false,cfg,plots)
      if(resident)records.push(resident)
      records.push(await save(tx,car,'vehicle'));return records
    })
    await Promise.all(records.map(hooks.publish))
  }
  async function beforeDemolish(tx,openid,plot) {
    const cfg=await hooks.config(),plots=await hooks.rows(plot.communityId,'plot'),records=[]
    const actor=await hooks.read(tx,playerId(openid))
    if(actor&&actor.vehicleRole==='passenger'&&actor.vehicleId) {
      const other=await hooks.read(tx,actor.vehicleId)
      if(other) {
        const released=await releaseOne(tx,actor,other,cfg,plots)
        records.push(...released.filter((r)=>r.kind!=='presence'&&r.kind!=='resident'))
        other.passengers=(other.passengers||[]).filter((p)=>p.id!==actor._id)
        records.push(await save(tx,other,'vehicle'))
      }
    }
    const car=await hooks.read(tx,'vehicle_'+world.hash(openid))
    if(car)records.push(...await releasePassengers(tx,car,cfg,plots))
    return records
  }
  return {request,respond,leave,releasePassengers,prepareEntry,exitPosition,beforeDemolish}
}
