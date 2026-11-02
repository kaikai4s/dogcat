const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '../../miniprogram')

const pages = [
  { name: '宠托师', dir: 'pages/client/sitters/list' },
  { name: '订单', dir: 'pages/client/orders/list' },
  { name: '消息', dir: 'pages/client/messages' },
  { name: '我的', dir: 'pages/client/profile' }
]

test('宠托师、订单、消息、我的 4个页面均去除原生白色导航栏，开启 custom 全屏沉浸模式', () => {
  for (const page of pages) {
    const jsonPath = path.join(root, page.dir, 'index.json')
    const config = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    assert.equal(config.navigationStyle, 'custom', `${page.name} 页面必须开启 navigationStyle: custom`)
    assert.equal(config.navigationBarTextStyle, 'black')
    assert.equal(config.backgroundColor, '#FFE7CB')
    assert.equal(config.backgroundColorTop, '#FFE7CB')
  }
})

test('宠托师、订单、消息、我的 4个页面 WXML 与 WXSS: 包含全屏白橙暖色渐变大背景与吸顶导航栏，彻底移除多余的空占位布局', () => {
  for (const page of pages) {
    const wxml = fs.readFileSync(path.join(root, page.dir, 'index.wxml'), 'utf8')
    const wxss = fs.readFileSync(path.join(root, page.dir, 'index.wxss'), 'utf8')

    // WXML 包含吸顶导航栏，且彻底移除冗余的 nav-bar-placeholder 占位，避免下拉刷新时露出大片空白
    assert.match(wxml, /custom-nav-bar/, `${page.name} WXML 必须包含 custom-nav-bar 吸顶导航栏`)
    assert.doesNotMatch(wxml, /nav-bar-placeholder/, `${page.name} WXML 必须彻底移除 nav-bar-placeholder 空占位`)

    // 下拉刷新组件适配白橙色背景
    assert.match(wxml, /<dovlin-refresh[^>]*background="#FFE7CB"/, `${page.name} 下拉刷新必须适配 #FFE7CB`)

    // WXSS 包含直通顶部的白橙色全屏大背景
    assert.match(wxss, /linear-gradient\(180deg,\s*#ffe7cb/, `${page.name} WXSS 必须包含白橙暖色全屏渐变`)
  }
})

test('个人中心左上角标题显示为会员中心，消息中心导航栏标题显示为消息中心', () => {
  const profileWxml = fs.readFileSync(path.join(root, 'pages/client/profile/index.wxml'), 'utf8')
  assert.match(profileWxml, /<text class="nav-brand-cn">会员中心<\/text>/, '个人中心顶部左上角必须显示为「会员中心」')

  const messagesWxml = fs.readFileSync(path.join(root, 'pages/client/messages/index.wxml'), 'utf8')
  assert.match(messagesWxml, /<text class="nav-brand-cn">消息中心<\/text>/, '消息界面顶部导航栏必须显示为「消息中心」')
  assert.doesNotMatch(messagesWxml, /messages-hero/, '消息界面原有 messages-hero 顶部必须已彻底移除')
})

test('宠托师、订单、消息、我的 4个页面 JS 逻辑: 包含导航栏尺寸计算与避让', () => {
  for (const page of pages) {
    const js = fs.readFileSync(path.join(root, page.dir, 'index.js'), 'utf8')
    assert.match(js, /function getNavBarInfo/, `${page.name} JS 必须包含 getNavBarInfo`)
    assert.match(js, /initNavBar\(/, `${page.name} JS 必须包含 initNavBar`)
  }
})

test('我的页面（Profile）布局防乱版回归校验: profile-hero 纵向布局且签到中心不顶格浮动', () => {
  const profileWxss = fs.readFileSync(path.join(root, 'pages/client/profile/index.wxss'), 'utf8')
  // profile-hero 必须是纵向流式容器，绝不能是 row flex 导致 width: 100% 把用户信息挤出可视区
  assert.match(profileWxss, /\.profile-hero\s*\{[^}]*flex-direction:\s*column/s)
  // 签到中心绝不能绝对定位 top: 36rpx 浮在状态栏/电池栏上
  assert.doesNotMatch(profileWxss, /\.checkin-pill\s*\{[^}]*position:\s*absolute/s)
})

test('全屏沉浸页面的下拉刷新 dovlin-refresh 必须绑定 nav-bar-height 避免动画被吸顶导航栏遮挡', () => {
  const allFullscreenPages = [
    { name: '首页', dir: 'pages/client/home' },
    ...pages
  ]
  for (const page of allFullscreenPages) {
    const wxml = fs.readFileSync(path.join(root, page.dir, 'index.wxml'), 'utf8')
    assert.match(wxml, /<dovlin-refresh[^>]*nav-bar-height="\{\{navBarHeight/, `${page.name} 必须绑定 nav-bar-height`)
  }
  const refreshJs = fs.readFileSync(path.join(root, 'components/dovlin-refresh/index.js'), 'utf8')
  assert.match(refreshJs, /navBarHeight:\s*\{/)
  assert.match(refreshJs, /computedScrollStyle/)
})
