const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('staff profile service config card title prevents text wrapping with compact edit button', () => {
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/staff/profile/index.wxml')
  const wxssPath = path.resolve(__dirname, '../../miniprogram/pages/staff/profile/index.wxss')

  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  const wxss = fs.readFileSync(wxssPath, 'utf8')

  // 1. WXML button label should be compact "编辑" rather than verbose "编辑配置"
  assert.ok(wxml.includes('<text class="remix-icon ri-edit-line"></text>编辑\n      </button>') ||
            wxml.includes('<text class="remix-icon ri-edit-line"></text>编辑</button>'),
            'button label should be compact "编辑"')
  assert.ok(wxml.includes('bindtap="openConfigModal"'), 'must preserve bindtap="openConfigModal"')

  // 2. card-subtitle must prevent text wrapping and support flexible shrink
  assert.match(wxss, /\.card-subtitle\s*\{[^}]*white-space:\s*nowrap/s, 'card-subtitle must have white-space: nowrap')
  assert.match(wxss, /\.card-subtitle\s*\{[^}]*font-size:\s*28rpx/s, 'card-subtitle font-size should be 28rpx to leave ample room')

  // 3. edit-pill-btn must prevent shrinking and wrapping, and must not stretch (width: auto)
  assert.match(wxss, /\.edit-pill-btn\s*\{[^}]*flex-shrink:\s*0/s, 'edit-pill-btn must have flex-shrink: 0')
  assert.match(wxss, /\.edit-pill-btn\s*\{[^}]*white-space:\s*nowrap/s, 'edit-pill-btn must have white-space: nowrap')
  assert.match(wxss, /\.edit-pill-btn\s*\{[^}]*width:\s*auto/s, 'edit-pill-btn must have width: auto to prevent default 184px stretch')
  assert.match(wxml, /class="edit-pill-btn"[^>]*size="mini"/s, 'edit-pill-btn must use size="mini"')
})
