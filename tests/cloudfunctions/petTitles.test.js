const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { createCollectionStore, loadCloudFunction } = require('./helpers')

function createTestDb(initial = {}) {
  return createCollectionStore(initial)
}

test('pet title admin: CRUD operations and validation', async () => {
  const db = createTestDb({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active', nickname: '管理员' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', memberLevel: 'level_gold', points: 100 }
    ],
    member_levels: [
      { _id: 'level_gold', name: '黄金会员', minPoints: 500, enabled: true },
      { _id: 'level_diamond', name: '钻石会员', minPoints: 2000, enabled: true }
    ],
    pet_titles: [],
    user_pet_titles: [],
    pet_title_grants: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')

  // 1. 创建宠物头衔
  const createRes = await adminFn.main({
    module: 'admin',
    action: 'savePetTitle',
    data: {
      name: '绝世萌喵',
      description: '给超高颜值的猫咪佩戴',
      icon: '🐱',
      nameColor: '#ff4d6d',
      nameEffect: 'pink_dream',
      badgeStyle: 'pink',
      duplicatePoints: 50,
      autoGrantLevelIds: ['level_gold'],
      enabled: true,
      sortOrder: 1
    }
  })

  assert.equal(createRes.ok, true)
  assert.equal(createRes.data.name, '绝世萌喵')
  assert.equal(createRes.data.nameEffect, 'pink_dream')
  assert.equal(createRes.data.badgeStyle, 'pink')
  assert.equal(createRes.data.duplicatePoints, 50)
  assert.deepEqual(createRes.data.autoGrantLevelIds, ['level_gold'])
  const titleId = createRes.data._id
  assert.ok(titleId)

  // 2. 验证同名校验
  const duplicateRes = await adminFn.main({
    module: 'admin',
    action: 'savePetTitle',
    data: {
      name: '绝世萌喵',
      badgeStyle: 'gold'
    }
  })
  assert.equal(duplicateRes.ok, false)
  assert.ok(duplicateRes.message.includes('已存在同名宠物头衔'))

  // 3. 列表查询
  const listRes = await adminFn.main({
    module: 'admin',
    action: 'listPetTitles',
    data: {}
  })
  assert.equal(listRes.ok, true)
  assert.equal(listRes.data.length, 1)
  assert.equal(listRes.data[0].name, '绝世萌喵')

  // 4. 编辑修改头衔
  const editRes = await adminFn.main({
    module: 'admin',
    action: 'savePetTitle',
    data: {
      _id: titleId,
      name: '绝世神喵',
      description: '全服唯一尊贵萌猫',
      icon: '👑',
      nameColor: '#d99200',
      nameEffect: 'gold_shine',
      badgeStyle: 'gold',
      duplicatePoints: 80,
      autoGrantLevelIds: ['level_gold', 'level_diamond']
    }
  })
  assert.equal(editRes.ok, true)
  assert.equal(editRes.data.name, '绝世神喵')
  assert.equal(editRes.data.icon, '👑')
  assert.equal(editRes.data.nameEffect, 'gold_shine')
  assert.equal(editRes.data.duplicatePoints, 80)

  // 5. 软删除头衔
  const deleteRes = await adminFn.main({
    module: 'admin',
    action: 'deletePetTitle',
    data: { _id: titleId }
  })
  assert.equal(deleteRes.ok, true)
  const afterDelete = await adminFn.main({
    module: 'admin',
    action: 'listPetTitles',
    data: { includeDeleted: false }
  })
  assert.equal(afterDelete.ok, true)
  assert.equal(afterDelete.data.length, 0)
})

