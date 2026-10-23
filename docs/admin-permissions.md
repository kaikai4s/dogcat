# 后台权限使用说明

入口：后台 → 用户组与权限。权限目录按当前服务端接口配置生成；本文列出本次更新后的权限。

## 授权与生效规则

- 分组模式启用前，旧版管理员拥有全部管理权限；启用后，仅超级管理员保留全权限，其他管理员按启用的用户组授权。
- 一人可加入最多 10 个用户组，权限取并集；停用用户组后，该组权限失效。
- 新增权限不会自动授予已有用户组；现有权限标识保持兼容。
- 编辑用户组时，选择操作会补齐页面所需的关联查看权限；移除基础查看权限会移除依赖操作。请核对补充的权限后保存。
- 旧用户组若缺少关联权限，编辑时会列出提示，需要补齐后保存。服务端不会擅自修改原组授权。
- 支持按名称、说明、接口标识搜索，筛选查看、操作、敏感和已选权限；批量选择仅作用于当前筛选结果。
- 查看权限可能包含联系方式、照片、财务和问卷答案，并不意味着无隐私风险。
- 界面隐藏未授权操作，云函数仍逐请求检查权限；修改客户端不能获得后台权限。
- 普通用户编辑权限不能变更角色，也不能编辑管理员账号；余额变更还受额外权限控制。
- 问卷立即发布同时检查新建/编辑与发布权限；订单会话数据独立检查会话查看权限。
- 部分页面用其他业务的查看接口提供下拉选项，例如优惠券、会员等级。未授权时不请求这些数据；需要相应选项时请额外授予对应查看权限。
- 形象发布页面上传与发布分开授权，实际上传发布需同时拥有两个权限。
- 标注“接口功能”的项目当前没有独立后台入口，目录列出的是可授权的实际服务端能力。

## 更新与验证

修改后需要重新部署 api 云函数并更新小程序代码。尚未在线上执行权限迁移、配置导入或实际资金操作。

## 业务权限目录

共 25 类、158 项。

### 乐园建筑与土地

建筑素材、上架状态、土地会员解锁及积分规则。

- **查看配置**（查看）`playgroundBuilding.list`：乐园建筑与土地：查看配置。仅授予该项数据查看，不包含编辑、审核或删除。
- **上传建筑素材**（操作）`playgroundBuilding.prepareUpload`：乐园建筑与土地：上传建筑素材。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看配置（playgroundBuilding.list）。
- **保存建筑**（操作）`playgroundBuilding.save`：乐园建筑与土地：保存建筑。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看配置（playgroundBuilding.list）。
- **删除建筑**（操作）`playgroundBuilding.remove`：乐园建筑与土地：删除建筑。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看配置（playgroundBuilding.list）。
- **配置土地等级**（操作）`playgroundBuilding.savePlotAccess`：乐园建筑与土地：配置土地等级。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看配置（playgroundBuilding.list）。

### 农作物管理

植物素材、生长阶段、会员解锁与上下架。

- **查看农作物**（查看）`playgroundFarm.list`：农作物管理：查看农作物。仅授予该项数据查看，不包含编辑、审核或删除。
- **上传阶段素材**（操作）`playgroundFarm.prepareUpload`：农作物管理：上传阶段素材。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看农作物（playgroundFarm.list）。
- **保存及上下架**（操作）`playgroundFarm.save`：农作物管理：保存及上下架。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看农作物（playgroundFarm.list）。
- **删除植物**（操作）`playgroundFarm.remove`：农作物管理：删除植物。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看农作物（playgroundFarm.list）。

### 乐园形象定制

用户上传的宠物照片、形象定制申请与专属图集发布。

- **申请列表**（查看）`playgroundAppearance.listAdmin`：乐园形象定制：申请列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **查看照片**（操作）`playgroundAppearance.detailAdmin`：乐园形象定制：查看照片。仅授予该项操作，其他管理操作需单独选择。
  关联查看：申请列表（playgroundAppearance.listAdmin）。
- **上传图集**（操作）`playgroundAppearance.prepareUpload`：乐园形象定制：上传图集。仅授予该项操作，其他管理操作需单独选择。
  关联查看：申请列表（playgroundAppearance.listAdmin）、查看照片（playgroundAppearance.detailAdmin）。
- **发布专属形象**（操作）`playgroundAppearance.publish`：上传并发布专属图集，将形象绑定给申请对象；现有页面需同时授予“上传图集”。
  关联查看：申请列表（playgroundAppearance.listAdmin）、查看照片（playgroundAppearance.detailAdmin）。
- **退回申请**（操作）`playgroundAppearance.reject`：乐园形象定制：退回申请。仅授予该项操作，其他管理操作需单独选择。
  关联查看：申请列表（playgroundAppearance.listAdmin）、查看照片（playgroundAppearance.detailAdmin）。

