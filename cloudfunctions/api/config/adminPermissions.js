const definitions = [
  ['overview', '控制台与通知', 'admin', 'dashboard:查看统计 listAdminNotifications:查看通知 getAdminNotificationBadge:通知角标 markAdminNotificationRead:标记已读'],
  ['orders', '服务订单', 'admin', 'listOrders:订单列表 getOrderDetail:订单详情 getEvidence:服务证据 assignOrder:派单 updateOrderStatus:修改状态 manualCompleteOrder:人工完单 refundOrder:退款 batchDeleteOrders:删除订单 republishOrderAsUrgent:加急重发 addOrderDepositPenaltyEvidence:录入扣罚证据 listOrderDepositPenaltyEvidences:查看扣罚证据'],
  ['users', '用户资料', 'admin', 'listUsers:用户列表 getUserDetail:用户详情 updateUserProfile:编辑用户 deleteUser:删除用户 hardDeleteUser:彻底删除用户'],
  ['staff', '宠托师', 'admin', 'listStaffProfiles:宠托师列表 setSitterFeatured:推荐设置 listStaffAudits:资质列表 auditStaff:审核资质 revokeStaff:撤销资格 listTrainingAudits:培训列表 auditTrainingVideo:培训审核 updateVideoAuditGuide:审核指引 listPromotionApplications:转正列表 getPromotionApplicationDetail:转正详情 auditPromotionApplication:转正审核'],
  ['finance', '财务', 'admin', 'financeDashboard:财务看板 listFinanceLogs:资金流水 listPayments:支付单 listRefunds:退款单 listStaffEarnings:收益明细 listWithdrawRequests:提现列表 auditWithdrawRequest:审核提现 markWithdrawPaid:确认提现付款 listStaffDeposits:保证金列表 getStaffDepositDetail:保证金详情 batchRequireDepositRepay:要求补缴 auditDepositRefund:审核保证金退款 confirmDepositRefund:确认保证金退款 forfeitStaffDeposit:没收保证金 listSupplyReimbursements:报销列表 auditSupplyReimbursement:审核报销 paySupplyReimbursement:确认报销付款'],
  ['prices', '服务配置', 'admin', 'listServicePrices:查看价格 saveServicePrice:编辑价格 deleteServicePrice:删除价格 resetDefaultServicePrices:重置价格 listServiceCheckinRules:打卡规则 saveServiceCheckinRules:编辑打卡规则 resetDefaultServiceCheckinRules:重置打卡规则'],
  ['marketing', '营销与会员', 'admin', 'listCouponTemplates:优惠券模板 saveCouponTemplate:编辑优惠券 deleteCouponTemplate:删除优惠券 issueCouponToUser:发放优惠券 issueCouponByLevels:分层发券 listMemberLevels:会员等级 saveMemberLevel:编辑会员等级 deleteMemberLevel:删除会员等级 listPetTitles:宠物头衔 savePetTitle:编辑头衔 deletePetTitle:删除头衔 grantPoints:调整积分 listPointLogs:积分流水 getCheckinMonthConfig:签到配置 saveCheckinMonthConfig:编辑签到配置 publishRewardMailByLevels:发放奖励 publishRetroCardMail:发放补签卡 publishPetTitleMail:发放头衔 saveLotteryActivity:编辑抽奖 listLotteryActivities:抽奖列表 toggleLotteryActivity:抽奖开关 deleteLotteryActivity:删除抽奖'],
  ['feedback', '反馈', 'admin', 'listFeedback:查看反馈 replyFeedback:回复反馈'],
  ['settings', '系统配置', 'admin', 'getSystemSettings:查看配置 saveSystemSettings:修改配置'],
  ['mall', '商城', 'adminMall', 'listCategories:查看分类 saveCategory:编辑分类 deleteCategory:删除分类 listProducts:商品列表 saveProduct:编辑商品 toggleProductStatus:上下架 listOrders:订单列表 getOrderDetail:订单详情 shipOrder:发货 updateOrderStatus:修改订单 refundOrder:退款 auditRefund:审核售后'],
  ['incidents', '纠纷', 'incident', 'listIncidents:纠纷列表 getIncidentDetail:纠纷详情 appendIncidentComment:留言 uploadIncidentEvidence:上传证据 updateIncidentStatus:更新状态 resolveIncident:标记解决 proposeResolution:处理方案 freezeStaffEarning:冻结收益 linkRefund:关联退款 closeIncident:结案扣减'],
  ['payments', '支付与活动维护', 'payment', 'createRefund:发起退款 listRefunds:查看退款 queryRefund:查询退款'],
  ['beauty', '选美结算', 'petBeauty', 'settleMonthlyRanking:结算排名'],
  ['logs', '后台审计', 'admin', 'listOperationLogs:查看操作日志 listOperationActors:查看后台人员筛选项']
]
const tree = definitions.map(([id, label, module, actions]) => ({ id, label, children: actions.split(' ').map(item => {
  const [action, name] = item.split(':')
  return { id: `${module}.${action}`, label: name }
}) }))
const permissions = new Set(tree.flatMap(node => node.children.map(child => child.id)))
const ownerActions = new Set(['admin.enableAdminPermissions', 'admin.listAdminGroups', 'admin.saveAdminGroup', 'admin.setAdminMembership',
  'admin.listAdminMembers', 'admin.getAdminMembership', 'admin.grantAdmin', 'admin.revokeAdmin', 'admin.listAdmins', 'initData.checkCollections', 'initData.seedDemoData'])
module.exports = { tree, permissions, ownerActions }
