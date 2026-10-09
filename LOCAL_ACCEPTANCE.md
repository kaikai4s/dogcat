# 本地优化验收与发布准备

更新日期：2026-10-09。范围是本地优化及验收准备，不包含部署、真实资金操作或生产数据修改。

## 本地结果

- 最新全量回归：871/871 通过，0 失败，用时约 75 秒（四个测试进程并行）。
- 专项覆盖：并发完单/奖励/收益及失败回滚、轨迹批内及并发去重、通知事件身份与人工重试、账户隔离/退避、被拒轨迹保留、消息历史及多页增量、财务日期及账单异常、图标完整性和性能日志隐私。
- 原生 WXML 编译通过：后台设置、客户消息详情、员工消息详情、员工服务执行四页。服务执行页编译输入包含 utils/beijing-time.wxs。
- 原生 WXSS 编译通过：上述四页及 app.wxss、图标样式。未做真机布局或视觉验收。
- 图标完整性检查及按仓库换行配置的 diff 空白检查通过。
- 图标 261 个名称；字体由 189216 降至 16496 字节，样式由 412628 降至 35639 字节，两项合计减少 549709 字节（约 91.3%）。完整源在 scripts/assets/remixicon，不进入小程序包。
- 本轮主包源码 384308 字节；本地服务装配五次为 274.01、220.25、287.98、257.59、325.58 毫秒。可用 `npm run benchmark:local` 重测，负载会影响结果。这不是微信压缩包体积，也不是云冷启动耗时；云入口通过 `[api-performance]` 记录耗时，不记录请求内容或用户身份。

## 本地复验

```powershell
npm ci
node --test --test-concurrency=4 tests/**/*.test.js
npm run check:icons
npm run benchmark:local
git -c core.whitespace=cr-at-eol diff --check
```

增加图标后运行 `npm run optimize:icons` 并再检查，生成需要 Python FontTools/Brotli。遇到新的动态拼接图标需在生成脚本中明确展开名称，不能跳过未知图标。

## 只读财务核对

先导出同一截止时刻、未截断的本地 JSON 快照。顶层是集合到数组的映射，记录包含 `_id`；必须提供 orders、mall_orders、payments、refunds、staff_earnings、withdraw_requests、staff_deposits、order_incidents。空集合也必须显式提供空数组。跨集合导出一致性由导出者核查，本工具不能证明快照一致。

```powershell
npm run audit:finance -- snapshot.json
npm run reconcile:finance -- snapshot.json statement.json costs.json
```

账单只包含指定北京时间期间的成功支付、成功退款及已打款提现。必须来自完整真实账单/付款凭证；`complete: true` 是导出者声明，不能从样例推断实际完整。

```json
{
  "complete": true,
  "period": { "startDate": "2026-10-01", "endDate": "2026-10-02" },
  "payments": [{ "paymentNo": "p", "amountFen": 10000, "wxTransactionId": "wxp", "paidAt": "2026-10-01 00:00" }],
  "refunds": [{ "refundNo": "r", "amountFen": 2000, "wxRefundId": "wxr", "succeededAt": "2026-10-02 09:00" }],
  "withdrawals": [{ "_id": "w", "amountFen": 5000, "paymentReference": "proof", "paidAt": "2026-10-02 09:00" }]
}
```

支付/退款凭证字段必须与快照相同；提现用内部请求 `_id` 匹配。账单金额是整数分，快照金额保留现有数字元字段。日期支持 Date 导出的 ISO 字符串、带时区字符串、北京时间字符串及数值毫秒。

可选成本文件格式为 `{ "complete": true, "days": [...] }`，期间每一天都应提供 date 和 mallCostFen、paymentFeeFen、taxFen、marketingFen、reimbursementFen、operatingCostFen 六个非负整数分字段，零成本也显式写 0。无交易日期仍需成本。字段无交叉重复；costsComplete=false 时不能当成完整利润。

退出码：0 表示所提供完整数据通过规则核对，2 表示异常或覆盖不完整，1 表示输入错误。输出仅业务记录 ID、金额、日期及异常代码，不输出客户姓名、OpenID 或支付密钥。没有真实快照/账单输入，因此本次没有真实对账结论。