### 控制台与通知

平台经营统计、待办数量与后台告警。

- **查看统计**（操作）`admin.dashboard`：查看全平台订单数量、待审核数量及经营汇总，包含跨业务统计。
  关联查看：查看通知（admin.listAdminNotifications）。
- **查看通知**（查看）`admin.listAdminNotifications`：控制台与通知：查看通知。仅授予该项数据查看，不包含编辑、审核或删除。
- **通知角标**（查看）`admin.getAdminNotificationBadge`：查看后台通知未读数及紧急待办摘要。
- **标记已读**（操作）`admin.markAdminNotificationRead`：控制台与通知：标记已读。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看通知（admin.listAdminNotifications）。
- **发送系统通知**（操作；敏感）`admin.sendSystemNotification`：控制台与通知：发送系统通知。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看通知（admin.listAdminNotifications）、系统通知列表（admin.listSystemNotifications）。
- **系统通知列表**（查看）`admin.listSystemNotifications`：控制台与通知：系统通知列表。仅授予该项数据查看，不包含编辑、审核或删除。
  关联查看：查看通知（admin.listAdminNotifications）。
- **撤回系统通知**（操作）`admin.revokeSystemNotification`：控制台与通知：撤回系统通知。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看通知（admin.listAdminNotifications）、系统通知列表（admin.listSystemNotifications）。

### 服务订单

服务订单、派单、证据、会话与订单处置。

- **订单列表**（查看）`admin.listOrders`：服务订单：订单列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **订单详情**（查看）`admin.getOrderDetail`：查看下单资料、服务安排、订单资金和打卡凭证。服务会话需另行授权。
  关联查看：订单列表（admin.listOrders）。
- **服务证据**（查看）`admin.getEvidence`：查看服务照片、视频、定位和打卡凭证。
  关联查看：订单列表（admin.listOrders）。
- **查看服务会话记录**（查看）`admin.listOrderSessionMessages`：读取订单对应服务会话的聊天记录，涉及用户与宠托师的私密沟通。
  关联查看：订单列表（admin.listOrders）、订单详情（admin.getOrderDetail）。
- **派单**（操作）`admin.assignOrder`：服务订单：派单。仅授予该项操作，其他管理操作需单独选择。
  关联查看：订单列表（admin.listOrders）、资质列表（admin.listStaffAudits）。
- **修改状态**（操作）`admin.updateOrderStatus`：服务订单：修改状态。仅授予该项操作，其他管理操作需单独选择。
  关联查看：订单列表（admin.listOrders）、订单详情（admin.getOrderDetail）。
- **人工完单**（操作）`admin.manualCompleteOrder`：服务订单：人工完单。仅授予该项操作，其他管理操作需单独选择。
  关联查看：订单列表（admin.listOrders）、订单详情（admin.getOrderDetail）。
- **退款**（操作；敏感）`admin.refundOrder`：服务订单：退款。仅授予该项操作，其他管理操作需单独选择。
  关联查看：订单列表（admin.listOrders）、订单详情（admin.getOrderDetail）。
- **删除订单**（操作；敏感）`admin.batchDeleteOrders`：服务订单：删除订单。仅授予该项操作，其他管理操作需单独选择。
  关联查看：订单列表（admin.listOrders）。
- **加急重发**（操作）`admin.republishOrderAsUrgent`：服务订单：加急重发。仅授予该项操作，其他管理操作需单独选择。
  关联查看：订单列表（admin.listOrders）、订单详情（admin.getOrderDetail）。
- **录入扣罚证据**（操作）`admin.addOrderDepositPenaltyEvidence`：服务订单：录入扣罚证据。仅授予该项操作，其他管理操作需单独选择。
  关联查看：订单列表（admin.listOrders）、订单详情（admin.getOrderDetail）、保证金详情（admin.getStaffDepositDetail）。
- **查看扣罚证据**（查看）`admin.listOrderDepositPenaltyEvidences`：服务订单：查看扣罚证据。仅授予该项数据查看，不包含编辑、审核或删除。
  关联查看：订单列表（admin.listOrders）。

### 用户资料

用户档案、联系方式及账号状态。普通管理员不能修改管理员账号或变更角色。

- **用户列表**（查看）`admin.listUsers`：用户资料：用户列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **用户详情**（查看）`admin.getUserDetail`：用户资料：用户详情。仅授予该项数据查看，不包含编辑、审核或删除。
  关联查看：用户列表（admin.listUsers）。
