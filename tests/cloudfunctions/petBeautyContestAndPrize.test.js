const test = require('node:test')
const assert = require('node:assert/strict')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

test('最美宠物大赛: 默认大赛配置与前台获取 (getActivityHome / getContestConfig)', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'client_1', openid: 'client_1', roles: ['client'], status: 'active' }],
    pets: [{
      _id: 'pet_1',
      openid: 'client_1',
      name: '小白',
      avatarFileId: 'cloud://photo1',
      beautyPhotos: [{ id: 'p1', fileId: 'cloud://photo1' }],
      createdAt: '2026-10-01 10:00'
    }],
    platform_configs: []
  })

  const clientFn = loadCloudFunction('api', db, 'client_1')
  const homeRes = await clientFn.main({
    module: 'petBeauty',
    action: 'getActivityHome',
    data: { monthKey: '2026-10' }
  })

  assert.equal(homeRes.ok, true)
  assert.equal(homeRes.data.contestConfig.firstPrizeAmount, 500)
  assert.equal(homeRes.data.contestConfig.rewardAmount, 500)
  assert.equal(typeof homeRes.data.contestConfig.bannerTitle, 'string')
  assert.equal(typeof homeRes.data.contestConfig.rulesSummary, 'string')

  const configRes = await clientFn.main({
    module: 'petBeauty',
    action: 'getContestConfig',
    data: {}
  })
  assert.equal(configRes.ok, true)
  assert.equal(configRes.data.firstPrizeAmount, 500)
})

test('最美宠物大赛: 管理员设置第一名奖金、活动海报与规则校验', async () => {
  const db = createCollectionStore({
    users: [{ _id: 'admin_1', openid: 'admin_1', roles: ['admin'], status: 'active' }],
    platform_configs: []
  })

  const adminFn = loadCloudFunction('api', db, 'admin_1')

  // 1. 负数金额校验
  const failRes1 = await adminFn.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: {
      petBeautyContest: {
        firstPrizeAmount: -100
      }
    }
  })
  assert.equal(failRes1.ok, false)
  assert.match(failRes1.message, /第一名奖金必须是最多两位小数的非负金额/)

  // 2. 超出两位小数校验
  const failRes2 = await adminFn.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: {
      petBeautyContest: {
        firstPrizeAmount: 500.123
      }
    }
  })
  assert.equal(failRes2.ok, false)
  assert.match(failRes2.message, /第一名奖金必须是最多两位小数的非负金额/)

  // 3. 正常设置奖金与海报
  const okRes = await adminFn.main({
    module: 'admin',
    action: 'saveSystemSettings',
    data: {
      petBeautyContest: {
        firstPrizeAmount: 888,
        posterUrl: 'cloud://custom-poster.jpg',
        posterFileId: 'cloud://custom-poster.jpg',
        bannerTitle: '金秋爱宠选美狂欢季',
        bannerSubtitle: '晒出宝贝萌照，赢取888元冠军大奖',
        rulesSummary: '每日投1票 · 冠军现金直发',
        detailedRules: '特别赞助：本月冠军加赠宠物庄园专属金色雕像'
      }
    }
  })
  assert.equal(okRes.ok, true)
  assert.equal(okRes.data.petBeautyContest.firstPrizeAmount, 888)
  assert.equal(okRes.data.petBeautyContest.posterUrl, 'cloud://custom-poster.jpg')
  assert.equal(okRes.data.petBeautyContest.bannerTitle, '金秋爱宠选美狂欢季')

  // 4. 前台用户获取最新配置
  const clientFn = loadCloudFunction('api', db, 'client_any')
  const clientHome = await clientFn.main({
    module: 'petBeauty',
    action: 'getActivityHome',
    data: { monthKey: '2026-10' }
  })
  assert.equal(clientHome.ok, true)
  assert.equal(clientHome.data.contestConfig.firstPrizeAmount, 888)
  assert.equal(clientHome.data.contestConfig.posterUrl, 'cloud://custom-poster.jpg')
  assert.equal(clientHome.data.contestConfig.detailedRules, '特别赞助：本月冠军加赠宠物庄园专属金色雕像')
})

