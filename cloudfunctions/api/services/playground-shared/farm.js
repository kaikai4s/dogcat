const {transaction}=require('../playground-transaction')
const world=require('../playground-world')
const {readCatalog}=require('../playground-farm-catalog')
const {memberAccess,decorate,unlocked}=require('../playground-access')
const {cropById,farmLayout,savedBeds,bedReach,bedView}=require('./farm-model')
const COLLECTION='pet_playground_plots'
module.exports=function createFarm(context,hooks) {
  const {db}=context,now=()=>context.nowMs?context.nowMs():Date.now()
  const save=async(tx,id,row)=>{const {_id,...data}=row;await tx.collection(COLLECTION).doc(id).set({data})}
  async function home(tx,openid,data) {
    const actor=await hooks.check(openid,data,tx)
    const owner=await hooks.read(tx,world.ownerId(openid))
    const plot=await hooks.read(tx,String(data.plotId||owner&&owner.plotId||''))
    if(!plot||plot.kind!=='plot'||plot.demolished||plot.ownerOpenid!==openid||plot.communityId!==actor.communityId||!actor.active)
      throw new Error('只能在自己的庭院或新地皮内布置植物')
    return {actor,plot,access:await memberAccess(tx,openid)}
  }
  function view(plot,access,stamp,catalog) {
    const saved=savedBeds(plot),tiles=farmLayout(plot)
    return {plotId:plot._id,serverTime:stamp,memberLevel:access.memberLevel,memberLevelName:access.memberLevelName,
      catalog,crops:catalog.crops.map((c)=>decorate(c,access)),tileCount:tiles.length,
      beds:tiles.map((t)=>({...t,...bedView(saved[t.id],stamp,catalog.crops),unlocked:true}))}
  }
  async function state(openid,data) {
    const {plot,access}=await home(db,openid,data)
    return view(plot,access,now(),await readCatalog(db))
  }
  async function pickup(openid,data) {
    const stamp=now()
    const resident=await transaction(db,async(tx)=>{
      const actor=await hooks.check(openid,data,tx)
      const match=/^waste_([a-f0-9]{32})_[a-f0-9]{8}_\d+$/.exec(String(data.poopId||''))
      if(!match)throw new Error('这份便便已消失，请刷新场景')
      const row=await hooks.read(tx,'resident_'+match[1])
      const pet=row&&row.communityId===actor.communityId&&(row.pets||[]).find((p)=>(p.waste||[]).some((w)=>w.id===data.poopId&&w.type==='poop'&&!w.vehicleId))
      const event=pet&&pet.waste.find((w)=>w.id===data.poopId)
      if(!event)throw new Error('这份便便已被拾取或已消失')
      const plots=await hooks.rows(actor.communityId,'plot')
      const nav=hooks.publicNavigation(await hooks.config(),plots,await hooks.access(openid,plots,tx))
      if(Math.hypot(actor.position.x-event.x,actor.position.z-event.z)>4.2||!nav.clearSegment(actor.position,event))throw new Error('请走近便便再拾取')
      pet.waste=pet.waste.filter((w)=>w.id!==data.poopId)
      row.revision=Math.max(stamp,(row.revision||0)+1)
      await save(tx,row._id,row)
      return row
    })
    await hooks.publish(resident)
    return {picked:true,message:'清理完成，感谢保持环境整洁'}
  }
  async function action(openid,data) {
    if(!/^[a-zA-Z0-9_-]{8,80}$/.test(data.requestId||''))throw new Error('缺少有效操作标识，请重试')
    if(data.operation==='pickupPoop')return pickup(openid,data)
    const stamp=now(),fingerprint=JSON.stringify([data.plotId||'',data.operation,data.bedId,data.cropId])
    const result=await transaction(db,async(tx)=>{
      const {actor,plot,access}=await home(tx,openid,data),catalog=await readCatalog(tx)
      const receiptId='garden_'+world.hash(plot._id+'|'+(plot.instanceId||plot.createdAt||''))
      const account=await hooks.read(tx,receiptId),receipts=account&&account.receipts||[]
      const receipt=receipts.find((r)=>r.id===data.requestId)
      if(receipt) {
        if(receipt.fingerprint!==fingerprint)throw new Error('操作标识已使用，请刷新庭院')
        return {plot,access,catalog,message:receipt.message}
      }
      if(actor.vehicleId)throw new Error('请先下车再布置植物')
      const selected=farmLayout(plot).find((t)=>t.id===data.bedId)
      if(!selected)throw new Error('请选择自家范围内未被建筑占用的草块')
      if(Math.hypot(actor.position.x-selected.x,actor.position.z-selected.z)>bedReach(selected))throw new Error('请先走到这块土地旁边')
      const plots=await hooks.rows(actor.communityId,'plot')
      const allowed=await hooks.access(openid,plots,tx)
      const nav=hooks.publicNavigation(await hooks.config(),plots,[...new Set([...allowed,plot._id])])
      if(!nav.clearSegment(actor.position,selected))throw new Error('请绕过障碍走到这块土地旁边')
      const beds=savedBeds(plot),bed=beds[selected.id],operation=data.operation
      let message='植物布置已更新'
      if(operation==='convert') {
        if(bed)throw new Error('这块草地已转换为耕地')
        beds[selected.id]={id:selected.id,stage:'soil'};message='已获得耕地，可以继续开垦'
      } else if(operation==='till') {
        if(!bed||bed.stage!=='soil'||bed.cropId)throw new Error('请先将草块转换为耕地')
        bed.stage='tilled';message='开垦完成，可以种植或浇水'
      } else if(operation==='water') {
        if(!bed||bed.stage==='soil'||bed.stage==='watered')throw new Error('请选择已开垦且未浇水的土地')
        bed.stage='watered';bed.watered=true;message='浇水完成'
      } else if(operation==='plant') {
        const crop=cropById(data.cropId,catalog.crops)
        if(!crop||!unlocked(crop,access))throw new Error('该植物已下架或当前会员等级尚未解锁')
        if(!bed||bed.stage==='soil'||bed.cropId)throw new Error('请选择已开垦的空地')
        Object.assign(bed,{cropId:crop.id,crop,plantedAt:stamp,readyAt:stamp+crop.minutes*60000})
        message=crop.name+'已种植'
      } else if(operation==='harvest') {
        if(!bed||!bed.cropId||stamp<bed.readyAt)throw new Error('这株植物仍在生长中')
        beds[selected.id]={id:selected.id,stage:bed.stage,watered:!!bed.watered}
        message='植株已收整，土地可重新布置'
      } else if(operation==='lawn') {
        if(!bed)throw new Error('这里已经是草坪')
        delete beds[selected.id];message='已重新绿化为草坪'
      } else throw new Error('不支持的植物布置操作')
      plot.farmBeds=Object.values(beds);plot.gardenVersion=2
      plot.revision=Math.max(stamp,(plot.revision||0)+1)
      await save(tx,receiptId,{kind:'garden_receipts',ownerOpenid:openid,receipts:[...receipts.slice(-39),{id:data.requestId,fingerprint,message}]})
      await save(tx,plot._id,plot)
      return {plot,access,catalog,message}
    })
    await hooks.publish(result.plot)
    return {...view(result.plot,result.access,now(),result.catalog),message:result.message}
  }
  return {state,action}
}