- **编辑用户**（操作）`admin.updateUserProfile`：编辑普通用户资料及账号状态；变更积分类余额还需“调整积分”，不能变更角色或编辑管理员账号。
  关联查看：用户列表（admin.listUsers）、用户详情（admin.getUserDetail）。
- **删除用户**（操作；敏感）`admin.deleteUser`：用户资料：删除用户。仅授予该项操作，其他管理操作需单独选择。
  关联查看：用户列表（admin.listUsers）。
- **彻底删除用户**（操作；敏感）`admin.hardDeleteUser`：彻底清理用户及相关业务数据，属于不可轻易恢复的操作。
  关联查看：用户列表（admin.listUsers）。

### 宠托师

宠托师资料、推荐、资格和培训、转正审核。

- **宠托师列表**（查看）`admin.listStaffProfiles`：宠托师：宠托师列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **推荐设置**（操作）`admin.setSitterFeatured`：宠托师：推荐设置。仅授予该项操作，其他管理操作需单独选择。
  关联查看：宠托师列表（admin.listStaffProfiles）。
- **资质列表**（查看）`admin.listStaffAudits`：宠托师：资质列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **审核资质**（操作）`admin.auditStaff`：宠托师：审核资质。仅授予该项操作，其他管理操作需单独选择。
  关联查看：资质列表（admin.listStaffAudits）。
- **核实补录性别**（操作）`admin.completeStaffGender`：宠托师：核实补录性别。仅授予该项操作，其他管理操作需单独选择。
  关联查看：资质列表（admin.listStaffAudits）。
- **撤销资格**（操作；敏感）`admin.revokeStaff`：宠托师：撤销资格。仅授予该项操作，其他管理操作需单独选择。
  关联查看：宠托师列表（admin.listStaffProfiles）。
- **培训列表**（查看）`admin.listTrainingAudits`：宠托师：培训列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **培训审核**（操作）`admin.auditTrainingVideo`：宠托师：培训审核。仅授予该项操作，其他管理操作需单独选择。
  关联查看：培训列表（admin.listTrainingAudits）。
- **审核指引**（操作）`admin.updateVideoAuditGuide`：宠托师：审核指引。仅授予该项操作，其他管理操作需单独选择。
  关联查看：培训列表（admin.listTrainingAudits）。
- **转正列表**（查看）`admin.listPromotionApplications`：宠托师：转正列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **转正详情**（查看）`admin.getPromotionApplicationDetail`：宠托师：转正详情。仅授予该项数据查看，不包含编辑、审核或删除。
  关联查看：转正列表（admin.listPromotionApplications）。
- **转正审核**（操作）`admin.auditPromotionApplication`：宠托师：转正审核。仅授予该项操作，其他管理操作需单独选择。
  关联查看：转正列表（admin.listPromotionApplications）、转正详情（admin.getPromotionApplicationDetail）。

### 财务

平台经营金额、支付退款、宠托师收益与资金流水。

- **财务看板**（操作）`admin.financeDashboard`：财务：财务看板。仅授予该项操作，其他管理操作需单独选择。
  关联查看：资金流水（admin.listFinanceLogs）。
- **资金流水**（查看）`admin.listFinanceLogs`：财务：资金流水。仅授予该项数据查看，不包含编辑、审核或删除。
- **支付单**（查看）`admin.listPayments`：财务：支付单。仅授予该项数据查看，不包含编辑、审核或删除。
- **退款单**（查看）`admin.listRefunds`：财务：退款单。仅授予该项数据查看，不包含编辑、审核或删除。
- **收益明细**（查看）`admin.listStaffEarnings`：财务：收益明细。仅授予该项数据查看，不包含编辑、审核或删除。

### 用品报销

用品报销凭证、审核及实际付款确认。

- **报销列表**（查看）`admin.listSupplyReimbursements`：用品报销：报销列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **审核报销**（操作；敏感）`admin.auditSupplyReimbursement`：用品报销：审核报销。仅授予该项操作，其他管理操作需单独选择。
  关联查看：报销列表（admin.listSupplyReimbursements）。
- **确认报销付款**（操作；敏感）`admin.paySupplyReimbursement`：用品报销：确认报销付款。仅授予该项操作，其他管理操作需单独选择。
  关联查看：报销列表（admin.listSupplyReimbursements）。

### 保证金与扣罚

宠托师保证金记录、退款、补缴和违规扣罚。

- **保证金列表**（查看）`admin.listStaffDeposits`：保证金与扣罚：保证金列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **保证金详情**（查看）`admin.getStaffDepositDetail`：保证金与扣罚：保证金详情。仅授予该项数据查看，不包含编辑、审核或删除。
  关联查看：保证金列表（admin.listStaffDeposits）。
