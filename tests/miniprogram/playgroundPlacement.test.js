const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('placement failure shows the complete cloud error and retains the existing yard', async () => {
  const modals = []
  let page
  const oldPlot = { id: 'old', x: 200, z: 200 }
  const source = fs.readFileSync(
    path.join(__dirname, '../../miniprogram/packagePlayground/pages/world.js'),
    'utf8'
  )
  vm.runInNewContext(source, {
    Page: (value) => {
      page = value
    },
    require: (name) =>
      name.includes('world2d')
        ? {}
        : {
            callFunction: async () => {
              const error = new Error(
                'document.set:fail resource system error; requestId: test-request'
              )
              error.code = -501001
              throw error
            }
          },
    wx: {
      showModal(options) {
        modals.push(options)
        if (options.success) options.success({ confirm: true })
      }
    }
  })
  page.setData = (value) => Object.assign(page.data, value)
  page.data.hasPlot = true
  page.data.canRelocate = true
  page.world = {
    ownPlot: oldPlot,
    candidate: { x: 400.25, z: 500.75, cellX: 7, cellZ: 8, size: 72 },
    chunks: new Map(),
    chunkKey: (x, z) => `${x},${z}`,
    setPlot() {
      assert.fail('failed save must not replace the old yard')
    }
  }
  await page.confirmPlot()
  assert.equal(modals.length, 2)
  assert.equal(modals[1].title, '庭院位置保存失败')
  assert.match(modals[1].content, /document.set:fail.*test-request/)
  assert.match(modals[1].content, /-501001/)
  assert.equal(modals[1].showCancel, false)
  assert.equal(page.world.ownPlot, oldPlot)
  assert.equal(page.data.claiming, false)
})
