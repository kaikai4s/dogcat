const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

test('最美宠物大赛: 小程序端界面包含海报展示、奖金说明与精美规则弹窗结构', () => {
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.wxml')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')

  // 1. 海报展示与预览入口 (横屏自适应展示，完整呈现2.5:1或16:9海报不被裁切，半透明角标不挡画面)
  assert.ok(wxml.includes('poster-banner-box'), '需包含海报展示容器')
  assert.ok(wxml.includes('poster-banner-img'), '需包含海报图片节点')
  assert.ok(wxml.includes('mode="widthFix"'), '海报图片需采用 widthFix 自适应横屏完整展示模式（零裁切）')
  assert.ok(wxml.includes('bindtap="previewPoster"'), '需支持点击海报查看大图')
  assert.ok(wxml.includes('today-vote-strip'), '需包含今日投票与邀请好友赠票进度提示条')
  assert.ok(wxml.includes('vote-main-text'), '需包含投票进度单行主文案节点')
  assert.ok(wxml.includes('vote-badge-hint'), '需包含邀新赠票提示小标签')
  assert.ok(wxml.includes('invite-bonus-tag'), '需包含一键分享邀请好友+1票标签')

  // 2. 样式校验：横屏自适应与半透明磨砂背景
  const wxssPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.wxss')
  const wxss = fs.readFileSync(wxssPath, 'utf8')
  assert.ok(wxss.includes('white-space: nowrap;'), '投票状态条文案需强制单行不换行，防止文字挤压换行')
  assert.ok(wxss.includes('min-height: 200rpx;'), '海报容器需设置横屏最小高度')
  assert.ok(wxss.includes('backdrop-filter: blur'), '文字角标需支持磨砂模糊效果')
  assert.ok(wxss.includes('rgba(18, 14, 12, 0.32)'), '月度冠军现金奖背景需为清透半透明磨砂')

  // 3. 冠军奖金醒目展区与规则入口
  assert.ok(wxml.includes('hero-prize-card'), '需包含冠军大奖展示卡片')
  assert.ok(wxml.includes('contestConfig.firstPrizeAmount'), '需动态渲染第一名奖金')
  assert.ok(wxml.includes('openRulesModal'), '需支持点击呼出规则与奖金说明')
  assert.ok(wxml.includes('contest-quick-bar'), '需包含常驻规则提示条')

  // 3. 详细规则与奖金说明弹窗结构与内容
  assert.ok(wxml.includes('rules-modal-mask'), '需包含规则弹窗蒙层')
  assert.ok(wxml.includes('rules-modal-container'), '需包含规则弹窗容器')
  assert.ok(wxml.includes('closeRulesModal'), '需包含关闭弹窗事件绑定')
  assert.ok(wxml.includes('月度第一名奖金与专属权益'), '弹窗内需详细说明第一名奖金与专属头衔')
  assert.ok(wxml.includes('参赛资格与美照要求'), '弹窗内需说明参赛门槛与美照规范')
  assert.ok(wxml.includes('投票机制与公平准则'), '弹窗内需说明每日1票与防刷票机制')
  assert.ok(wxml.includes('锁榜周期与奖金发放'), '弹窗内需说明月底24:00锁榜与发奖流程')
})

test('最美宠物大赛: 管理端设置页面支持第一名奖金设置、海报上传与规则定制', () => {
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/admin/settings/index.wxml')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')

  // 1. 概览卡片
  assert.ok(wxml.includes('data-panel="petBeautyContest"'), '管理端设置需包含大赛配置概览卡片')
  assert.ok(wxml.includes('最美宠物大赛与奖金'), '概览卡片需展示最美宠物大赛标题')
  assert.ok(wxml.includes('settings.petBeautyContest.firstPrizeAmount'), '概览卡片需展示当前设置的第一名奖金')

  // 2. 弹窗编辑面板
  assert.ok(wxml.includes("activeSettingPanel === 'petBeautyContest'"), '需包含大赛设置编辑弹窗面板')
  assert.ok(wxml.includes('data-field="firstPrizeAmount"'), '需包含第一名奖金输入框')
  assert.ok(wxml.includes('bindtap="choosePetBeautyPoster"'), '需支持点击上传活动海报')
  assert.ok(wxml.includes('bindtap="removePetBeautyPoster"'), '需支持清除海报并恢复默认')
  assert.ok(wxml.includes('data-field="detailedRules"'), '需支持详细规则特别补充说明输入')
})

test('最美宠物大赛: 页面逻辑与交互方法完整具备，且具备邀请人绑定与分享带参', () => {
  const jsPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.js')
  const js = fs.readFileSync(jsPath, 'utf8')

  assert.ok(js.includes('contestConfig:'), '页面初始数据需包含 contestConfig')
  assert.ok(js.includes('showRulesModal: false'), '页面初始数据需包含 showRulesModal 控制标识')
  assert.ok(js.includes('savePendingInvite'), '页面需引入并调用 savePendingInvite 存储邀请人')
  assert.ok(js.includes('inviteCode='), '分享链接需自动携带 inviteCode 参数')
  assert.ok(js.includes('inviterOpenid='), '分享链接需自动携带 inviterOpenid 参数')
  assert.ok(js.includes('openRulesModal()'), '页面需提供 openRulesModal 方法')
  assert.ok(js.includes('closeRulesModal()'), '页面需提供 closeRulesModal 方法')
  assert.ok(js.includes('previewPoster()'), '页面需提供 previewPoster 方法')

  const appPath = path.resolve(__dirname, '../../miniprogram/app.js')
  const appJs = fs.readFileSync(appPath, 'utf8')
  assert.ok(appJs.includes('savePendingInvite'), '全局 app.js 需支持进入时自动保存邀请人信息')
})