- **要求补缴**（操作；敏感）`admin.batchRequireDepositRepay`：保证金与扣罚：要求补缴。仅授予该项操作，其他管理操作需单独选择。
  关联查看：宠托师列表（admin.listStaffProfiles）。
- **审核保证金退款**（操作；敏感）`admin.auditDepositRefund`：保证金与扣罚：审核保证金退款。仅授予该项操作，其他管理操作需单独选择。
  关联查看：保证金列表（admin.listStaffDeposits）。
- **确认保证金退款**（操作；敏感）`admin.confirmDepositRefund`：保证金与扣罚：确认保证金退款。仅授予该项操作，其他管理操作需单独选择。
  关联查看：保证金列表（admin.listStaffDeposits）。
- **没收保证金**（操作；敏感）`admin.forfeitStaffDeposit`：依据违规事实、证据和原因扣除保证金余额。
  关联查看：保证金列表（admin.listStaffDeposits）。

### 提现审核与微信转账

提现申请、审核、微信零钱转账与失败处理。查看综合提现列表会包含用户邀请收益提现。

- **提现列表**（查看）`admin.listWithdrawRequests`：查看综合提现申请，包含宠托师及用户邀请收益提现、收款方式和历史记录。
- **用户资产提现列表**（查看）`admin.listUserAssetWithdrawals`：仅查看用户可提现资产申请，不授予宠托师综合提现数据访问。
- **审核提现**（操作；敏感）`admin.auditWithdrawRequest`：通过或驳回综合提现申请；微信零钱渠道通过后可能直接发起实际转账。
  关联查看：提现列表（admin.listWithdrawRequests）。
- **审核用户资产提现**（操作；敏感）`admin.auditUserAssetWithdrawal`：通过或驳回用户资产提现；可能触发实际微信零钱转账。
  关联查看：用户资产提现列表（admin.listUserAssetWithdrawals）。
- **查询微信提现**（操作）`admin.queryWithdrawTransfer`：向微信查询转账状态，并按结果同步本地提现状态。
  关联查看：提现列表（admin.listWithdrawRequests）。
- **重试微信提现**（操作；敏感）`admin.retryWithdrawTransfer`：发起或安全重试实际微信零钱转账，可能产生资金支出。
  关联查看：提现列表（admin.listWithdrawRequests）。
- **释放失败提现**（操作；敏感）`admin.releaseFailedWithdraw`：核实微信转账失败后释放占用收益，将余额退回可提现额度。
  关联查看：提现列表（admin.listWithdrawRequests）。
- **确认提现付款**（操作；敏感）`admin.markWithdrawPaid`：核实人工付款凭证后将提现标记为已到账。
  关联查看：提现列表（admin.listWithdrawRequests）。

### 服务配置

服务价格、展示内容与服务打卡规则。

- **查看价格**（查看）`admin.listServicePrices`：服务配置：查看价格。仅授予该项数据查看，不包含编辑、审核或删除。
- **编辑价格**（操作）`admin.saveServicePrice`：服务配置：编辑价格。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看价格（admin.listServicePrices）。
- **删除价格**（操作）`admin.deleteServicePrice`：服务配置：删除价格。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看价格（admin.listServicePrices）。
- **重置价格**（操作；敏感）`admin.resetDefaultServicePrices`：服务配置：重置价格。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看价格（admin.listServicePrices）。
- **打卡规则**（查看）`admin.listServiceCheckinRules`：服务配置：打卡规则。仅授予该项数据查看，不包含编辑、审核或删除。
  关联查看：查看价格（admin.listServicePrices）。
- **编辑打卡规则**（操作）`admin.saveServiceCheckinRules`：服务配置：编辑打卡规则。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看价格（admin.listServicePrices）、打卡规则（admin.listServiceCheckinRules）。
- **重置打卡规则**（操作；敏感）`admin.resetDefaultServiceCheckinRules`：服务配置：重置打卡规则。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看价格（admin.listServicePrices）、打卡规则（admin.listServiceCheckinRules）。

### 营销与会员

优惠券模板、定向发券及奖励邮件。

- **优惠券模板**（查看）`admin.listCouponTemplates`：营销与会员：优惠券模板。仅授予该项数据查看，不包含编辑、审核或删除。
- **编辑优惠券**（操作）`admin.saveCouponTemplate`：营销与会员：编辑优惠券。仅授予该项操作，其他管理操作需单独选择。
  关联查看：优惠券模板（admin.listCouponTemplates）。
- **删除优惠券**（操作）`admin.deleteCouponTemplate`：营销与会员：删除优惠券。仅授予该项操作，其他管理操作需单独选择。
  关联查看：优惠券模板（admin.listCouponTemplates）。
