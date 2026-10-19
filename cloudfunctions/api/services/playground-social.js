const world=require('./playground-world')
const {transaction}=require('./playground-transaction')
const {playerId}=require('./playground-live')
const COLLECTION='pet_playground_plots'
const bookId=(openid)=>'social_'+world.hash(openid)
const dayEnd=(stamp)=>Math.floor((stamp+28800000)/86400000)*86400000+57600000
module.exports=function createSocial(context) {
  const {db}=context,live=require('./playground-live')(context)
  const now=()=>context.nowMs?context.nowMs():Date.now()
  const blank=()=>({friends:{},incoming:{},outgoing:{},visits:{}})
  async function book(openid,database=db) {return {...blank(),...await world.read(database,bookId(openid))}}
  async function save(tx,openid,value) {
    for(const key of ['incoming','outgoing']) {
      const pending=Object.values(value[key]).filter((r)=>r.status==='pending'&&(!r.expiresAt||r.expiresAt>now()))
      const history=Object.values(value[key]).filter((r)=>r.status!=='pending').sort((a,b)=>b.createdAt-a.createdAt).slice(0,50)
      value[key]=Object.fromEntries([...pending,...history].map((r)=>[r.id,r]))
    }
    value.visits=Object.fromEntries(Object.entries(value.visits).filter(([,v])=>v.expiresAt>now()))
    const {_id,...data}=value
    await tx.collection(COLLECTION).doc(bookId(openid)).set({data:{...data,kind:'social',revision:Math.max(now(),(value.revision||0)+1)}})
  }
  const cleanRequest=(r)=>({id:r.id,type:r.type,playerId:r.playerId,name:r.name,plotId:r.plotId||'',vehicleId:r.vehicleId||'',status:r.status,createdAt:r.createdAt,expiresAt:r.expiresAt||0})
  function publicBook(value) {
    return {revision:value.revision||0,friends:Object.entries(value.friends).map(([id,v])=>({id,name:v.name})),
      incoming:Object.values(value.incoming).filter((r)=>r.status==='pending' && (!r.expiresAt||r.expiresAt>now())).map(cleanRequest),
      outgoing:Object.values(value.outgoing).map(cleanRequest),visits:value.visits}
  }
  async function state(openid) {
    const value=publicBook(await book(openid))
    await live.mailbox(openid,value)
    return value
  }
  async function access(openid,plots,database=db) {
    const value=await book(openid,database),stamp=now()
    return plots.filter((plot)=>plot.ownerOpenid===openid || value.friends[playerId(plot.ownerOpenid)] ||
      value.visits[plot._id] && value.visits[plot._id].expiresAt>stamp && value.visits[plot._id].instanceId===(plot.instanceId||plot.createdAt||'')).map((plot)=>plot._id)
  }
  async function actor(openid,data,tx) {
    const row=await world.read(tx,playerId(openid))
    if(!row || row.session!==data.session || row.communityId!==data.sceneId || !row.active) throw new Error('请重新进入场景后操作')
    return row
  }
  async function request(openid,data) {
    const targetId=String(data.playerId||'')
    if(!/^presence_[a-f0-9]{32}$/.test(targetId) || targetId===playerId(openid)) throw new Error('请选择附近的其他用户')
    const type=data.type==='visit'?'visit':'friend'
    const other=await transaction(db,async(tx)=>{
      const a=await actor(openid,data,tx)
      let b=await world.read(tx,targetId)
      let plot=null
      if(type==='visit') {
        if(!/^plot_[a-f0-9]{32}_\d+_\d+$/.test(String(data.plotId||''))) throw new Error('请选择有效庭院')
        const yard=await world.read(tx,data.plotId)
        if(!yard || playerId(yard.ownerOpenid)!==targetId) throw new Error('庭院已变化，请重新靠近院门')
        b={ownerOpenid:yard.ownerOpenid,name:yard.ownerName||String(yard.name||'邻居').replace(/的庭院$/,'')}
        const home=await world.read(tx,world.ownerId(b.ownerOpenid))
        plot=home && await world.read(tx,home.plotId)
        const half = (plot.size || 48) / 2
        const dir = plot.gateDirection || 'south'
        const gate = dir === 'north' ? { x: plot.x, z: plot.z - half - 2 } :
                     dir === 'east' ? { x: plot.x + half + 2, z: plot.z } :
                     dir === 'west' ? { x: plot.x - half - 2, z: plot.z } :
                     { x: plot.x, z: plot.z + half + 2 }
        if(Math.hypot(a.position.x-gate.x,a.position.z-gate.z)>6) throw new Error('请先移动到对方庭院门口')
      } else {
        if(!b || b.communityId!==a.communityId || !b.active) throw new Error('用户已离开当前场景')
        if(Math.hypot(a.position.x-b.position.x,a.position.z-b.position.z)>5) throw new Error('请先走近对方再添加好友')
      }
      const own=await book(openid,tx),target=await book(b.ownerOpenid,tx)
      if(own.friends[targetId] || plot && own.visits[plot._id] && own.visits[plot._id].expiresAt>now() && own.visits[plot._id].instanceId===(plot.instanceId||plot.createdAt||'')) return b.ownerOpenid
      const id=type+'_'+playerId(openid)+(plot?'_'+world.hash(plot._id+(plot.instanceId||plot.createdAt||'')):'')
      const pending=target.incoming[id]
      if(pending && pending.status==='pending' && (!pending.expiresAt || pending.expiresAt>now())) return b.ownerOpenid
      if(pending && now()-pending.createdAt<30000) throw new Error('申请已处理，请稍后再试')
      if(Object.values(target.incoming).filter((r)=>r.status==='pending'&&(!r.expiresAt||r.expiresAt>now())).length>=100) throw new Error('对方待处理申请较多，请稍后再试')
      if(Object.values(own.outgoing).filter((r)=>r.status==='pending'&&(!r.expiresAt||r.expiresAt>now())).length>=100) throw new Error('待处理申请较多，请稍后再试')
      const common={id,type,plotId:plot?plot._id:'',plotVersion:plot?plot.instanceId||plot.createdAt||'':'',status:'pending',createdAt:now(),expiresAt:type==='visit'?dayEnd(now()):0}
      target.incoming[id]={...common,playerId:playerId(openid),name:a.name,openid}
      own.outgoing[id]={...common,playerId:targetId,name:b.name}
      await save(tx,openid,own)
      await save(tx,b.ownerOpenid,target)
      return b.ownerOpenid
    })
    await state(other)
    return state(openid)
  }
  async function respond(openid,data) {
    const other=await transaction(db,async(tx)=>{
      const mine=await book(openid,tx),r=mine.incoming[String(data.requestId||'')]
      if(!r || r.status!=='pending') throw new Error('申请已处理或不存在')
      if(!['visit','friend'].includes(r.type))throw new Error('请使用乘车申请入口处理')
      if(r.expiresAt && r.expiresAt<=now()) throw new Error('访问申请已过期，请重新申请')
      const sender=await book(r.openid,tx),accepted=data.accept===true
      if(accepted && r.type==='visit') {
        const home=await world.read(tx,world.ownerId(openid))
        if(!home || home.plotId!==r.plotId || (home.instanceId||home.createdAt||'')!==r.plotVersion) throw new Error('原庭院已拆除或更换，不能批准旧申请')
        sender.visits[r.plotId]={ownerId:playerId(openid),instanceId:r.plotVersion,expiresAt:dayEnd(now())}
      }
      if(accepted && r.type==='friend') {
        if(Object.keys(mine.friends).length>=200 || Object.keys(sender.friends).length>=200) throw new Error('好友数量已达上限')
        mine.friends[r.playerId]={name:r.name,openid:r.openid}
        const user=(await db.collection('users').where({openid}).limit(1).get()).data[0]
        sender.friends[playerId(openid)]={name:user&&user.nickname||'邻居',openid}
      }
      r.status=accepted?'accepted':'rejected'
      if(sender.outgoing[r.id]) sender.outgoing[r.id].status=r.status
      await save(tx,openid,mine);await save(tx,r.openid,sender)
      return r.openid
    })
    await state(other)
    return state(openid)
  }
  async function removeFriend(openid,data) {
    const other=await transaction(db,async(tx)=>{
      const mine=await book(openid,tx),friend=mine.friends[String(data.playerId||'')]
      if(!friend) throw new Error('该用户不是你的好友')
      const target=await book(friend.openid,tx)
      delete mine.friends[data.playerId];delete target.friends[playerId(openid)]
      for(const [id,v] of Object.entries(mine.visits)) if(v.ownerId===data.playerId) delete mine.visits[id]
      for(const [id,v] of Object.entries(target.visits)) if(v.ownerId===playerId(openid)) delete target.visits[id]
      await save(tx,openid,mine);await save(tx,friend.openid,target)
      return friend.openid
    })
    await state(other);return state(openid)
  }
  return {state,access,request,respond,removeFriend,book,save}
}
module.exports.dayEnd=dayEnd