test('最美宠物大赛: 月底结算为第一名发放奖金记录并在历史榜单正确展示', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'admin_1', roles: ['admin'], status: 'active' },
      { _id: 'client_1', openid: 'client_1', roles: ['client'], status: 'active' },
      { _id: 'client_2', openid: 'client_2', roles: ['client'], status: 'active' }
    ],
    pets: [
      {
        _id: 'pet_champ',
        openid: 'client_1',
        name: '冠军猫咪',
        exclusiveId: 'CAT001',
        beautyPhotos: [{ id: 'p1', fileId: 'cloud://cat.jpg' }],
        createdAt: '2026-10-01 10:00'
      },
      {
        _id: 'pet_runner_up',
        openid: 'client_2',
        name: '亚军狗狗',
        exclusiveId: 'DOG002',
        beautyPhotos: [{ id: 'p2', fileId: 'cloud://dog.jpg' }],
        createdAt: '2026-10-01 11:00'
      }
    ],
    pet_beauty_votes: [
      { _id: 'v1', petId: 'pet_champ', monthKey: '2026-10', createdAt: '2026-10-02' },
      { _id: 'v2', petId: 'pet_champ', monthKey: '2026-10', createdAt: '2026-10-03' },
      { _id: 'v3', petId: 'pet_runner_up', monthKey: '2026-10', createdAt: '2026-10-02' }
    ],
    platform_configs: [
      {
        key: 'system_settings',
        value: {
          petBeautyContest: {
            firstPrizeAmount: 1200,
            rewardAmount: 1200,
            posterUrl: 'cloud://banner.png'
          }
        }
      }
    ],
    pet_beauty_month_rankings: [],
    pet_beauty_month_locks: []
  })

  const adminFn = loadCloudFunction('api', db, 'admin_1')

  // 执行月度结算
  const settleRes = await adminFn.main({
    module: 'petBeauty',
    action: 'settleMonthlyRanking',
    data: { monthKey: '2026-10' }
  })
  assert.equal(settleRes.ok, true)
  assert.equal(settleRes.data.firstPrizeAmount, 1200)

  // 验证锁榜记录
  const locks = db.state.pet_beauty_month_locks
  assert.equal(locks.length, 1)
  assert.equal(locks[0].firstPrizeAmount, 1200)

  // 验证排行榜记录中，第1名获得 1200 元奖金，第2名为 0 元
  const rankings = db.state.pet_beauty_month_rankings
  assert.equal(rankings.length, 2)
  const champ = rankings.find((r) => r.petId === 'pet_champ')
  const runnerUp = rankings.find((r) => r.petId === 'pet_runner_up')
  assert.equal(champ.rank, 1)
  assert.equal(champ.prizeAmount, 1200)
  assert.equal(champ.petSnapshot.prizeAmount, 1200)
  assert.equal(runnerUp.rank, 2)
  assert.equal(runnerUp.prizeAmount, 0)

  // 验证前台 listRanking 查询历史月份排行榜时正确带出奖金
  const clientFn = loadCloudFunction('api', db, 'client_1')
  const historyRankingRes = await clientFn.main({
    module: 'petBeauty',
    action: 'listRanking',
    data: { monthKey: '2026-11', historyMonthKey: '2026-10' }
  })
  assert.equal(historyRankingRes.ok, true)
  assert.equal(historyRankingRes.data.list.length, 2)
  assert.equal(historyRankingRes.data.list[0].rank, 1)
  assert.equal(historyRankingRes.data.list[0].prizeAmount, 1200)
  assert.equal(historyRankingRes.data.list[1].rank, 2)
  assert.equal(historyRankingRes.data.list[1].prizeAmount, 0)
})