- **发放优惠券**（操作；敏感）`admin.issueCouponToUser`：营销与会员：发放优惠券。仅授予该项操作，其他管理操作需单独选择。
  关联查看：优惠券模板（admin.listCouponTemplates）。
- **分层发券**（操作；敏感）`admin.issueCouponByLevels`：营销与会员：分层发券。仅授予该项操作，其他管理操作需单独选择。
  关联查看：优惠券模板（admin.listCouponTemplates）。
- **发放奖励**（操作；敏感）`admin.publishRewardMailByLevels`：营销与会员：发放奖励。仅授予该项操作，其他管理操作需单独选择。
  关联查看：优惠券模板（admin.listCouponTemplates）。

### 积分、签到与抽奖

积分流水、补签卡、月度签到奖励和抽奖活动。

- **发放用户可提现零钱**（操作；敏感；接口功能）`admin.grantUserAssetCash`：通过管理接口为指定用户增加可提现零钱，会形成平台资金责任；当前无独立后台页面。
- **调整积分**（操作；敏感）`admin.grantPoints`：积分、签到与抽奖：调整积分。仅授予该项操作，其他管理操作需单独选择。
  关联查看：积分流水（admin.listPointLogs）。
- **积分流水**（查看）`admin.listPointLogs`：积分、签到与抽奖：积分流水。仅授予该项数据查看，不包含编辑、审核或删除。
- **签到配置**（查看）`admin.getCheckinMonthConfig`：积分、签到与抽奖：签到配置。仅授予该项数据查看，不包含编辑、审核或删除。
- **编辑签到配置**（操作）`admin.saveCheckinMonthConfig`：积分、签到与抽奖：编辑签到配置。仅授予该项操作，其他管理操作需单独选择。
  关联查看：签到配置（admin.getCheckinMonthConfig）。
- **发放补签卡**（操作；敏感）`admin.publishRetroCardMail`：积分、签到与抽奖：发放补签卡。仅授予该项操作，其他管理操作需单独选择。
  关联查看：积分流水（admin.listPointLogs）。
- **编辑抽奖**（操作）`admin.saveLotteryActivity`：积分、签到与抽奖：编辑抽奖。仅授予该项操作，其他管理操作需单独选择。
  关联查看：抽奖列表（admin.listLotteryActivities）。
- **抽奖列表**（查看）`admin.listLotteryActivities`：积分、签到与抽奖：抽奖列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **抽奖开关**（操作）`admin.toggleLotteryActivity`：积分、签到与抽奖：抽奖开关。仅授予该项操作，其他管理操作需单独选择。
  关联查看：抽奖列表（admin.listLotteryActivities）。
- **删除抽奖**（操作）`admin.deleteLotteryActivity`：积分、签到与抽奖：删除抽奖。仅授予该项操作，其他管理操作需单独选择。
  关联查看：抽奖列表（admin.listLotteryActivities）。

### 会员、头衔与疫苗

会员等级、宠物头衔和疫苗认证审核。

- **会员等级**（查看）`admin.listMemberLevels`：会员、头衔与疫苗：会员等级。仅授予该项数据查看，不包含编辑、审核或删除。
- **编辑会员等级**（操作）`admin.saveMemberLevel`：会员、头衔与疫苗：编辑会员等级。仅授予该项操作，其他管理操作需单独选择。
  关联查看：会员等级（admin.listMemberLevels）。
- **删除会员等级**（操作）`admin.deleteMemberLevel`：会员、头衔与疫苗：删除会员等级。仅授予该项操作，其他管理操作需单独选择。
  关联查看：会员等级（admin.listMemberLevels）。
- **宠物头衔**（查看）`admin.listPetTitles`：会员、头衔与疫苗：宠物头衔。仅授予该项数据查看，不包含编辑、审核或删除。
- **编辑头衔**（操作）`admin.savePetTitle`：会员、头衔与疫苗：编辑头衔。仅授予该项操作，其他管理操作需单独选择。
  关联查看：宠物头衔（admin.listPetTitles）。
- **删除头衔**（操作）`admin.deletePetTitle`：会员、头衔与疫苗：删除头衔。仅授予该项操作，其他管理操作需单独选择。
  关联查看：宠物头衔（admin.listPetTitles）。
- **宠物疫苗审核**（查看）`admin.listPetVaccineCertifications`：会员、头衔与疫苗：宠物疫苗审核。仅授予该项数据查看，不包含编辑、审核或删除。
- **审核疫苗认证**（操作）`admin.auditPetVaccineCertification`：会员、头衔与疫苗：审核疫苗认证。仅授予该项操作，其他管理操作需单独选择。
  关联查看：宠物疫苗审核（admin.listPetVaccineCertifications）。
