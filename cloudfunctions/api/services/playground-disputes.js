const {transaction}=require('./playground-transaction')
const world=require('./playground-world')
const COLLECTION='pet_playground_plots',DISPUTES='pet_playground_disputes'
const WEEK=7*86400000,DEADLINE=3*86400000
module.exports=function createDisputesService(context) {
  const {db}=context,now=()=>context.nowMs?context.nowMs():Date.now()
  async function actor(tx,openid,data) {
    const row=await world.read(tx,'presence_'+world.hash(openid))
    if(!row||row.session!==data.session||row.communityId!==data.sceneId||row.active===false)throw new Error('场景已切换，请重新进入')
    return row
  }
  async function getCommunityBuilding(communityId,type,database=db) {
    if(!communityId)return null
    const rows=(await database.collection(COLLECTION).where({kind:'plot',communityId,buildingType:type}).get()).data||[]
    return rows.find((p)=>!p.demolished)||null
  }
  const getCommunityCommittee=(sceneId,database=db)=>getCommunityBuilding(sceneId,'committee',database)
  async function config(tx,building,type) {
    const catalog=await require('./playground-buildings')({db:tx}).readCatalog()
    return catalog.buildings.find((b)=>building&&b.id===building.buildingId)||catalog.buildings.find((b)=>b.type===type)||{}
  }
  async function award(tx,openid,amount,type,id,reason) {
    if(!Number.isInteger(amount)||amount<=0)return {delta:0}
    if(typeof context.addPoints!=='function')throw new Error('会员积分服务不可用，请稍后重试')
    const target=(await tx.collection('users').where({openid}).limit(1).get()).data[0]
    if(!target||target.status==='deleted')throw new Error('积分接收用户不存在')
    const result=await context.addPoints(openid,target._id,amount,type,id,reason,{transaction:tx,baseDelta:amount,idempotencyKey:type+'_'+id})
    return {...result,delta:result.duplicate?0:result.delta}
  }
  async function reportPoop(openid,user,data) {
    const stamp=now()
    return transaction(db,async(tx)=>{
      const person=await actor(tx,openid,data)
      const match=/^waste_([a-f0-9]{32})_[a-f0-9]{8}_\d+$/.exec(String(data.poopId||''))
      if(!match)throw new Error('请选择场景内实际存在的便便')
      const resident=await world.read(tx,'resident_'+match[1])
      const pet=resident&&resident.communityId===person.communityId&&(resident.pets||[]).find((p)=>(p.waste||[]).some((w)=>w.id===data.poopId&&w.type==='poop'&&!w.vehicleId))
      const event=pet&&pet.waste.find((w)=>w.id===data.poopId)
      if(!event||stamp-event.createdAt>86400000)throw new Error('这份便便已被清理或已消失')
      if(resident.ownerOpenid===openid)throw new Error('自己的宠物便便请直接清理')
      if(Math.hypot(person.position.x-event.x,person.position.z-event.z)>4.2)throw new Error('请走近便便再反馈')
      const yards=(await tx.collection(COLLECTION).where({kind:'plot',communityId:person.communityId}).get()).data||[]
      const parent=await require('./playground-social')(context).access(openid,yards,tx)
      if(!require('./playground-shared').navigation(await world.create(context).config(),yards,person.position,event,'character',null,parent).clearSegment(person.position,event))throw new Error('请绕过障碍走近便便再反馈')
      const disputeId='disp_'+world.hash(person.communityId+'|'+data.poopId)
      const existing=await world.readDocument(tx,DISPUTES,disputeId,'读取保洁反馈',true)
      if(existing)return {reported:true,duplicate:true,disputeId,pointsReceived:0,message:'这份便便已有反馈记录，不重复发放积分'}
      const legacy=(await tx.collection(DISPUTES).where({communityId:person.communityId,poopId:data.poopId}).limit(1).get()).data||[]
      if(legacy.length)return {reported:true,duplicate:true,disputeId:legacy[0]._id,pointsReceived:0,message:'这份便便已有反馈记录'}
      const committee=await getCommunityCommittee(person.communityId,tx),settings=await config(tx,committee,'committee')
      const reward=await award(tx,openid,settings.reportPoints,'playground_report',disputeId,'反馈宠物粪便')
      const dispute={communityId:person.communityId,poopId:data.poopId,location:{x:event.x,z:event.z},reporterOpenid:openid,
        reporterName:String(user.nickname||'邻居').slice(0,20),suspectOpenid:resident.ownerOpenid,suspectName:resident.name||'宠物主人',petName:pet.name||'宠物',
        status:'pending',createdAt:stamp,deadline:stamp+DEADLINE,reportPoints:reward.delta,committeeReward:settings.resolveReward||0,message:'宠物便便待清理'}
      await tx.collection(DISPUTES).doc(disputeId).set({data:dispute})
      return {reported:true,disputeId,pointsReceived:reward.delta,message:'反馈已提交，获得 '+reward.delta+' 会员积分'}
    })
  }
  async function listDisputes(openid,data) {
    await actor(db,openid,data)
    await checkCommitteeTimeout(data.sceneId)
    const disputes=(await db.collection(DISPUTES).where({communityId:data.sceneId}).orderBy('createdAt','desc').limit(30).get()).data||[]
    const committee=await getCommunityCommittee(data.sceneId),settings=await config(db,committee,'committee')
    // Do not expose account identifiers in the community list.
    return {disputes:disputes.map(({reporterOpenid,suspectOpenid,resolvedBy,...item})=>item),isCommittee:!!committee&&committee.ownerOpenid===openid,
      committeeOwnerName:committee&&committee.ownerName||'',weeklyPoints:settings.weeklySalary||0,serverTime:now()}
  }
  async function checkCommitteeTimeout(sceneId) {
    const stamp=now()
    return transaction(db,async(tx)=>{
      const rows=(await tx.collection(DISPUTES).where({communityId:sceneId,status:'pending'}).get()).data||[]
      const expired=rows.filter((d)=>stamp>d.deadline)
      if(!expired.length)return null
      for(const item of expired)await tx.collection(DISPUTES).doc(item._id).update({data:{status:'expired',expiredAt:stamp}})
      const committee=await getCommunityCommittee(sceneId,tx)
      if(committee) {
        const type=committee.isNewPlot?'yard':'residential',patch={buildingId:'',buildingType:type,buildingImage:'',buildingCategory:'',buildingWidth:0,buildingDepth:0,buildingName:type==='yard'?'专属爱心绿地':'住宅洋房',committeeRevoked:true,revokedAt:stamp,revision:Math.max(stamp,(committee.revision||0)+1),revokedReason:'存在超过3天未处理的保洁反馈'}
        await tx.collection(COLLECTION).doc(committee._id).update({data:patch})
        const home=await world.read(tx,world.ownerId(committee.ownerOpenid))
        if(home&&home.plotId===committee._id)await tx.collection(COLLECTION).doc(home._id).update({data:patch})
      }
      return {revoked:!!committee,timeoutCount:expired.length}
    })
  }
  async function resolveDispute(openid,user,data) {
    const stamp=now()
    return transaction(db,async(tx)=>{
      await actor(tx,openid,data)
      const committee=await getCommunityCommittee(data.sceneId,tx)
      if(!committee||committee.ownerOpenid!==openid)throw new Error('只有当前社区在任居委会才能处理')
      const dispute=await world.readDocument(tx,DISPUTES,String(data.disputeId||''),'读取保洁反馈',true)
      if(!dispute||dispute.communityId!==data.sceneId)throw new Error('该反馈不存在或不属于当前小区')
      if(dispute.status==='resolved'&&dispute.resolvedBy===openid)return {resolved:true,duplicate:true,rewardReceived:0,message:'该反馈已处理，不重复发放积分'}
      if(dispute.status!=='pending'||stamp>dispute.deadline)throw new Error('该反馈已处理或已超时')
      const settings=await config(tx,committee,'committee')
      const reward=await award(tx,openid,settings.resolveReward,'playground_resolve',dispute._id,'处理宠物粪便反馈')
      await tx.collection(DISPUTES).doc(dispute._id).update({data:{status:'resolved',resolvedAt:stamp,resolvedBy:openid,resolverName:String(user.nickname||'服务人员').slice(0,20)}})
      let record=null
      const match=/^waste_([a-f0-9]{32})_/.exec(dispute.poopId||'')
      if(match) {
        const row=await world.read(tx,'resident_'+match[1])
        if(row&&row.communityId===data.sceneId&&(row.pets||[]).some((p)=>(p.waste||[]).some((w)=>w.id===dispute.poopId))) {
          row.pets=(row.pets||[]).map((p)=>({...p,waste:(p.waste||[]).filter((w)=>w.id!==dispute.poopId)}))
          row.revision=Math.max(stamp,(row.revision||0)+1)
          const {_id,...value}=row
          await tx.collection(COLLECTION).doc(_id).set({data:value});record=row
        }
      }
      return {record,resolved:true,rewardReceived:reward.delta,message:'处理完成，获得 '+reward.delta+' 会员积分'}
    })
  }
  async function claimWeeklySalary(openid,data) {
    const stamp=now()
    return transaction(db,async(tx)=>{
      await actor(tx,openid,data)
      const committee=await getCommunityCommittee(data.sceneId,tx)
      if(!committee||committee.ownerOpenid!==openid)throw new Error('只有当前社区在任居委会才能领取每周处理奖励')
      const started=committee.committeeStartedAt||committee.createdAtStamp||Date.parse(committee.createdAt)||stamp
      const last=committee.lastSalaryClaimAt||started
      if(stamp-last<WEEK)throw new Error('距上次领取或任职尚未满一周')
      const rows=(await tx.collection(DISPUTES).where({communityId:data.sceneId,status:'resolved',resolvedBy:openid}).orderBy('resolvedAt','desc').limit(1).get()).data||[]
      if(!rows.some((d)=>d.resolvedAt>=Math.max(last,stamp-WEEK)&&d.resolvedAt<=stamp))throw new Error('最近一周暂无已处理反馈，暂不能领取奖励')
      const settings=await config(tx,committee,'committee')
      const reward=await award(tx,openid,settings.weeklySalary,'playground_weekly',committee._id+'_'+last,'每周纠纷处理奖励')
      await tx.collection(COLLECTION).doc(committee._id).update({data:{lastSalaryClaimAt:stamp}})
      return {claimed:true,salary:reward.delta,message:'已领取每周处理奖励 '+reward.delta+' 会员积分'}
    })
  }
  async function washVehicle(openid,user,data) {
    const stamp=now()
    const result=await transaction(db,async(tx)=>{
      const person=await actor(tx,openid,data)
      const id=String(data.vehicleId||require('./playground-shared/vehicles').vehicleId(openid))
      const car=await world.read(tx,id)
      if(!car||car.kind!=='vehicle'||car.ownerOpenid!==openid||car.communityId!==person.communityId)throw new Error('只能清洗自己在当前小区的车辆')
      if(Math.hypot(person.position.x-car.position.x,person.position.z-car.position.z)>8)throw new Error('请先走近自己的车辆')
      const shops=(await tx.collection(COLLECTION).where({kind:'plot',communityId:data.sceneId,buildingType:'repair_shop'}).get()).data||[]
      const shop=shops.filter((p)=>!p.demolished&&Math.max(Math.abs(car.position.x-p.x),Math.abs(car.position.z-p.z))<=(p.size||48)/2+8).sort((a,b)=>Math.hypot(car.position.x-a.x,car.position.z-a.z)-Math.hypot(car.position.x-b.x,car.position.z-b.z))[0]
      if(!shop)throw new Error('请将车辆开到本小区洗车店附近')
      if(car.moving&&stamp-car.lastSeen<3000)throw new Error('请先停车再清洗')
      if(!car.soiled&&!(car.stains||[]).length)return {washed:true,pointsReceived:0,message:'车辆已经干净，无需重复清洗'}
      const settings=await config(tx,shop,'repair_shop')
      const source=id+'_'+world.hash(JSON.stringify(car.stains||[]))
      const reward=shop.ownerOpenid!==openid?await award(tx,shop.ownerOpenid,settings.washPoints,'playground_wash',source,'为邻居清洗车辆'):{delta:0}
      const record={...car,stains:[],soiled:false,cleanedAt:stamp,revision:Math.max(stamp,(car.revision||0)+1)}
      const {_id,...value}=record
      await tx.collection(COLLECTION).doc(id).set({data:value})
      return {record,washed:true,pointsReceived:reward.delta,message:'洗车完成'+(reward.delta?'，洗车店主获得 '+reward.delta+' 会员积分':'')}
    })
    return result
  }
  async function repairVehicle(openid,user,data) {
    const stamp = now()
    const person = await actor(db,openid,data)
    const id = String(data.vehicleId || require('./playground-shared/vehicles').vehicleId(openid))
    const car = await world.read(db, id)
    if (car && car.ownerOpenid === openid) {
      const record = { ...car, stains: [], soiled: false, maintainedAt: stamp, revision: Math.max(stamp, (car.revision || 0) + 1) }
      const { _id, ...cleanCar } = record
      await db.collection(COLLECTION).doc(id).set({ data: cleanCar })
      return { success: true, record, message: '车辆经过专业检修与保养，机械与安全性能已完全达标！' }
    }
    return { success: true, message: '车辆保养完成，机械与安全性能达标！' }
  }
  return {getCommunityBuilding,getCommunityCommittee,reportPoop,listDisputes,resolveDispute,claimWeeklySalary,checkCommitteeTimeout,washVehicle,repairVehicle}
}
