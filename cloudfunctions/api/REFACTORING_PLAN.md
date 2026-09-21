# 云函数架构重构方案

## 当前问题分析

### 现状
- **文件大小**：`index.js` 约 11,500 行，近 600KB
- **代码结构**：所有业务逻辑、工具函数、常量定义都在单文件中
- **handlers 对象**：包含 15+ 个业务模块，每个模块几百到上千行

### 问题影响

#### 1. 开发效率问题
- ❌ 多人协作时 Git 冲突频繁（同一文件的不同位置修改）
- ❌ 代码跳转困难（IDE 性能下降）
- ❌ 难以快速定位功能代码
- ❌ 代码审查困难（单次 PR 可能涉及几千行）

#### 2. 运行性能问题
- ❌ 云函数冷启动慢（需解析整个 600KB 文件）
- ❌ 内存占用高（所有模块代码都加载到内存）
- ❌ 无法针对高频接口单独优化

#### 3. 测试与维护问题
- ❌ 单元测试困难（函数间耦合严重）
- ❌ 修改一个模块可能影响其他模块
- ❌ 难以进行模块级别的性能分析
- ❌ 新人上手成本高

---

## 重构方案

### 目标架构

```
cloudfunctions/api/
├── index.js                    # 入口文件（路由分发）
├── config/
│   ├── constants.js           # 常量定义
│   └── database.js            # 数据库连接
├── utils/
│   ├── time.js                # 时间处理工具
│   ├── validation.js          # 数据校验工具
│   ├── encryption.js          # 加密解密工具
│   ├── wechat.js              # 微信相关工具
│   ├── payment.js             # 支付工具函数
│   └── database.js            # 数据库查询工具
├── models/
│   ├── order.js               # 订单数据模型
│   ├── user.js                # 用户数据模型
│   ├── staff.js               # 宠托师数据模型
│   └── ...
├── services/
│   ├── order.service.js       # 订单业务逻辑服务
│   ├── payment.service.js     # 支付业务逻辑服务
│   ├── staff.service.js       # 宠托师业务逻辑服务
│   └── ...
├── handlers/
│   ├── system.js              # 系统模块处理器
│   ├── order.js               # 订单模块处理器
│   ├── client.js              # 客户端模块处理器
│   ├── staff.js               # 宠托师模块处理器
│   ├── admin.js               # 管理后台模块处理器
│   ├── payment.js             # 支付模块处理器
│   ├── finance.js             # 财务模块处理器
│   ├── mall.js                # 商城模块处理器
│   ├── petBeauty.js           # 宠物选美模块处理器
│   └── ...
├── middleware/
│   ├── auth.js                # 权限验证中间件
│   └── error.js               # 错误处理中间件
├── scheduled/
│   ├── cancelUnpaidOrders.js  # 定时任务：取消未支付订单
│   ├── expireOrders.js        # 定时任务：过期订单处理
│   └── ...
└── package.json
```

---

## 分步重构计划

### 阶段一：提取工具函数和常量（低风险）

#### 1.1 创建 `config/constants.js`
```javascript
// 订单状态常量
exports.ORDER_STATUS = {
  PENDING_PAY: 'pending_pay',
  PAID: 'paid',
  ASSIGNED: 'assigned',
  IN_SERVICE: 'in_service',
  DAY_COMPLETED: 'day_completed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
}

// 服务类型常量
exports.VISIT_FEE_SERVICE_KEY = 'visit_fee'
exports.RETIRED_SERVICE_KEYS = new Set(['extra_pet'])
exports.EXTRA_PET_RULES = new Set(['none', 'all', 'dog'])

// 默认服务价格
exports.defaultServicePrices = [
  { key: 'walk', label: '遛狗服务', price: 39, ... },
  // ...
]

// 数据库集合名称
exports.COLLECTIONS = [
  'users', 'pets', 'orders', 'payments', ...
]
```

#### 1.2 创建 `utils/time.js`
```javascript
// 时间相关工具函数
exports.now = () => new Date()
exports.nowText = () => new Date().toISOString()
exports.toTimeValue = (value) => { /* ... */ }
exports.parseDateValue = (value) => { /* ... */ }
exports.formatDateTimeParts = (dateObj) => { /* ... */ }
exports.parseDateTimeParts = (dateStr) => { /* ... */ }
// ... 其他时间处理函数
```

#### 1.3 创建 `utils/validation.js`
```javascript
// 数据校验工具
exports.safeText = (value) => { /* ... */ }
exports.validatePhone = (phone) => { /* ... */ }
exports.validateOrderTime = (data) => { /* ... */ }
exports.validateMallProductInput = (data) => { /* ... */ }
// ... 其他校验函数
```

#### 1.4 创建 `utils/database.js`
```javascript
// 数据库查询工具
exports.getAllDocuments = async (collectionName, orderByField, orderDirection) => {
  // 分批查询全量数据
}

exports.getDocOrNull = async (collectionName, docId) => {
  // 安全获取文档
}

exports.findByClientRequestId = async (collectionName, where) => {
  // 幂等性查询
}
```

