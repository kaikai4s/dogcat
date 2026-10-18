const {hash}=require('./playground-world')
function publicAppearance(value,type,targetId,openid) {
  const ownerId='presence_'+hash(openid)
  if(!value||value.targetType!==type||value.targetId!==targetId||value.ownerId!==ownerId||!/^look_[a-f0-9]{32}$/.test(value.id||''))return null
  const clean=(atlas)=>atlas&&typeof atlas.fileID==='string'&&atlas.fileID.startsWith('cloud://')&&
    atlas.frames===24&&atlas.columns===4&&atlas.rows===6&&[128,256,512].includes(atlas.frameSize)?
    {fileID:atlas.fileID,frames:24,columns:4,rows:6,anchor:460/512,frameSize:atlas.frameSize}:null
  const walk=clean(value.walk)
  if(!walk)return null
  return {id:value.id,targetType:type,targetId,ownerId,revision:value.revision||0,walk,run:clean(value.run)}
}
module.exports={publicAppearance}
