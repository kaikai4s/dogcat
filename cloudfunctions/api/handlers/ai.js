module.exports = function createHandler(context) {
  const {
    cloud,
    db,
    getOrderForAccess,
    nowText,
    readScopedDocuments,
    safeText
  } = context
  return async function ai(openid, action, data) {
    if (action === 'aiPetAssistant') {
      const question = safeText(data.question).trim()
      if (!question) throw new Error('请填写咨询问题')
      const petId = safeText(data.petId).trim()
      let petInfo = ''
      if (petId) {
        const petRes = await db.collection('pets').doc(petId).get().catch(() => null)
        const p = petRes && petRes.data ? petRes.data : null
        if (!p || p.openid !== openid) throw new Error('无权访问')
        petInfo = `【宠物资料】名称：${p.name}，种类：${p.species === 'dog' ? '狗' : p.species === 'cat' ? '猫' : '其他'}，品种：${p.breed || '未知'}，体重：${p.weight || '未填'}kg。`
      }

      let answer = ''
      // 直接调用微信云开发内置的 hy3-preview 大模型
      const model = cloud.extend.AI.createModel('hunyuan')
      const res = await model.generateText({
        model: 'hy3',
        messages: [
          { role: 'system', content: `你是一个VIP上门宠护平台的专业AI智能助手和宠物医生顾问，性格温馨专业，精通宠物护理、疾病预防、上门服务注意事项。${petInfo}` },
          { role: 'user', content: question }
        ]
      })

      if (res && res.choices && res.choices[0] && res.choices[0].message) {
        answer = res.choices[0].message.content
      } else if (res && res.text) {
        answer = res.text
      } else {
        answer = JSON.stringify(res)
      }

      return {
        question,
        answer,
        generatedAt: nowText(),
        source: 'hy3-preview'
      }
    }

    if (action === 'aiGenerateReport') {
      const orderId = safeText(data.orderId).trim()
      if (!orderId) throw new Error('订单 ID 不能为空')
      const { order } = await getOrderForAccess(openid, orderId)
      if (!order) throw new Error('订单不存在')

      const checkins = await readScopedDocuments('checkin_logs', { orderId }, 'createdAt', 'asc')
      const eventLabels = checkins.map(c => c.eventType).join('、')

      const reportSummary = `【AI 智能宠护报告总结】
今日给宝贝「${order.petName || '宠物'}」的服务已顺利完成！
服务项目：${order.serviceSummary || '上门宠护'}
关键服务打卡记录：${checkins.length} 次（打卡环节包含：${eventLabels || '基础入户与服务'}）。
宠物状态：精神状态良好，打卡互动顺畅，离户时已确认门锁与电源安全。感谢您的信任！`

      return {
        orderId,
        reportSummary,
        generatedAt: nowText()
      }
    }

    if (action === 'generatePetVoice') {
      const petId = safeText(data.petId).trim()
      const petData = data.pet && typeof data.pet === 'object' ? data.pet : {}
      let p = { ...petData }
      if (petId) {
        const petRes = await db.collection('pets').doc(petId).get().catch(() => null)
        const existingPet = petRes && petRes.data ? petRes.data : null
        if (!existingPet || existingPet.openid !== openid) throw new Error('无权访问')
        p = { ...existingPet, ...p }
      }

      const name = safeText(p.name).trim() || '宝贝'
      const speciesLabel = p.species === 'dog' ? '狗狗' : p.species === 'cat' ? '猫咪' : '小可爱'
      const breed = safeText(p.breed).trim()
      const personality = safeText(p.personality).trim()
      const specialNotes = safeText(p.specialNotes).trim()
      const serviceName = safeText(data.serviceName || data.serviceType).trim()
      const startDate = safeText(data.startDate).trim()

      let weekdayLabel = '今天'
      if (startDate) {
        const parts = startDate.split('-').map(Number)
        if (parts.length === 3) {
          const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]))
          const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
          weekdayLabel = days[d.getUTCDay()] || '今天'
        }
      }

      let voiceMessage = ''
      let source = 'preset'

      // 调用微信云开发内置混元大模型 (AI 宠护小助手同款模型)
      try {
        const aiExt = cloud.extend && cloud.extend.AI ? cloud.extend.AI : null
        if (aiExt) {
          let modelInstance
          try {
            modelInstance = aiExt.createModel('cloudbase')
          } catch (_) {
            modelInstance = aiExt.createModel('hunyuan')
          }
          if (modelInstance && typeof modelInstance.generateText === 'function') {
            const petProfile = `【宠物资料】昵称：${name}，种类：${speciesLabel}${breed ? `，品种：${breed}` : ''}${personality ? `，性格：${personality}` : ''}${specialNotes ? `，习惯特质：${specialNotes}` : ''}`
            const res = await modelInstance.generateText({
              model: 'hy3',
              messages: [
                {
                  role: 'system',
                  content: `你是一只名为「${name}」的${speciesLabel}，正在以第一人称口吻对最爱的主人撒娇和表达心声。${petProfile}。
说话内容必须同时包含两个方面：
1. 【告诉主人今天/当前天气情况】：结合当季时令告诉主人今天天气如何（例如阳光明媚温暖、秋高气爽微风正好、或者降温微凉提醒主人添衣）；
2. 【让主人安心放心】：告诉主人待会有宠托师来贴心照顾自己，自己会乖乖听话吃饭休息，让主人在外面安心工作忙碌，不用担心牵挂自己。
要求：
- 语气萌趣治愈、生动可爱、充满对主人的爱；
- 字数在35到65字左右；
- 严禁出现任何双引号、单引号、书名号、markdown标记，只直接输出宠物说的这一句话。`
                },
                {
                  role: 'user',
                  content: `主人为你预约了${startDate ? `${weekdayLabel}（${startDate}）` : '今天'}的${serviceName || '上门宠托'}服务。请以萌宠第一人称口吻，告诉主人今天天气情况并让主人安心放心！`
                }
              ]
            })

            let text = ''
            if (res && res.choices && res.choices[0] && res.choices[0].message) {
              text = res.choices[0].message.content
            } else if (res && res.text) {
              text = res.text
            }

            text = safeText(text).trim().replace(/^["“'「]+|["”'」]+$/g, '').replace(/[\r\n]+/g, ' ').trim()
            if (text && text.length >= 5 && text.length <= 80) {
              voiceMessage = text
              source = 'hy3'
            }
          }
        }
      } catch (err) {
        console.warn('[generatePetVoice] AI model call failed:', (err && err.message) || err)
      }

      if (!voiceMessage) {
        const fallbacks = [
          `主人，今天外头阳光暖洋洋的超舒服！有宠托师来陪我，我会超级乖的，你在外头安心工作不用担心我哦～`,
          `主人主人，今天天气凉爽微风正好～你帮我约的宠托师马上就到，我会按时吃粮喝水，主人安心忙吧不用惦记我！`,
          `主人，今天秋高气爽很适合晒太阳，等宠托师带我玩开心了我就回窝睡觉，你在外面安心拼事业，放一百个心吧～`,
          `今天天色微凉，主人出门记得多披件外套哦！我在家有宠托师细心照料，很安全很听话，主人放宽心去忙吧～`,
          `我是${name}！今天天气晴朗宜人，等宠托师陪我散步放风，我绝不捣乱拆家，主人安心上班，不用牵挂我呀～`,
          `主人快看，今天天气这么好！家里有贴心的宠托师陪伴，我一点都不孤单，主人就踏踏实实工作，不用操心我哦～`,
          `主人，今天微风习习很惬意呢！你给我安排的宠托师最贴心啦，我会乖乖等主人回家，主人安心忙碌别挂念我～`
        ]
        const idxMap = { '周日': 0, '周一': 1, '周二': 2, '周三': 3, '周四': 4, '周五': 5, '周六': 6 }
        const idx = idxMap[weekdayLabel] != null ? idxMap[weekdayLabel] : 2
        voiceMessage = fallbacks[idx]
        source = 'preset'
      }

      return {
        petId,
        name,
        weekdayLabel,
        voiceMessage,
        source
      }
    }

    throw new Error('未知 ai 操作')
  }
}