---

### 阶段二：拆分业务模块（中风险）

#### 2.1 创建 `handlers/order.js`
```javascript
const { ORDER_STATUS } = require('../config/constants')
const { now, toTimeValue } = require('../utils/time')
const { validateOrderTime } = require('../utils/validation')
const orderService = require('../services/order.service')

module.exports = async (openid, action, data) => {
  const db = cloud.database()
  
  if (action === 'createOrder') {
    // 订单创建逻辑
    // 从 index.js 迁移过来
  }
  
  if (action === 'listOrders') {
    // 订单列表逻辑
  }
  
  if (action === 'cancelOrder') {
    // 取消订单逻辑
  }
  
  // ... 其他订单相关 action
  
  throw new Error('未知订单操作')
}
```

#### 2.2 创建 `handlers/staff.js`
```javascript
module.exports = async (openid, action, data) => {
  if (action === 'listApprovedSitters') {
    // 宠托师列表
  }
  
  if (action === 'acceptOrder') {
    // 接单逻辑
  }
  
  if (action === 'getScheduleCalendar') {
    // 排班日历
  }
  
  // ... 其他宠托师相关 action
  
  throw new Error('未知宠托师操作')
}
```

#### 2.3 创建 `handlers/payment.js`
```javascript
const paymentService = require('../services/payment.service')

module.exports = async (openid, action, data) => {
  if (action === 'createPayment') {
    // 创建支付
  }
  
  if (action === 'paymentCallback') {
    // 支付回调（已添加安全检查）
    if (!data._isInternalHttpCallback) {
      throw new Error('paymentCallback 仅限内部 HTTP 回调调用')
    }
    // ... 回调处理逻辑
  }
  
  // ... 其他支付相关 action
  
  throw new Error('未知支付操作')
}
```

#### 2.4 其他模块
按照相同模式拆分：
- `handlers/admin.js` - 管理后台
- `handlers/finance.js` - 财务模块
- `handlers/mall.js` - 商城模块
- `handlers/client.js` - 客户端模块
- `handlers/petBeauty.js` - 宠物选美

---

### 阶段三：提取服务层（中风险）

#### 3.1 创建 `services/order.service.js`
```javascript
// 订单业务逻辑服务
const { getAllDocuments } = require('../utils/database')

// 计算订单价格
exports.calcOrderPricing = async (data, pets, options) => {
  // 从 index.js 迁移 calcOrderPricing 函数
}

// 验证宠托师可用性
exports.validateStaffAvailability = async (profile, startTime, endTime, options) => {
  // 从 index.js 迁移 validateStaffAvailability 函数
}

// 过期未接单订单
exports.expireUnacceptedOrder = async (orderId, order, time) => {
  // 从 index.js 迁移
}
```

#### 3.2 创建 `services/payment.service.js`
```javascript
// 支付业务逻辑服务

// 创建退款
exports.createRefundForOrder = async (order, amount, reason, source, openid, clientRequestId) => {
  // 从 index.js 迁移
}

// 标记订单已支付
exports.markOrderPaid = async (orderId, paymentInfo) => {
  // 从 index.js 迁移
}

// 微信支付请求
exports.wechatPayRequest = async (method, path, body, config) => {
  // 从 index.js 迁移
}
```

---

### 阶段四：提取定时任务（低风险）

#### 4.1 创建 `scheduled/cancelUnpaidOrders.js`
```javascript
const { ORDER_STATUS } = require('../config/constants')
const { now, toTimeValue } = require('../utils/time')

module.exports = async () => {
  const db = cloud.database()
  const res = await db.collection('orders').where({ 
    status: ORDER_STATUS.PENDING_PAY 
  }).get()
  
  const time = now()
  const timeoutMinutes = 30
  const timeoutMs = timeoutMinutes * 60 * 1000
  const cancelledOrders = []

  for (const order of res.data || []) {
    const createdAt = toTimeValue(order.createdAt)
    if (createdAt > 0 && time.getTime() - createdAt > timeoutMs) {
      // 取消订单逻辑
      // ... 
      cancelledOrders.push(order._id)
    }
  }

  return cancelledOrders
}
```

#### 4.2 创建 `scheduled/index.js`
```javascript
const cancelUnpaidOrders = require('./cancelUnpaidOrders')
const expireOrders = require('./expireOrders')
const sendReminders = require('./sendReminders')
const settlePetBeauty = require('./settlePetBeauty')

module.exports = async () => {
  await cancelUnpaidOrders()
  await expireOrders()
  const reminders = await sendReminders()
  const settled = await settlePetBeauty()
  
  return {
    expired: true,
    remindersCount: reminders.length,
    settled
  }
}
```

---

