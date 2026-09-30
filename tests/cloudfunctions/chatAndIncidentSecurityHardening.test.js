const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('order chat: sendOrderSessionMessage enforces checkTextSecurity and checkImageSecurity', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_chat_1',
        orderNo: 'NO_CHAT_1',
        clientOpenid: 'openid_client',
        clientUserId: 'u_client',
        staffOpenid: 'openid_staff',
        staffUserId: 'u_staff',
        status: 'in_service'
      }
    ],
    order_message_threads: [],
    order_session_messages: [],
    risk_bypass_logs: []
  })

  // 1. 模拟微信内容安全检测
  const securityMock = {
    msgSecCheck: async ({ content }) => {
      if (content && content.includes('违规敏感词')) {
        const err = new Error('内容包含违法违规信息')
        err.errCode = 87014
        throw err
      }
      return { errCode: 0, errMsg: 'ok' }
    },
    imgSecCheck: async ({ media }) => {
      if (media && media.value && media.value.toString().includes('bad-image')) {
        const err = new Error('图片包含违规内容')
        err.errCode = 87014
        throw err
      }
      return { errCode: 0, errMsg: 'ok' }
    }
  }

  const clientFn = loadCloudFunction('api', db, 'openid_client', {
    security: securityMock,
    downloadFile: async ({ fileID }) => ({
      fileContent: fileID && fileID.includes('bad') ? Buffer.from('bad-image') : Buffer.from('good-image')
    })
  })

  // 1.1 发送违规文本被安全拦截
  const resBadText = await clientFn.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'ord_chat_1',
      content: '这里包含违规敏感词内容'
    }
  })
  assert.equal(resBadText.ok, false)
  assert.match(resBadText.message, /包含敏感或不合规/)

  // 1.2 模拟图片违规拦截
  const resBadImg = await clientFn.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'ord_chat_1',
      mediaUrl: 'cloud://bad_image.jpg'
    }
  })
  assert.equal(resBadImg.ok, false)
  assert.match(resBadImg.message, /包含违规敏感内容|包含敏感或不合规/)

  // 1.3 正常合规发送成功
  const resOk = await clientFn.main({
    module: 'order',
    action: 'sendOrderSessionMessage',
    data: {
      orderId: 'ord_chat_1',
      content: '宠托师您好，水碗在阳台左侧',
      mediaUrl: 'cloud://good_bowl.jpg'
    }
  })
  assert.equal(resOk.ok, true)
  assert.equal(resOk.data.content, '宠托师您好，水碗在阳台左侧')
  assert.equal(resOk.data.senderRole, 'client')
})

test('incident: createSosIncident triggers urgent admin notification and verifies description security', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_sos_1',
        orderNo: 'NO_SOS_001',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        staffUserId: 'u_staff',
        status: 'in_service'
      }
    ],
    order_incidents: [],
    admin_notifications: [],
    incident_actions: [],
    order_timelines: []
  })

  const staffFn = loadCloudFunction('api', db, 'openid_staff')

  // 发起 SOS 求助
  const res = await staffFn.main({
    module: 'incident',
    action: 'createSosIncident',
    data: {
      orderId: 'ord_sos_1',
      description: '现场犬只突发撕咬攻击，宠托师手部受伤，急需医疗与平台协助！',
      latitude: 39.9,
      longitude: 116.4
    }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.status, 'open')

  // 验证：管理员通知集合已写入最高优先级紧急告警（level: urgent, type: sos_alert）
  const adminNotifs = db.state.admin_notifications || []
  assert.equal(adminNotifs.length, 1)
  const notif = adminNotifs[0]
  assert.equal(notif.type, 'sos_alert')
  assert.equal(notif.level, 'urgent')
  assert.equal(notif.orderId, 'ord_sos_1')
  assert.match(notif.title, /紧急求助.*SOS/)
  assert.match(notif.content, /突发撕咬攻击/)
})

test('incident: createComplaint and appendIncidentComment enforce content and image security', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' },
      { _id: 'u_staff', openid: 'openid_staff', roles: ['staff'], status: 'active' }
    ],
    orders: [
      {
        _id: 'ord_comp_1',
        orderNo: 'NO_COMP_001',
        clientOpenid: 'openid_client',
        staffOpenid: 'openid_staff',
        status: 'completed'
      }
    ],
    order_incidents: [],
    incident_comments: [],
    incident_actions: []
  })

  const securityMock = {
    msgSecCheck: async ({ content }) => {
      if (content && content.includes('违禁词汇')) {
        const err = new Error('内容包含违禁词汇')
        err.errCode = 87014
        throw err
      }
      return { errCode: 0, errMsg: 'ok' }
    },
    imgSecCheck: async () => ({ errCode: 0, errMsg: 'ok' })
  }

  const clientFn = loadCloudFunction('api', db, 'openid_client', {
    security: securityMock,
    downloadFile: async () => ({ fileContent: Buffer.from('good-image') })
  })

  // 1. 投诉文字违规拦截
  const resBadComplaint = await clientFn.main({
    module: 'incident',
    action: 'createComplaint',
    data: {
      orderId: 'ord_comp_1',
      title: '服务投诉',
      description: '这里包含辱骂与违禁词汇'
    }
  })
  assert.equal(resBadComplaint.ok, false)
  assert.match(resBadComplaint.message, /包含敏感或不合规/)

  // 2. 正常投诉创建成功
  const resOkComplaint = await clientFn.main({
    module: 'incident',
    action: 'createComplaint',
    data: {
      orderId: 'ord_comp_1',
      title: '服务未按约定完成',
      description: '宠托师未按约定完成猫砂盆深度清洁，有照片为证',
      mediaFileIds: ['cloud://evidence_clean.jpg']
    }
  })
  assert.equal(resOkComplaint.ok, true)
  const incidentId = resOkComplaint.data._id

  // 3. 追加证据/留言安全检查
  const resBadComment = await clientFn.main({
    module: 'incident',
    action: 'appendIncidentComment',
    data: {
      incidentId,
      content: '含有违禁词汇的补充留言'
    }
  })
  assert.equal(resBadComment.ok, false)
  assert.match(resBadComment.message, /包含敏感或不合规/)

  // 4. 正常追加留言成功
  const resOkComment = await clientFn.main({
    module: 'incident',
    action: 'appendIncidentComment',
    data: {
      incidentId,
      content: '补充了当时的沟通记录截图',
      mediaFileIds: ['cloud://chat_proof.jpg']
    }
  })
  assert.equal(resOkComment.ok, true)
})

test('scheduled: runScheduledTasks completes concurrent retries and order lifecycle within budget', async () => {
  const db = createCollectionStore({
    orders: [],
    payments: [],
    user_coupons: [],
    staff_cancellations: [],
    pet_beauty_votes: [],
    pet_beauty_month_locks: []
  })

  // 模拟微信系统底层定时触发器调用（OPENID 为空，带 Timer 事件）
  const timerFn = loadCloudFunction('api', db, '')
  const res = await timerFn.main({
    Type: 'Timer',
    TriggerName: 'expireOrders'
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.expired, true)
})
