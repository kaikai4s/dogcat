module.exports=function createHandler(context) {
  const service=require('../services/playground-farm-catalog')(context)
  return async(openid,action,data={})=>{
    await context.getUser(openid)
    await context.requireAdmin(openid)
    if(action==='list')return service.list()
    if(action==='prepareUpload')return service.prepareUpload(openid,data)
    if(action==='remove')return service.remove(openid,data)
    if(action==='save')return service.save(openid,data)
    throw new Error('未知农作物管理操作')
  }
}
