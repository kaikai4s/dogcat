const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('theme switching feature is completely removed from client settings and profile', () => {
  const settingsWxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/settings/index.wxml')
  const settingsWxml = fs.readFileSync(settingsWxmlPath, 'utf8')

  const profileWxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/profile/index.wxml')
  const profileWxml = fs.readFileSync(profileWxmlPath, 'utf8')

  // 1. settings page should not contain theme switching UI
  assert.ok(!settingsWxml.includes('主题切换'), 'settings.wxml must not contain "主题切换"')
  assert.ok(!settingsWxml.includes('ri-palette-line'), 'settings.wxml must not contain theme icon ri-palette-line')
  assert.ok(!settingsWxml.includes('bindchange="changeTheme"'), 'settings.wxml must not bind changeTheme')
  assert.ok(settingsWxml.includes('字体设置'), 'settings.wxml should still maintain 字体设置')

  // 2. profile page should not contain theme switching UI
  assert.ok(!profileWxml.includes('主题切换'), 'profile.wxml must not contain "主题切换"')
  assert.ok(!profileWxml.includes('bindchange="changeTheme"'), 'profile.wxml must not bind changeTheme')
  assert.ok(profileWxml.includes('字体设置'), 'profile.wxml should still maintain 字体设置')
})

test('theme utility always normalizes to default day theme', () => {
  const { applyTheme, getSavedThemeKey, normalizeThemeKey, getThemeState, getThemeOption } = require('../../miniprogram/utils/theme')

  assert.equal(getSavedThemeKey(), 'day', 'saved theme must normalize to day')
  assert.equal(normalizeThemeKey('night'), 'day', 'night theme must normalize to day')
  assert.equal(normalizeThemeKey('unknown'), 'day', 'unknown theme must normalize to day')

  const state = getThemeState('night')
  assert.equal(state.themeKey, 'day')
  assert.equal(state.themeClass, 'theme-day')

  const applied = applyTheme('night')
  assert.equal(applied.value, 'day')
  assert.equal(applied.className, 'theme-day')
})
