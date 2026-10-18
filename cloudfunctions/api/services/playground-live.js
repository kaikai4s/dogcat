const {hash,readDocument}=require('./playground-world')
const COLLECTION='pet_playground_live'
const playerId=(openid)=>'presence_'+hash(openid)
module.exports=function createLive({db,nowMs}) {
  const now=()=>nowMs?nowMs():Date.now()
  async function ensure(sceneId,shard) {
    const id='scene_'+sceneId+'_'+shard
    if(!await readDocument(db,COLLECTION,id,'读取实时场景',true)) {
      try {await db.collection(COLLECTION).add({data:{_id:id,kind:'scene',communityId:sceneId,records:{}}})}
      catch(error) {if(!/already exists|已存在|duplicate/i.test(error.message||error.errMsg||'')) throw error}
    }
    return id
  }
  async function publish(sceneId,record,version) {
    const shard=hash(record.id).slice(0,1),id=await ensure(sceneId,shard)
    if(record.deleted) {
      const previous=await readDocument(db,COLLECTION,id,'读取实时场景')
      const old=previous.records&&previous.records[record.id]
      version={epoch:Math.max(now(),(old&&old.version&&old.version.epoch||0)+1),seq:0}
    }
    version=version||{epoch:now(),seq:0}
    const key='records.'+record.id+'.version',command=db.command
    // Atomic conditional update: an old snapshot must never resurrect a deleted entity.
    // Plain objects are expanded into dotted leaf updates by the SDK, which
    // cannot replace appearance:null and leaves obsolete fields (e.g. deleted).
    // Replace this entity only; keep the shard's other entities and version guard.
    await db.collection(COLLECTION).where(command.and([{_id:id},command.or([
      {[key]:command.exists(false)},
      {[key+'.epoch']:command.lt(version.epoch)},
      {[key+'.epoch']:version.epoch,[key+'.seq']:command.lt(version.seq)}
    ])])).update({data:{['records.'+record.id]:command.set({...record,version})}})
  }
  async function nextEpoch(sceneId,recordId,proposed=now()) {
    const id='scene_'+sceneId+'_'+hash(recordId).slice(0,1)
    const room=await readDocument(db,COLLECTION,id,'读取实时场景',true)
    const previous=room&&room.records&&room.records[recordId]
    return Math.max(proposed,(previous&&previous.version&&previous.version.epoch||0)+1)
  }
  async function mailbox(openid,state) {
    const id='mail_'+playerId(openid),command=db.command
    if(!await readDocument(db,COLLECTION,id,'读取好友申请',true)) {
      try {await db.collection(COLLECTION).add({data:{_id:id,kind:'mail',_openid:openid,revision:-1}})}
      catch(error){if(!/already exists|已存在|duplicate/i.test(error.message||error.errMsg||''))throw error}
    }
    await db.collection(COLLECTION).where({_id:id,revision:command.lt(state.revision)}).update({data:{...state,kind:'mail',_openid:openid}})
  }
  return {publish,mailbox,playerId,nextEpoch}
}
module.exports.COLLECTION=COLLECTION
module.exports.playerId=playerId
