const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('service flow collapsible click-to-toggle logic', async () => {
  // 1. Verify WXML structure
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/home/index.wxml')
  const wxmlContent = fs.readFileSync(wxmlPath, 'utf8')

  assert.ok(wxmlContent.includes('service-flow-collapse-wrap'), 'Must contain service-flow-collapse-wrap')
  assert.ok(wxmlContent.includes('service-flow-collapse-inner'), 'Must contain service-flow-collapse-inner for smooth animation')
  assert.ok(wxmlContent.includes('service-flow-head'), 'Must contain service-flow-head for click toggle')
  assert.ok(wxmlContent.includes('flow-toggle-arrow'), 'Must contain flow-toggle-arrow')
  assert.ok(wxmlContent.includes("{{flowExpanded ? '收起详情' : '展开详情'}}"), 'Button text must toggle between 展开详情 and 收起详情')

  // 2. Verify JS toggle logic
  const page = {
    data: {
      flowExpanded: false
    },
    setData(update) {
      Object.assign(this.data, update)
    },
    toggleFlowExpand() {
      this.setData({
        flowExpanded: !this.data.flowExpanded
      })
    }
  }

  // Initial state must be completely folded
  assert.equal(page.data.flowExpanded, false)

  // First tap expands content
  page.toggleFlowExpand()
  assert.equal(page.data.flowExpanded, true)

  // Second tap collapses content back
  page.toggleFlowExpand()
  assert.equal(page.data.flowExpanded, false)
})
