const test = require('node:test')
const assert = require('node:assert/strict')
const constants = require('../../cloudfunctions/api/config/constants')
const legacy = require('../../cloudfunctions/api/config/legacy-staff-training-quiz')
const { createCollectionStore, loadCloudFunction } = require('./helpers')
const service = require('../../cloudfunctions/api/services/staffTraining')({ ...constants, safeText: value => String(value ?? '') })

test('default bank contains the original five and 45 distinct valid single-choice questions', () => {
  const bank = constants.DEFAULT_STAFF_TRAINING_QUIZ
  assert.equal(bank.length, 50)
  assert.deepEqual(bank.slice(0, 5), legacy)
  assert.equal(new Set(bank.map(q => q.id)).size, 50)
  assert.equal(new Set(bank.map(q => q.question)).size, 50)
  for (const q of bank) {
    assert.equal(q.type, 'single')
    assert.ok(q.options.length >= 2 && q.options.length <= 6)
    assert.ok(q.options.every(option => option.label.trim()))
    assert.equal(q.options.filter(option => option.value === q.answer).length, 1)
  }
})

test('legacy untouched default upgrades, but explicit selections and custom questions persist', () => {
  assert.equal(service.normalizeStaffTrainingConfig().quiz.length, 50)
  assert.equal(service.normalizeStaffTrainingConfig({ quiz: legacy }).quiz.length, 50)
  const chosen = service.normalizeStaffTrainingConfig({ quiz: legacy, quizBankVersion: 2 })
  assert.equal(chosen.quiz.length, 5)
  assert.equal(service.normalizeStaffTrainingConfig(chosen).quiz.length, 5)
  const edited = structuredClone(legacy)
  edited[0].question = '管理员自行编辑的题目'
  assert.equal(service.normalizeStaffTrainingConfig({ quiz: edited }).quiz[0].question, edited[0].question)
  assert.equal(service.normalizeStaffTrainingConfig({ quiz: edited }).quiz.length, 5)
  const selected = service.normalizeStaffTrainingConfig({ quiz: constants.DEFAULT_STAFF_TRAINING_QUIZ.slice(10, 15), quizBankVersion: 2 })
  assert.deepEqual(selected.quiz.map(q => q.id), ['q11', 'q12', 'q13', 'q14', 'q15'])
})

test('normalization clones defaults and public training questions contain no answers', () => {
  const first = service.normalizeStaffTrainingConfig()
  first.quiz[0].options[0].label = 'changed'
  assert.notEqual(service.normalizeStaffTrainingConfig().quiz[0].options[0].label, 'changed')
  const exposed = service.publicTrainingQuiz(service.normalizeStaffTrainingConfig().quiz)
  assert.equal(exposed.length, 50)
  assert.ok(exposed.every(q => !Object.hasOwn(q, 'answer')))
})

test('admin bank can be mixed with custom questions and saved selections survive reload', async () => {
  const db = createCollectionStore({ users: [{ _id: 'admin', openid: 'admin', roles: ['admin'], status: 'active' }], platform_configs: [] })
  const api = loadCloudFunction('api', db, 'admin')
  const get = () => api.main({ module: 'admin', action: 'getSystemSettings', data: {} })
  const result = await get()
  assert.equal(result.ok, true)
  assert.equal(result.data.staffTrainingQuestionBank.length, 50)
  const custom = { id: 'custom_question', question: '客户临时调整服务应当如何记录？', type: 'single', options: [{ value: 'A', label: '通过平台确认并留痕' }, { value: 'B', label: '无需记录' }], answer: 'A' }
  const quiz = [result.data.staffTrainingQuestionBank[12], custom]
  const saved = await api.main({ module: 'admin', action: 'saveSystemSettings', data: { staffTraining: { quiz, quizBankVersion: 2, passScore: 80 } } })
  assert.equal(saved.ok, true)
  const reloaded = await get()
  assert.deepEqual(reloaded.data.staffTraining.quiz.map(q => q.id), ['q13', 'custom_question'])
  assert.equal(reloaded.data.staffTraining.quiz[1].answer, 'A')
  assert.equal(reloaded.data.staffTrainingQuestionBank.length, 50)
})

test('50-question training scores correctly and changed exams require a fresh attempt', async () => {
  const db = createCollectionStore({ users: [{ _id: 'staff', openid: 'staff', roles: ['staff'], status: 'active' }],
    staff_profiles: [{ _id: 'sp', openid: 'staff', auditStatus: 'approved', trainingVideoProgress: Object.fromEntries(constants.STAFF_TRAINING_VIDEOS.map(v => [v.key, { watched: true }])) }], platform_configs: [] })
  const api = loadCloudFunction('api', db, 'staff')
  const status = await api.main({ module: 'staff', action: 'getTrainingStatus' })
  assert.equal(status.ok, true)
  assert.equal(status.data.quiz.questions.length, 50)
  assert.ok(status.data.quiz.questions.every(q => !Object.hasOwn(q, 'answer')))
  const answers = Object.fromEntries(constants.DEFAULT_STAFF_TRAINING_QUIZ.map((q, index) => [q.id, index < 40 ? q.answer : q.options.find(o => o.value !== q.answer).value]))
  const result = await api.main({ module: 'staff', action: 'submitTrainingQuiz', data: { answers, quizVersion: status.data.quiz.version } })
  assert.equal(result.ok, true)
  assert.equal(result.data.score, 80)
  assert.equal(result.data.passed, true)
  db.state.platform_configs.push({ _id: 'settings', key: 'system_settings', value: { staffTraining: { quizBankVersion: 2, quiz: constants.DEFAULT_STAFF_TRAINING_QUIZ.slice(5, 7) } } })
  const stale = await api.main({ module: 'staff', action: 'submitTrainingQuiz', data: { answers, quizVersion: status.data.quiz.version } })
  assert.equal(stale.ok, false)
  assert.match(stale.message, /题目配置已更新/)
  const incomplete = await api.main({ module: 'staff', action: 'submitTrainingQuiz', data: { answers: {} } })
  assert.equal(incomplete.ok, false)
  assert.match(incomplete.message, /全部题目/)
})
