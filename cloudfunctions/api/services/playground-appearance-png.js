const crypto = require('crypto')
const zlib = require('zlib')
const signature = Buffer.from([137,80,78,71,13,10,26,10])
const crcTable = Array.from({length:256},(_,i)=>{
  for(let j=0;j<8;j++)i=i&1?0xedb88320^(i>>>1):i>>>1
  return i>>>0
})
function crc32(bytes) {
  let crc=0xffffffff
  for(const byte of bytes)crc=crcTable[(crc^byte)&255]^(crc>>>8)
  return (crc^0xffffffff)>>>0
}
function inspectAtlas(buffer) {
  if(!Buffer.isBuffer(buffer)||buffer.length>8*1024*1024||!buffer.subarray(0,8).equals(signature))
    throw new Error('请上传不超过8MB的透明PNG图集')
  let header,idat=[],ended=false,offset=8
  while(offset+12<=buffer.length) {
    const length=buffer.readUInt32BE(offset),end=offset+12+length
    if(end>buffer.length)throw new Error('PNG文件不完整')
    const type=buffer.toString('ascii',offset+4,offset+8),bytes=buffer.subarray(offset+8,end-4)
    if(crc32(buffer.subarray(offset+4,end-4))!==buffer.readUInt32BE(end-4))throw new Error('PNG校验失败，请重新导出')
    if(!header&&type!=='IHDR')throw new Error('PNG格式不正确')
    if(type==='IHDR') {
      if(header||length!==13)throw new Error('PNG格式不正确')
      header={width:bytes.readUInt32BE(0),height:bytes.readUInt32BE(4)}
      const size=header.width/4
      if(![128,256,512].includes(size)||header.height!==size*6||bytes[8]!==8||bytes[9]!==6||bytes[10]||bytes[11]||bytes[12])
        throw new Error('图集需为4列6行、24帧透明RGBA PNG，每格128、256或512像素，关闭隔行扫描')
    }
    if(type==='acTL')throw new Error('请上传静态24帧图集，不支持动态PNG')
    if(type==='IDAT')idat.push(bytes)
    if(type==='IEND') {ended=true;offset=end;break}
    offset=end
  }
  if(!header||!idat.length||!ended||offset!==buffer.length)throw new Error('PNG文件不完整')
  const {width,height}=header,rowBytes=width*4,expected=(rowBytes+1)*height
  let raw
  try {raw=zlib.inflateSync(Buffer.concat(idat),{maxOutputLength:expected})}
  catch(error) {throw new Error('PNG像素数据损坏，请重新导出')}
  if(raw.length!==expected)throw new Error('PNG像素数据不完整')
  let previous=Buffer.alloc(rowBytes),transparent=false
  const frames=new Uint32Array(24),size=width/4,hash=crypto.createHash('sha256').update(`${width}x${height}:`)
  const paeth=(a,b,c)=>{
    const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c)
    return pa<=pb&&pa<=pc?a:pb<=pc?b:c
  }
  for(let y=0;y<height;y++) {
    const filter=raw[y*(rowBytes+1)],row=Buffer.allocUnsafe(rowBytes)
    if(filter>4)throw new Error('PNG滤波格式不正确')
    for(let x=0;x<rowBytes;x++) {
      const a=x>=4?row[x-4]:0,b=previous[x],c=x>=4?previous[x-4]:0
      const predictor=filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):0
      row[x]=(raw[y*(rowBytes+1)+1+x]+predictor)&255
      if(x%4===3) {
        if(row[x]<255)transparent=true
        if(row[x]>0)frames[Math.floor(y/size)*4+Math.floor((x>>2)/size)]++
      }
    }
    // Preserve original bytes for the next row's PNG filter prediction.
    const canonical=Buffer.from(row)
    for(let x=3;x<rowBytes;x+=4)if(!row[x])canonical.fill(0,x-3,x)
    hash.update(canonical)
    previous=row
  }
  if(!transparent||frames.some((count)=>count===0))throw new Error('图集必须保留透明背景，且24个格子都需要有动作画面')
  return {digest:hash.digest('hex'),width,height,frameSize:size,frames:24,columns:4,rows:6,anchor:460/512}
}
module.exports={inspectAtlas,crc32}