test('最美宠物大赛: 邀请新用户获得额外当日投票数与多邀多得机制', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'u_inviter', openid: 'openid_inviter', inviteCode: 'INV888', retroCardCount: 0, roles: ['client'], status: 'active' },
      { _id: 'u_new_1', openid: 'openid_new_1', roles: ['client'], status: 'active' },
      { _id: 'u_new_2', openid: 'openid_new_2', roles: ['client'], status: 'active' }
    ],
    pets: [
      {
        _id: 'pet_cat',
        openid: 'openid_inviter',
        name: '咪咪',
        exclusiveId: 'CAT999',
        beautyPhotos: [{ id: 'p1', fileId: 'cloud://mimi.jpg' }],
        createdAt: '2026-10-01 10:00'
      },
      {
        _id: 'pet_dog',
        openid: 'openid_inviter',
        name: '旺财',
        exclusiveId: 'DOG888',
        beautyPhotos: [{ id: 'p2', fileId: 'cloud://wangcai.jpg' }],
        createdAt: '2026-10-01 10:00'
      }
    ],
    pet_beauty_votes: [],
    pet_beauty_bonus_votes: [],
    user_invites: [],
    retro_card_logs: [],
    platform_configs: []
  })

  const inviterFn = loadCloudFunction('api', db, 'openid_inviter')
  const user1Fn = loadCloudFunction('api', db, 'openid_new_1')
  const user2Fn = loadCloudFunction('api', db, 'openid_new_2')

  // 1. 初始状态：邀请人拥有基础 1 票，未投过
  const home1 = await inviterFn.main({ module: 'petBeauty', action: 'getActivityHome', data: {} })
  assert.equal(home1.ok, true)
  assert.equal(home1.data.hasVotedToday, false)
  assert.equal(home1.data.remainingVotesToday, 1)
  assert.equal(home1.data.todayBonusVotes, 0)
  assert.equal(home1.data.totalVotesToday, 1)

  // 2. 投出基础第 1 票
  const vote1 = await inviterFn.main({ module: 'petBeauty', action: 'vote', data: { petId: 'pet_cat' } })
  assert.equal(vote1.ok, true)
  assert.equal(vote1.data.hasVotedToday, true)
  assert.equal(vote1.data.remainingVotesToday, 0)
  assert.equal(vote1.data.voteCount, 1)

  // 3. 此时已无剩余票数，再次尝试投票应被拦截
  const voteFail1 = await inviterFn.main({ module: 'petBeauty', action: 'vote', data: { petId: 'pet_dog' } })
  assert.equal(voteFail1.ok, false)
  assert.match(voteFail1.message, /今天已经投过票了/)

  // 4. 新用户 1 首次登录并绑定邀请人的 inviteCode
  const loginRes1 = await user1Fn.main({ module: 'auth', action: 'login', data: { inviteCode: 'INV888' } })
  assert.equal(loginRes1.ok, true)

  // 验证邀请关系与额外票数发放
  assert.equal(db.state.user_invites.length, 1)
  assert.equal(db.state.pet_beauty_bonus_votes.length, 1)
  assert.equal(db.state.pet_beauty_bonus_votes[0].openid, 'openid_inviter')

  // 5. 邀请人再次获取主页信息：已获得额外票，今日总票数变为 2，剩余可投票数变为 1
  const home2 = await inviterFn.main({ module: 'petBeauty', action: 'getActivityHome', data: {} })
  assert.equal(home2.ok, true)
  assert.equal(home2.data.hasVotedToday, false)
  assert.equal(home2.data.remainingVotesToday, 1)
  assert.equal(home2.data.todayBonusVotes, 1)
  assert.equal(home2.data.totalVotesToday, 2)

  // 6. 邀请人投出额外赠送的第 2 票
  const vote2 = await inviterFn.main({ module: 'petBeauty', action: 'vote', data: { petId: 'pet_dog' } })
  assert.equal(vote2.ok, true)
  assert.equal(vote2.data.hasVotedToday, true)
  assert.equal(vote2.data.remainingVotesToday, 0)
  assert.equal(vote2.data.totalVotesToday, 2)
  assert.equal(vote2.data.voteCount, 1)

  // 7. 再次尝试投票被拦截
  const voteFail2 = await inviterFn.main({ module: 'petBeauty', action: 'vote', data: { petId: 'pet_cat' } })
  assert.equal(voteFail2.ok, false)
  assert.match(voteFail2.message, /今天已经投过票了/)

  // 8. 新用户 2 同样绑定邀请人，验证多邀多得
  const loginRes2 = await user2Fn.main({ module: 'auth', action: 'login', data: { inviteCode: 'INV888' } })
  assert.equal(loginRes2.ok, true)
  assert.equal(db.state.pet_beauty_bonus_votes.length, 2)

  const home3 = await inviterFn.main({ module: 'petBeauty', action: 'getActivityHome', data: {} })
  assert.equal(home3.data.hasVotedToday, false)
  assert.equal(home3.data.remainingVotesToday, 1)
  assert.equal(home3.data.todayBonusVotes, 2)
  assert.equal(home3.data.totalVotesToday, 3)

  // 9. 投出第 3 票
  const vote3 = await inviterFn.main({ module: 'petBeauty', action: 'vote', data: { petId: 'pet_cat' } })
  assert.equal(vote3.ok, true)
  assert.equal(vote3.data.hasVotedToday, true)
  assert.equal(vote3.data.remainingVotesToday, 0)
  assert.equal(vote3.data.voteCount, 2)
})

