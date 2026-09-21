# 数据库索引优化方案

## 重要性说明

当前代码中存在大量基于 `openid`、`status` 等字段的查询，随着数据量增长，未建立索引会导致：
- 查询性能指数级下降（全表扫描）
- 用户体验变差（接口响应慢）
- 云函数超时风险增加

## 核心索引规划

### 1. orders 集合（订单表）

**索引 1：客户订单查询**
```json
{
  "keys": [
    { "name": "clientOpenid", "direction": "asc" },
    { "name": "createdAt", "direction": "desc" }
  ]
}
```
- **用途**：客户查看自己的订单列表
- **对应代码**：`index.js:6778` - `listOrders` (client 端)
- **查询频率**：极高（每个用户每天多次查看）

**索引 2：宠托师订单查询**
```json
{
  "keys": [
    { "name": "staffOpenid", "direction": "asc" },
    { "name": "status", "direction": "asc" }
  ]
}
```
- **用途**：宠托师查看待接单、进行中的订单
- **对应代码**：`index.js:1298` - `validateStaffAvailabilityForSessions`（冲突检测）
- **查询频率**：高（接单、查看订单列表）

**索引 3：订单状态筛选**
```json
{
  "keys": [
    { "name": "status", "direction": "asc" }
  ]
}
```
- **用途**：管理后台按状态筛选订单、定时任务处理特定状态订单
- **对应代码**：
  - `index.js:1960` - `expireDueUnacceptedOrders` (查询 `paid` 状态)
  - `index.js:1969` - `cancelUnpaidOrders` (查询 `pending_pay` 状态)
  - `index.js:8602` - `listAvailableOrders` (查询 `paid` 状态)
- **查询频率**：高（定时任务、管理后台）

**索引 4：发布模式筛选**
```json
{
  "keys": [
    { "name": "publishMode", "direction": "asc" },
    { "name": "status", "direction": "asc" }
  ]
}
```
- **用途**：筛选指派订单（`direct` 模式）
- **对应代码**：`index.js:8725` - `listDirectOrders`
- **查询频率**：中等

---

### 2. order_messages / order_staff_messages 集合（订单消息表）

**索引：会话消息查询**
```json
{
  "keys": [
    { "name": "conversationId", "direction": "asc" },
    { "name": "createdAt", "direction": "desc" }
  ]
}
```
- **用途**：查询某个订单的聊天记录
- **对应代码**：消息列表查询（按会话ID + 时间倒序）
- **查询频率**：高（用户每次查看聊天记录）

---

### 3. user_coupons 集合（用户优惠券表）

**索引：用户优惠券查询**
```json
{
  "keys": [
    { "name": "openid", "direction": "asc" },
    { "name": "status", "direction": "asc" }
  ]
}
```
- **用途**：查询用户的可用/已使用优惠券
- **对应代码**：优惠券列表、下单时选择优惠券
- **查询频率**：高（下单流程、优惠券列表）

---

### 4. staff_profiles 集合（宠托师认证表）

**索引 1：根据 openid 查询**
```json
{
  "keys": [
    { "name": "openid", "direction": "asc" }
  ]
}
```
- **用途**：根据用户 openid 查询宠托师认证信息
- **对应代码**：大量代码使用 `where({ openid })`
- **查询频率**：极高（几乎所有宠托师操作都需要）

**索引 2：审核状态筛选**
```json
{
  "keys": [
    { "name": "auditStatus", "direction": "asc" }
  ]
}
```
- **用途**：管理后台筛选待审核/已通过的宠托师
- **对应代码**：管理后台宠托师列表
- **查询频率**：中等

---

### 5. payments 集合（支付记录表）

**索引 1：订单支付查询**
```json
{
  "keys": [
    { "name": "orderId", "direction": "asc" }
  ]
}
```
- **用途**：查询某个订单的支付记录
- **对应代码**：`index.js:8035` - `getPaymentStatus`
- **查询频率**：高

**索引 2：支付单号查询**
```json
{
  "keys": [
    { "name": "paymentNo", "direction": "asc" }
  ]
}
```
- **用途**：支付回调时根据支付单号查询支付记录
- **对应代码**：`index.js:8049` - `paymentCallback`
- **查询频率**：高（每笔支付都会触发）