日汇总以付款日期、退款成功日期、收益创建日期和提现打款日期归属自然日，保留历史日期回退；保证金单列，不计收入。扣员工收益结余不再扣提现，避免重复扣减。成本缺失时 profitEstimateFen=null；即使成本完整仍只是估算，不能作为权责发生制会计利润。工具不写在线日汇总集合，也不自动修余额或补付款。

## 测试云环境与真机验收

1. 备份完整代码、云配置及数据库快照，使用独立测试环境和客户/员工/管理员测试账号。
2. 核对 SDK 聚合表达式、混合日期及时区行为，比较数据库统计和完整快照结果；记录真实查询耗时、冷启动和压缩包体积。
3. 验证 CloudBase 冲突重试：同订单重复完单、同客户不同订单完单、轨迹并发补传、接单/派单、退款、提现及纠纷竞争；任一步写入失败应整体回滚。
4. 验证通知：提交业务后立即停止进程，定时任务仍能发送；多日完成各自发送；失败退避、六次上限、失败/跳过人工重试、列表翻页及权限有效。微信外部发送和数据库写回不是原子操作，可能至少一次投递。
5. 真机离线采样/打卡后恢复网络；自动退避后可手动重试，拒绝记录保留。补传中切换账号，不能继续发起原账号请求或删改原账号记录；原无 owner 记录不自动认领。
6. 消息详情超过 100 条及同时间多条时，验证向前翻页和新增增量无漏项/重复；失败可恢复，未读汇总及用户隔离正确。
7. 在不同尺寸手机检查消息翻页、补传提示、后台通知列表和所有图标；当前原生编译结果不等于视觉验收。
8. 使用小额真实支付验证回调、重复回调、关单、退款查单、提现付款凭证和真实账单核对。没有凭证时不确认付款，不使用 mock 结果证明真实到账。

建议在测试云环境核查索引：

| 集合 | 查询字段 |
| --- | --- |
| track_logs | orderId, recordedAt, _id；orderId, clientPointId |
| subscription_logs | delivery, status, nextAttemptAt；delivery, status, _id；expiresAt 的终态 TTL |
| order_message_threads / order_staff_message_threads | 所属字段、隐藏标记、_id；计算日期/未读字段排序需实测查询计划 |
| order_messages / order_staff_messages | threadId, createdAt, _id；混合历史日期的计算排序需实测 |
| staff_earnings / orders | staffOpenid, status, _id；订单 completedAt 排序 |
| refunds / payments | orderId；退款 status, channel, updatedAt；支付 orderId, targetType |

未在本次创建任何云端索引。计算字段可能无法使用普通日期索引，须根据真实查询计划调整或迁移原生日期，不能只按表格建索引便认为性能已验收。

## 历史迁移与发布顺序

先审查历史 recordedAt 类型、缺失/异常金额、缺失支付凭证、重复收益及保证金和孤立冻结。轨迹邻居读取以数值毫秒为条件，Date/字符串旧记录需核验迁移后再放量；有界质量查询失败不应静默丢掉待补传数据。

历史已计数订单没有 completionOrdinal 时，completionOrdinalNeedsReview=true，不从当前客户总单数补推奖励；保留原奖励日志人工核对。旧未归属弱网记录仍保留本地，不自动归属到当前账户。金额、日期和归属迁移须先在副本验证，不自动付款或清理异常记录。

停止旧写入实例后整体更新 api 云函数及依赖，确认测试环境定时重试和索引后，再发布对应小程序体验版。生产推广以全部真实环境验收记录为依据。回滚需整体恢复同版本云函数与小程序；保留队列、固定业务 ID、迁移备份和账单，不删除新记录来回滚，也不能重新启用旧随机 ID 写入路径而不核对兼容性。

明确边界：服务开始、部分取消/提醒通知和完单后的站内消息、时间线、密钥清理仍在业务事务之外；服务中实时聊天、员工余额等仍有全量读取。历史修复、完整在线日汇总、真实转账接入和云端性能验收未在此次本地范围完成。
