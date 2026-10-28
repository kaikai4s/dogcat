const definitions = [
  ['communityMap', '小区地图', 'communityMap', 'listAdmin:查看公共小区 saveAdmin:维护公共小区 deleteAdmin:删除公共小区 rejectApplication:驳回新增申请'],
  ['buildings','乐园建筑与土地','playgroundBuilding','list:查看配置 prepareUpload:上传建筑素材 save:保存建筑 remove:删除建筑 savePlotAccess:配置土地等级'],
  ['farm', '农作物管理', 'playgroundFarm', 'list:查看农作物 prepareUpload:上传阶段素材 save:保存及上下架 remove:删除植物'],
  ['playground', '乐园形象定制', 'playgroundAppearance', 'listAdmin:申请列表 detailAdmin:查看照片 prepareUpload:上传图集 publish:发布专属形象 reject:退回申请 disableAppearance:作废专属形象 enableAppearance:重新启用专属形象'],
  ['overview', '控制台与通知', 'admin', 'dashboard:查看统计 listAdminNotifications:查看通知 getAdminNotificationBadge:通知角标 markAdminNotificationRead:标记已读 sendSystemNotification:发送系统通知 listSystemNotifications:系统通知列表 revokeSystemNotification:撤回系统通知'],
  ['orders', '服务订单', 'admin', 'listOrders:订单列表 getOrderDetail:订单详情 getEvidence:服务证据 listOrderSessionMessages:查看服务会话记录 assignOrder:派单 updateOrderStatus:修改状态 manualCompleteOrder:人工完单 refundOrder:退款 batchDeleteOrders:删除订单 republishOrderAsUrgent:加急重发 addOrderDepositPenaltyEvidence:录入扣罚证据 listOrderDepositPenaltyEvidences:查看扣罚证据'],
  ['users', '用户资料', 'admin', 'listUsers:用户列表 getUserDetail:用户详情 updateUserProfile:编辑用户 deleteUser:删除用户 hardDeleteUser:彻底删除用户'],
  ['staff', '宠托师', 'admin', 'listStaffProfiles:宠托师列表 setSitterFeatured:推荐设置 listStaffAudits:资质列表 auditStaff:审核资质 completeStaffGender:核实补录性别 revokeStaff:撤销资格 listTrainingAudits:培训列表 auditTrainingVideo:培训审核 updateVideoAuditGuide:审核指引 listPromotionApplications:转正列表 getPromotionApplicationDetail:转正详情 auditPromotionApplication:转正审核'],
  ['finance', '财务', 'admin', 'financeDashboard:财务看板 listFinanceLogs:资金流水 listPayments:支付单 listRefunds:退款单 listStaffEarnings:收益明细 listWithdrawRequests:提现列表 listUserAssetWithdrawals:用户资产提现列表 getStaffSettlementPreview:结清收益预览 settleStaffEarningsByWechat:结清收益微信转账 auditWithdrawRequest:审核提现 auditUserAssetWithdrawal:审核用户资产提现 queryWithdrawTransfer:查询微信提现 retryWithdrawTransfer:重试微信提现 releaseFailedWithdraw:释放失败提现 markWithdrawPaid:确认提现付款 listStaffDeposits:保证金列表 getStaffDepositDetail:保证金详情 shipStaffSupplies:寄送首次用品 batchRequireDepositRepay:要求补缴 requestStaffDepositRefund:发起保证金退还 auditDepositRefund:审核保证金退款 confirmDepositRefund:确认保证金退款 autoRefundStaffDeposit:自动退还保证金 forfeitStaffDeposit:没收保证金 listSupplyReimbursements:报销列表 auditSupplyReimbursement:审核报销 paySupplyReimbursement:确认报销付款'],
  ['prices', '服务配置', 'admin', 'listServicePrices:查看价格 saveServicePrice:编辑价格 deleteServicePrice:删除价格 resetDefaultServicePrices:重置价格 listServiceCheckinRules:打卡规则 saveServiceCheckinRules:编辑打卡规则 resetDefaultServiceCheckinRules:重置打卡规则'],
  ['marketing', '营销与会员', 'admin', 'listCouponTemplates:优惠券模板 saveCouponTemplate:编辑优惠券 deleteCouponTemplate:删除优惠券 issueCouponToUser:发放优惠券 issueCouponByLevels:分层发券 listMemberLevels:会员等级 saveMemberLevel:编辑会员等级 deleteMemberLevel:删除会员等级 listPetTitles:宠物头衔 savePetTitle:编辑头衔 deletePetTitle:删除头衔 listPetVaccineCertifications:宠物疫苗审核 auditPetVaccineCertification:审核疫苗认证 grantUserAssetCash:发放用户可提现零钱 grantPoints:调整积分 listPointLogs:积分流水 getCheckinMonthConfig:签到配置 saveCheckinMonthConfig:编辑签到配置 publishRewardMailByLevels:发放奖励 publishRetroCardMail:发放补签卡 publishPetTitleMail:发放头衔 saveLotteryActivity:编辑抽奖 listLotteryActivities:抽奖列表 toggleLotteryActivity:抽奖开关 deleteLotteryActivity:删除抽奖'],
  ['feedback', '反馈', 'admin', 'listFeedback:查看反馈 replyFeedback:回复反馈'],
  ['settings', '系统配置', 'admin', 'getSystemSettings:查看配置 listSubscriptionDeliveries:查看通知投递 retrySubscriptionDelivery:重试通知投递'],
  ['mall', '商城', 'adminMall', 'listCategories:查看分类 saveCategory:编辑分类 deleteCategory:删除分类 listProducts:商品列表 saveProduct:编辑商品 toggleProductStatus:上下架 getShopConfig:查看微信小店配置 saveShopConfig:编辑微信小店配置 listOrders:订单列表 getOrderDetail:订单详情 listExpressCompanies:查看快递公司 queryOrderLogistics:查询订单物流 shipOrder:发货 updateOrderStatus:修改订单 refundOrder:退款 auditRefund:审核售后'],
  ['incidents', '纠纷', 'incident', 'listIncidents:纠纷列表 getIncidentDetail:纠纷详情 appendIncidentComment:留言 uploadIncidentEvidence:上传证据 updateIncidentStatus:更新状态 resolveIncident:标记解决 proposeResolution:处理方案 freezeStaffEarning:冻结收益 linkRefund:关联退款 closeIncident:结案扣减'],
  ['payments', '支付与活动维护', 'payment', 'createRefund:发起退款 listRefunds:查看退款 queryRefund:查询退款'],
  ['beauty', '选美活动管理', 'petBeauty', 'settleMonthlyRanking:结算月度排名 disqualifyPetBeautyCandidate:取消参赛资格 reinstatePetBeautyCandidate:恢复参赛资格 grantPetBeautyChampionPrize:发放冠军奖金 syncBeautyPhotoFlags:同步美照状态'],
  ['questionnaires', '问卷调查', 'questionnaire', 'listAdmin:问卷列表 detailAdmin:问卷详情 create:新建问卷 update:编辑问卷 publish:发布问卷 close:关闭问卷 delete:删除问卷 clone:克隆问卷 responses:回收记录 analyzeAI:AI分析 getAiReport:查看AI报告 retryReward:补发奖励 retryAllRewards:批量补发'],
  ['timeouts', '订单超时巡检', 'order', 'checkOverdueOrders:执行订单超时巡检'],
  ['reminders', '临近服务提醒', 'staff', 'checkUpcomingReminders:触发临近服务提醒'],
  ['logs', '后台审计', 'admin', 'listOperationLogs:查看操作日志 listOperationActors:查看后台人员筛选项']
]
// Permission IDs are stable: regrouping and richer descriptions do not change existing grants.
const descriptions = {
  timeouts: '手动触发未开始、未结束订单的超时检测与处置，当前通过接口调用。', reminders: '手动触发临近服务的宠托师订阅提醒，受模板授权限制，当前通过接口调用。',
  buildings: '建筑素材、上架状态、土地会员解锁及积分规则。', farm: '植物素材、生长阶段、会员解锁与上下架。',
  playground: '用户上传的宠物照片、形象定制申请与专属图集发布。', overview: '平台经营统计、待办数量与后台告警。',
  orders: '服务订单、派单、证据、会话与订单处置。', users: '用户档案、联系方式及账号状态。普通管理员不能修改管理员账号或变更角色。',
  staff: '宠托师资料、推荐、资格和培训、转正审核。', finance: '平台经营金额、支付退款、宠托师收益与资金流水。',
  withdrawals: '提现申请、审核、微信零钱转账与失败处理。查看综合提现列表会包含用户邀请收益提现。',
  deposits: '宠托师保证金记录、退款、补缴和违规扣罚。', supplies: '用品报销凭证、审核及实际付款确认。',
  prices: '服务价格、展示内容与服务打卡规则。', marketing: '优惠券模板、定向发券及奖励邮件。',
  membership: '会员等级、宠物头衔和疫苗认证审核。', rewards: '积分流水、补签卡、月度签到奖励和抽奖活动。',
  feedback: '用户反馈及客服回复。', settings: '查看脱敏系统配置及订阅消息投递、失败重试。保存全局设置仅限超级管理员。',
  mall: '商城分类、商品上下架、订单发货、物流查询及售后退款。', incidents: 'SOS、客诉、证据与纠纷处置。',
  payments: '微信退款记录、退款状态查询和直接发起退款接口。', beauty: '选美资格、月度结算与冠军奖金，部分功能由现有业务页面或接口调用。',
  questionnaires: '问卷内容、发布、回收数据、AI分析和奖励补发。', logs: '后台操作人员、操作目标及执行结果。'
}
const splitGroups = [
  ['withdrawals', '提现审核与微信转账', 'finance', 'listWithdrawRequests listUserAssetWithdrawals getStaffSettlementPreview settleStaffEarningsByWechat auditWithdrawRequest auditUserAssetWithdrawal queryWithdrawTransfer retryWithdrawTransfer releaseFailedWithdraw markWithdrawPaid'],
  ['deposits', '保证金与扣罚', 'finance', 'listStaffDeposits getStaffDepositDetail shipStaffSupplies batchRequireDepositRepay requestStaffDepositRefund auditDepositRefund confirmDepositRefund autoRefundStaffDeposit forfeitStaffDeposit'],
  ['supplies', '用品报销', 'finance', 'listSupplyReimbursements auditSupplyReimbursement paySupplyReimbursement'],
  ['membership', '会员、头衔与疫苗', 'marketing', 'listMemberLevels saveMemberLevel deleteMemberLevel listPetTitles savePetTitle deletePetTitle listPetVaccineCertifications auditPetVaccineCertification publishPetTitleMail'],
  ['rewards', '积分、签到与抽奖', 'marketing', 'grantPoints listPointLogs getCheckinMonthConfig saveCheckinMonthConfig publishRetroCardMail saveLotteryActivity listLotteryActivities toggleLotteryActivity deleteLotteryActivity grantUserAssetCash']
]
const groups = definitions.map(([id, label, module, actions]) => ({ id, label, module, actions: actions.split(' ') }))
for (const [id, label, from, names] of splitGroups) {
  const source = groups.find(group => group.id === from)
  const keys = new Set(names.split(' '))
  const actions = source.actions.filter(item => keys.has(item.split(':')[0]))
  source.actions = source.actions.filter(item => !keys.has(item.split(':')[0]))
  groups.splice(groups.indexOf(source) + 1, 0, { id, label, module: source.module, actions })
}
const sensitive = new Set(('communityMap.rejectApplication order.checkOverdueOrders staff.checkUpcomingReminders admin.refundOrder admin.batchDeleteOrders admin.deleteUser admin.hardDeleteUser admin.revokeStaff admin.settleStaffEarningsByWechat admin.auditWithdrawRequest admin.auditUserAssetWithdrawal admin.retryWithdrawTransfer admin.releaseFailedWithdraw admin.markWithdrawPaid admin.batchRequireDepositRepay admin.requestStaffDepositRefund admin.auditDepositRefund admin.confirmDepositRefund admin.autoRefundStaffDeposit admin.forfeitStaffDeposit admin.shipStaffSupplies admin.auditSupplyReimbursement admin.paySupplyReimbursement admin.grantPoints admin.grantUserAssetCash admin.issueCouponToUser admin.issueCouponByLevels admin.publishRewardMailByLevels admin.publishRetroCardMail admin.publishPetTitleMail admin.resetDefaultServicePrices admin.resetDefaultServiceCheckinRules admin.sendSystemNotification adminMall.refundOrder adminMall.auditRefund incident.freezeStaffEarning incident.closeIncident payment.createRefund petBeauty.settleMonthlyRanking petBeauty.grantPetBeautyChampionPrize questionnaire.retryReward questionnaire.retryAllRewards').split(' '))
sensitive.add('communityMap.deleteAdmin')
const details = {
  'communityMap.deleteAdmin': '从公开目录删除小区，阻止新访客及新住户进入，保留原住户庄园并持续提醒搬迁。',
  'communityMap.rejectApplication': '填写原因并永久驳回新增小区申请，通过系统通知告知原申请人；同一小区不再接受申请。',
  'admin.dashboard': '查看全平台订单数量、待审核数量及经营汇总，包含跨业务统计。',
  'admin.getAdminNotificationBadge': '查看后台通知未读数及紧急待办摘要。',
  'admin.getOrderDetail': '查看下单资料、服务安排、订单资金和打卡凭证。服务会话需另行授权。',
  'admin.listOrderSessionMessages': '读取订单对应服务会话的聊天记录，涉及用户与宠托师的私密沟通。',
  'playgroundAppearance.publish': '上传并发布专属图集，将形象绑定给申请对象；现有页面需同时授予“上传图集”。',
  'admin.getEvidence': '查看服务照片、视频、定位和打卡凭证。',
  'admin.updateUserProfile': '编辑普通用户资料及账号状态；变更积分类余额还需“调整积分”，不能变更角色或编辑管理员账号。',
  'admin.hardDeleteUser': '彻底清理用户及相关业务数据，属于不可轻易恢复的操作。',
  'admin.listWithdrawRequests': '查看综合提现申请，包含宠托师及用户邀请收益提现、收款方式和历史记录。',
  'admin.listUserAssetWithdrawals': '仅查看用户可提现资产申请，不授予宠托师综合提现数据访问。',
  'admin.auditWithdrawRequest': '通过或驳回综合提现申请；微信零钱渠道通过后可能直接发起实际转账。',
  'admin.auditUserAssetWithdrawal': '通过或驳回用户资产提现；可能触发实际微信零钱转账。',
  'admin.retryWithdrawTransfer': '发起或安全重试实际微信零钱转账，可能产生资金支出。',
  'admin.queryWithdrawTransfer': '向微信查询转账状态，并按结果同步本地提现状态。',
  'admin.releaseFailedWithdraw': '核实微信转账失败后释放占用收益，将余额退回可提现额度。',
  'admin.markWithdrawPaid': '核实人工付款凭证后将提现标记为已到账。',
  'admin.forfeitStaffDeposit': '依据违规事实、证据和原因扣除保证金余额。',
  'admin.grantUserAssetCash': '通过管理接口为指定用户增加可提现零钱，会形成平台资金责任；当前无独立后台页面。',
  'admin.getSystemSettings': '查看脱敏的平台参数；支付密钥和集成凭据仍仅超级管理员可读取。',
  'admin.retrySubscriptionDelivery': '将订阅消息重新入队；实际发送受模板配置和用户授权次数限制。',
  'adminMall.queryOrderLogistics': '请求物流服务查询轨迹，可能消耗物流服务额度；确认签收后会同步订单完成状态。',
  'payment.queryRefund': '向微信查询退款结果并同步退款记录，不仅是读取缓存。',
  'payment.createRefund': '直接调用退款业务接口，可能向用户退还实际资金。',
  'petBeauty.grantPetBeautyChampionPrize': '向月度冠军用户发放可提现现金奖金。',
  'questionnaire.responses': '查看问卷答案与回收记录，可能包含用户填写的个人资料。',
  'questionnaire.analyzeAI': '将问卷数据用于AI汇总分析，可能消耗模型服务额度。',
  'questionnaire.retryAllRewards': '批量重试未成功发放的问卷奖励。'
}
// These dependencies support entering the existing page; never added to stored groups on the server implicitly.
const requires = {}
function depend(keys, prerequisites) { for (const key of keys.split(' ')) requires[key] = prerequisites.split(' ') }
for (const group of groups) {
  const read = group.actions.map(item => item.split(':')[0]).find(action => /^(list|get)/.test(action))
  if (!read) continue
  for (const item of group.actions) {
    const action = item.split(':')[0], key = `${group.module}.${action}`
    if (!/^(list|get|query)/.test(action)) requires[key] = [`${group.module}.${read}`]
  }
}
depend('admin.getOrderDetail admin.assignOrder admin.getEvidence admin.listOrderSessionMessages admin.updateOrderStatus admin.manualCompleteOrder admin.refundOrder admin.republishOrderAsUrgent admin.addOrderDepositPenaltyEvidence admin.listOrderDepositPenaltyEvidences', 'admin.listOrders')
depend('admin.listOrderSessionMessages admin.updateOrderStatus admin.manualCompleteOrder admin.refundOrder admin.republishOrderAsUrgent admin.addOrderDepositPenaltyEvidence', 'admin.listOrders admin.getOrderDetail')
depend('admin.addOrderDepositPenaltyEvidence', 'admin.listOrders admin.getOrderDetail admin.getStaffDepositDetail')
depend('admin.assignOrder', 'admin.listOrders admin.listStaffAudits')
depend('admin.getUserDetail', 'admin.listUsers')
depend('admin.updateUserProfile', 'admin.listUsers admin.getUserDetail')
depend('admin.auditStaff admin.completeStaffGender', 'admin.listStaffAudits')
depend('admin.auditTrainingVideo admin.updateVideoAuditGuide', 'admin.listTrainingAudits')
depend('admin.getPromotionApplicationDetail', 'admin.listPromotionApplications')
depend('admin.auditPromotionApplication', 'admin.listPromotionApplications admin.getPromotionApplicationDetail')
depend('admin.queryWithdrawTransfer admin.retryWithdrawTransfer admin.releaseFailedWithdraw admin.markWithdrawPaid admin.auditWithdrawRequest', 'admin.listWithdrawRequests')
depend('admin.auditUserAssetWithdrawal', 'admin.listUserAssetWithdrawals')
depend('admin.settleStaffEarningsByWechat', 'admin.getStaffSettlementPreview admin.listWithdrawRequests admin.queryWithdrawTransfer')
depend('admin.requestStaffDepositRefund admin.auditDepositRefund admin.confirmDepositRefund admin.autoRefundStaffDeposit admin.forfeitStaffDeposit admin.shipStaffSupplies admin.getStaffDepositDetail', 'admin.listStaffDeposits')
depend('admin.batchRequireDepositRepay', 'admin.listStaffProfiles')
depend('admin.auditSupplyReimbursement admin.paySupplyReimbursement', 'admin.listSupplyReimbursements')
depend('admin.saveServiceCheckinRules admin.resetDefaultServiceCheckinRules', 'admin.listServicePrices admin.listServiceCheckinRules')
depend('admin.grantPoints admin.publishRetroCardMail', 'admin.listPointLogs')
depend('admin.saveCheckinMonthConfig', 'admin.getCheckinMonthConfig')
depend('admin.saveLotteryActivity admin.toggleLotteryActivity admin.deleteLotteryActivity', 'admin.listLotteryActivities')
depend('admin.saveMemberLevel admin.deleteMemberLevel', 'admin.listMemberLevels')
depend('admin.savePetTitle admin.deletePetTitle admin.publishPetTitleMail', 'admin.listPetTitles')
depend('admin.auditPetVaccineCertification', 'admin.listPetVaccineCertifications')
depend('admin.markAdminNotificationRead', 'admin.listAdminNotifications')
depend('admin.sendSystemNotification admin.revokeSystemNotification', 'admin.listAdminNotifications admin.listSystemNotifications')
depend('admin.retrySubscriptionDelivery', 'admin.getSystemSettings admin.listSubscriptionDeliveries')
depend('adminMall.shipOrder adminMall.updateOrderStatus adminMall.refundOrder adminMall.auditRefund adminMall.queryOrderLogistics', 'adminMall.listOrders')
depend('adminMall.saveProduct adminMall.toggleProductStatus adminMall.saveCategory adminMall.deleteCategory', 'adminMall.listProducts adminMall.listCategories')
depend('adminMall.saveShopConfig', 'adminMall.getShopConfig adminMall.listProducts')
depend('questionnaire.create', 'questionnaire.listAdmin')
depend('questionnaire.update questionnaire.publish questionnaire.close questionnaire.delete questionnaire.clone questionnaire.responses questionnaire.detailAdmin', 'questionnaire.listAdmin')
depend('questionnaire.update questionnaire.responses questionnaire.analyzeAI questionnaire.getAiReport', 'questionnaire.listAdmin questionnaire.detailAdmin')
depend('questionnaire.retryReward questionnaire.retryAllRewards', 'questionnaire.listAdmin questionnaire.detailAdmin questionnaire.responses')
depend('questionnaire.analyzeAI', 'questionnaire.listAdmin questionnaire.detailAdmin questionnaire.getAiReport')
depend('admin.listSubscriptionDeliveries', 'admin.getSystemSettings')
depend('admin.listSystemNotifications', 'admin.listAdminNotifications')
depend('admin.listServiceCheckinRules', 'admin.listServicePrices')
depend('playgroundAppearance.detailAdmin', 'playgroundAppearance.listAdmin')
depend('playgroundAppearance.prepareUpload playgroundAppearance.publish playgroundAppearance.reject playgroundAppearance.disableAppearance playgroundAppearance.enableAppearance', 'playgroundAppearance.listAdmin playgroundAppearance.detailAdmin')
depend('incident.getIncidentDetail', 'incident.listIncidents')
depend('incident.updateIncidentStatus incident.proposeResolution incident.linkRefund incident.freezeStaffEarning incident.appendIncidentComment incident.closeIncident', 'incident.listIncidents incident.getIncidentDetail')
depend('adminMall.getOrderDetail', 'adminMall.listOrders')
depend('admin.listOperationActors', 'admin.listOperationLogs')
requires['admin.grantUserAssetCash'] = []
// Separate title/vaccine pages do not require the coupon page.
const apiOnly = new Set(['order.checkOverdueOrders', 'staff.checkUpcomingReminders', 'admin.grantUserAssetCash', 'payment.createRefund', 'petBeauty.settleMonthlyRanking', 'petBeauty.disqualifyPetBeautyCandidate', 'petBeauty.reinstatePetBeautyCandidate', 'petBeauty.grantPetBeautyChampionPrize', 'petBeauty.syncBeautyPhotoFlags'])
const tree = groups.map(({ id, label, module, actions }) => ({ id, label, description: descriptions[id], children: actions.map(item => {
  const [action, name] = item.split(':')
  const key = `${module}.${action}`
  const kind = /^(list|get)/.test(action) ? 'read' : 'write'
  const risk = sensitive.has(key)
  return { id: key, label: name, kind, risk, apiOnly: apiOnly.has(key),
    description: details[key] || `${label}：${name}。${kind === 'read' ? '仅授予该项数据查看，不包含编辑、审核或删除。' : '仅授予该项操作，其他管理操作需单独选择。'}`,
    requires: (requires[key] || []).filter(value => value !== key) }
}) }))
const permissions = new Set(tree.flatMap(node => node.children.map(child => child.id)))
const ownerDefinitions = [
  ['migration', '配置导入、导出与备份', 'configMigration', 'export:导出配置 preview:预览导入差异 import:导入并写入配置 backup:读取导入前备份', '涉及跨环境全量配置与生产参数，只允许超级管理员操作。'],
  ['global', '全局设置与庄园规则', 'admin', 'saveSystemSettings:保存全局及支付设置 savePlaygroundSettings:保存庄园规则', '全局配置包含支付、转账、密钥及平台规则；读取未脱敏密钥同样仅限超级管理员。'],
  ['access', '管理员与用户组授权', 'admin', 'enableAdminPermissions:启用分组权限 listAdminGroups:查看用户组 saveAdminGroup:保存用户组 setAdminMembership:分配人员用户组 listAdminMembers:查看后台人员 getAdminMembership:查看人员分组 grantAdmin:授予管理员 revokeAdmin:撤销管理员 listAdmins:管理员列表', '可直接改变后台权限边界，不可通过普通用户组转授。'],
  ['maintenance', '数据库初始化与维护', 'initData', 'checkCollections:检查集合 seedDemoData:写入演示数据 setupDatabase:建立数据库 initAllCollections:初始化全部集合 buildNotificationIndexes:建立通知索引 setupNotificationIndexes:初始化通知索引', '初始化、演示数据及数据库结构维护；不属于普通业务人员操作。']
]
const ownerTree = ownerDefinitions.map(([id, label, module, actions, description]) => ({ id, label, description,
  children: actions.split(' ').map(item => { const [action, name] = item.split(':'); return { id: `${module}.${action}`, label: name } }) }))
const ownerActions = new Set(ownerTree.flatMap(node => node.children.map(child => child.id)))
module.exports = { tree, permissions, ownerActions, ownerTree }
