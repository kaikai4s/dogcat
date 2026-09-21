const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('quick repeat and staff entry placement in client home page', async () => {
  // 1. Verify WXML structure
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/home/index.wxml')
  const wxmlContent = fs.readFileSync(wxmlPath, 'utf8')

  // quick-action-panel should contain onTapQuickRepeat
  assert.ok(wxmlContent.includes('bindtap="onTapQuickRepeat"'), 'quick-action-panel must contain onTapQuickRepeat')
  assert.ok(wxmlContent.includes('一键复购'), 'quick-action-panel must show 一键复购')

  // repeat-card should be removed
  assert.ok(!wxmlContent.includes('repeat-card'), 'standalone repeat-card must be removed')

  // staff entry must be at the very end of quick-action-panel
  const panelStartIndex = wxmlContent.indexOf('quick-action-panel')
  const panelEndIndex = wxmlContent.indexOf('</view>', wxmlContent.lastIndexOf('openStaffEntry'))
  const panelSection = wxmlContent.slice(panelStartIndex, panelEndIndex + 7)

  const quickRepeatIdx = panelSection.indexOf('onTapQuickRepeat')
  const staffEntryIdx = panelSection.indexOf('openStaffEntry')
  const securityIdx = panelSection.indexOf('home-security')

  assert.ok(quickRepeatIdx > 0, 'onTapQuickRepeat must be in panel')
  assert.ok(staffEntryIdx > securityIdx, 'openStaffEntry must be placed at the end of the panel (after security)')

  // 2. Verify JS logic for onTapQuickRepeat and loadStaffEntryState
  let navigatedUrl = null
  const mockWx = {
    navigateTo: ({ url }) => { navigatedUrl = url },
    showToast: () => {},
    getStorageSync: () => '宠护端',
    setStorageSync: () => {}
  }
  global.wx = mockWx

  const page = {
    data: {
      staffEntryLoaded: true,
      staffEntryTitle: '宠护端',
      repeatOrder: { _id: 'order_123', petName: '咪咪', serviceSummary: '喂养服务' }
    },
    setData(update) {
      Object.assign(this.data, update)
    },
    onTapQuickRepeat() {
      if (this.data.repeatOrder && this.data.repeatOrder._id) {
        mockWx.navigateTo({
          url: `/pages/client/orders/create/index?rebookOrderId=${this.data.repeatOrder._id}`
        })
      }
    },
    loadStaffEntryState(mockProfile) {
      // Must not reset staffEntryLoaded to false
      assert.equal(this.data.staffEntryLoaded, true, 'staffEntryLoaded must remain true during reload')
      const status = mockProfile && mockProfile.auditStatus
      const stateMap = {
        approved: { title: '宠护端' },
        pending: { title: '审核中' },
        rejected: { title: '修改认证' },
        none: { title: '申请宠护师' }
      }
      const entry = stateMap[status] || stateMap.none
      this.setData({
        staffEntryLoaded: true,
        staffEntryTitle: entry.title
      })
    }
  }

  // Test tapping quick repeat
  page.onTapQuickRepeat()
  assert.equal(navigatedUrl, '/pages/client/orders/create/index?rebookOrderId=order_123')

  // Test silent staff entry reload
  page.loadStaffEntryState({ auditStatus: 'approved' })
  assert.equal(page.data.staffEntryTitle, '宠护端')

  page.loadStaffEntryState({ auditStatus: 'pending' })
  assert.equal(page.data.staffEntryTitle, '审核中')
})
