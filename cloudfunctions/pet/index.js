const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const allowedFields = [
  'name', 'species', 'breed', 'weight', 'gender', 'birthday', 'isSterilized',
  'vaccineStatus', 'hasAggression', 'hasFoodGuarding', 'hasLeashPulling',
  'hasSeparationAnxiety', 'allergyNotes', 'feedingNotes', 'walkingNotes',
  'specialNotes', 'photoFileId'
]

function ok(data) { return { ok: true, data } }
function fail(message) { return { ok: false, message } }
function now() { return new Date() }

async function getUser(openid) {
  const res = await db.collection('users').where({ openid }).limit(1).get()
  const user = res.data[0]
  if (!user || user.status !== 'active') throw new Error('请先登录')
  return user
}

function pick(input) {
  const out = {}
  allowedFields.forEach((field) => {
    if (input[field] !== undefined) out[field] = input[field]
  })
  return out
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext()
    const action = event.action
    const data = event.data || {}
    const user = await getUser(OPENID)

    if (action === 'listPets') {
      const res = await db.collection('pets').where({ openid: OPENID }).orderBy('createdAt', 'desc').get()
      return ok(res.data)
    }

    if (action === 'getPet') {
      const res = await db.collection('pets').doc(data.id).get()
      if (res.data.openid !== OPENID) throw new Error('无权访问')
      return ok(res.data)
    }

    if (action === 'recognizePetBreed') {
      throw new Error('宠物 AI 识别已迁移到 api 云函数，请通过 module=pet/action=recognizePetBreed 调用')
    }

    if (action === 'createPet') {
      if (!data.name) throw new Error('宠物名称不能为空')
      if (!data.avatarFileId) throw new Error('请上传至少一张宠物照片')
      const time = now()
      const pet = {
        ...pick(data),
        species: data.species || 'dog',
        userId: user._id,
        openid: OPENID,
        createdAt: time,
        updatedAt: time
      }
      const created = await db.collection('pets').add({ data: pet })
      return ok({ _id: created._id, ...pet })
    }

    if (action === 'updatePet') {
      const existing = await db.collection('pets').doc(data.id).get()
      if (existing.data.openid !== OPENID) throw new Error('无权访问')
      if (!data.avatarFileId) throw new Error('请上传至少一张宠物照片')
      await db.collection('pets').doc(data.id).update({ data: { ...pick(data), updatedAt: now() } })
      return ok({ id: data.id })
    }

    if (action === 'deletePet') {
      const existing = await db.collection('pets').doc(data.id).get()
      if (existing.data.openid !== OPENID) throw new Error('无权访问')
      await db.collection('pets').doc(data.id).remove()
      return ok({ id: data.id })
    }

    return fail('未知操作')
  } catch (error) {
    return fail(error.message)
  }
}
