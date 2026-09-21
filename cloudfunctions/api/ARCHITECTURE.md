# API 架构与维护指南

## 当前实现

生产入口是 `index.js`，保留 RPC 分发、HTTP 支付通知分发、定时触发分发和统一错误处理。`index.refactored.js` 仅转发到同一个入口，不再维护第二套路由。

所有原有 25 个业务模块已经迁入 `handlers/`，包含真实业务实现。前端继续使用原有 module/action/data 协议，RPC 返回值保持 `{ ok: true, data }` 或 `{ ok: false, code, message }`。微信支付通知保持原生 SUCCESS/FAIL 响应。

目录职责：

- `config/database.js`：初始化云 SDK，创建数据库依赖。
- `config/constants.js`：从原入口迁出的实际业务常量。
- `handlers/index.js`：固定模块白名单、按需加载与实例内缓存。
- `handlers/*.js`：业务入口，每个工厂显式声明所需依赖。
- `services/context.js`：仅负责依赖装配，业务函数已全部迁出；按拓扑顺序构建服务，不做运行时动态依赖查找。
- `services/*.js`：50 个领域服务工厂，分别负责支付、结算、排班、订单、会员、消息、商城等业务。
- `services/paymentCallback.js`：验签、解密、处理支付通知；不属于 RPC action。
- `scheduled/index.js`：完整定时编排，包含取消、过期、提醒、超时处理、月度结算与补结算。
- `scheduled/cancelUnpaidOrders.js`、`scheduled/expireOrders.js`：订单定时处理。
- `utils/`：原有时间、响应、校验、加密和数据库辅助实现。

## 依赖规则

业务模块导出 `createHandler(context)`，返回 `(openid, action, data) => Promise`。不要在业务模块中初始化 SDK、导入生产 index.js 或读取其他模块的全局数据库实例。模块工厂可以被 Node 缓存，但持有数据库的 handler 实例由每个入口实例单独缓存，避免测试或多实例共享错误依赖。

新增模块时，在 `handlers/index.js` 注册固定加载器，并明确列出依赖。禁止用外部传入的模块名直接拼接 require 路径。共享函数应放入职责明确的服务中，context.js 不再承载业务实现。

领域服务采用 `createService({ dependencyA, dependencyB })`，返回具名业务函数。装配时依赖必须已初始化，禁止通过 getter、全局容器或互相 require 绕过循环依赖。架构测试会逐项检查装配所读取的依赖，并拒绝重复导出。每次 createContext 都产生独立服务实例，模块不得捕获全局数据库状态。

常用修改位置：

| 业务 | 服务文件 |
| --- | --- |
| 微信支付协议、签名、金额校验 | wechatPay.js |
| 支付成功处理、退款、库存扣减 | paymentLifecycle.js |
| 支付订单读取及权限 | payableOrders.js |
| 订单访问、状态流转、展示 | orderAccess.js、orderState.js、orderViews.js |
| 排班及多日服务时段 | scheduling.js、schedulingTime.js、orderSessions.js |
| 服务完成、超时处理、收益生成 | serviceExecution.js、overdueOrders.js、earnings.js |
| 消息及订阅通知 | orderMessages.js、subscriptions.js |
| 财务统计及售后收益处理 | financeReports.js、incidents.js |
| 商品与购物车 | mallCatalog.js |
| 会员、优惠券、奖励 | membership.js、coupons.js、couponIssuance.js、points.js、rewardMails.js |

两个容易重新引入的循环依赖：日期解析统一放在 schedulingTime，排班和订单时段共同依赖它；支付订单读取独立放在 payableOrders，支付处理不依赖会触发订单过期退款的 orderAccess。

纯工具直接导出函数；涉及数据库或加密等依赖的工具通过工厂注入。保留 HOME_SECURITY_KEY、原有密文格式和错误格式，不能使用旧模板中的默认加密密钥或另一套响应结构。

## 支付与触发边界

paymentCallback 的实现已从 payment handler 移出。RPC 即使传入 `_isInternalHttpCallback: true` 也会拒绝。HTTP 分支及定时分支拒绝有 OPENID 的客户端上下文，支付通知仍必须经过验签和金额校验。

部署时必须在真实云环境验证 HTTP 触发器事件及 SDK 上下文。事件中的字段本身不是可信来源凭证；无 OPENID 也不是支付真实性凭证，验签不能关闭。定时入口仍需通过云端权限配置限制可调用者。

## 数据分页

getAllDocuments 已移除当前 SDK 不支持的 startAfter，使用 skip/limit，并以 _id 作为同时间记录的稳定排序字段。已用 250 条相同时间的数据验证无遗漏。

这不是快照读取，并发增删时仍可能变化；偏移很大时效率也会下降。财务统计后续应迁往数据库聚合，批处理应采用 SDK 支持的唯一键游标或固定数据快照。索引不能代替分页。

## 验证与发布

在仓库根目录执行 `npm test`。覆盖原业务回归，以及模块依赖、实例隔离、RPC 回调拒绝、客户端伪造触发器、分页和定时编排测试。支付相关用例通过 HTTP 入口检查验签拒绝、重复回调和金额不匹配，不再通过 RPC 模拟合法支付通知。

部署需上传整个 api 云函数目录并安装现有生产依赖，不能只上传 index.js。迁移工具使用的 AST 包不是生产依赖。上线前在测试环境验证真实支付、退款、提现、订阅通知和定时触发器。回滚时需将入口及其模块整体恢复到同一版本。

## 后续工作与边界

本轮完成业务入口、共享领域服务及基础工具迁移，不代表所有业务一致性问题都已修复：

1. 提现单创建与收益冻结仍需整体事务化，修复部分失败遗留冻结收益。
2. 超时取消仍需支付查单/关单、订单与优惠券原子处理及失败恢复。
3. 实际接单入口仍需统一排班查询和跨订单并发约束。
4. 财务统计需统一 success/paid 状态口径，并改用数据库聚合。
5. 继续在领域服务中补充资金并发、真实云数据库事务和支付联调测试；结构迁移保持原业务行为，不替代专项修复。

handler 已按需加载，但共享服务仍在启动时加载。尚未测量生产冷启动、内存或延迟，不能承诺任何性能提升百分比。
