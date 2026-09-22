// 萌宠专属趣味祝福语库（覆盖主流猫咪与狗狗品种）
const PET_BLESSINGS = [
  // 🐶 狗狗系列
  {
    category: 'dog',
    breed: '大金毛',
    name: '金毛送财运',
    text: '我是大金毛，你抽中了我今天会有滚滚财运和满满好心情哦～'
  },
  {
    category: 'dog',
    breed: '柯基',
    name: '柯基送福气',
    text: '我是小短腿柯基，迈着欢快的小短腿也要把满满福气送到你怀里！'
  },
  {
    category: 'dog',
    breed: '边境牧羊犬',
    name: '边牧神机妙算',
    text: '我是高智商边牧，经过我的严谨推算，你今天诸事顺遂、智商在线！'
  },
  {
    category: 'dog',
    breed: '柴犬',
    name: '柴犬招财笑',
    text: '我是微笑柴犬，奉上招牌治愈微笑，祝你今天万事皆柴（财）、乐开花！'
  },
  {
    category: 'dog',
    breed: '哈士奇',
    name: '二哈拆烦恼',
    text: '我是二哈，今天我不拆家，专门把你的所有烦恼和压力通通拆碎！'
  },
  {
    category: 'dog',
    breed: '萨摩耶',
    name: '萨摩耶甜拥抱',
    text: '我是微笑天使萨摩耶，送你一个毛茸茸的治愈拥抱，愿你今天甜度超标！'
  },
  {
    category: 'dog',
    breed: '法斗',
    name: '法斗贴心暖炉',
    text: '我是呆萌法斗，虽然我不爱跑动，但我愿意做你最贴心的小暖炉～'
  },
  {
    category: 'dog',
    breed: '博美',
    name: '博美团宠光环',
    text: '我是蓬松小博美，像朵元气棉花糖，祝你今天走到哪都是全场焦点！'
  },
  {
    category: 'dog',
    breed: '泰迪/贵宾',
    name: '泰迪欢喜连连',
    text: '我是活泼机灵小泰迪，蹦蹦跳跳为你摇尾巴，祝你天天开心无忧！'
  },
  {
    category: 'dog',
    breed: '德国牧羊犬',
    name: '德牧平安守护',
    text: '我是威武帅气德牧，今日由我全天候为你保驾护航，平安常在！'
  },
  {
    category: 'dog',
    breed: '拉布拉多',
    name: '拉布拉多幸福',
    text: '我是暖男拉布拉多，用最忠诚的心祝你付出皆有回报，收获稳稳的幸福！'
  },
  {
    category: 'dog',
    breed: '比熊',
    name: '比熊圆满顺意',
    text: '我是雪白软萌小比熊，圆溜溜的小脑袋一歪，祝你生活万事圆圆满满！'
  },
  {
    category: 'dog',
    breed: '雪纳瑞',
    name: '雪纳瑞稳操胜券',
    text: '我是帅气小老头雪纳瑞，抖抖小胡子，祝你今天沉着从容、胜券在握！'
  },
  {
    category: 'dog',
    breed: '八哥犬',
    name: '八哥心宽福厚',
    text: '我是乐天派八哥犬，多吃不胖心宽体胖，祝你天天胃口好心情更好！'
  },
  {
    category: 'dog',
    breed: '阿拉斯加',
    name: '阿拉斯加可靠',
    text: '我是敦厚大阿拉斯加，巨型棉花糖为你撑腰，遇到困难都能轻松越过！'
  },

  // 🐱 猫咪系列
  {
    category: 'cat',
    breed: '大橘猫',
    name: '大橘大吉大利',
    text: '我是十橘九胖的大橘，以吨位压倒一切困难，祝你今天大吉大利、兜里有钱！'
  },
  {
    category: 'cat',
    breed: '布偶猫',
    name: '布偶仙气好运',
    text: '我是神仙颜值布偶猫，眨眨清澈蓝眼睛，把满满仙气与贵人运悄悄渡给你～'
  },
  {
    category: 'cat',
    breed: '英国短毛猫',
    name: '英短福气圆圆',
    text: '我是圆脸英短，圆头圆脑好福相，祝你今天福气团团转、钱包鼓囊囊！'
  },
  {
    category: 'cat',
    breed: '美国短毛猫',
    name: '美短元气捕手',
    text: '我是元气美短，身手敏捷帮你抓捕幸运，今天出门好事一定会发生！'
  },
  {
    category: 'cat',
    breed: '暹罗猫',
    name: '暹罗越旺小煤球',
    text: '我是挖煤小暹罗，天冷脸越糊，福气越聚越旺，今天有我罩着你！'
  },
  {
    category: 'cat',
    breed: '三花猫',
    name: '三花锦鲤附体',
    text: '我是锦鲤附体的三花猫，自带吉祥三色，抽中我就等于接到了上上签大运！'
  },
  {
    category: 'cat',
    breed: '玄猫/黑猫',
    name: '玄猫辟邪纳祥',
    text: '我是玄猫小黑，古籍里记载能辟邪纳祥招贵人，祝你今天一路顺风顺水！'
  },
  {
    category: 'cat',
    breed: '加菲猫',
    name: '加菲惬意躺赢',
    text: '我是佛系加菲猫，舒服伸个大懒腰，祝你今天烦事有人扛，轻松愉快能躺赢！'
  },
  {
    category: 'cat',
    breed: '缅因猫',
    name: '缅因步步高升',
    text: '我是长毛温柔巨人缅因猫，霸气外表温柔心，祝你事业开挂步步高升！'
  },
  {
    category: 'cat',
    breed: '无毛猫',
    name: '无毛猫专属温暖',
    text: '我是斯芬克斯无毛猫，39度贴心恒温小暖炉，给你最纯粹专一的陪伴与关怀！'
  },
  {
    category: 'cat',
    breed: '奶牛猫',
    name: '奶牛猫元气爆棚',
    text: '我是猫中哈士奇奶牛猫，带你一起打破常规，放飞自我开怀大笑每一天！'
  },
  {
    category: 'cat',
    breed: '狸花猫',
    name: '狸花猫战力拉满',
    text: '我是中华神捕狸花猫，嗅觉灵敏战力无双，助你今天精准拿下所有的目标！'
  },
  {
    category: 'cat',
    breed: '金吉拉',
    name: '金吉拉优雅被宠',
    text: '我是华贵名媛金吉拉，举手投足尽显优雅，祝你今天处处优雅受人宠爱！'
  },
  {
    category: 'cat',
    breed: '德文卷毛猫',
    name: '德文精灵笑语',
    text: '我是精灵小卷毛德文猫，扑棱着大耳朵，为你收集全世界的欢声笑语！'
  },
  {
    category: 'cat',
    breed: '波斯猫',
    name: '波斯祥和安康',
    text: '我是雍容华贵波斯猫，步履轻盈气定神闲，愿你生活恬淡安康、诸事顺意！'
  }
]

function getFormattedBlessingList() {
  return PET_BLESSINGS.map((item, index) => {
    const icon = item.category === 'cat' ? '🐱' : '🐶'
    return {
      index,
      ...item,
      label: `${icon}【${item.breed}】${item.text.slice(0, 20)}...`
    }
  })
}

function getRandomBlessing() {
  const idx = Math.floor(Math.random() * PET_BLESSINGS.length)
  return PET_BLESSINGS[idx]
}

module.exports = {
  PET_BLESSINGS,
  getFormattedBlessingList,
  getRandomBlessing
}