- **发放头衔**（操作；敏感）`admin.publishPetTitleMail`：会员、头衔与疫苗：发放头衔。仅授予该项操作，其他管理操作需单独选择。
  关联查看：宠物头衔（admin.listPetTitles）。

### 反馈

用户反馈及客服回复。

- **查看反馈**（查看）`admin.listFeedback`：反馈：查看反馈。仅授予该项数据查看，不包含编辑、审核或删除。
- **回复反馈**（操作）`admin.replyFeedback`：反馈：回复反馈。仅授予该项操作，其他管理操作需单独选择。
  关联查看：查看反馈（admin.listFeedback）。

### 系统配置

查看脱敏系统配置及订阅消息投递、失败重试。保存全局设置仅限超级管理员。

- **查看配置**（查看）`admin.getSystemSettings`：查看脱敏的平台参数；支付密钥和集成凭据仍仅超级管理员可读取。
- **查看通知投递**（查看）`admin.listSubscriptionDeliveries`：系统配置：查看通知投递。仅授予该项数据查看，不包含编辑、审核或删除。
  关联查看：查看配置（admin.getSystemSettings）。
- **重试通知投递**（操作）`admin.retrySubscriptionDelivery`：将订阅消息重新入队；实际发送受模板配置和用户授权次数限制。
  关联查看：查看配置（admin.getSystemSettings）、查看通知投递（admin.listSubscriptionDeliveries）。

### 商城

商城分类、商品上下架、订单发货、物流查询及售后退款。

- **查看分类**（查看）`adminMall.listCategories`：商城：查看分类。仅授予该项数据查看，不包含编辑、审核或删除。
- **编辑分类**（操作）`adminMall.saveCategory`：商城：编辑分类。仅授予该项操作，其他管理操作需单独选择。
  关联查看：商品列表（adminMall.listProducts）、查看分类（adminMall.listCategories）。
- **删除分类**（操作）`adminMall.deleteCategory`：商城：删除分类。仅授予该项操作，其他管理操作需单独选择。
  关联查看：商品列表（adminMall.listProducts）、查看分类（adminMall.listCategories）。
- **商品列表**（查看）`adminMall.listProducts`：商城：商品列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **编辑商品**（操作）`adminMall.saveProduct`：商城：编辑商品。仅授予该项操作，其他管理操作需单独选择。
  关联查看：商品列表（adminMall.listProducts）、查看分类（adminMall.listCategories）。
- **上下架**（操作）`adminMall.toggleProductStatus`：商城：上下架。仅授予该项操作，其他管理操作需单独选择。
  关联查看：商品列表（adminMall.listProducts）、查看分类（adminMall.listCategories）。
- **订单列表**（查看）`adminMall.listOrders`：商城：订单列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **订单详情**（查看）`adminMall.getOrderDetail`：商城：订单详情。仅授予该项数据查看，不包含编辑、审核或删除。
  关联查看：订单列表（adminMall.listOrders）。
- **查看快递公司**（查看）`adminMall.listExpressCompanies`：商城：查看快递公司。仅授予该项数据查看，不包含编辑、审核或删除。
- **查询订单物流**（操作）`adminMall.queryOrderLogistics`：请求物流服务查询轨迹，可能消耗物流服务额度；确认签收后会同步订单完成状态。
  关联查看：订单列表（adminMall.listOrders）。
- **发货**（操作）`adminMall.shipOrder`：商城：发货。仅授予该项操作，其他管理操作需单独选择。
  关联查看：订单列表（adminMall.listOrders）。
- **修改订单**（操作）`adminMall.updateOrderStatus`：商城：修改订单。仅授予该项操作，其他管理操作需单独选择。
  关联查看：订单列表（adminMall.listOrders）。
- **退款**（操作；敏感）`adminMall.refundOrder`：商城：退款。仅授予该项操作，其他管理操作需单独选择。
  关联查看：订单列表（adminMall.listOrders）。
- **审核售后**（操作；敏感）`adminMall.auditRefund`：商城：审核售后。仅授予该项操作，其他管理操作需单独选择。
  关联查看：订单列表（adminMall.listOrders）。

### 纠纷

SOS、客诉、证据与纠纷处置。

- **纠纷列表**（查看）`incident.listIncidents`：纠纷：纠纷列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **纠纷详情**（查看）`incident.getIncidentDetail`：纠纷：纠纷详情。仅授予该项数据查看，不包含编辑、审核或删除。
  关联查看：纠纷列表（incident.listIncidents）。
- **留言**（操作）`incident.appendIncidentComment`：纠纷：留言。仅授予该项操作，其他管理操作需单独选择。
  关联查看：纠纷列表（incident.listIncidents）、纠纷详情（incident.getIncidentDetail）。
