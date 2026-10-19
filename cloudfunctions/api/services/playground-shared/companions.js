const {transaction}=require('../playground-transaction')
const world=require('../playground-world')
const {sampleMotion}=require('./shared-motion')
const {settleNeeds,RECOVERY}=require('./pet-needs')
const {yardLayout}=require('./yard-layout')
const COLLECTION='pet_playground_plots'
const residentId=(openid)=>'resident_'+world.hash(openid)
module.exports=function createCompanions(context,hooks) {
  const {db}=context,now=()=>context.nowMs?context.nowMs():Date.now()
  async function save(tx,resident) {
    resident.revision=Math.max(now(),(resident.revision||0)+1)
    const {_id,...data}=resident
    await tx.collection(COLLECTION).doc(residentId(resident.ownerOpenid)).set({data})
    return {...data,_id:residentId(resident.ownerOpenid)}
  }
  function followRoute(pet,actor,cfg,plots,allowed,index=0) {
    const stamp=now()
    const previous=pet.motion
    let current=sampleMotion(previous,stamp).position
    const nav=hooks.navigation(cfg,plots,current,actor.position,'companion',null,allowed)
    // Expired access or a newly built fence can invalidate an old route.
    if(!nav.walkable(current))current=hooks.safePoint(nav,current)
    // Each pet gets a distinct place around its owner, with a tiny safe patrol.
    const angle=index*2.39996,radius=2.5+Math.floor(index/4)
    const desired={x:actor.position.x+Math.cos(angle)*radius,z:actor.position.z+Math.sin(angle)*radius}
    const target=nav.walkable(desired)&&nav.clearSegment(actor.position,desired)?desired:actor.position
    const route=nav.path(current,target)
    if(!route)return false
    const patrol=[target]
    for(let i=0;i<4;i++) {
      const a=angle+i*Math.PI/2,p={x:actor.position.x+Math.cos(a)*radius,z:actor.position.z+Math.sin(a)*radius}
      if(nav.clearSegment(patrol[patrol.length-1],p)&&nav.clearSegment(p,target))patrol.push(p)
    }
    patrol.push(target)
    // Buffer a new pursuit once. Frequent owner updates keep its original
    // departure time; an already walking pet continues without another pause.
    const waiting=previous.followUntil&&stamp<previous.epoch
    const walking=previous.followUntil&&stamp>=previous.epoch&&stamp<previous.followUntil
    const continuous=pet.followUpdatedAt&&stamp-pet.followUpdatedAt<1800
    const epoch=waiting?previous.epoch:walking||continuous?stamp:stamp+700
    const gap=Math.hypot(current.x-target.x,current.z-target.z)
    const speed=Math.min(16,7+gap*.25)
    let distance=0,last=current
    for(const point of route){distance+=Math.hypot(point.x-last.x,point.z-last.z);last=point}
    pet.motion={epoch,approach:[current,...route],patrol,speed,roamSpeed:2,wait:2,followUntil:epoch+distance/speed*1000}
    pet.followCenter={...actor.position}
    pet.followUpdatedAt=stamp
    return true
  }
  async function action(openid,data) {
    const operation=data.operation
    if(!['follow','stay','eat','sleep','drink','feed'].includes(operation))throw new Error('未知宠物操作')
    const actor=await hooks.check(openid,data),cfg=await hooks.config(),plots=await hooks.rows(data.sceneId,'plot')
    const result=await transaction(db,async(tx)=>{
      const resident=await hooks.read(tx,residentId(openid))
      const currentPet=await world.readDocument(tx,'pets',String(data.petId||''),'读取宠物',true)
      if(!currentPet||currentPet.openid!==openid||currentPet.deletedAt||!resident||resident.communityId!==data.sceneId)throw new Error('只能照料自己当前小区的宠物')
      if(resident.session!==data.session)throw new Error('场景已切换，请重新进入')
      const pet=(resident.pets||[]).find((p)=>p.id===data.petId),stamp=now()
      if(!pet)throw new Error('宠物已离开当前场景')
      if(!Number.isInteger(data.commandSeq)||data.commandSeq<1)throw new Error('无效宠物操作序号')
      if(data.commandSeq<=(resident.petSeq||0)) {
        if(pet.commandSeq===data.commandSeq&&pet.lastOperation===operation)return {resident,pet}
        throw new Error('宠物操作已更新，请重试')
      }
      if((actor.vehicleId||resident.ridingVehicleId||pet.ridingVehicleId)&&operation!=='feed')throw new Error('请先下车再安排宠物活动')
      const current=sampleMotion(pet.motion,stamp).position
      const values=settleNeeds(pet,stamp)
      if(operation==='feed') {
        if(pet.fedAt&&stamp-pet.fedAt<60000)throw new Error('宠物刚吃过零食，过一分钟再喂吧')
        if(values.satiety>=95)throw new Error('宠物已经吃饱啦')
        const effective=pet.ridingVehicleId?actor.position:current
        if(Math.hypot(actor.position.x-effective.x,actor.position.z-effective.z)>5)throw new Error('请先走近宠物再喂食')
        if(!pet.ridingVehicleId&&!hooks.publicNavigation(cfg,plots,await hooks.access(openid,plots,tx)).clearSegment(actor.position,current))throw new Error('请走到宠物身边，不能隔着围栏喂食')
        values.satiety=Math.min(100,values.satiety+25);pet.fedAt=stamp
      } else if(operation==='follow') {
        const allowed=await hooks.access(openid,plots,tx)
        if(Math.hypot(actor.position.x-current.x,actor.position.z-current.z)>300)throw new Error('宠物离你太远，请先靠近一些')
        if(!followRoute(pet,actor,cfg,plots,allowed,resident.pets.indexOf(pet)))throw new Error('宠物暂时无法到你身边，请从院门进出')
        pet.following=true;pet.care=null
        await tx.collection(COLLECTION).doc(actor._id).update({data:{hasFollowers:true}})
      } else if(operation==='stay') {
        pet.following=false;pet.care=null;pet.motion=hooks.motion(cfg,plots,current,stamp,pet.id+'stay')
      } else {
        const home=await hooks.read(tx,world.ownerId(openid))
        if(!home||home.communityId!==actor.communityId||home.plotId!==resident.plotId)throw new Error('请回到自家庭院照料宠物')
        const target=yardLayout(home).stations[pet.species==='cat'?'cat':'dog'][operation]
        const nav=hooks.navigation(cfg,plots,current,target,'pet',resident.plotId),route=nav.path(current,target)
        if(!route)throw new Error('暂时无法到达，请从自家庭院院门进出')
        if(operation==='eat') {
          const species=pet.species==='cat'?'cat':'dog',food={dog:0,cat:0,...home.foodBowls}
          if(food[species]<25)throw new Error('碗里粮食不足，请先添粮')
          food[species]-=25
          await tx.collection(COLLECTION).doc(world.ownerId(openid)).update({data:{foodBowls:food}})
          const plot=await hooks.read(tx,home.plotId)
          if(plot) {plot.foodBowls=food;plot.revision=Math.max(stamp,(plot.revision||0)+1);const {_id,...saved}=plot;await tx.collection(COLLECTION).doc(home.plotId).set({data:saved})}
        }
        let distance=0,previous=current
        for(const point of route){distance+=Math.hypot(point.x-previous.x,point.z-previous.z);previous=point}
        const startsAt=stamp+distance/7*1000,spec=RECOVERY[operation]
        pet.following=false;pet.care={type:operation,startsAt,endsAt:startsAt+spec.seconds*1000}
        pet.motion={epoch:stamp,approach:[current,...route],patrol:[target],speed:7}
      }
      pet.commandSeq=data.commandSeq;pet.lastOperation=operation;resident.petSeq=data.commandSeq
      return {resident:await save(tx,resident),pet}
    })
    await hooks.publish(result.resident)
    if(operation==='eat'){const plot=await hooks.read(db,result.resident.plotId);if(plot)await hooks.publish(plot)}
    return {pet:result.pet,serverTime:now()}
  }
  async function sync(tx,actor,cfg,plots,force=false) {
    if(actor.vehicleId)return null
    const stamp=now()
    if(!force&&stamp-(actor.lastCompanionSync||0)<600)return null
    actor.lastCompanionSync=stamp
    const resident=await hooks.read(tx,residentId(actor.ownerOpenid))
    if(!resident||resident.communityId!==actor.communityId)return null
    let changed=false
    for(const pet of resident.pets||[]) {
      if(pet.care && stamp >= pet.care.endsAt && !pet.ridingVehicleId && !pet.following) {
        settleNeeds(pet, stamp)
        const current=sampleMotion(pet.motion,stamp).position
        const start=hooks.safePoint(hooks.navigation(cfg,plots,current,current,'pet',resident.plotId),current)
        pet.care=null
        pet.motion=hooks.motion(cfg,plots,start,stamp,pet.id+'roam')
        changed=true
      }
    }
    const followers=resident.pets.filter((p)=>p.following&&!p.ridingVehicleId)
    if(followers.length) {
      actor.hasFollowers=true
      const allowed=await hooks.access(actor.ownerOpenid,plots,tx)
      for(const pet of followers) {
        if(!force&&pet.followCenter&&Math.hypot(pet.followCenter.x-actor.position.x,pet.followCenter.z-actor.position.z)<2)continue
        changed=followRoute(pet,actor,cfg,plots,allowed,resident.pets.indexOf(pet))||changed
      }
    } else {
      actor.hasFollowers=false
    }
    return changed?save(tx,resident):null
  }
  async function transport(tx,actor,car,boarding,cfg,plots) {
    const resident=await hooks.read(tx,residentId(actor.ownerOpenid))
    if(!resident||resident.communityId!==actor.communityId)return null
    const pets=resident.pets.filter((p)=>boarding?p.following:p.ridingVehicleId===car._id)
    const allowed=await hooks.access(actor.ownerOpenid,plots,tx)
    const nav=hooks.publicNavigation(cfg,plots,allowed)
    resident.ridingVehicleId=boarding?car._id:''
    for(const pet of pets) {
      const current=sampleMotion(pet.motion,now()).position
      if(boarding&&(Math.hypot(current.x-car.position.x,current.z-car.position.z)>12||!nav.clearSegment(current,car.position)))throw new Error('等跟随的宠物来到车旁再上车吧')
      settleNeeds(pet,now());pet.ridingVehicleId=boarding?car._id:'';pet.following=true;pet.care=null
      pet.motion={epoch:now(),approach:[{...actor.position}],patrol:[{...actor.position}],speed:7}
      if(!boarding)followRoute(pet,actor,cfg,plots,allowed,resident.pets.indexOf(pet))
    }
    actor.hasFollowers=resident.pets.some((p)=>p.following)
    return save(tx,resident)
  }
  return {action,sync,transport,save,followRoute}
}
