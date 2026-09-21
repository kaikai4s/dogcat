const test = require('node:test')
const assert = require('node:assert/strict')

test('checkin requirements hydration correctly populates photo counts and completed flag', () => {
  const sessionStartedAt = 1789950000000 // e.g. service started earlier
  const checkins = [
    { eventType: 'enter_door', mediaFileId: 'cloud://photo1.jpg', recordedAt: 1789950010000 },
    { eventType: 'enter_door', mediaFileId: 'cloud://photo2.jpg', recordedAt: '2026-09-21T02:00:20.000Z' },
    { eventType: 'leash_on', mediaFileId: 'cloud://photo3.jpg', recordedAt: 1789950030000 },
    { eventType: 'enter_door', mediaFileId: '', recordedAt: 1789950040000 }, // no photo, ignored
    { eventType: 'enter_door', mediaFileId: 'cloud://deleted.jpg', recordedAt: 1789950050000, deletedAt: new Date() } // deleted, ignored
  ]

  const checkinRequirements = [
    { eventType: 'enter_door', label: '到达入户', required: true, photoCount: 0, completed: false },
    { eventType: 'leash_on', label: '牵引准备', required: true, photoCount: 0, completed: false },
    { eventType: 'pet_status', label: '宠物状态', required: true, photoCount: 0, completed: false },
    { eventType: 'return_home', label: '返家确认', required: true, photoCount: 0, completed: false }
  ]

  const toTimeValue = (val) => {
    if (!val) return 0
    if (typeof val === 'number') return Number.isFinite(val) ? val : 0
    const parsed = new Date(val).getTime()
    return Number.isNaN(parsed) ? 0 : parsed
  }

  const validCheckins = checkins.filter((item) => {
    if (item.eventType === 'sanitization') return true
    return !item.deletedAt && toTimeValue(item.recordedAt) >= (sessionStartedAt - 60000)
  })

  const countsByType = {}
  validCheckins.forEach((c) => {
    if (c.eventType && c.mediaFileId) {
      countsByType[c.eventType] = (countsByType[c.eventType] || 0) + 1
    }
  })

  const enriched = checkinRequirements.map((req) => {
    const count = countsByType[req.eventType] !== undefined ? countsByType[req.eventType] : (req.photoCount || 0)
    return {
      ...req,
      photoCount: count,
      completed: count > 0 || Boolean(req.completed)
    }
  })

  const enterDoor = enriched.find((item) => item.eventType === 'enter_door')
  assert.equal(enterDoor.photoCount, 2)
  assert.equal(enterDoor.completed, true)

  const leashOn = enriched.find((item) => item.eventType === 'leash_on')
  assert.equal(leashOn.photoCount, 1)
  assert.equal(leashOn.completed, true)

  const petStatus = enriched.find((item) => item.eventType === 'pet_status')
  assert.equal(petStatus.photoCount, 0)
  assert.equal(petStatus.completed, false)
})
