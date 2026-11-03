const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const format = require('../../miniprogram/utils/format')

const root = path.resolve(__dirname, '../../miniprogram')
function loadPage(relative) {
  const context = {
    Page() {},
    require(name) {
      if (name.endsWith('/format')) return format
      return { navMethods: () => ({}) }
    }
  }
  vm.runInNewContext(fs.readFileSync(path.join(root, relative), 'utf8'), context)
  return context
}

for (const role of ['client', 'staff', 'admin']) {
  test(`${role} incident detail renders resolution and actor labels without changing raw data`, () => {
    const relative = `pages/${role}/incidents/detail/index`
    const { decorate } = loadPage(`${relative}.js`)
    for (const type of ['refund', 'coupon', 'explain', 'reject', 'future_resolution', '']) {
      const original = {
        incident: { _id: 'incident-1', orderId: 'order-1', title: 'keep_title', description: 'keep_description', status: 'refund_pending', resolution: { type, content: 'keep_content', refundAmount: 12 } },
        comments: ['admin', 'staff', 'client', 'system', 'future_role', ''].map(actorRole => ({ actorRole, content: 'keep_comment', mediaFileIds: ['photo-1'] })),
        actions: [{ actorRole: 'future_role', action: 'future_action', detail: { remark: 'keep_remark' } }]
      }
      const before = structuredClone(original)
      const result = decorate(original)
      assert.equal(result.incident.resolutionTypeText, format.formatIncidentResolutionType(type))
      assert.match(result.incident.resolutionTypeText, /[\u4e00-\u9fff]/)
      assert.equal(result.incident.statusText, '退款处理中')
      assert.equal(result.incident.status, 'refund_pending')
      assert.deepEqual(result.incident.resolution, original.incident.resolution)
      assert.equal(result.incident.title, 'keep_title')
      assert.equal(result.incident.description, 'keep_description')
      assert.equal(result.incident.orderId, 'order-1')
      result.comments.forEach((comment, index) => {
        assert.equal(comment.actorRoleText, format.formatActorRole(original.comments[index].actorRole))
        assert.equal(comment.actorRole, original.comments[index].actorRole)
        assert.equal(comment.content, 'keep_comment')
        assert.equal(comment.mediaFileIds[0], 'photo-1')
      })
      if (role === 'admin') {
        assert.equal(result.actions[0].actorRoleText, format.formatActorRole('future_role'))
        assert.equal(result.actions[0].detailText, 'keep_remark')
      }
      assert.deepEqual(original, before)
    }
    assert.doesNotThrow(() => decorate({ incident: {} }))
    const template = fs.readFileSync(path.join(root, `${relative}.wxml`), 'utf8')
    assert.ok(template.includes('{{detail.incident.resolutionTypeText}}'))
    assert.ok(template.includes('{{item.actorRoleText}}'))
    assert.doesNotMatch(template, /\{\{detail\.incident\.resolution\.type(?:\s|\}|\|)/)
    assert.doesNotMatch(template, /\{\{item\.actorRole\}\}/)
  })
}

test('staff bundled-order service label does not fall back to the raw service type', () => {
  const template = fs.readFileSync(path.join(root, 'pages/staff/home/index.wxml'), 'utf8')
  assert.ok(template.includes("{{sub.serviceSummary || '上门宠护'}}"))
  assert.doesNotMatch(template, /\{\{sub\.serviceSummary\s*\|\|\s*sub\.serviceType\}\}/)
})

for (const page of ['tracking', 'report']) {
  test(`${page} photo groups use checkin formatter and retain event keys, remarks and media`, () => {
    const { groupCheckinPhotos } = loadPage(`pages/client/orders/${page}/index.js`)
    const photos = ['feed', 'future_event', ''].map((eventType, i) => ({ eventType, eventTypeText: eventType, mediaFileId: `photo-${i}`, remark: 'keep_remark' }))
    const groups = groupCheckinPhotos(photos)
    assert.equal(groups[0].eventTypeText, '喂食')
    assert.equal(groups[1].eventTypeText, '照护打卡')
    assert.equal(groups[2].eventTypeText, '照护打卡')
    groups.forEach((group, i) => {
      assert.equal(group.eventType, photos[i].eventType)
      assert.equal(group.photos[0], photos[i])
      assert.equal(group.remarkText, 'keep_remark')
    })
  })
}
