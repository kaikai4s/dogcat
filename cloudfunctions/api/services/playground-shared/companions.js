const {transaction}=require('../playground-transaction')
const world=require('../playground-world')
const {sampleMotion}=require('./shared-motion')
const {settleNeeds,relieveWaste,RECOVERY,recoverySpec}=require('./pet-needs')
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
  async function startCare(tx,resident,pet,home,operation,cfg,plots,stamp,automatic=false) {
    const current=sampleMotion(pet.motion,stamp).position
    const species=pet.species==='cat'?'cat':'dog'
    const food={dog:0,cat:0,...home.foodBowls}
    if(operation==='eat'&&food[species]<25)return false
    const target=yardLayout(home).stations[species][operation]
    const nav=hooks.navigation(cfg,plots,current,target,'pet',resident.plotId),route=nav.path(current,target)
    if(!route) return false
    if(operation==='eat') {
      food[species]-=25;home.foodBowls=food
      await tx.collection(COLLECTION).doc(world.ownerId(resident.ownerOpenid)).update({data:{foodBowls:food}})
      const plot=await hooks.read(tx,home.plotId)
      if(plot) {
        plot.foodBowls=food;plot.revision=Math.max(stamp,(plot.revision||0)+1)
        const {_id,...saved}=plot
        await tx.collection(COLLECTION).doc(home.plotId).set({data:saved})
      }
    }
    let distance=0,previous=current
    for(const point of route){distance+=Math.hypot(point.x-previous.x,point.z-previous.z);previous=point}
    const startsAt=stamp+distance/7*1000,spec=recoverySpec(pet,operation)
    const seconds=automatic?Math.max(spec.seconds,(100-pet.needs[spec.key])/spec.rate):spec.seconds
    pet.following=false;pet.care={type:operation,startsAt,endsAt:startsAt+seconds*1000}
    pet.motion={epoch:stamp,approach:[current,...route],patrol:[target],speed:7}
    return true
  }
  async function recordRelief(tx,resident,pet,type,stamp,position) {
    relieveWaste(pet,type,type==='poop'?40:20,stamp)
    const event={id:'waste_'+world.hash(resident.ownerOpenid)+'_'+world.hash(pet.id).slice(0,8)+'_'+stamp,type,x:position.x,z:position.z,createdAt:stamp,vehicleId:pet.ridingVehicleId||''}
    pet.waste=[...(pet.waste||[]).filter((w)=>stamp-w.createdAt<86400000).slice(-11),event]
    pet.relieving={id:event.id,type,start:stamp,until:stamp+3000,position:{...position}}
    // Delay the saved route by the same pause on every client.
    pet.motion={...pet.motion,epoch:pet.motion.epoch+3000}
    if(pet.care)pet.care={...pet.care,startsAt:Math.max(stamp,pet.care.startsAt)+3000,endsAt:pet.care.endsAt+3000}
    pet[type==='poop'?'poopDueAt':'peeDueAt']=null
    if(pet.ridingVehicleId) {
      const car=await hooks.read(tx,pet.ridingVehicleId)
      if(car) {
        const stains=[...(car.stains||[]).slice(-23),{id:event.id,type,at:stamp,x:0,y:0}]
        await tx.collection(COLLECTION).doc(car._id).update({data:{stains,soiled:true,revision:Math.max(stamp,(car.revision||0)+1)}})
      }
    }
  }
  async function publishLife(resident) {
    await hooks.publish(resident)
    if(resident.pets.some((p)=>p.care&&p.care.type==='eat')) {
      const plot=await hooks.read(db,resident.plotId)
      if(plot)await hooks.publish(plot)
    }
    for(const id of new Set(resident.pets.map((p)=>p.ridingVehicleId).filter(Boolean))) {
      const car=await hooks.read(db,id)
      if(car)await hooks.publish(car)
    }
  }
  async function advance(tx,resident,cfg,plots) {
    const stamp=now(),before=JSON.parse(JSON.stringify(resident.pets||[]))
    const home=await hooks.read(tx,world.ownerId(resident.ownerOpenid))
    if(!home||home.communityId!==resident.communityId||home.plotId!==resident.plotId)return false
    for(const pet of resident.pets||[]) {
      if(!pet.motion)continue
      if(pet.relieving&&stamp<pet.relieving.until)continue
      if(pet.relieving)pet.relieving=null
      const current=sampleMotion(pet.motion,stamp).position
      const values=settleNeeds(pet,stamp)
      const rules=pet.needsRules||{}
      const inside=Math.abs(current.x-home.x)<=(home.size||48)/2&&Math.abs(current.z-home.z)<=(home.size||48)/2
      if(inside&&!pet.ridingVehicleId) {pet.poopDueAt=null;pet.peeDueAt=null}
      else {
        if(values.poop>=(rules.poopThreshold||40))pet.poopDueAt=pet.poopDueAt||stamp+(rules.poopDelaySeconds||120)*1000
        else pet.poopDueAt=null
        if(values.pee>=(rules.peeThreshold||20))pet.peeDueAt=pet.peeDueAt||stamp+(rules.peeDelaySeconds?rules.peeDelaySeconds*1000:30000+parseInt(world.hash(pet.id+stamp).slice(0,4),16)%30001)
        else pet.peeDueAt=null
      }
      const type=values.poop>=100||pet.poopDueAt&&stamp>=pet.poopDueAt?'poop':
        values.pee>=100||pet.peeDueAt&&stamp>=pet.peeDueAt?'pee':''
      if(type){await recordRelief(tx,resident,pet,type,stamp,current);continue}
      if(pet.serviceManaged)continue
      if(pet.care) {
        const spec=recoverySpec(pet,pet.care.type)
        if(stamp<pet.care.endsAt&&(!spec||values[spec.key]<98))continue
        pet.care=null
        pet.motion=hooks.motion(cfg,plots,current,stamp,pet.id+'roam')
      }
      if(!inside||pet.ridingVehicleId||pet.interactionUntil>stamp)continue
      const actions=Object.keys(RECOVERY).filter((op)=>values[RECOVERY[op].key]<=20)
        .sort((a,b)=>values[RECOVERY[a].key]-values[RECOVERY[b].key])
      for(const operation of actions)if(await startCare(tx,resident,pet,home,operation,cfg,plots,stamp,true))break
    }
    // Sampling alone does not need a write; timed actions and their baselines do.
    const changed=resident.pets.some((pet,i)=>{
      const old=before[i]
      return JSON.stringify({...pet,needs:null})!==JSON.stringify({...old,needs:null})
    })
    return changed
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
      if(pet.serviceManaged)throw new Error('宠物正在接受宠托师服务，请等待照护完成后再操作')
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
        if(operation==='eat'&&Number(home.foodBowls&&home.foodBowls[pet.species==='cat'?'cat':'dog']||0)<25)throw new Error('碗里粮食不足，请先添粮')
        if(!await startCare(tx,resident,pet,home,operation,cfg,plots,stamp))throw new Error('暂时无法到达，请从自家庭院院门进出')
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
    let changed=await advance(tx,resident,cfg,plots)
    const followers=resident.pets.filter((p)=>p.following&&!p.ridingVehicleId)
    if(followers.length) {
      actor.hasFollowers=true
      const allowed=await hooks.access(actor.ownerOpenid,plots,tx)
      for(const pet of followers) {
        if(pet.relieving&&stamp<pet.relieving.until)continue
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
  async function relief(openid, data) {
    await hooks.check(openid,data)
    const petId = String(data.petId || '')
    const type = data.type
    if(!['poop','pee'].includes(type))throw new Error('无效排泄类型')
    const result = await transaction(db, async (tx) => {
      const resident = await hooks.read(tx, residentId(openid))
      if (!resident||resident.session!==data.session||resident.communityId!==data.sceneId)throw new Error('场景已切换，请重新进入')
      const pet = (resident.pets || []).find((p) => p.id === petId)
      if (!pet)throw new Error('只能操作自己的宠物')
      const stamp = now()
      const values=settleNeeds(pet,stamp),minimum=type==='poop'?40:20
      if(pet.relieving&&stamp<pet.relieving.until||values[type]<minimum)return {resident,pet}
      await recordRelief(tx,resident,pet,type,stamp,sampleMotion(pet.motion,stamp).position)
      return {resident:await save(tx,resident),pet}
    })
    if (result && result.resident && hooks.publish) {
      await publishLife(result.resident)
    }
    return {pet:result.pet,serverTime:now()}
  }
  return {action,sync,transport,save,followRoute,relief,advance,publishLife}
}