test('pet title: eligible member level auto-grant upon auth/me check', async () => {
  const db = createTestDb({
    users: [
      { _id: 'u_client', openid: 'openid_client', role: 'client', status: 'active', memberLevel: 'level_diamond', points: 300, totalPoints: 3000 }
    ],
    member_levels: [
      { _id: 'level_diamond', name: '钻石会员', minPoints: 2000, enabled: true }
    ],
    pet_titles: [
      {
        _id: 'title_vip_dog',
        name: '遛狗战神',
        icon: '⚡',
        nameColor: '#409eff',
        nameEffect: 'blue_diamond',
        badgeStyle: 'blue',
        duplicatePoints: 60,
        autoGrantLevelIds: ['level_diamond'],
        enabled: true,
        sortOrder: 1
      }
    ],
    user_pet_titles: [],
    pet_title_grants: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client')

  // 触发 me 动作
  const meRes = await clientFn.main({
    module: 'auth',
    action: 'me'
  })
  assert.equal(meRes.ok, true)

  // 验证用户自动获得了该头衔
  const titlesRes = await clientFn.main({
    module: 'pet',
    action: 'listMyTitles'
  })
  assert.equal(titlesRes.ok, true)
  assert.equal(titlesRes.data.length, 1)
  assert.equal(titlesRes.data[0].title.name, '遛狗战神')
  assert.equal(titlesRes.data[0].title.nameEffect, 'blue_diamond')
})

test('pet title: publish reward mail, claim in inbox, and compensate with points on duplicate', async () => {
  const db = createTestDb({
    users: [
      { _id: 'u_admin', openid: 'openid_admin', roles: ['admin'], status: 'active' },
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active', points: 100 }
    ],
    member_levels: [],
    pet_titles: [
      {
        _id: 'title_demolish',
        name: '拆家大帝',
        icon: '💥',
        nameColor: '#ff3300',
        nameEffect: 'fire_glow',
        badgeStyle: 'red',
        duplicatePoints: 50,
        autoGrantLevelIds: [],
        enabled: true
      }
    ],
    reward_mails: [],
    user_pet_titles: [],
    pet_title_grants: [],
    point_logs: []
  })

  const adminFn = loadCloudFunction('api', db, 'openid_admin')
  const clientFn = loadCloudFunction('api', db, 'openid_client')

  // 1. 管理员通过邮件发放头衔
  const mailRes = await adminFn.main({
    module: 'admin',
    action: 'publishPetTitleMail',
    data: {
      titleId: 'title_demolish',
      targetType: 'openid_list',
      openids: 'openid_client',
      title: '恭喜荣获【拆家大帝】宠物头衔',
      content: '爱宠拆家有功，特赐专属霸气头衔！'
    }
  })
  assert.equal(mailRes.ok, true)
  assert.equal(mailRes.data.issued, 1)

  // 2. 客户端在奖励邮箱查看并领取
  const listMailRes = await clientFn.main({
    module: 'rewardMail',
    action: 'listMyMails'
  })
  assert.equal(listMailRes.ok, true)
  assert.equal(listMailRes.data.length, 1)
  const mail = listMailRes.data[0]
  assert.equal(mail.reward.type, 'pet_title')
  assert.equal(mail.reward.titleSnapshot.name, '拆家大帝')

  const claimRes = await clientFn.main({
    module: 'rewardMail',
    action: 'claimReward',
    data: { id: mail._id }
  })
  assert.equal(claimRes.ok, true)
  assert.equal(claimRes.data.rewardClaimResult.petTitleOutcome, 'owned')

  // 3. 验证头衔已进入用户的可用头衔列表
  const myTitlesRes = await clientFn.main({
    module: 'pet',
    action: 'listMyTitles'
  })
  assert.equal(myTitlesRes.ok, true)
  assert.equal(myTitlesRes.data.length, 1)
  assert.equal(myTitlesRes.data[0].title.name, '拆家大帝')

  // 4. 再次发放相同头衔给该用户，测试重复补偿积分机制
  await adminFn.main({
    module: 'admin',
    action: 'publishPetTitleMail',
    data: {
      titleId: 'title_demolish',
      targetType: 'openid_list',
      openids: 'openid_client'
    }
  })
  const secondMailRes = await clientFn.main({
    module: 'rewardMail',
    action: 'listMyMails'
  })
  const secondMail = secondMailRes.data.find((m) => m._id !== mail._id)
  assert.ok(secondMail)

  const secondClaimRes = await clientFn.main({
    module: 'rewardMail',
    action: 'claimReward',
    data: { id: secondMail._id }
  })
  assert.equal(secondClaimRes.ok, true)
  assert.equal(secondClaimRes.data.rewardClaimResult.petTitleOutcome, 'compensated')
  assert.equal(secondClaimRes.data.rewardClaimResult.pointsDelta, 50)

  // 验证用户积分增加了 50
  const user = db.state.users.find((u) => u.openid === 'openid_client')
  assert.equal(user.points, 150)
  const pointLog = db.state.point_logs.find((l) => l.sourceType === 'pet_title_duplicate')
  assert.ok(pointLog)
  assert.equal(pointLog.delta, 50)
})

test('pet title: lottery draw can win pet title prize and creates reward mail', async () => {
  const db = createTestDb({
    users: [
      { _id: 'u_client', openid: 'openid_client', role: 'client', status: 'active', points: 100 }
    ],
    pet_titles: [
      {
        _id: 'title_lucky_star',
        name: '欧皇本汪',
        icon: '🌟',
        nameColor: '#d99200',
        nameEffect: 'gold_shine',
        badgeStyle: 'gold',
        duplicatePoints: 30,
        enabled: true
      }
    ],
    lottery_activities: [
      {
        _id: 'act_lottery_title',
        name: '幸运转盘有头衔',
        enabled: true,
        prizes: [
          {
            type: 'pet_title',
            name: '宠物头衔：欧皇本汪',
            titleId: 'title_lucky_star',
            probability: 100,
            stockLeft: 10
          }
        ]
      }
    ],
    lottery_records: [],
    reward_mails: [],
    user_pet_titles: [],
    pet_title_grants: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client')
  const drawRes = await clientFn.main({
    module: 'lottery',
    action: 'draw'
  })

  assert.equal(drawRes.ok, true)
  assert.equal(drawRes.data.prizeType, 'pet_title')
  assert.equal(drawRes.data.titleId, 'title_lucky_star')
  assert.ok(drawRes.data.rewardMailId)

  // 验证生成了奖励邮件
  const mail = db.state.reward_mails.find((m) => m._id === drawRes.data.rewardMailId)
  assert.ok(mail)
  assert.equal(mail.reward.type, 'pet_title')
  assert.equal(mail.reward.titleId, 'title_lucky_star')
})

test('pet title: equipping, switching, and un-equipping pet titles with single-title-per-pet constraint', async () => {
  const db = createTestDb({
    users: [
      { _id: 'u_client', openid: 'openid_client', roles: ['client'], status: 'active' }
    ],
    pet_titles: [
      {
        _id: 'title_1',
        name: '绝世萌喵',
        icon: '🐱',
        nameColor: '#ff4d6d',
        nameEffect: 'pink_dream',
        badgeStyle: 'pink',
        enabled: true
      },
      {
        _id: 'title_2',
        name: '无敌大白熊',
        icon: '🐻',
        nameColor: '#409eff',
        nameEffect: 'blue_diamond',
        badgeStyle: 'blue',
        enabled: true
      }
    ],
    user_pet_titles: [
      {
        _id: 'inv_1',
        openid: 'openid_client',
        userId: 'u_client',
        titleId: 'title_1',
        titleSnapshot: { _id: 'title_1', name: '绝世萌喵', icon: '🐱', nameEffect: 'pink_dream', badgeStyle: 'pink' },
        equippedPetId: ''
      },
      {
        _id: 'inv_2',
        openid: 'openid_client',
        userId: 'u_client',
        titleId: 'title_2',
        titleSnapshot: { _id: 'title_2', name: '无敌大白熊', icon: '🐻', nameEffect: 'blue_diamond', badgeStyle: 'blue' },
        equippedPetId: ''
      }
    ],
    pets: [
      {
        _id: 'pet_cat',
        openid: 'openid_client',
        name: '咪咪',
        species: 'cat',
        avatarFileId: 'cloud://test/cat.jpg',
        exclusiveId: 'PCAT01',
        equippedTitleInventoryId: ''
      },
      {
        _id: 'pet_dog',
        openid: 'openid_client',
        name: '旺财',
        species: 'dog',
        avatarFileId: 'cloud://test/dog.jpg',
        exclusiveId: 'PDOG01',
        equippedTitleInventoryId: ''
      }
    ],
    pet_title_grants: []
  })

  const clientFn = loadCloudFunction('api', db, 'openid_client')

  // 1. 咪咪佩戴头衔 1
  const equipRes1 = await clientFn.main({
    module: 'pet',
    action: 'equipTitle',
    data: { petId: 'pet_cat', inventoryId: 'inv_1' }
  })
  assert.equal(equipRes1.ok, true)
  assert.equal(equipRes1.data.equippedTitle.name, '绝世萌喵')

  // 检查数据库记录
  const petCat = db.state.pets.find((p) => p._id === 'pet_cat')
  assert.equal(petCat.equippedTitleInventoryId, 'inv_1')
  const inv1 = db.state.user_pet_titles.find((i) => i._id === 'inv_1')
  assert.equal(inv1.equippedPetId, 'pet_cat')

  // 验证 listPets 与 getPet 返回带出 decorated equippedTitle
  const listPetsRes = await clientFn.main({
    module: 'pet',
    action: 'listPets',
    data: {}
  })
  assert.equal(listPetsRes.ok, true)
  const catInList = listPetsRes.data.find((p) => p._id === 'pet_cat')
  assert.ok(catInList.equippedTitle)
  assert.equal(catInList.equippedTitle.name, '绝世萌喵')
  assert.equal(catInList.equippedTitle.nameEffect, 'pink_dream')

  // 2. 咪咪更换佩戴头衔 2（单宠物一次只能佩戴一个头衔）
  const equipRes2 = await clientFn.main({
    module: 'pet',
    action: 'equipTitle',
    data: { petId: 'pet_cat', inventoryId: 'inv_2' }
  })
  assert.equal(equipRes2.ok, true)
  assert.equal(equipRes2.data.equippedTitle.name, '无敌大白熊')
  // 原头衔 inv_1 的 equippedPetId 应被清空
  assert.equal(db.state.user_pet_titles.find((i) => i._id === 'inv_1').equippedPetId, '')
  assert.equal(db.state.user_pet_titles.find((i) => i._id === 'inv_2').equippedPetId, 'pet_cat')

  // 3. 旺财也佩戴头衔 2（一个头衔一次只能被一个宠物佩戴，移动到新宠物）
  const equipDogRes = await clientFn.main({
    module: 'pet',
    action: 'equipTitle',
    data: { petId: 'pet_dog', inventoryId: 'inv_2' }
  })
  assert.equal(equipDogRes.ok, true)
  assert.equal(db.state.pets.find((p) => p._id === 'pet_dog').equippedTitleInventoryId, 'inv_2')
  // 咪咪的头衔自动被卸下
  assert.equal(db.state.pets.find((p) => p._id === 'pet_cat').equippedTitleInventoryId, '')

  // 4. 旺财主动卸下头衔
  const unequipRes = await clientFn.main({
    module: 'pet',
    action: 'unequipTitle',
    data: { petId: 'pet_dog' }
  })
  assert.equal(unequipRes.ok, true)
  assert.equal(db.state.pets.find((p) => p._id === 'pet_dog').equippedTitleInventoryId, '')
  assert.equal(db.state.user_pet_titles.find((i) => i._id === 'inv_2').equippedPetId, '')

  // 5. 咪咪重新佩戴头衔 1 后，删除咪咪宠物，验证头衔自动释放
  await clientFn.main({
    module: 'pet',
    action: 'equipTitle',
    data: { petId: 'pet_cat', inventoryId: 'inv_1' }
  })
  assert.equal(db.state.user_pet_titles.find((i) => i._id === 'inv_1').equippedPetId, 'pet_cat')

  const deletePetRes = await clientFn.main({
    module: 'pet',
    action: 'deletePet',
    data: { id: 'pet_cat' }
  })
  assert.equal(deletePetRes.ok, true)
  assert.equal(db.state.user_pet_titles.find((i) => i._id === 'inv_1').equippedPetId, '')
})

test('pet title UI components: admin and client files consistency check', () => {
  // 1. 管理端头衔管理
  const adminTitlesWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/pet-titles/index.wxml'), 'utf8')
  const adminTitlesJs = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/pet-titles/index.js'), 'utf8')
  assert.ok(adminTitlesWxml.includes('name-effect-'), 'Admin titles WXML must support name-effect preview')
  assert.ok(adminTitlesWxml.includes('badgeStyle'), 'Admin titles WXML must support badgeStyle selection')
  assert.ok(adminTitlesJs.includes('publishPetTitleMail'), 'Admin titles JS must call publishPetTitleMail')

  // 2. 抽奖页面配置头衔
  const adminLotteryWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/lottery/index.wxml'), 'utf8')
  const adminLotteryJs = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/admin/lottery/index.js'), 'utf8')
  assert.ok(adminLotteryWxml.includes('pet_title'), 'Admin lottery WXML must support pet_title prize type')
  assert.ok(adminLotteryJs.includes('choosePrizePetTitle'), 'Admin lottery JS must implement choosePrizePetTitle')

  // 3. 客户端宠物编辑与列表佩戴头衔
  const clientEditWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/client/pets/edit/index.wxml'), 'utf8')
  const clientEditJs = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/client/pets/edit/index.js'), 'utf8')
  const clientListWxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/client/pets/list/index.wxml'), 'utf8')
  assert.ok(clientEditWxml.includes('pet-equipped-title'), 'Client pet edit WXML must render pet-equipped-title')
  assert.ok(clientEditWxml.includes('chooseTitle'), 'Client pet edit WXML must bind chooseTitle')
  assert.ok(clientEditJs.includes('equipTitle'), 'Client pet edit JS must call equipTitle')
  assert.ok(clientListWxml.includes('pet-title-tag'), 'Client pet list WXML must render pet-title-tag')

  // 4. 全局样式支持头衔徽章
  const appWxss = fs.readFileSync(path.join(__dirname, '../../miniprogram/app.wxss'), 'utf8')
  assert.ok(appWxss.includes('.pet-equipped-title.badge-gold'), 'app.wxss must define pet-equipped-title badge styles')
  assert.ok(appWxss.includes('.pet-title-tag.badge-gold'), 'app.wxss must define pet-title-tag badge styles')
})