test('最美宠物大赛: 管理员取消参赛资格与恢复资格，全链路阻断违规宠物上榜与投票', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'admin_1', roles: ['admin'], status: 'active' },
      { _id: 'client_1', openid: 'client_1', roles: ['client'], status: 'active' }
    ],
    pets: [
      {
        _id: 'pet_cheater',
        openid: 'client_1',
        name: '刷票盗图猫',
        exclusiveId: 'CAT_CHEAT',
        beautyPhotos: [{ id: 'p1', fileId: 'cloud://fake.jpg' }],
        createdAt: '2026-10-01 10:00'
      },
      {
        _id: 'pet_honest',
        openid: 'client_1',
        name: '乖巧狗狗',
        exclusiveId: 'DOG_HONEST',
        beautyPhotos: [{ id: 'p2', fileId: 'cloud://dog.jpg' }],
        createdAt: '2026-10-01 10:00'
      }
    ],
    pet_beauty_votes: [],
    platform_configs: []
  })

  const adminFn = loadCloudFunction('api', db, 'admin_1')
  const clientFn = loadCloudFunction('api', db, 'client_1')

  // 1. 初始状态：两只宠物均出现在前台候选列表中
  const homeBefore = await clientFn.main({ module: 'petBeauty', action: 'getActivityHome', data: {} })
  assert.equal(homeBefore.ok, true)
  assert.equal(homeBefore.data.candidates.length, 2)

  // 2. 管理员对违规宠物执行取消参赛资格
  const disqRes = await adminFn.main({
    module: 'petBeauty',
    action: 'disqualifyPetBeautyCandidate',
    data: { petId: 'pet_cheater', reason: '经核实上传虚假网络图并刷票' }
  })
  assert.equal(disqRes.ok, true)
  assert.equal(disqRes.data.beautyContestDisqualified, true)

  // 验证宠物数据已被标记取消参赛资格
  const petCheater = db.state.pets.find((p) => p._id === 'pet_cheater')
  assert.equal(petCheater.beautyContestDisqualified, true)
  assert.equal(petCheater.disqualifiedReason, '经核实上传虚假网络图并刷票')

  // 3. 取消资格后，前台候选列表自动过滤掉该违规宠物
  const homeAfter = await clientFn.main({ module: 'petBeauty', action: 'getActivityHome', data: {} })
  assert.equal(homeAfter.ok, true)
  assert.equal(homeAfter.data.candidates.length, 1)
  assert.equal(homeAfter.data.candidates[0].petId, 'pet_honest')

  // 4. 用户若尝试直接为被取消资格的宠物投票，强阻断拦截
  const voteCheat = await clientFn.main({ module: 'petBeauty', action: 'vote', data: { petId: 'pet_cheater' } })
  assert.equal(voteCheat.ok, false)
  assert.match(voteCheat.message, /该宠物已被取消参赛资格/)

  // 5. 月度结算时，被取消资格的宠物绝不参与排名
  const settleRes = await adminFn.main({ module: 'petBeauty', action: 'settleMonthlyRanking', data: { monthKey: '2026-10' } })
  assert.equal(settleRes.ok, true)
  const rankings = db.state.pet_beauty_month_rankings || []
  assert.ok(!rankings.some((r) => r.petId === 'pet_cheater'), '被取消资格的宠物不得入选月榜')

  // 6. 管理员恢复参赛资格
  const reinstateRes = await adminFn.main({
    module: 'petBeauty',
    action: 'reinstatePetBeautyCandidate',
    data: { petId: 'pet_cheater' }
  })
  assert.equal(reinstateRes.ok, true)
  assert.equal(reinstateRes.data.beautyContestDisqualified, false)

  // 恢复后重回候选列表
  const homeRecovered = await clientFn.main({ module: 'petBeauty', action: 'getActivityHome', data: {} })
  assert.equal(homeRecovered.data.candidates.length, 2)
})