- **上传证据**（操作）`incident.uploadIncidentEvidence`：纠纷：上传证据。仅授予该项操作，其他管理操作需单独选择。
  关联查看：纠纷列表（incident.listIncidents）。
- **更新状态**（操作）`incident.updateIncidentStatus`：纠纷：更新状态。仅授予该项操作，其他管理操作需单独选择。
  关联查看：纠纷列表（incident.listIncidents）、纠纷详情（incident.getIncidentDetail）。
- **标记解决**（操作）`incident.resolveIncident`：纠纷：标记解决。仅授予该项操作，其他管理操作需单独选择。
  关联查看：纠纷列表（incident.listIncidents）。
- **处理方案**（操作）`incident.proposeResolution`：纠纷：处理方案。仅授予该项操作，其他管理操作需单独选择。
  关联查看：纠纷列表（incident.listIncidents）、纠纷详情（incident.getIncidentDetail）。
- **冻结收益**（操作；敏感）`incident.freezeStaffEarning`：纠纷：冻结收益。仅授予该项操作，其他管理操作需单独选择。
  关联查看：纠纷列表（incident.listIncidents）、纠纷详情（incident.getIncidentDetail）。
- **关联退款**（操作）`incident.linkRefund`：纠纷：关联退款。仅授予该项操作，其他管理操作需单独选择。
  关联查看：纠纷列表（incident.listIncidents）、纠纷详情（incident.getIncidentDetail）。
- **结案扣减**（操作；敏感）`incident.closeIncident`：纠纷：结案扣减。仅授予该项操作，其他管理操作需单独选择。
  关联查看：纠纷列表（incident.listIncidents）、纠纷详情（incident.getIncidentDetail）。

### 支付与活动维护

微信退款记录、退款状态查询和直接发起退款接口。

- **发起退款**（操作；敏感；接口功能）`payment.createRefund`：直接调用退款业务接口，可能向用户退还实际资金。
  关联查看：查看退款（payment.listRefunds）。
- **查看退款**（查看）`payment.listRefunds`：支付与活动维护：查看退款。仅授予该项数据查看，不包含编辑、审核或删除。
- **查询退款**（操作）`payment.queryRefund`：向微信查询退款结果并同步退款记录，不仅是读取缓存。

### 选美活动管理

选美资格、月度结算与冠军奖金，部分功能由现有业务页面或接口调用。

- **结算月度排名**（操作；敏感；接口功能）`petBeauty.settleMonthlyRanking`：选美活动管理：结算月度排名。仅授予该项操作，其他管理操作需单独选择。
- **取消参赛资格**（操作；接口功能）`petBeauty.disqualifyPetBeautyCandidate`：选美活动管理：取消参赛资格。仅授予该项操作，其他管理操作需单独选择。
- **恢复参赛资格**（操作；接口功能）`petBeauty.reinstatePetBeautyCandidate`：选美活动管理：恢复参赛资格。仅授予该项操作，其他管理操作需单独选择。
- **发放冠军奖金**（操作；敏感；接口功能）`petBeauty.grantPetBeautyChampionPrize`：向月度冠军用户发放可提现现金奖金。
- **同步美照状态**（操作；接口功能）`petBeauty.syncBeautyPhotoFlags`：选美活动管理：同步美照状态。仅授予该项操作，其他管理操作需单独选择。

### 问卷调查

问卷内容、发布、回收数据、AI分析和奖励补发。

- **问卷列表**（查看）`questionnaire.listAdmin`：问卷调查：问卷列表。仅授予该项数据查看，不包含编辑、审核或删除。
- **问卷详情**（操作）`questionnaire.detailAdmin`：问卷调查：问卷详情。仅授予该项操作，其他管理操作需单独选择。
  关联查看：问卷列表（questionnaire.listAdmin）。
- **新建问卷**（操作）`questionnaire.create`：问卷调查：新建问卷。仅授予该项操作，其他管理操作需单独选择。
  关联查看：问卷列表（questionnaire.listAdmin）。
- **编辑问卷**（操作）`questionnaire.update`：问卷调查：编辑问卷。仅授予该项操作，其他管理操作需单独选择。
  关联查看：问卷列表（questionnaire.listAdmin）、问卷详情（questionnaire.detailAdmin）。
- **发布问卷**（操作）`questionnaire.publish`：问卷调查：发布问卷。仅授予该项操作，其他管理操作需单独选择。
  关联查看：问卷列表（questionnaire.listAdmin）。
- **关闭问卷**（操作）`questionnaire.close`：问卷调查：关闭问卷。仅授予该项操作，其他管理操作需单独选择。
  关联查看：问卷列表（questionnaire.listAdmin）。
- **删除问卷**（操作）`questionnaire.delete`：问卷调查：删除问卷。仅授予该项操作，其他管理操作需单独选择。
  关联查看：问卷列表（questionnaire.listAdmin）。
