module.exports=function createHandler(context) {
  const service=require('../services/playground-appearance')(context)
  const adminActions=new Set(['listAdmin','detailAdmin','prepareUpload','publish','reject'])
  return async(openid,action,data={})=>{
    await context.getUser(openid)
    if(adminActions.has(action))await context.requireAdmin(openid)
    if(action==='options')return service.options(openid)
    if(action==='createDraft')return service.createDraft(openid,data)
    if(action==='submit')return service.submit(openid,data)
    if(action==='listMine')return service.list(openid,data)
    if(action==='detail')return service.detail(openid,data)
    if(action==='cancel')return service.close(openid,data)
    if(action==='listAdmin')return service.list(openid,data,true)
    if(action==='detailAdmin')return service.detail(openid,data,true)
    if(action==='prepareUpload')return service.prepareUpload(openid,data)
    if(action==='publish')return service.publish(openid,data)
    if(action==='reject')return service.close(openid,data,true)
    throw new Error('未知形象定制操作')
  }
}