test('最美宠物大赛: 后台向第1名用户发放可提现零钱奖金与后台通用零钱加款', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'admin_1', openid: 'admin_1', roles: ['admin'], status: 'active' },
      { _id: 'u_winner', openid: 'openid_winner', roles: ['client'], status: 'active' }
    ],
    pets: [
      {
        _id: 'pet_champ',
        openid: 'openid_winner',
        name: '冠军猫咪',
        exclusiveId: 'CAT_CHAMP',
        beautyPhotos: [{ id: 'p1', fileId: 'cloud://cat.jpg' }],
        createdAt: '2026-10-01 10:00'
      }
    ],
    pet_beauty_votes: [
      { _id: 'v1', petId: 'pet_champ', monthKey: '2026-10', dateKey: '2026-10-02' }
    ],
    platform_configs: [
      {
        key: 'system_settings',
        value: {
          petBeautyContest: { firstPrizeAmount: 666 }
        }
      }
    ],
    pet_beauty_month_rankings: [],
    pet_beauty_month_locks: [],
    user_asset_earnings: []
  })

  const adminFn = loadCloudFunction('api', db, 'admin_1')
  const winnerFn = loadCloudFunction('api', db, 'openid_winner')

  // 1. 锁榜结算
  const settleRes = await adminFn.main({ module: 'petBeauty', action: 'settleMonthlyRanking', data: { monthKey: '2026-10' } })
  assert.equal(settleRes.ok, true)

  // 2. 初始状态：获奖用户的可提现零钱为 0
  const assetBefore = await winnerFn.main({ module: 'finance', action: 'getUserAssetSummary', data: {} })
  assert.equal(assetBefore.ok, true)
  assert.equal(assetBefore.data.availableAmount, 0)

  // 3. 管理员在后台一键给第 1 名发放现金大奖到可提现零钱
  const grantPrizeRes = await adminFn.main({
    module: 'petBeauty',
    action: 'grantPetBeautyChampionPrize',
    data: { monthKey: '2026-10', remark: '10月最美爱宠第一名冠军奖金发放' }
  })
  assert.equal(grantPrizeRes.ok, true)
  assert.equal(grantPrizeRes.data.prizeAmount, 666)
  assert.equal(grantPrizeRes.data.status, 'available')
  assert.equal(grantPrizeRes.data.targetOpenid, 'openid_winner')

  // 4. 验证获奖用户钱包：可提现零钱立增 666 元，且有详细收益流水
  const assetAfter = await winnerFn.main({ module: 'finance', action: 'getUserAssetSummary', data: {} })
  assert.equal(assetAfter.ok, true)
  assert.equal(assetAfter.data.availableAmount, 666)
  const prizeEarning = assetAfter.data.earnings.find((e) => e.sourceType === 'pet_beauty_champion_prize')
  assert.ok(prizeEarning)
  assert.equal(prizeEarning.amount, 666)
  assert.equal(prizeEarning.status, 'available')

  // 5. 幂等安全拦截：重复调用发放第 1 名奖金时，强阻断重复加钱
  const grantDuplicateRes = await adminFn.main({
    module: 'petBeauty',
    action: 'grantPetBeautyChampionPrize',
    data: { monthKey: '2026-10' }
  })
  assert.equal(grantDuplicateRes.ok, false)
  assert.match(grantDuplicateRes.message, /已发放至该用户可提现零钱，请勿重复发放/)
  assert.equal(db.state.user_asset_earnings.length, 1)

  // 6. 测试后台通用增加可提现零钱接口 admin.grantUserAssetCash
  const manualCashRes = await adminFn.main({
    module: 'admin',
    action: 'grantUserAssetCash',
    data: {
      openid: 'openid_winner',
      amount: 188.88,
      title: '线下活动特别奖励金',
      reason: '优质宠主回馈礼'
    }
  })
  assert.equal(manualCashRes.ok, true)
  assert.equal(manualCashRes.data.amount, 188.88)
  assert.equal(manualCashRes.data.status, 'available')

  // 用户可提现余额变为 666 + 188.88 = 854.88
  const assetFinal = await winnerFn.main({ module: 'finance', action: 'getUserAssetSummary', data: {} })
  assert.equal(assetFinal.data.availableAmount, 854.88)
})

