const { uploadImage } = require('../../utils/image-upload')
const {getCloudEnv}=require('../../utils/cloud')
const STATUS_TEXT={draft:'待补充照片',pending:'等待处理',processing:'制作中',completed:'已生效',rejected:'需重新申请',cancelled:'已取消'}
function choosePhotos(count=6) {
  return new Promise((resolve,reject)=>wx.chooseMedia({count,mediaType:['image'],sourceType:['album','camera'],sizeType:['compressed'],
    success:(result)=>{
      const files=result.tempFiles||[]
      if(files.some((file)=>file.size>5*1024*1024))return reject(new Error('每张照片不能超过5MB'))
      resolve(files.map((file)=>({path:file.tempFilePath,size:file.size})))
    },fail:reject}))
}
function uploadFile(filePath,cloudPath,onProgress) {
  return new Promise((resolve,reject)=>{
    const task=uploadImage({filePath,cloudPath,config:{env:getCloudEnv()},success:(result)=>{
      if(!result.fileID)return reject(new Error('文件上传失败，请重试'))
      resolve(result.fileID)
    },fail:reject})
    if(onProgress&&task&&task.onProgressUpdate)task.onProgressUpdate((event)=>onProgress(event.progress||0))
  })
}
module.exports={choosePhotos,uploadFile,STATUS_TEXT}
