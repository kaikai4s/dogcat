const test = require('node:test')
const assert = require('node:assert/strict')
const {
  AssetLoader2D
} = require('../../miniprogram/packagePlayground/utils/asset-loader-2d')

test('farm cloud atlases keep their original canvas and skip decoration background processing', async () => {
  const previousWx=global.wx,requests=[]
  let width=1280
  global.wx={cloud:{downloadFile(options){requests.push(options.fileID);options.success({tempFilePath:'/tmp/farm-stage.png'})}},
    createOffscreenCanvas(){assert.fail('Transparent farm art must not be resized or background-removed')}}
  const canvas={createImage(){return {width,height:256,set src(value){queueMicrotask(()=>this.onload())}}}}
  const atlas={fileID:'cloud://test.env/farm/transparent-stages.png',columns:5,rows:1,frameSize:256}
  try {
    const loader=new AssetLoader2D(canvas),image=await loader.loadAtlas(atlas)
    assert.equal(image.width,1280);assert.equal(image.height,256)
    assert.equal(await loader.loadAtlas(atlas),image)
    assert.deepEqual(requests,[atlas.fileID])
    const wrong={...atlas,fileID:'cloud://test.env/farm/wrong-stages.png'}
    width=1024
    await assert.rejects(()=>loader.loadAtlas(wrong),/尺寸不匹配/)
    width=1280
    assert.equal((await loader.loadAtlas(wrong)).width,1280)
    assert.equal(requests.filter((id)=>id===wrong.fileID).length,2)
  }finally{if(previousWx===undefined)delete global.wx;else global.wx=previousWx}
})

test('cloud assets load only requested images, share downloads and recover after network or image failures', async () => {
  const requests = []
  let failNetwork = true
  let failDecode = true
  global.wx = {
    cloud: {
      downloadFile({ fileID, success, fail }) {
        requests.push(fileID)
        if (fileID.endsWith('/pq/pq6.png')) {
          fail(new Error('fountain frame unavailable'))
        } else if (fileID.includes('cat_run') && failNetwork) {
          failNetwork = false
          fail(new Error('network unavailable'))
        } else success({ tempFilePath: '/tmp/' + fileID.split('/').pop() })
      }
    },
    createOffscreenCanvas({ width, height }) {
      return {
        getContext: () => ({
          save() {},
          restore() {},
          translate() {},
          scale() {},
          drawImage() {},
          getImageData: () => ({
            data: new Uint8ClampedArray(width * height * 4)
          }),
          putImageData() {}
        })
      }
    }
  }
  const canvas = {
    createImage() {
      return {
        width: 2048,
        height: 2048,
        set src(value) {
          queueMicrotask(() => {
            if (value.includes('cat_run') && failDecode) {
              failDecode = false
              this.onerror(new Error('invalid image'))
            } else this.onload()
          })
        }
      }
    }
  }
  try {
    const first = new AssetLoader2D(canvas)
    const result = await first.loadAll(null, [
      'grass_tile',
      'dog_stand',
      'dog_run'
    ])
    assert.equal(Object.keys(result).length, 3)
    assert.equal(requests.length, 3)
    assert.ok(
      requests.every((id) => id.startsWith('cloud://') && !id.includes('house'))
    )
    await new AssetLoader2D(canvas).loadAll(null, [
      'grass_tile',
      'dog_stand',
      'dog_run'
    ])
    assert.equal(requests.length, 3)
    await assert.rejects(() => first.loadImage('cat_run'), /network/)
    await assert.rejects(() => first.loadImage('cat_run'), /invalid image/)
    assert.ok(await first.loadImage('cat_run'))
    assert.equal(requests.filter((id) => id.includes('cat_run')).length, 3)
    const decorations = await first.loadAll(
      null,
      ['pq/pq1', 'pq/pq6', 'dog_eat', 'cat_eat', 'dog_wo', 'cat_wo'],
      { optional: true }
    )
    assert.equal(Object.keys(decorations).length, 5)
    assert.ok(requests.some((id) => id.endsWith('/baseImage/pq/pq1.png')))
    for (const name of ['dog_eat', 'cat_eat', 'dog_wo', 'cat_wo']) {
      assert.ok(decorations[name])
      assert.ok(requests.some((id) => id.endsWith(`/baseImage/${name}.png`)))
    }
    await assert.rejects(() => first.loadAll(null, ['pq/pq6']), /unavailable/)
    const requestCount=requests.length
    const idle=await first.loadImage('boy_idle_sw')
    assert.ok(idle)
    assert.equal(requests.at(-1),'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/2d/baseImage/people/boy/boy-walk-sw-end/boy-walk-sw-stop.png')
    const atlas=await first.loadImage('boy_walk_sw')
    assert.ok(atlas)
    assert.equal(atlas.width,2048)
    assert.equal(requests.at(-1),'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/2d/baseImage/people/boy/boy-walk-sw-end/walk-sw.png')
    assert.ok(await first.loadImage('boy_run_sw'))
    assert.equal(requests.at(-1),'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/2d/baseImage/people/boy/boy-walk-sw-end/run-sw.png')
    assert.equal(requests.length,requestCount+3)
    for (const action of ['idle', 'walk', 'run']) {
      const image = await first.loadImage('girl_' + action + '_sw')
      assert.equal(image.width, 2048)
      assert.equal(requests.at(-1), 'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/2d/baseImage/people/girl/' + action + '-sw.png')
    }
    await new AssetLoader2D(canvas).loadAll(null, ['boy_idle_sw', 'boy_walk_sw', 'boy_run_sw'])
    assert.equal(requests.length,requestCount+6)
    const catAtlas = await first.loadImage('cat_walk')
    assert.equal(catAtlas.width, 2048)
    assert.equal(catAtlas.height, 2048)
    assert.equal(requests.at(-1), 'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/2d/baseImage/cat/walk.png')
    await new AssetLoader2D(canvas).loadImage('cat_walk')
    assert.equal(requests.length,requestCount+7)
    const dogAtlas = await first.loadImage('dog_walk')
    assert.equal(dogAtlas.width,2048)
    assert.equal(dogAtlas.height,2048)
    assert.equal(requests.at(-1),'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/2d/baseImage/dog/walk.png')
    await new AssetLoader2D(canvas).loadImage('dog_walk')
    assert.equal(requests.length,requestCount+8)
  } finally {
    delete global.wx
  }
})
