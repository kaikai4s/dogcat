const crypto=require('crypto')
const {transaction}=require('./playground-transaction')
const {hash,readDocument}=require('./playground-world')
const {inspectAtlas}=require('./playground-appearance-png')
const REQUESTS='pet_playground_appearance_requests'
const BINDINGS='pet_playground_appearance_bindings'
const active=new Set(['draft','pending','processing'])
const random=()=>crypto.randomBytes(16).toString('hex')
const keyOf=(type,openid,petId)=>'target_'+hash(JSON.stringify([type,openid,type==='pet'?petId:'character']))
const pathOf=(fileID)=>{
  if(typeof fileID!=='string'||!/^cloud:\/\/[^/]+\//.test(fileID))return ''
  return fileID.slice(fileID.indexOf('/',8)+1)
}
module.exports=function createAppearance(context) {
  const {db,cloud}=context
  const now=()=>context.nowMs?context.nowMs():Date.now()
  const read=(database,collection,id)=>readDocument(database,collection,id,'读取形象定制',true)
  function requestId(data) {
    if(!/^custom_[a-f0-9]{32}$/.test(data.requestId||''))throw new Error('无效的定制申请')
    return data.requestId
  }
  function view(row) {
    return {_id:row._id,targetType:row.targetType,targetId:row.targetId,targetName:row.targetName,ownerName:row.ownerName,
      status:row.status,photos:row.photos||[],remark:row.remark||'',reason:row.reason||'',createdAt:row.createdAt,
      submittedAt:row.submittedAt||row.createdAt,
      updatedAt:row.updatedAt,appearance:row.appearance||null,
      appearanceDisabled:Boolean(row.appearanceDisabled || (row.appearance && row.appearance.disabled)),
      appearanceDisabledReason:row.appearanceDisabledReason || (row.appearance && row.appearance.disabledReason) || ''}
  }
  function getBeijingMonthStart(nowMs = now()) {
    const BEIJING_OFFSET_MS = 8 * 3600 * 1000
    const beijingDate = new Date(nowMs + BEIJING_OFFSET_MS)
    const year = beijingDate.getUTCFullYear()
    const month = beijingDate.getUTCMonth()
    return Date.UTC(year, month, 1) - BEIJING_OFFSET_MS
  }
  async function checkAppearanceEligibility(database, openid, nowMs = now()) {
    if (context.skipEligibilityCheck) {
      return {
        canApply: true,
        hasBaseQualification: true,
        clientCompletedCount: 99,
        clientEarnedChances: 33,
        clientRequiredPerChance: 3,
        clientRemainder: 0,
        clientNextChanceNeeded: 0,
        isStaff: true,
        staffCompletedCount: 99,
        staffEarnedChances: 33,
        staffRequiredPerChance: 3,
        staffRemainder: 0,
        staffNextChanceNeeded: 0,
        totalEarnedChances: 66,
        totalUsedChances: 0,
        availableChances: 66,
        monthQuota: 1,
        monthUsedCount: 0,
        monthRemaining: 1,
        unavailableReason: ''
      }
    }
    const users = (await database.collection('users').where({ openid }).limit(1).get()).data || []
    const user = users[0] || {}
    const isStaff = Array.isArray(user.roles) && user.roles.includes('staff')

    let clientCompletedCount = 0
    try {
      const cRes = await database.collection('orders').where({ clientOpenid: openid, status: 'completed' }).count()
      clientCompletedCount = Number(cRes.total || 0)
    } catch (_) {
      const cRes = await database.collection('orders').where({ clientOpenid: openid, status: 'completed' }).get()
      clientCompletedCount = (cRes.data || []).length
    }

    let staffCompletedCount = 0
    if (isStaff) {
      try {
        const sRes = await database.collection('orders').where({ staffOpenid: openid, status: 'completed' }).count()
        staffCompletedCount = Number(sRes.total || 0)
      } catch (_) {
        const sRes = await database.collection('orders').where({ staffOpenid: openid, status: 'completed' }).get()
        staffCompletedCount = (sRes.data || []).length
      }
    }

    // 机会规则：普通客户每完成3单获1次机会；宠托师每完成3次服务履约获1次机会
    const clientEarnedChances = Math.floor(clientCompletedCount / 3)
    const clientRemainder = clientCompletedCount % 3
    const clientNextChanceNeeded = clientRemainder === 0 ? 3 : 3 - clientRemainder

    const staffEarnedChances = isStaff ? Math.floor(staffCompletedCount / 3) : 0
    const staffRemainder = isStaff ? staffCompletedCount % 3 : 0
    const staffNextChanceNeeded = staffRemainder === 0 ? 3 : 3 - staffRemainder
    const totalEarnedChances = clientEarnedChances + staffEarnedChances

    // 统计历史消耗（状态为 pending / processing / completed 均计入消耗；draft 不消耗，rejected/cancelled 不占用消耗）
    let allRequests = []
    try {
      const qRes = await database.collection(REQUESTS).where({
        ownerOpenid: openid
      }).get()
      allRequests = qRes.data || []
    } catch (_) {
      allRequests = []
    }

    const consumedRequests = allRequests.filter(r => ['pending', 'processing', 'completed'].includes(r.status))
    const totalUsedChances = consumedRequests.length
    const availableChances = Math.max(0, totalEarnedChances - totalUsedChances)

    // 自然月频次上限：每个自然月最多可提交申请1次（月度熔断）
    const monthStartMs = getBeijingMonthStart(nowMs)
    const monthConsumedRequests = consumedRequests.filter(r => {
      const submitTime = r.submittedAt || r.createdAt
      const submitMs = typeof submitTime === 'number' ? submitTime : new Date(submitTime || 0).getTime()
      return submitMs >= monthStartMs
    })

    const monthQuota = 1
    const monthUsedCount = monthConsumedRequests.length
    const monthRemaining = Math.max(0, monthQuota - monthUsedCount)

    let canApply = false
    let unavailableReason = ''

    if (totalEarnedChances === 0) {
      if (isStaff) {
        unavailableReason = `未达到专属形象定制申请条件：普通客户每完成3笔服务订单可获1次机会（当前${clientRemainder}/3单，还差${clientNextChanceNeeded}单）；宠托师每完成3次服务履约可获1次机会（当前${staffRemainder}/3单，还差${staffNextChanceNeeded}单）。`
      } else {
        unavailableReason = `未达到专属形象定制申请条件：普通客户每完成3笔服务订单可获1次定制机会（当前进度${clientRemainder}/3单，还差${clientNextChanceNeeded}单）。`
      }
    } else if (availableChances === 0) {
      if (isStaff) {
        unavailableReason = `您累计获得的${totalEarnedChances}次形象定制机会已全部使用。普通客户每再完成3笔订单可增加1次机会（当前${clientRemainder}/3单，还差${clientNextChanceNeeded}单）；宠托师每再完成3笔服务履约可增加1次机会（当前${staffRemainder}/3单，还差${staffNextChanceNeeded}单）。`
      } else {
        unavailableReason = `您累计获得的${totalEarnedChances}次形象定制机会已全部使用。每再完成3笔服务订单可增加1次定制机会（当前进度${clientRemainder}/3单，还差${clientNextChanceNeeded}单）。`
      }
    } else if (monthRemaining === 0) {
      unavailableReason = `您当前还剩余${availableChances}次定制机会，但每个自然月限申请1次。您本月已提交过申请，剩余机会可在下月1日后继续使用。`
    } else {
      canApply = true
    }

    return {
      canApply,
      hasBaseQualification: totalEarnedChances > 0,
      clientCompletedCount,
      clientEarnedChances,
      clientRequiredPerChance: 3,
      clientRemainder,
      clientNextChanceNeeded,
      isStaff,
      staffCompletedCount,
      staffEarnedChances,
      staffRequiredPerChance: 3,
      staffRemainder,
      staffNextChanceNeeded,
      totalEarnedChances,
      totalUsedChances,
      availableChances,
      monthQuota,
      monthUsedCount,
      monthRemaining,
      unavailableReason
    }
  }
  async function target(database,openid,type,petId) {
    const users=(await database.collection('users').where({openid}).limit(1).get()).data||[]
    const user=users[0]
    if(!user||user.status!=='active')throw new Error('申请用户已失效')
    if(type==='character')return {user,entity:user,collection:'users',id:user._id,name:'我的角色'}
    if(type!=='pet'||typeof petId!=='string'||!petId||petId.length>128)throw new Error('请选择要定制的角色或宠物')
    const pet=await read(database,'pets',petId)
    if(!pet||pet.openid!==openid||pet.deletedAt||!['dog','cat'].includes(pet.species||'dog'))throw new Error('宠物不存在或不属于申请用户')
    return {user,entity:pet,collection:'pets',id:petId,name:pet.name||'宠物'}
  }
  async function options(openid) {
    const pets=(await db.collection('pets').where({openid}).orderBy('createdAt','desc').limit(100).get()).data||[]
    const eligibility=await checkAppearanceEligibility(db,openid,now())
    return {eligibility,pets:pets.filter((p)=>!p.deletedAt&&['cat','dog'].includes(p.species||'dog')).map((p)=>({id:p._id,name:p.name||'宠物',species:p.species||'dog'}))}
  }
  async function createDraft(openid,data) {
    const type=data.targetType,petId=type==='pet'?data.petId:''
    return transaction(db,async(tx)=>{
      const t=await target(tx,openid,type,petId),key=keyOf(type,openid,petId)
      const eligibility=await checkAppearanceEligibility(tx,openid,now())
      if(!eligibility.canApply) {
        throw new Error(eligibility.unavailableReason||'当前暂不符合专属形象定制申请条件')
      }
      const binding=await read(tx,BINDINGS,key)
      if(binding&&binding.activeRequestId) {
        const old=await read(tx,REQUESTS,binding.activeRequestId)
        if(old&&active.has(old.status)) {
          if(old.status!=='draft')throw new Error('这个对象已有待处理申请，请先查看申请进度')
          return {...view(old),photoPrefix:old.photoPrefix}
        }
      }
      const id='custom_'+random(),stamp=now(),photoPrefix=`playground-appearance/references/${hash(openid)}/${id}/`
      const row={ownerOpenid:openid,ownerName:t.user.nickname||'用户',targetType:type,targetId:type==='pet'?petId:'presence_'+hash(openid),
        targetName:t.name,targetKey:key,status:'draft',photos:[],photoPrefix,createdAt:stamp,updatedAt:stamp}
      await tx.collection(REQUESTS).doc(id).set({data:row})
      const {_id,...saved}=binding||{}
      await tx.collection(BINDINGS).doc(key).set({data:{...saved,kind:'target',ownerOpenid:openid,targetType:type,targetId:row.targetId,activeRequestId:id}})
      return {...view({...row,_id:id}),photoPrefix}
    })
  }
  async function submit(openid,data) {
    const id=requestId(data),row=await read(db,REQUESTS,id)
    if(!row||row.ownerOpenid!==openid)throw new Error('申请不存在或无权操作')
    if(row.status==='pending')return view(row)
    if(row.status!=='draft')throw new Error('申请状态已变化，请刷新')
    const photos=data.photos,remark=String(data.remark||'').trim().slice(0,500)
    if(!Array.isArray(photos)||photos.length<1||photos.length>6||new Set(photos).size!==photos.length||
      photos.some((file)=>!pathOf(file).startsWith(row.photoPrefix)||!/^[-a-zA-Z0-9_]+\.(jpg|jpeg|png)$/i.test(pathOf(file).slice(row.photoPrefix.length))))
      throw new Error('请上传1至6张本次申请的参考照片')
    if(context.checkTextSecurity)await context.checkTextSecurity(openid,remark,{label:'定制说明'})
    for(const fileID of photos) {
      const file=await cloud.downloadFile({fileID})
      const bytes=file.fileContent
      if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>5*1024*1024||
        !(bytes[0]===255&&bytes[1]===216 || bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))))throw new Error('照片需为不超过5MB的JPG或PNG图片')
      if(context.checkImageSecurity)await context.checkImageSecurity(openid,fileID,{label:'参考照片'})
    }
    return transaction(db,async(tx)=>{
      const current=await read(tx,REQUESTS,id)
      if(!current||current.ownerOpenid!==openid||current.status!=='draft')throw new Error('申请状态已变化，请刷新')
      const eligibility=await checkAppearanceEligibility(tx,openid,now())
      if(!eligibility.canApply) {
        throw new Error(eligibility.unavailableReason||'当前暂不符合专属形象定制申请条件')
      }
      await target(tx,openid,current.targetType,current.targetType==='pet'?current.targetId:'')
      const stamp=now()
      await tx.collection(REQUESTS).doc(id).update({data:{photos,remark,status:'pending',submittedAt:stamp,updatedAt:stamp}})
      return view({...current,photos,remark,status:'pending',submittedAt:stamp,updatedAt:stamp})
    })
  }
  async function list(openid,data,admin=false) {
    const limit=20,cursor=String(data.cursor||'')
    if(cursor.length>100)throw new Error('无效页码')
    const where=admin?{}:{ownerOpenid:openid}
    if(data.status) {
      if(!['draft','pending','processing','completed','rejected','cancelled'].includes(data.status))throw new Error('无效申请状态')
      where.status=data.status
    }
    if(cursor)where._id=db.command.gt(cursor)
    const rows=(await db.collection(REQUESTS).where(where).orderBy('_id','asc').limit(limit).get()).data||[]
    return {list:rows.map(view),nextCursor:rows.length===limit?rows.at(-1)._id:''}
  }
  async function detail(openid,data,admin=false) {
    const row=await read(db,REQUESTS,requestId(data))
    if(!row||!admin&&row.ownerOpenid!==openid)throw new Error('申请不存在或无权查看')
    const result=view(row)
    if(cloud.getTempFileURL&&result.photos.length) {
      const urls=await cloud.getTempFileURL({fileList:result.photos.map((fileID)=>({fileID,maxAge:600}))})
      result.photoUrls=(urls.fileList||[]).map((item)=>item.tempFileURL).filter(Boolean)
    }
    return result
  }
  async function close(openid,data,admin=false) {
    const id=requestId(data),reason=String(data.reason||'').trim().slice(0,500)
    if(admin&&!reason)throw new Error('请填写未通过原因')
    return transaction(db,async(tx)=>{
      const row=await read(tx,REQUESTS,id)
      if(!row||!admin&&row.ownerOpenid!==openid)throw new Error('申请不存在或无权操作')
      if(!active.has(row.status))throw new Error('申请已处理，请刷新')
      const status=admin?'rejected':'cancelled'
      await tx.collection(REQUESTS).doc(id).update({data:{status,reason:admin?reason:'',updatedAt:now(),reviewer:admin?openid:''}})
      const binding=await read(tx,BINDINGS,row.targetKey)
      if(binding&&binding.activeRequestId===id)await tx.collection(BINDINGS).doc(row.targetKey).update({data:{activeRequestId:''}})
      return {status}
    })
  }
  async function prepareUpload(admin,data) {
    const id=requestId(data),token=random()
    return transaction(db,async(tx)=>{
      const row=await read(tx,REQUESTS,id)
      if(!row||!['pending','processing'].includes(row.status))throw new Error('申请已处理或还未提交照片')
      await target(tx,row.ownerOpenid,row.targetType,row.targetType==='pet'?row.targetId:'')
      const uploadPrefix=`playground-appearance/staging/${id}/${hash(admin)}/${token}/`
      await tx.collection(REQUESTS).doc(id).update({data:{status:'processing',reviewer:admin,uploadToken:token,uploadPrefix,updatedAt:now()}})
      return {token,walkPath:uploadPrefix+'walk.png',runPath:uploadPrefix+'run.png',targetName:row.targetName}
    })
  }
  async function publish(admin,data) {
    const id=requestId(data),row=await read(db,REQUESTS,id)
    if(row&&row.status==='completed')return {appearance:row.appearance,completed:true}
    if(!row||row.status!=='processing'||row.reviewer!==admin||row.uploadToken!==data.token)throw new Error('上传批次已失效，请重新打开申请')
    const inputs={walk:data.walkFileID}
    if(data.runFileID)inputs.run=data.runFileID
    const atlases={},digests=[]
    for(const [action,fileID] of Object.entries(inputs)) {
      if(pathOf(fileID)!==row.uploadPrefix+action+'.png')throw new Error('只能使用这条申请本次上传的动作图集')
      const bytes=(await cloud.downloadFile({fileID})).fileContent
      const meta=inspectAtlas(bytes)
      const uploaded=await cloud.uploadFile({cloudPath:`packagePlayground/custom/${row.targetKey}/${id}/${action}-${meta.digest}.png`,fileContent:bytes})
      if(!uploaded.fileID)throw new Error('图集上传失败，请重试')
      const {digest,width,height,...style}=meta
      atlases[action]={...style,fileID:uploaded.fileID}
      digests.push(digest)
    }
    const result=await transaction(db,async(tx)=>{
      const current=await read(tx,REQUESTS,id)
      if(current&&current.status==='completed')return {appearance:current.appearance,rows:[]}
      if(!current||current.status!=='processing'||current.reviewer!==admin||current.uploadToken!==data.token)throw new Error('申请已变化或取消，本次素材未绑定')
      const t=await target(tx,current.ownerOpenid,current.targetType,current.targetType==='pet'?current.targetId:'')
      const binding=await read(tx,BINDINGS,current.targetKey)
      if(!binding||binding.activeRequestId!==id)throw new Error('绑定对象的申请已更新')
      for(const digest of new Set(digests)) {
        const lock=await read(tx,BINDINGS,'image_'+digest)
        if(lock&&lock.targetKey!==current.targetKey)throw new Error('这套形象已经专属绑定其他角色或宠物，不能重复分配')
      }
      const stamp=Math.max(now(),(t.entity.playgroundAppearance&&t.entity.playgroundAppearance.revision||0)+1),appearance={id:'look_'+id.slice(7),targetType:current.targetType,targetId:current.targetId,
        ownerId:'presence_'+hash(current.ownerOpenid),revision:stamp,...atlases}
      for(const digest of new Set(digests))await tx.collection(BINDINGS).doc('image_'+digest).set({data:{kind:'image',targetKey:current.targetKey,appearanceId:appearance.id,createdAt:stamp}})
      // Replace optional nested objects explicitly: legacy values can be null,
      // and a new walking-only appearance must not retain the previous run atlas.
      await tx.collection(BINDINGS).doc(current.targetKey).update({data:{appearance:db.command.set(appearance),activeRequestId:''}})
      await tx.collection(t.collection).doc(t.id).update({data:{playgroundAppearance:db.command.set(appearance)}})
      await tx.collection(REQUESTS).doc(id).update({data:{status:'completed',appearance:db.command.set(appearance),updatedAt:stamp}})
      const rows=[]
      const sourceId=(current.targetType==='pet'?'resident_':'presence_')+hash(current.ownerOpenid)
      const source=await read(tx,'pet_playground_plots',sourceId)
      if(source) {
        const {_id,...saved}=source
        if(current.targetType==='pet') {
          saved.pets=(saved.pets||[]).map((pet)=>pet.id===current.targetId?{...pet,appearance}:pet)
          saved.revision=Math.max(stamp,(saved.revision||0)+1)
        } else {saved.appearance=appearance;saved.sessionStarted=Math.max(stamp,(saved.sessionStarted||0)+1)}
        await tx.collection('pet_playground_plots').doc(sourceId).set({data:saved})
        rows.push({...saved,_id:sourceId})
      }
      return {appearance,rows}
    })
    let syncPending=false
    try {await require('./playground-shared')(context).publishRecords(result.rows)}
    catch(error) {syncPending=true;console.warn('[appearance] scene projection will recover on snapshot',error.message)}
    return {appearance:result.appearance,completed:true,syncPending}
  }
  async function disableAppearance(admin, data) {
    const id = data.requestId || data.id
    const reason = String(data.reason || '管理员作废专属形象').trim()
    return transaction(db, async (tx) => {
      let current = null
      let targetType = data.targetType
      let targetId = data.targetId

      if (id) {
        current = await read(tx, REQUESTS, id)
        if (current) {
          targetType = current.targetType
          targetId = current.targetType === 'pet' ? current.targetId : ''
        }
      }

      if (!targetType) throw new Error('缺少形象定制对象')
      const t = await target(tx, (current && current.ownerOpenid) || data.ownerOpenid, targetType, targetId)
      const appearance = t.entity.playgroundAppearance
      if (!appearance || !appearance.id) throw new Error('该对象尚未绑定生效专属形象')

      const stamp = now()
      const updatedAppearance = {
        ...appearance,
        disabled: true,
        disabledReason: reason,
        disabledAt: stamp,
        disabledBy: admin,
        revision: (appearance.revision || 0) + 1
      }

      await tx.collection(t.collection).doc(t.id).update({
        data: { playgroundAppearance: db.command.set(updatedAppearance) }
      })

      const key = keyOf(targetType, t.user.openid, targetType === 'pet' ? t.id : '')
      const binding = await read(tx, BINDINGS, key)
      if (binding) {
        await tx.collection(BINDINGS).doc(key).update({
          data: { appearance: db.command.set(updatedAppearance) }
        }).catch(() => {})
      }

      if (current) {
        await tx.collection(REQUESTS).doc(current._id).update({
          data: {
            appearance: db.command.set(updatedAppearance),
            appearanceDisabled: true,
            appearanceDisabledReason: reason,
            updatedAt: stamp
          }
        })
      }

      const rows = []
      const sourceId = (targetType === 'pet' ? 'resident_' : 'presence_') + hash(t.user.openid)
      const source = await read(tx, 'pet_playground_plots', sourceId)
      if (source) {
        const { _id, ...saved } = source
        if (targetType === 'pet') {
          saved.pets = (saved.pets || []).map((pet) => pet.id === t.id ? { ...pet, appearance: updatedAppearance } : pet)
          saved.revision = Math.max(stamp, (saved.revision || 0) + 1)
        } else {
          saved.appearance = updatedAppearance
          saved.sessionStarted = Math.max(stamp, (saved.sessionStarted || 0) + 1)
        }
        await tx.collection('pet_playground_plots').doc(sourceId).set({ data: saved })
        rows.push({ ...saved, _id: sourceId })
      }

      try {
        await require('./playground-shared')(context).publishRecords(rows)
      } catch (err) {
        console.warn('[disableAppearance] scene sync failed:', err.message)
      }

      await tx.collection('admin_operation_logs').doc(`disable_look_${stamp}_${random().slice(0, 8)}`).set({
        data: {
          adminOpenid: admin,
          action: 'disablePlaygroundAppearance',
          targetType,
          targetId: t.id,
          reason,
          createdAt: stamp
        }
      }).catch(() => {})

      return { success: true, disabled: true, reason, targetId: t.id }
    })
  }

  async function enableAppearance(admin, data) {
    const id = data.requestId || data.id
    return transaction(db, async (tx) => {
      let current = null
      let targetType = data.targetType
      let targetId = data.targetId

      if (id) {
        current = await read(tx, REQUESTS, id)
        if (current) {
          targetType = current.targetType
          targetId = current.targetType === 'pet' ? current.targetId : ''
        }
      }

      if (!targetType) throw new Error('缺少形象定制对象')
      const t = await target(tx, (current && current.ownerOpenid) || data.ownerOpenid, targetType, targetId)
      const appearance = t.entity.playgroundAppearance
      if (!appearance || !appearance.id) throw new Error('该对象尚未绑定生效专属形象')

      const stamp = now()
      const { disabled: _dis, disabledReason: _rea, disabledAt: _at, disabledBy: _by, ...rest } = appearance
      const updatedAppearance = {
        ...rest,
        disabled: false,
        disabledReason: '',
        enabledAt: stamp,
        enabledBy: admin,
        revision: (appearance.revision || 0) + 1
      }

      await tx.collection(t.collection).doc(t.id).update({
        data: { playgroundAppearance: db.command.set(updatedAppearance) }
      })

      const key = keyOf(targetType, t.user.openid, targetType === 'pet' ? t.id : '')
      const binding = await read(tx, BINDINGS, key)
      if (binding) {
        await tx.collection(BINDINGS).doc(key).update({
          data: { appearance: db.command.set(updatedAppearance) }
        }).catch(() => {})
      }

      if (current) {
        await tx.collection(REQUESTS).doc(current._id).update({
          data: {
            appearance: db.command.set(updatedAppearance),
            appearanceDisabled: false,
            appearanceDisabledReason: '',
            updatedAt: stamp
          }
        })
      }

      const rows = []
      const sourceId = (targetType === 'pet' ? 'resident_' : 'presence_') + hash(t.user.openid)
      const source = await read(tx, 'pet_playground_plots', sourceId)
      if (source) {
        const { _id, ...saved } = source
        if (targetType === 'pet') {
          saved.pets = (saved.pets || []).map((pet) => pet.id === t.id ? { ...pet, appearance: updatedAppearance } : pet)
          saved.revision = Math.max(stamp, (saved.revision || 0) + 1)
        } else {
          saved.appearance = updatedAppearance
          saved.sessionStarted = Math.max(stamp, (saved.sessionStarted || 0) + 1)
        }
        await tx.collection('pet_playground_plots').doc(sourceId).set({ data: saved })
        rows.push({ ...saved, _id: sourceId })
      }

      try {
        await require('./playground-shared')(context).publishRecords(rows)
      } catch (err) {
        console.warn('[enableAppearance] scene sync failed:', err.message)
      }

      await tx.collection('admin_operation_logs').doc(`enable_look_${stamp}_${random().slice(0, 8)}`).set({
        data: {
          adminOpenid: admin,
          action: 'enablePlaygroundAppearance',
          targetType,
          targetId: t.id,
          createdAt: stamp
        }
      }).catch(() => {})

      return { success: true, disabled: false, targetId: t.id }
    })
  }

  return {options,createDraft,submit,list,detail,close,prepareUpload,publish,disableAppearance,enableAppearance}
}
module.exports.REQUESTS=REQUESTS
module.exports.BINDINGS=BINDINGS
