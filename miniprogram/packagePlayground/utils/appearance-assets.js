function validAppearance(value,type,targetId,ownerId) {
  return !!value && /^look_[a-f0-9]{32}$/.test(value.id||'') && value.targetType===type && value.targetId===targetId &&
    !!ownerId && value.ownerId===ownerId && !!value.walk
}
function atlasFor(value,action,direction='sw') {
  const actionAtlas=action==='run'&&value.run?value.run:value.walk
  const directional=!!(actionAtlas&&!actionAtlas.fileID)
  const atlas=directional?actionAtlas[direction]:actionAtlas
  const validLayout=atlas&&((atlas.frames===24&&atlas.columns===4&&atlas.rows===6)||(atlas.frames===12&&atlas.columns===4&&atlas.rows===3))
  return validLayout&&typeof atlas.fileID==='string'&&atlas.fileID.startsWith('cloud://')&&
    [128,256,512].includes(atlas.frameSize)?{...atlas,anchor:460/512,directional}:null
}
module.exports={validAppearance,atlasFor}
