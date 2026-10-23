const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const flush = () => new Promise(resolve => setImmediate(resolve))
function setup(respond) {
  let definition
  const calls = [], errors = []
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../miniprogram/packagePlayground/components/community-chooser/index.js'), 'utf8'), {
    Component(value) { definition = value }, require() { return {
      callFunction(module, action, data) { calls.push({ module, action, data }); return Promise.resolve().then(() => respond(action, data)) },
      chooseSelectedLocation: async () => ({ name: '地图小区', address: '公园路', city: '上海', district: '浦东' }),
      showError(error) { errors.push(error.message) }
    } }
  })
  const component = { ...definition.methods, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch) } }
  return { component, calls, errors }
}
test('community selection displays real counts and returns public community identity only after tapping a row', async () => {
  const item = { id: 'c', community: { name: '阳光小区', city: '上海', district: '浦东' }, residentCount: 132 }
  const { component } = setup(() => ({ list: [item], hasMore: false }))
  let selected = false
  const selection = component.open().then(value => { selected = true; return value })
  await flush()
  assert.equal(component.data.list[0].residentCount, 132)
  assert.equal(selected, false)
  component.select({ currentTarget: { dataset: { id: 'c' } } })
  const result = await selection
  assert.equal(result.district, '浦东')
  assert.equal(component.data.visible, false)
})
test('map choice displays occupancy before confirmation and count failures do not invent a zero', async () => {
  let fail = true
  const { component, errors } = setup((action) => {
    if (action === 'listCommunities') return { list: [], hasMore: false }
    if (fail) throw new Error('入住人数读取失败')
    return { id: 'map', community: { name: '地图小区', city: '上海' }, residentCount: 0 }
  })
  const selection = component.open()
  await flush()
  await component.map()
  assert.equal(component.data.candidate, null)
  assert.deepEqual(errors, ['入住人数读取失败'])
  assert.equal(component.data.visible, true)
  fail = false
  await component.map()
  assert.equal(component.data.candidate.residentCount, 0)
  assert.equal(component.data.visible, true)
  component.confirmCandidate()
  assert.equal((await selection).name, '地图小区')
})
test('closing the community selector cancels without changing the selected community', async () => {
  const { component } = setup(() => ({ list: [], hasMore: false }))
  const selection = component.open()
  const result = assert.rejects(selection, error => String(error.errMsg).includes('cancel'))
  component.close()
  await result
  await flush()
  assert.equal(component.data.visible, false)
})
