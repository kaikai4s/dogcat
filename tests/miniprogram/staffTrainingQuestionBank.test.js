const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const bank = require('../../cloudfunctions/api/config/constants').DEFAULT_STAFF_TRAINING_QUIZ
function setup() {
  let page, confirmation
  const errors = [], toasts = []
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../miniprogram/pages/admin/settings/index.js'), 'utf8'), {
    Page(value) { page = value }, wx: { showToast(value) { toasts.push(value.title) }, showModal(value) { confirmation = value } },
    require(name) {
      if (name.endsWith('/payment-config')) return require('../../miniprogram/pages/admin/settings/payment-config')
      if (name.endsWith('/subscription-options')) return require('../../miniprogram/utils/subscription-options')
      return { showError(error) { errors.push(error.message) } }
    }
  })
  page.setData = (patch, callback) => {
    for (const [key, value] of Object.entries(patch)) {
      const fields = key.replace(/\[(\d+)\]/g, '.$1').split('.')
      const target = fields.slice(0, -1).reduce((obj, field) => obj[field], page.data)
      target[fields.at(-1)] = value
    }
    if (callback) callback.call(page)
  }
  page.data.defaultQuizBank = structuredClone(bank)
  page.data.settings.staffTraining.quiz = [structuredClone(bank[0])]
  return { page, errors, toasts, confirm(value) { confirmation.success({ confirm: value }) } }
}
const event = id => ({ currentTarget: { dataset: { id } } })

test('search and selection append distinct defaults without changing existing custom edits', () => {
  const { page } = setup()
  page.data.settings.staffTraining.quiz[0].question = '保留管理员修改'
  page.openQuizBank()
  page.quizBankSearch({ detail: { value: '入户与钥匙安全' } })
  assert.equal(page.data.quizBankRows.length, 8)
  page.selectAllQuizBank()
  assert.equal(page.data.quizBankSelectedCount, 8)
  page.addSelectedDefaultQuestions()
  assert.equal(page.data.settings.staffTraining.quiz.length, 9)
  assert.equal(page.data.settings.staffTraining.quiz[0].question, '保留管理员修改')
  assert.equal(page.data.settings.staffTraining.quizBankVersion, 2)
  assert.equal(page.data.quizBankOpen, false)
  page.openQuizBank()
  page.toggleQuizBankQuestion(event('q1'))
  assert.equal(page.data.quizBankSelectedCount, 0)
  page.toggleQuizBankQuestion(event('q30'))
  page.quizBankSearch({ detail: { value: '没有这个关键词' } })
  assert.equal(page.data.quizBankSelectedCount, 1, 'changing search retains checked questions')
  page.addSelectedDefaultQuestions()
  assert.equal(page.data.settings.staffTraining.quiz.at(-1).id, 'q30')
  page.data.settings.staffTraining.quiz.at(-1).options[0].label = 'edited'
  assert.notEqual(page.data.defaultQuizBank.find(q => q.id === 'q30').options[0].label, 'edited')
})

test('replace-all requires explicit confirmation and keeps a detached 50-question draft', () => {
  const h = setup()
  h.page.useAllDefaultQuestions()
  h.confirm(false)
  assert.equal(h.page.data.settings.staffTraining.quiz.length, 1)
  h.page.useAllDefaultQuestions()
  h.confirm(true)
  assert.equal(h.page.data.settings.staffTraining.quiz.length, 50)
  h.page.data.settings.staffTraining.quiz[0].options[0].label = 'edited'
  assert.notEqual(h.page.data.defaultQuizBank[0].options[0].label, 'edited')
})

test('new custom question opens editor; deleting the last question is blocked', () => {
  const h = setup(), { page } = h
  page.addQuizQuestion()
  const custom = page.data.settings.staffTraining.quiz[1]
  assert.equal(custom.type, 'single')
  assert.equal(custom.id, page.data.quizEditorId)
  page.toggleQuizEditor(event(custom.id))
  assert.equal(page.data.quizEditorId, '')
  page.deleteQuizQuestion({ currentTarget: { dataset: { index: 1 } } })
  page.deleteQuizQuestion({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(page.data.settings.staffTraining.quiz.length, 1)
  assert.match(h.toasts.at(-1), /至少保留/)
})

test('removing an option before the correct option preserves its semantic answer', () => {
  const { page } = setup()
  page.data.settings.staffTraining.quiz = [structuredClone(bank[5])]
  const q = page.data.settings.staffTraining.quiz[0]
  const correctLabel = q.options.find(o => o.value === q.answer).label
  page.deleteQuizOption({ currentTarget: { dataset: { questionIndex: 0, optionIndex: 0 } } })
  const edited = page.data.settings.staffTraining.quiz[0]
  assert.equal(edited.options.find(o => o.value === edited.answer).label, correctLabel)
})

test('incomplete custom questions stop settings save instead of silently disappearing', () => {
  const { page, errors } = setup()
  page.data.loaded = true
  page.addQuizQuestion()
  page.save()
  assert.match(errors.at(-1), /第2道题/)
  assert.equal(page.data.saving, false)
})
