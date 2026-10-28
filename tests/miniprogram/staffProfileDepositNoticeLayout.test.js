const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('staff profile deposit notice card layout: amount is cleanly formatted without awkward wrapping and footer is not wrapped', () => {
  const wxmlPath = path.join(__dirname, '../../miniprogram/pages/staff/profile/index.wxml')
  const wxssPath = path.join(__dirname, '../../miniprogram/pages/staff/profile/index.wxss')

  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  const wxss = fs.readFileSync(wxssPath, 'utf8')

  // 1. WXML 中包含结构化的金额容器与数字
  assert.ok(wxml.includes('deposit-amount-val'), 'WXML must define deposit-amount-val container')
  assert.ok(wxml.includes('deposit-amount-num'), 'WXML must define deposit-amount-num for price')
  assert.ok(wxml.includes('deposit-amount-label'), 'WXML must display label for deposit amount')
  assert.ok(wxml.includes('deposit-reason-box'), 'WXML must display structured reason box for repay')

  // 2. WXSS 中金额与金额容器必须显式声明 white-space: nowrap，防止数字断开或符号折行
  const amountValMatch = wxss.match(/\.deposit-amount-val\s*\{[\s\S]*?\}/)
  assert.ok(amountValMatch, '.deposit-amount-val rule must exist in wxss')
  assert.ok(amountValMatch[0].includes('white-space: nowrap'), '.deposit-amount-val must prevent wrapping')

  const amountContainerMatch = wxss.match(/\.deposit-notice-amount\s*\{[\s\S]*?\}/)
  assert.ok(amountContainerMatch, '.deposit-notice-amount rule must exist in wxss')
  assert.ok(amountContainerMatch[0].includes('white-space: nowrap'), '.deposit-notice-amount must prevent wrapping')
  assert.ok(!amountContainerMatch[0].includes('flex-wrap: wrap'), '.deposit-notice-amount must NOT wrap flex items')

  // 3. WXSS 中 footer 容器必须保持同一水平排版，不设置多余的 flex-wrap: wrap
  const footerMatch = wxss.match(/\.deposit-notice-footer\s*\{[\s\S]*?\}/)
  assert.ok(footerMatch, '.deposit-notice-footer rule must exist in wxss')
  assert.ok(!footerMatch[0].includes('flex-wrap: wrap'), '.deposit-notice-footer must NOT wrap items awkwardly')
  assert.ok(footerMatch[0].includes('justify-content: space-between'), '.deposit-notice-footer must justify content')
})