test('最美宠物大赛: 邀请绑定立即赠票，现金佣金在好友建立宠物档案后入账', async () => {
  const db = createCollectionStore({
    users: [
      { _id: 'inviter_user', openid: 'inviter_openid', roles: ['client'], status: 'active', inviteCode: 'INVTEST01', retroCardCount: 0 },
      { _id: 'new_user', openid: 'new_user_openid', roles: ['client'], status: 'active', inviterOpenid: '' }
    ],
    pets: [{
      _id: 'pet_1',
      openid: 'inviter_openid',
      name: '花花',
      avatarFileId: 'cloud://photo1',
      beautyPhotos: [{ id: 'p1', fileId: 'cloud://photo1' }],
      createdAt: '2026-10-01 10:00'
    }],
    platform_configs: [{
      _id: 'cfg_system_settings',
      key: 'system_settings',
      value: { invitation: { enabled: true, rewardAmount: 5 } }
    }],
    user_invites: [],
    user_asset_earnings: [],
    retro_card_logs: [],
    pet_beauty_bonus_votes: []
  })

  // 1. 邀请人调用 getActivityHome，应返回自己的 inviteCode 和 userOpenid
  const inviterFn = loadCloudFunction('api', db, 'inviter_openid')
  const inviterHomeRes = await inviterFn.main({
    module: 'petBeauty',
    action: 'getActivityHome',
    data: { monthKey: '2026-10' }
  })
  assert.equal(inviterHomeRes.ok, true)
  assert.equal(inviterHomeRes.data.inviteCode, 'INVTEST01')
  assert.equal(inviterHomeRes.data.userOpenid, 'inviter_openid')

  // 2. 新用户通过分享链接打开最美大赛并调用 getActivityHome，携带邀请参数
  const newFn = loadCloudFunction('api', db, 'new_user_openid')
  const newHomeRes = await newFn.main({
    module: 'petBeauty',
    action: 'getActivityHome',
    data: {
      monthKey: '2026-10',
      inviteCode: 'INVTEST01',
      inviterOpenid: 'inviter_openid'
    }
  })
  assert.equal(newHomeRes.ok, true)

  // 3. 校验新用户已自动绑定邀请人
  const newUserDoc = db.state.users.find((u) => u.openid === 'new_user_openid')
  assert.equal(newUserDoc.inviterOpenid, 'inviter_openid')

  // 4. 校验邀请记录与邀请人各项奖励到账
  assert.equal(db.state.user_invites.length, 1)
  assert.equal(db.state.user_invites[0].inviterOpenid, 'inviter_openid')
  assert.equal(db.state.user_invites[0].invitedOpenid, 'new_user_openid')

  // 邀请人补签卡 +1
  const inviterDoc = db.state.users.find((u) => u.openid === 'inviter_openid')
  assert.equal(inviterDoc.retroCardCount, 1)

  // 邀请人宠美大赛当日投票数 +1
  assert.equal(db.state.pet_beauty_bonus_votes.length, 1)
  assert.equal(db.state.pet_beauty_bonus_votes[0].openid, 'inviter_openid')

  assert.equal(db.state.user_asset_earnings.length, 0)
  const petCreated = await newFn.main({ module: 'pet', action: 'createPet', data: { name: '小狗', avatarFileId: 'cloud://pet.jpg' } })
  assert.equal(petCreated.ok, true, petCreated.message)
  // 邀请人钱包佣金收益到账 (5元)
  assert.equal(db.state.user_asset_earnings.length, 1)
  assert.equal(db.state.user_asset_earnings[0].userOpenid, 'inviter_openid')
  assert.equal(db.state.user_asset_earnings[0].amount, 5)
  assert.equal(db.state.user_asset_earnings[0].status, 'available')
})
