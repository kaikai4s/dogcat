function validAppearance(value,type,targetId,ownerId) {
  return !!value && /^look_[a-f0-9]{32}$/.test(value.id||'') && value.targetType===type && value.targetId===targetId &&
    !!ownerId && value.ownerId===ownerId && !!value.walk
}
function atlasFor(value,action) {
  const atlas=action==='run'&&value.run?value.run:value.walk
  return atlas&&typeof atlas.fileID==='string'&&atlas.fileID.startsWith('cloud://')&&atlas.frames===24&&atlas.columns===4&&atlas.rows===6&&
    [128,256,512].includes(atlas.frameSize)?{...atlas,anchor:460/512}:null
}
module.exports={validAppearance,atlasFor}
