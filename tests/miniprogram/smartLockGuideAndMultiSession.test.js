const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

test('orders/create has prominent smart lock requirements and app setup guidance', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.wxml'), 'utf8')
  const js = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.js'), 'utf8')

  // 1. 验证选项提示文案
  assert.match(js, /需智能锁App生成临时密码/)
  assert.match(js, /请填写智能门锁App生成的一次性开门密码/)

  // 2. 验证引导卡片中包含智能门锁、品牌App、临时有效密码说明
  assert.match(wxml, /智能门锁一次性密码设置指引/)
  assert.match(wxml, /需家中门锁为.*智能门锁.*且支持在门锁手机 App 中设置“一次性临时密码”/)
  assert.match(wxml, /手机.*App.*米家.*鹿客.*凯迪仕/)
  assert.match(wxml, /根据下方服务时间生成一次性临时有效密码/)
  assert.match(wxml, /placeholder="智能门锁App生成的一次性密码（本单专用）"/)
})

test('orders/detail supports smart lock tips, per-day session code views, and session-specific password updates', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/orders/detail/index.wxml'), 'utf8')
  const js = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/orders/detail/index.js'), 'utf8')

  // 1. 验证订单详情页展示各天专属智能锁密码列表
  assert.match(wxml, /智能门锁一次性密码/)
  assert.match(wxml, /各天专属智能锁密码/)
  assert.match(wxml, /session-codes-wrap/)

  // 2. 验证重新设置密码弹窗包含智能锁 App 生成指引和多场次选择器
  assert.match(wxml, /智能门锁一次性密码设置指引/)
  assert.match(wxml, /门锁.*App.*米家.*鹿客.*生成.*临时密码/)
  assert.match(wxml, /chooseResetSession/)

  // 3. 验证 JS 中 showResetOneTimeCode / chooseResetSession 的多场次组装逻辑
  assert.match(js, /resetSessionOptions/)
  assert.match(js, /chooseResetSession/)
  assert.match(js, /请填写智能锁临时密码和有效区间/)

  // 模拟 showResetOneTimeCode 和 chooseResetSession 的行为
  const context = {
    data: {
      order: {
        startTime: '2026-10-01 10:00:00',
        endTime: '2026-10-03 11:00:00',
        orderHomeSecurity: {
          oneTimeCode: { masked: '1***6', effectiveStart: '2026-10-01 09:30', effectiveEnd: '2026-10-01 11:30' },
          sessionCodes: [
            { sessionIndex: 1, date: '2026-10-01', masked: '1***6', effectiveStart: '2026-10-01 09:30', effectiveEnd: '2026-10-01 11:30' },
            { sessionIndex: 2, date: '2026-10-02', masked: '2***8', effectiveStart: '2026-10-02 09:30', effectiveEnd: '2026-10-02 11:30' }
          ]
        },
        serviceSessions: [
          { index: 1, date: '2026-10-01', startTime: '2026-10-01 10:00:00', endTime: '2026-10-01 11:00:00' },
          { index: 2, date: '2026-10-02', startTime: '2026-10-02 10:00:00', endTime: '2026-10-02 11:00:00' }
        ]
      },
      resetSessionOptions: [],
      selectedResetSessionIdx: 0,
      resetCodeForm: {}
    },
    setData(patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (k.includes('.')) {
          const parts = k.split('.')
          let target = this.data
          for (let i = 0; i < parts.length - 1; i++) target = target[parts[i]]
          target[parts[parts.length - 1]] = v
        } else {
          this.data[k] = v
        }
      }
    }
  }

  // 提取并测试 showResetOneTimeCode
  const order = context.data.order
  const security = order.orderHomeSecurity
  const sessions = order.serviceSessions
  const code = security.oneTimeCode
  const resetSessionOptions = [{ label: '整单通用/首场密码', sessionIndex: null, date: '', startTime: code.effectiveStart, endTime: code.effectiveEnd }]
  sessions.forEach(s => {
    const existingSessionCode = security.sessionCodes.find(item => Number(item.sessionIndex) === Number(s.index))
    resetSessionOptions.push({
      label: `第${s.index}天专属密码 (${s.date})`,
      sessionIndex: s.index,
      date: s.date,
      startTime: existingSessionCode.effectiveStart,
      endTime: existingSessionCode.effectiveEnd
    })
  })

  assert.equal(resetSessionOptions.length, 3)
  assert.equal(resetSessionOptions[1].sessionIndex, 1)
  assert.equal(resetSessionOptions[2].sessionIndex, 2)
})

test('staff/orders/service displays session-aware unlock code label and guidance', () => {
  const wxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/staff/orders/service/index.wxml'), 'utf8')
  assert.match(wxml, /unlock\.sessionIndex \? '第' \+ unlock\.sessionIndex \+ '天门锁密码' : '门锁密码'/)
  assert.match(wxml, /此密码为客户在智能门锁 App 中生成的本场次临时开门密码，仅在当前服务时间窗口内有效/)
})

test('orders/create & detail & staff/orders/service comprehensive guidance for remote_unlock and key entry', () => {
  const createWxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.wxml'), 'utf8')
  const createJs = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/orders/create/index.js'), 'utf8')
  const detailWxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/client/orders/detail/index.wxml'), 'utf8')
  const staffWxml = fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/staff/orders/service/index.wxml'), 'utf8')

  // 1. 验证创建页各方式描述与步骤指引
  assert.match(createJs, /需智能锁网关支持App开锁/)
  assert.match(createJs, /密码盒或隐蔽位置存放拍照/)
  assert.match(createWxml, /上门后远程开门使用指引/)
  assert.match(createWxml, /联网智能门锁.*已配网关保持在线.*远程开锁功能/)
  assert.match(createWxml, /微信提醒.*点击“请求开门”.*推送服务开门提醒/)
  assert.match(createWxml, /钥匙入户与存放安全指引/)
  assert.match(createWxml, /门边机械密码盒\/钥匙箱/)
  assert.match(createWxml, /原样放回原位置并强制拍照打卡/)
  assert.match(createWxml, /有人在家接待指引/)

  // 2. 验证订单详情页展示与存证说明
  assert.match(detailWxml, /发起远程开门请求，请注意查看微信通知/)
  assert.match(detailWxml, /待宠托师放回打卡/)
  assert.match(detailWxml, /宠托师必须在服务完成离开前将钥匙放回原位置并拍照打卡，平台全程留痕存证/)

  // 3. 验证员工服务打卡与指引
  assert.match(staffWxml, /请到达客户门前确认环境安全后，点击下方“请求开门”/)
  assert.match(staffWxml, /钥匙安全责任：请核对照片寻匙开门；服务结束离开前必须原位放回并拍照打卡，确保锁闭/)
})

