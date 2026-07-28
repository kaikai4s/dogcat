const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function ok(data) { return { ok: true, data } }
function fail(message) { return { ok: false, message } }
function now() { return new Date() }

async function getUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  const user = res.data[0]
  if (!user || user.status !== 'active') throw new Error('请先登录')
  return user
}

async function mockPayOrder(openid, data) {
  await getUser(openid)
  const orderRes = await db.collection('orders').doc(data.orderId).get()
  const order = orderRes.data
  if (order.clientOpenid !== openid) throw new Error('无权支付该订单')
  if (order.paymentStatus === 'paid') return { orderId: data.orderId, status: 'paid' }
  if (order.status !== 'pending_pay') throw new Error('订单状态不可支付')

  const time = now()
  await db.collection('payments').add({
    data: {
      orderId: data.orderId,
      orderNo: order.orderNo,
      paymentNo: `P${Date.now()}${Math.floor(Math.random() * 1000)}`,
      wxTransactionId: '',
      amount: order.payAmount,
      status: 'success',
      paidAt: time,
      rawCallback: { mock: true },
      createdAt: time,
      updatedAt: time
    }
  })

  await db.collection('orders').doc(data.orderId).update({
    data: { paymentStatus: 'paid', status: 'paid', paidAt: time, updatedAt: time }
  })

  return { orderId: data.orderId, status: 'paid' }
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const action = event.action
    const data = event.data || {}
    if (action === 'createPayment') return ok({ mock: true, message: 'MVP 暂未接入真实微信支付，请调用 mockPayOrder' })
    if (action === 'mockPayOrder') return ok(await mockPayOrder(OPENID, data))
    if (action === 'paymentCallback') return ok({ ignored: true })
    return fail('未知操作')
  } catch (error) {
    return fail(error.message)
  }
}