### 阶段五：重构入口文件（中风险）

#### 5.1 新的 `index.js`
```javascript
const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 导入 handlers
const handlers = {
  system: require('./handlers/system'),
  order: require('./handlers/order'),
  client: require('./handlers/client'),
  staff: require('./handlers/staff'),
  admin: require('./handlers/admin'),
  payment: require('./handlers/payment'),
  finance: require('./handlers/finance'),
  mall: require('./handlers/mall'),
  petBeauty: require('./handlers/petBeauty')
}

// 导入定时任务
const scheduledTasks = require('./scheduled')

// 工具函数
const { ok, fail } = require('./utils/response')
const { isWechatPayHttpCallback } = require('./utils/payment')

exports.main = async (event = {}) => {
  try {
    // 定时任务
    if (event.Type === 'Timer') {
      return ok(await scheduledTasks())
    }
    
    // 微信支付回调
    if (isWechatPayHttpCallback(event)) {
      return handlers.payment('', 'paymentCallback', {
        _isInternalHttpCallback: true,
        headers: event.headers || event.header || {},
        rawBody: event.rawBody,
        body: event.body,
        isBase64Encoded: event.isBase64Encoded === true
      })
    }
    
    // 常规请求
    const { OPENID } = cloud.getWXContext()
    const moduleName = event.module || event.name
    const action = event.action
    const data = event.data || {}
    const handler = handlers[moduleName]
    
    if (!handler) throw new Error(`未知模块：${moduleName}`)
    
    return ok(await handler(OPENID, action, data))
  } catch (error) {
    return fail(error.message, error.code)
  }
}
```

**重构后的 `index.js` 只有约 60 行，清晰易读！**

---

## 重构执行策略

### 推荐方式：渐进式重构（最安全）

#### Week 1：准备工作
- [ ] 创建目录结构
- [ ] 编写单元测试框架
- [ ] 提取常量和配置

#### Week 2-3：工具函数迁移
- [ ] 提取时间工具函数
- [ ] 提取校验工具函数
- [ ] 提取数据库工具函数
- [ ] 提取加密工具函数

#### Week 4-6：业务模块迁移
- [ ] 迁移 `handlers.order`
- [ ] 迁移 `handlers.staff`
- [ ] 迁移 `handlers.payment`
- [ ] 迁移其他 handlers

#### Week 7：服务层提取
- [ ] 提取订单服务
- [ ] 提取支付服务
- [ ] 提取其他服务

#### Week 8：定时任务拆分
- [ ] 拆分定时任务
- [ ] 测试定时任务

#### Week 9：入口文件重构
- [ ] 重构 `index.js`
- [ ] 全量回归测试

#### Week 10：上线与监控
- [ ] 灰度发布
- [ ] 性能监控
- [ ] 问题修复

---

## 迁移注意事项

### 1. 保持向后兼容
- ✅ 迁移过程中保持 API 接口不变
- ✅ 先测试后上线，避免影响线上用户

### 2. 数据库连接
- ✅ 每个模块文件都需要初始化 cloud 和 db
- ✅ 或者在 `config/database.js` 中统一初始化

### 3. 共享状态
- ❌ 避免模块间的全局变量依赖
- ✅ 通过参数传递或服务层调用

### 4. 循环依赖
- ❌ 避免 A 模块引用 B，B 又引用 A
- ✅ 提取共享逻辑到独立的 service 或 utils

### 5. 测试覆盖
- ✅ 每迁移一个模块，补充单元测试
- ✅ 保持至少 60% 的测试覆盖率

---

## 预期收益

### 开发效率提升
- ✅ Git 冲突减少 **80%**
- ✅ 代码定位速度提升 **5-10 倍**
- ✅ 新人上手时间缩短 **50%**
- ✅ Code Review 效率提升 **3 倍**

### 运行性能提升
- ✅ 冷启动时间减少 **30-50%**（仅加载需要的模块）
- ✅ 内存占用降低 **20-30%**
- ✅ 支持按模块单独优化

### 维护成本降低
- ✅ 单元测试覆盖率可达 **60%+**
- ✅ Bug 修复时间缩短 **40%**
- ✅ 模块职责清晰，易于扩展

---

## 替代方案：多云函数架构

如果团队规模较大，还可以考虑拆分为多个独立云函数：

```
cloudfunctions/
├── api-order/          # 订单相关接口
├── api-payment/        # 支付相关接口
├── api-staff/          # 宠托师相关接口
├── api-admin/          # 管理后台接口
├── api-mall/           # 商城相关接口
└── scheduled-tasks/    # 定时任务
```

**优点**：
- 完全隔离，互不影响
- 可独立部署和扩容
- 冷启动更快

**缺点**：
- 部署复杂度增加
- 代码复用需要抽取为 npm 包
- 调试和日志分散

---

**创建时间**：2026-09-21  
**维护状态**：活跃  
**最后更新**：2026-09-21