---

### 6. staff_earnings 集合（宠托师收益表）

**索引：可提现收益查询**
```json
{
  "keys": [
    { "name": "staffOpenid", "direction": "asc" },
    { "name": "status", "direction": "asc" }
  ]
}
```
- **用途**：查询宠托师的可提现收益（`status: 'available'`）
- **对应代码**：`index.js:8157` - `createWithdrawRequest`
- **查询频率**：高（提现申请）

---

### 7. staff_schedule_exceptions 集合（宠托师排班例外表）

**索引：日期查询**
```json
{
  "keys": [
    { "name": "staffOpenid", "direction": "asc" },
    { "name": "dateKey", "direction": "asc" }
  ]
}
```
- **用途**：查询宠托师某天的排班例外
- **对应代码**：`index.js:1279` - `validateStaffScheduleOnly`
- **查询频率**：高（每次下单/接单都需要验证）

---

### 8. pets 集合（宠物表）

**索引：用户宠物查询**
```json
{
  "keys": [
    { "name": "openid", "direction": "asc" }
  ]
}
```
- **用途**：查询用户的宠物列表
- **查询频率**：高（下单、宠物管理）

---

### 9. mall_orders 集合（商城订单表）

**索引：客户商城订单查询**
```json
{
  "keys": [
    { "name": "clientOpenid", "direction": "asc" },
    { "name": "createdAt", "direction": "desc" }
  ]
}
```
- **用途**：客户查看自己的商城订单
- **查询频率**：高

---

## 实施步骤

### 方式一：通过控制台创建（推荐）

1. 登录微信云开发控制台
2. 进入「数据库」→ 选择对应集合
3. 点击「索引管理」→「添加索引」
4. 按照上述配置创建复合索引

### 方式二：通过 API 创建

可以编写一次性脚本在云函数中执行：

```javascript
// 仅供参考，实际创建建议在控制台操作
async function createIndexes() {
  const db = cloud.database()
  
  // orders 集合索引
  await db.collection('orders').createIndex({
    keys: [{ name: 'clientOpenid', direction: 'asc' }, { name: 'createdAt', direction: 'desc' }]
  })
  
  await db.collection('orders').createIndex({
    keys: [{ name: 'staffOpenid', direction: 'asc' }, { name: 'status', direction: 'asc' }]
  })
  
  // ... 其他索引
}
```

---

## 索引优先级

### P0（立即创建 - 极高频查询）
1. `orders` → `(clientOpenid, createdAt)`
2. `orders` → `(staffOpenid, status)`
3. `staff_profiles` → `openid`
4. `user_coupons` → `(openid, status)`
5. `payments` → `paymentNo`

### P1（高优先级 - 高频查询）
6. `orders` → `status`
7. `staff_earnings` → `(staffOpenid, status)`
8. `staff_schedule_exceptions` → `(staffOpenid, dateKey)`
9. `pets` → `openid`

### P2（中优先级 - 性能优化）
10. `order_messages` → `(conversationId, createdAt)`
11. `payments` → `orderId`
12. `mall_orders` → `(clientOpenid, createdAt)`

---

## 注意事项

1. **索引字段顺序很重要**：复合索引中，最左侧的字段应该是过滤性最强的（即区分度最高的）
2. **避免过度索引**：每个索引都会占用存储空间并影响写入性能
3. **定期监控**：通过控制台查看「慢查询日志」，根据实际情况调整索引
4. **唯一索引**：对于业务上需要唯一的字段（如 `paymentNo`），可以创建唯一索引防止重复

---

## 预期收益

创建索引后，相关查询性能预期提升：
- 用户订单列表查询：**50-100倍**（从全表扫描变为索引查询）
- 宠托师接单冲突检测：**20-50倍**
- 支付回调查询：**100倍以上**（精确匹配 + 索引）
- 优惠券查询：**30-50倍**

---

**创建时间**：2026-09-21  
**维护状态**：活跃  
**最后更新**：2026-09-21
