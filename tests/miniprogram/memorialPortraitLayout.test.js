const test = require('node:test'), assert = require('node:assert/strict')
const { portraitLayout, placementPreview, drawPortrait } = require('../../miniprogram/packageMemorial/scene/memorial-portrait-layout')
const { inspectPortrait } = require('../../cloudfunctions/api/services/playground-appearance-png')
const { chunk } = require('../fixtures/appearanceAtlas')
const zlib = require('node:zlib')
function png(size, b) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) {
    const i = y * (size * 4 + 1) + 1 + x * 4
    raw[i] = 180; raw[i + 1] = 140; raw[i + 2] = 100; raw[i + 3] = 255
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const close = (a,b) => assert.ok(Math.abs(a-b) < 1e-7, `${a} != ${b}`)
const css = value => Object.fromEntries(value.split(';').filter(Boolean).map(p => { const [k,v] = p.split(':'); return [k,parseFloat(v)] }))
test('alpha bounds remove unequal transparent margins without changing proportions, for small cats and wide sleeping pets', () => {
  for (const [size,bounds] of [[512,{x:320,y:100,width:40,height:100}], [512,{x:17,y:300,width:440,height:130}], [1024,{x:100,y:21,width:600,height:750}]]) {
    const inspected=inspectPortrait(png(size,bounds));assert.deepEqual(inspected.bounds,bounds)
    for (const legacy of [false,true]) for (const scale of [.5,1,1.4]) {
      const memorial={x:170,y:400,legacy,portrait:{...inspected,layoutVersion:1,scale}}
      const box=portraitLayout(memorial), ratio=legacy?64/112:1
      close(box.width/box.height,bounds.width/bounds.height)
      close(box.x+box.width/2,memorial.x); close(box.y+box.height,memorial.y+(legacy?3:6))
      assert.ok(box.width<=78.400001*ratio);assert.ok(box.height<=67.200001*ratio)
      const draws=[],context=new Proxy({}, {get:(_,key)=>(...args)=>{if(key==='drawImage')draws.push(args)}}), image={}
      drawPortrait(context,image,memorial)
      assert.deepEqual(draws[0],[image,bounds.x,bounds.y,bounds.width,bounds.height,box.x,box.y,box.width,box.height])
      const texture={width:256,height:256};drawPortrait(context,texture,memorial)
      assert.deepEqual(draws[1],[texture,bounds.x*256/size,bounds.y*256/size,bounds.width*256/size,bounds.height*256/size,box.x,box.y,box.width,box.height])
      // The admin's clipped PNG uses the exact same destination and crop as Canvas.
      const preview=placementPreview(memorial,memorial.portrait), pet=css(preview.pet), art=css(preview.image)
      const world=portraitLayout({...memorial,x:84*ratio,y:147*ratio})
      close(pet.left/100*168*ratio,world.x);close(pet.top/100*192*ratio,world.y)
      close(pet.width/100*168*ratio,world.width);close(pet.height/100*192*ratio,world.height)
      close(art.width/100,size/bounds.width);close(art.height/100,size/bounds.height)
      close(art.left/100,-bounds.x/bounds.width);close(art.top/100,-bounds.y/bounds.height)
    }
  }
})
test('different PNG padding and resolutions produce identical physical pet sizes', () => {
  const a={layoutVersion:1,width:512,height:512,bounds:{x:200,y:100,width:80,height:120},scale:1.2}
  const b={layoutVersion:1,width:1024,height:1024,bounds:{x:20,y:50,width:320,height:480},scale:1.2}
  const m={x:100,y:200}
  const first=portraitLayout(m,a), second=portraitLayout(m,b)
  for(const key of ['x','y','width','height','groundY'])close(first[key],second[key])
  const old=portraitLayout(m,{width:512,height:512});assert.equal(old.crop,undefined);assert.equal(old.width,88)
})
