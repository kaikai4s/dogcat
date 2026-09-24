const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('pet deletion protection against active and refunding service orders', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_client_1', openid: 'openid_client_1', roles: ['client'], status: 'active', phone: '13800000001' },
      { _id: 'u_client_2', openid: 'openid_client_2', roles: ['client'], status: 'active', phone: '13800000002' }
    ],
    pets: [
      { _id: 'pet_active_single', openid: 'openid_client_1', name: '单宠豆豆', species: 'dog', breed: '柯基' },
      { _id: 'pet_active_multi_primary', openid: 'openid_client_1', name: '多宠大黄', species: 'dog', breed: '金毛' },
      { _id: 'pet_active_multi_secondary', openid: 'openid_client_1', name: '多宠花花', species: 'cat', breed: '美短' },
      { _id: 'pet_refunding', openid: 'openid_client_1', name: '退款中球球', species: 'cat', breed: '布偶' },
      { _id: 'pet_completed_only', openid: 'openid_client_1', name: '历史宠圆圆', species: 'dog', breed: '泰迪' },
      { _id: 'pet_free_to_delete', openid: 'openid_client_1', name: '无单宠乐乐', species: 'dog', breed: '萨摩耶' }
    ],
    user_pet_titles: [
      { _id: 'inv_1', openid: 'openid_client_1', titleId: 'title_1', equippedPetId: 'pet_free_to_delete' }
    ],
    pet_titles: [
      { _id: 'title_1', name: '年度萌神', enabled: true }
    ],
    orders: [
      // 1. 单宠订单进行中 (in_service)
      {
        _id: 'order_1',
        orderNo: 'O10001',
        clientOpenid: 'openid_client_1',
        status: 'in_service',
        petId: 'pet_active_single',
        petIds: ['pet_active_single']
      },
      // 2. 多宠订单待接单 (paid)，pet_active_multi_secondary 是副宠
      {
        _id: 'order_2',
        orderNo: 'O10002',
        clientOpenid: 'openid_client_1',
        status: 'paid',
        petId: 'pet_active_multi_primary',
        petIds: ['pet_active_multi_primary', 'pet_active_multi_secondary']
      },
      // 3. 订单退款处理中 (paymentStatus: refunding)
      {
        _id: 'order_3',
        orderNo: 'O10003',
        clientOpenid: 'openid_client_1',
        status: 'cancelled',
        paymentStatus: 'refunding',
        petId: 'pet_refunding',
        petIds: ['pet_refunding']
      },
      // 4. 历史已完成订单
      {
        _id: 'order_4',
        orderNo: 'O10004',
        clientOpenid: 'openid_client_1',
        status: 'completed',
        paymentStatus: 'paid',
        petId: 'pet_completed_only',
        petIds: ['pet_completed_only']
      }
    ],
    platform_configs: []
  })

  const clientApi = loadCloudFunction('api', db, 'openid_client_1')

  // 1. 测试：删除正在进行单宠服务的宠物 -> 必须被拦截
  const resActiveSingle = await clientApi.main({
    module: 'pet',
    action: 'deletePet',
    data: { id: 'pet_active_single' }
  })
  assert.equal(resActiveSingle.ok, false)
  assert.match(resActiveSingle.message, /待支付或履约中的服务订单/)

  // 2. 测试：删除多宠待接单订单中的主宠 -> 必须被拦截
  const resActiveMultiPrimary = await clientApi.main({
    module: 'pet',
    action: 'deletePet',
    data: { id: 'pet_active_multi_primary' }
  })
  assert.equal(resActiveMultiPrimary.ok, false)
  assert.match(resActiveMultiPrimary.message, /待支付或履约中的服务订单/)

  // 3. 测试：删除多宠待接单订单中的副宠（只在 petIds 数组中） -> 必须被拦截
  const resActiveMultiSecondary = await clientApi.main({
    module: 'pet',
    action: 'deletePet',
    data: { id: 'pet_active_multi_secondary' }
  })
  assert.equal(resActiveMultiSecondary.ok, false)
  assert.match(resActiveMultiSecondary.message, /待支付或履约中的服务订单/)

  // 4. 测试：待支付状态 (pending_pay) 订单同样拦截
  const pendingOrder = {
    _id: 'order_pending',
    orderNo: 'O10005',
    clientOpenid: 'openid_client_1',
    status: 'pending_pay',
    petId: 'pet_free_to_delete',
    petIds: ['pet_free_to_delete']
  }
  db.state.orders.push(pendingOrder)
  const resPending = await clientApi.main({
    module: 'pet',
    action: 'deletePet',
    data: { id: 'pet_free_to_delete' }
  })
  assert.equal(resPending.ok, false)
  assert.match(resPending.message, /待支付或履约中的服务订单/)

  // 移除该待支付测试订单
  db.state.orders = db.state.orders.filter((o) => o._id !== 'order_pending')

  // 5. 测试：删除退款处理中订单的宠物 -> 必须被拦截
  const resRefunding = await clientApi.main({
    module: 'pet',
    action: 'deletePet',
    data: { id: 'pet_refunding' }
  })
  assert.equal(resRefunding.ok, false)
  assert.match(resRefunding.message, /退款处理中的订单/)

  // 6. 测试：仅有关联已完成 (completed) 历史订单的宠物 -> 允许正常删除
  const resCompletedOnly = await clientApi.main({
    module: 'pet',
    action: 'deletePet',
    data: { id: 'pet_completed_only' }
  })
  assert.equal(resCompletedOnly.ok, true)
  assert.equal(db.state.pets.some((p) => p._id === 'pet_completed_only'), false)

  // 7. 测试：佩戴头衔但无未完成订单的宠物 -> 允许删除且头衔自动解绑释放
  assert.equal(db.state.user_pet_titles.find((i) => i._id === 'inv_1').equippedPetId, 'pet_free_to_delete')
  const resFree = await clientApi.main({
    module: 'pet',
    action: 'deletePet',
    data: { id: 'pet_free_to_delete' }
  })
  assert.equal(resFree.ok, true)
  assert.equal(db.state.pets.some((p) => p._id === 'pet_free_to_delete'), false)
  assert.equal(db.state.user_pet_titles.find((i) => i._id === 'inv_1').equippedPetId, '')
})