test('最美宠物大赛: 投票按钮变白色透明玻璃爱心、向左移动留下心电图变红、水滴融入与票数滚动动效', () => {
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.wxml')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')

  // 1. WXML 结构校验
  assert.ok(wxml.includes('flying-glass-heart'), '需包含飞行玻璃爱心节点')
  assert.ok(wxml.includes('ecg-pulse-trail'), '需包含心电图脉冲轨迹节点')
  assert.ok(wxml.includes('droplet-ripple'), '需包含水滴吸收融入扩散波纹')
  assert.ok(wxml.includes('flying-plus-one'), '需包含+1浮动飞升文本')
  assert.ok(wxml.includes('heart-target-icon'), '需包含左侧目标爱心节点')

  // 2. WXSS 动画与色彩校验
  const wxssPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.wxss')
  const wxss = fs.readFileSync(wxssPath, 'utf8')

  // 爱心颜色调红
  assert.ok(wxss.includes('#ff2d55 !important'), '原本爱心图标需调整为鲜亮纯正爱心红')

  // 玻璃爱心变色与向左平移关键帧动画
  assert.ok(wxss.includes('@keyframes glass-heart-flight'), '需包含玻璃爱心变色平移动画帧')
  assert.ok(wxss.includes('translate3d(-176rpx'), '玻璃爱心需向左移动至左侧目标爱心位置')
  assert.ok(wxss.includes('rgba(255, 255, 255, 0.88)'), '初始阶段需为白色半透明玻璃拟态')

  // 心电图轨迹动画
  assert.ok(wxss.includes('@keyframes ecg-trail-glow'), '需包含心电图闪烁展开动画')
  assert.ok(wxss.includes('background-image: url("data:image/svg+xml'), '心电图轨迹需基于矢量心跳波折线呈现')

  // 水滴吸收与数字滚动动画
  assert.ok(wxss.includes('@keyframes heart-droplet-absorbed'), '需包含左侧爱心如水滴融入吸收回弹关键帧')
  assert.ok(wxss.includes('@keyframes number-roll-up'), '需包含票数向上滚动增加关键帧')
  assert.ok(wxss.includes('@keyframes float-plus-one'), '需包含+1飞升关键帧')

  // 3. JS 状态管理
  const jsPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.js')
  const js = fs.readFileSync(jsPath, 'utf8')
  assert.ok(js.includes('animatingPetId'), 'JS需维护当前正在执行投票动画的宠物ID')
})

test('最美宠物大赛: 顶部标题动态显示为**月宠物最美大赛，且顶部海报与参赛照片支持骨骼预加载', () => {
  // 1. JSON 导航栏配置校验：不再显示为“最美宠物活动”
  const jsonPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.json')
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  assert.notEqual(json.navigationBarTitleText, '最美宠物活动', '页面导航栏标题不得再写死为 最美宠物活动')
  assert.ok(json.navigationBarTitleText.includes('宠物最美大赛'), '页面初始导航栏需包含 宠物最美大赛')

  // 2. JS 动态标题计算与更新逻辑
  const jsPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.js')
  const js = fs.readFileSync(jsPath, 'utf8')
  assert.ok(js.includes('formatContestTitle'), '需包含格式化大赛月份标题的方法')
  assert.ok(js.includes('月宠物最美大赛'), '标题需动态格式化为 **月宠物最美大赛')
  assert.ok(js.includes('updateContestTitle'), '需提供 updateContestTitle 动态更新导航栏标题')
  assert.ok(js.includes('wx.setNavigationBarTitle'), '需调用微信原生能力动态设置导航栏标题')

  // 3. 骨骼预加载状态与回调方法
  assert.ok(js.includes('posterLoaded: false'), '页面数据需维护海报加载状态')
  assert.ok(js.includes('photoLoadedMap:'), '页面数据需维护宠物美照加载状态字典')
  assert.ok(js.includes('onPosterLoaded()'), '需提供海报加载完成回调')
  assert.ok(js.includes('onPetPhotoLoaded('), '需提供宠物美照加载完成回调')

  // 4. WXML 骨架屏与骨骼预加载结构校验
  const wxmlPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.wxml')
  const wxml = fs.readFileSync(wxmlPath, 'utf8')
  assert.ok(wxml.includes('poster-skeleton-box'), '需包含顶部海报骨骼预加载骨架节点')
  assert.ok(wxml.includes('photo-skeleton-shimmer'), '需包含参赛宠物美照骨骼预加载骨架层')
  assert.ok(wxml.includes('avatar-skeleton-shimmer'), '需包含列表头像骨骼预加载骨架层')
  assert.ok(wxml.includes('beauty-skeleton-waterfall'), '需包含初始加载阶段的瀑布流骨架屏')
  assert.ok(wxml.includes('skeleton-shimmer'), '需应用全局骨骼流光预加载效果')

  // 5. WXSS 样式校验
  const wxssPath = path.resolve(__dirname, '../../miniprogram/pages/client/pet-beauty/activity/index.wxss')
  const wxss = fs.readFileSync(wxssPath, 'utf8')
  assert.ok(wxss.includes('.poster-skeleton-box'), '需具备海报骨架样式')
  assert.ok(wxss.includes('.photo-skeleton-shimmer'), '需具备宠物美照骨架样式')
  assert.ok(wxss.includes('.beauty-skeleton-waterfall'), '需具备瀑布流骨架样式')
})
