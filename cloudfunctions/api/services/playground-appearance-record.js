const {hash}=require('./playground-world')
function publicAppearance(value,type,targetId,openid) {
  const ownerId='presence_'+hash(openid)
  if(!value||value.disabled===true||value.targetType!==type||value.targetId!==targetId||value.ownerId!==ownerId||!/^look_[a-f0-9]{32}$/.test(value.id||''))return null
  const cleanAtlas=(atlas,rows)=>atlas&&typeof atlas.fileID==='string'&&atlas.fileID.startsWith('cloud://')&&
    atlas.frames===4*rows&&atlas.columns===4&&atlas.rows===rows&&[128,256,512].includes(atlas.frameSize)?
    {fileID:atlas.fileID,frames:4*rows,columns:4,rows,anchor:460/512,frameSize:atlas.frameSize}:null
  const clean=(value)=>{
    if(!value)return null
    if(value.fileID)return cleanAtlas(value,6)
    if(type!=='character')return null
    const directions={}
    for(const direction of ['sw','se','nw','ne']) {
      const atlas=cleanAtlas(value[direction],3)
      if(!atlas)return null
      directions[direction]=atlas
    }
    return directions
  }
  const walk=clean(value.walk)
  if(!walk)return null
  return {id:value.id,targetType:type,targetId,ownerId,revision:value.revision||0,walk,run:clean(value.run)}
}
module.exports={publicAppearance}