- **克隆问卷**（操作）`questionnaire.clone`：问卷调查：克隆问卷。仅授予该项操作，其他管理操作需单独选择。
  关联查看：问卷列表（questionnaire.listAdmin）。
- **回收记录**（操作）`questionnaire.responses`：查看问卷答案与回收记录，可能包含用户填写的个人资料。
  关联查看：问卷列表（questionnaire.listAdmin）、问卷详情（questionnaire.detailAdmin）。
- **AI分析**（操作）`questionnaire.analyzeAI`：将问卷数据用于AI汇总分析，可能消耗模型服务额度。
  关联查看：问卷列表（questionnaire.listAdmin）、问卷详情（questionnaire.detailAdmin）、查看AI报告（questionnaire.getAiReport）。
- **查看AI报告**（查看）`questionnaire.getAiReport`：问卷调查：查看AI报告。仅授予该项数据查看，不包含编辑、审核或删除。
  关联查看：问卷列表（questionnaire.listAdmin）、问卷详情（questionnaire.detailAdmin）。
- **补发奖励**（操作；敏感）`questionnaire.retryReward`：问卷调查：补发奖励。仅授予该项操作，其他管理操作需单独选择。
  关联查看：问卷列表（questionnaire.listAdmin）、问卷详情（questionnaire.detailAdmin）、回收记录（questionnaire.responses）。
- **批量补发**（操作；敏感）`questionnaire.retryAllRewards`：批量重试未成功发放的问卷奖励。
  关联查看：问卷列表（questionnaire.listAdmin）、问卷详情（questionnaire.detailAdmin）、回收记录（questionnaire.responses）。

### 订单超时巡检

手动触发未开始、未结束订单的超时检测与处置，当前通过接口调用。

- **执行订单超时巡检**（操作；敏感；接口功能）`order.checkOverdueOrders`：订单超时巡检：执行订单超时巡检。仅授予该项操作，其他管理操作需单独选择。

### 临近服务提醒

手动触发临近服务的宠托师订阅提醒，受模板授权限制，当前通过接口调用。

- **触发临近服务提醒**（操作；敏感；接口功能）`staff.checkUpcomingReminders`：临近服务提醒：触发临近服务提醒。仅授予该项操作，其他管理操作需单独选择。

### 后台审计

后台操作人员、操作目标及执行结果。

- **查看操作日志**（查看）`admin.listOperationLogs`：后台审计：查看操作日志。仅授予该项数据查看，不包含编辑、审核或删除。
- **查看后台人员筛选项**（查看）`admin.listOperationActors`：后台审计：查看后台人员筛选项。仅授予该项数据查看，不包含编辑、审核或删除。
  关联查看：查看操作日志（admin.listOperationLogs）。

## 超级管理员专属能力

以下 21 项仅作目录展示，不出现在可分配权限集合中。普通用户组即使伪造这些标识也不能获得权限。

### 配置导入、导出与备份

涉及跨环境全量配置与生产参数，只允许超级管理员操作。

- 导出配置：`configMigration.export`
- 预览导入差异：`configMigration.preview`
- 导入并写入配置：`configMigration.import`
- 读取导入前备份：`configMigration.backup`

### 全局设置与庄园规则

全局配置包含支付、转账、密钥及平台规则；读取未脱敏密钥同样仅限超级管理员。

- 保存全局及支付设置：`admin.saveSystemSettings`
- 保存庄园规则：`admin.savePlaygroundSettings`

### 管理员与用户组授权

可直接改变后台权限边界，不可通过普通用户组转授。

- 启用分组权限：`admin.enableAdminPermissions`
- 查看用户组：`admin.listAdminGroups`
- 保存用户组：`admin.saveAdminGroup`
- 分配人员用户组：`admin.setAdminMembership`
- 查看后台人员：`admin.listAdminMembers`
- 查看人员分组：`admin.getAdminMembership`
- 授予管理员：`admin.grantAdmin`
- 撤销管理员：`admin.revokeAdmin`
- 管理员列表：`admin.listAdmins`

### 数据库初始化与维护

初始化、演示数据及数据库结构维护；不属于普通业务人员操作。

- 检查集合：`initData.checkCollections`
- 写入演示数据：`initData.seedDemoData`
- 建立数据库：`initData.setupDatabase`
- 初始化全部集合：`initData.initAllCollections`
- 建立通知索引：`initData.buildNotificationIndexes`
- 初始化通知索引：`initData.setupNotificationIndexes`

支付密钥及集成凭据的未脱敏读取同样仅限超级管理员。首次认领管理员属于初始化密钥流程，不通过用户组分配。
