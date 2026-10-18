const zlib=require('node:zlib')
// Independent encoder used to exercise the server decoder, including all PNG filters.
function crc32(bytes) {
  let crc=0xffffffff
  for(const byte of bytes) {crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1}
  return (crc^0xffffffff)>>>0
}
function chunk(name,bytes) {
  const type=Buffer.from(name),out=Buffer.alloc(bytes.length+12)
  out.writeUInt32BE(bytes.length);type.copy(out,4);bytes.copy(out,8)
  out.writeUInt32BE(crc32(Buffer.concat([type,bytes])),out.length-4)
  return out
}
function atlas({color=100,filter=0,hidden=0,blank=-1,opaque=false,columns=4,rows=6,level=6}={}) {
  const width=128*columns,height=128*rows,stride=width*4,raw=Buffer.alloc((stride+1)*height)
  let previous=Buffer.alloc(stride)
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c}
  for(let y=0;y<height;y++) {
    const row=Buffer.alloc(stride)
    for(let x=0;x<width;x++) {
      const occupied=(opaque||x%128>48&&x%128<78&&y%128>30&&y%128<115)&&Math.floor(y/128)*columns+Math.floor(x/128)!==blank
      row[x*4]=occupied?color:hidden;row[x*4+1]=occupied?120:hidden;row[x*4+2]=occupied?80:hidden;row[x*4+3]=occupied?255:0
    }
    raw[y*(stride+1)]=filter
    for(let i=0;i<stride;i++) {
      const a=i>=4?row[i-4]:0,b=previous[i],c=i>=4?previous[i-4]:0
      const predictor=filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):0
      raw[y*(stride+1)+1+i]=(row[i]-predictor)&255
    }
    previous=row
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw,{level})),chunk('IEND',Buffer.alloc(0))])
}
module.exports={atlas,chunk}
