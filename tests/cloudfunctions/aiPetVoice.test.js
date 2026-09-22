const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('ai generatePetVoice: successfully generates voice using hy3 model and cleans quotes', async () => {
  const db = createCollectionStore({
    pets: [
      {
        _id: 'pet_doudou',
        name: '豆豆',
        species: 'dog',
        breed: '柯基',
        personality: '活泼好动，喜欢玩球',
        specialNotes: '进门时会稍微激动'
      }
    ]
  })

  let modelCalledWith = null
  const mockAiExt = {
    createModel(provider) {
      assert.ok(provider === 'cloudbase' || provider === 'hunyuan')
      return {
        async generateText(options) {
          modelCalledWith = options
          return {
            choices: [
              {
                message: {
                  content: '“主人，周二我也在想你呢，等宠托师陪我玩开心了就回去抱你～”'
                }
              }
            ]
          }
        }
      }
    }
  }

  const fn = loadCloudFunction('api', db, 'openid_client', {
    extend: {
      AI: mockAiExt
    }
  })

  const res = await fn.main({
    module: 'ai',
    action: 'generatePetVoice',
    data: {
      petId: 'pet_doudou',
      startDate: '2026-09-22',
      serviceType: 'walk'
    }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.name, '豆豆')
  assert.equal(res.data.weekdayLabel, '周二')
  assert.equal(res.data.source, 'hy3')
  // Quotes should be stripped
  assert.equal(res.data.voiceMessage, '主人，周二我也在想你呢，等宠托师陪我玩开心了就回去抱你～')
  assert.ok(!res.data.voiceMessage.startsWith('“'))
  assert.ok(!res.data.voiceMessage.endsWith('”'))

  // Verify prompt passed to model
  assert.equal(modelCalledWith.model, 'hy3')
  assert.ok(modelCalledWith.messages[0].content.includes('豆豆'))
  assert.ok(modelCalledWith.messages[0].content.includes('柯基'))
  assert.ok(modelCalledWith.messages[0].content.includes('活泼好动'))
  assert.ok(modelCalledWith.messages[0].content.includes('天气'))
  assert.ok(modelCalledWith.messages[0].content.includes('安心放心'))
})

test('ai generatePetVoice: gracefully falls back to preset when AI is unavailable or fails', async () => {
  const db = createCollectionStore({
    pets: [
      {
        _id: 'pet_huahua',
        name: '花花',
        species: 'cat',
        breed: '英短'
      }
    ]
  })

  const mockAiError = {
    createModel() {
      return {
        async generateText() {
          throw new Error('AI network timeout')
        }
      }
    }
  }

  const fn = loadCloudFunction('api', db, 'openid_client', {
    extend: {
      AI: mockAiError
    }
  })

  const res = await fn.main({
    module: 'ai',
    action: 'generatePetVoice',
    data: {
      petId: 'pet_huahua',
      startDate: '2026-09-22' // Tuesday
    }
  })

  assert.equal(res.ok, true)
  assert.equal(res.data.source, 'preset')
  assert.equal(res.data.weekdayLabel, '周二')
  // Verify both weather and reassurance exist in message
  assert.ok(res.data.voiceMessage.includes('秋高气爽') || res.data.voiceMessage.includes('天气') || res.data.voiceMessage.includes('阳光'))
  assert.ok(res.data.voiceMessage.includes('安心') || res.data.voiceMessage.includes('放一百个心') || res.data.voiceMessage.includes('不用担心'))
})
