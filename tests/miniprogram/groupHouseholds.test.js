const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

test('household tabs preserve all pets and switch the service order only on explicit action', () => {
  let definition
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/components/group-households/index.js'), 'utf8'), {
    Component: value => { definition = value },
    require: () => require('../../miniprogram/utils/format')
  })
  const events = []
  const component = { data: { ...definition.data }, setData(patch) { Object.assign(this.data, patch) }, triggerEvent(...args) { events.push(args) } }
  const bundle = { members: [
    { orderId: 'a', serviceType: 'walk', petSnapshots: [{ name: 'cat' }] },
    { orderId: 'b', serviceType: 'future_service', petSnapshots: [{ name: 'dog' }, { name: 'kitten' }] }
  ] }
  component.data.bundle = bundle
  const observe = (id) => definition.observers['bundle,currentId'].call(component, bundle, id)
  observe('a')
  assert.equal(component.data.selected.orderId, 'a')
  assert.equal(component.data.selected.serviceTypeText, '遛狗服务')
  assert.equal(component.data.selected.serviceType, 'walk')
  assert.equal(bundle.members[0].serviceTypeText, undefined)
  definition.methods.select.call(component, { currentTarget: { dataset: { id: 'b' } } })
  assert.equal(component.data.selected.petSnapshots.length, 2)
  assert.equal(component.data.selected.serviceTypeText, '其他服务')
  assert.equal(component.data.selected.serviceType, 'future_service')
  assert.equal(events.length, 0)
  observe('a')
  assert.equal(component.data.selectedId, 'b')
  definition.methods.open.call(component)
  assert.equal(events[0][0], 'switchhousehold')
  assert.equal(events[0][1].orderId, 'b')
  observe('b')
  assert.equal(component.data.selectedId, 'b')
  observe('a')
  assert.equal(component.data.selectedId, 'a')
})
