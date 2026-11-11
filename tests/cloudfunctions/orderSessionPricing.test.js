const test = require('node:test')
const assert = require('node:assert/strict')
const { getOrderSessionPricing, freezeOrderSessionPricing } = require('../../cloudfunctions/api/utils/orderSessionPricing')

const sessions = [1, 2, 3].map(index => ({ index, date: `2099-09-0${index}`, startTime: `2099-09-0${index} 10:00` }))

test('session allocation preserves every cent of original price and coupon discount', () => {
  for (const count of [1, 2, 3, 7, 31]) {
    for (const paid of [0, 1, 2, 3, 101, 10000, 10001]) {
      const order = { amount: 100.01, payAmount: paid / 100, serviceSessions: Array.from({ length: count }, (_, i) => ({ index: i + 1, startTime: `session_${i}` })) }
      const rows = getOrderSessionPricing(order)
      assert.equal(rows.reduce((sum, row) => sum + Math.round(row.amount * 100), 0), 10001)
      assert.equal(rows.reduce((sum, row) => sum + Math.round(row.payAmount * 100), 0), paid)
      assert.equal(rows.reduce((sum, row) => sum + Math.round(row.discountAmount * 100), 0), 10001 - paid)
      assert.ok(rows.every(row => row.payAmount >= 0 && row.payAmount <= row.amount))
    }
  }
})

test('date and time surcharges are assigned to their matching sessions before coupon allocation', () => {
  const order = { amount: 350, payAmount: 175, sessions, priceSnapshot: { surchargeItems: [
    { type: 'date_surcharge', dates: ['2099-09-01'], price: 40 },
    { type: 'time_surcharge', timeRule: { startTime: '09:00', endTime: '11:00' }, price: 10 }
  ] } }
  const rows = getOrderSessionPricing(order)
  assert.deepEqual(rows.map(row => row.amount), [143.34, 103.33, 103.33])
  assert.deepEqual(rows.map(row => row.payAmount), [71.67, 51.67, 51.66])
})

test('frozen session prices survive setting changes and reallocate subsequent discounts', () => {
  const pricing = freezeOrderSessionPricing({ amount: 340, payAmount: 340, sessions, priceSnapshot: {
    surchargeItems: [{ type: 'date_surcharge', dates: ['2099-09-01'], price: 40 }]
  } })
  pricing.priceSnapshot.surchargeItems = [{ type: 'date_surcharge', dates: ['2099-09-03'], price: 40 }]
  const rows = getOrderSessionPricing({ ...pricing, payAmount: 170 })
  assert.deepEqual(rows.map(row => row.amount), [140, 100, 100])
  assert.deepEqual(rows.map(row => row.payAmount), [70, 50, 50])
})

test('changed service dates invalidate stale frozen pricing', () => {
  const pricing = freezeOrderSessionPricing({ amount: 340, payAmount: 340, sessions, priceSnapshot: {
    surchargeItems: [{ type: 'date_surcharge', dates: ['2099-09-01'], price: 40 }]
  } })
  const rows = getOrderSessionPricing(pricing, [...sessions].reverse())
  assert.deepEqual(rows.map(row => row.amount), [100, 100, 140])
})
