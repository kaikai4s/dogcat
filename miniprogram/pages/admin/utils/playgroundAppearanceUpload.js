const {getCloudEnv}=require('../../../utils/cloud')
const STATUS_TEXT={draft:'待补充照片',pending:'等待处理',processing:'制作中',completed:'已生效',rejected:'需重新申请',cancelled:'已取消'}
function chooseAtlas() {
  return new Promise((resolve,reject)=>wx.chooseMedia({count:1,mediaType:['image'],sourceType:['album'],sizeType:['original'],
    success:(result)=>{
      const file=(result.tempFiles||[])[0]
      if(!file||!file.tempFilePath||!Number.isFinite(file.size)||file.size<=0||file.size>8*1024*1024)return reject(new Error('请选择不超过8MB的PNG原图'))
      const path=file.tempFilePath
      wx.getImageInfo({src:path,success:(info)=>{
        if(String(info.type||'').toLowerCase()!=='png')return reject(new Error('请选择透明PNG原图，不支持JPG或截图；请将原始图集保存到相册后重试'))
        const size=info.width/4
        if(![128,256,512].includes(size)||info.height!==size*6)return reject(new Error('需上传4列6行24帧图集，每格128、256或512像素'))
        resolve({path,name:path.split(/[\\/]/).pop()||'24帧图集.png',width:info.width,height:info.height,frameSize:size})
      },fail:reject})
    },fail:reject}))
}
function uploadFile(filePath,cloudPath,onProgress) {
  return new Promise((resolve,reject)=>{
    const task=wx.cloud.uploadFile({filePath,cloudPath,config:{env:getCloudEnv()},success:(result)=>{
      if(!result.fileID)return reject(new Error('文件上传失败，请重试'))
      resolve(result.fileID)
    },fail:reject})
    if(onProgress&&task&&task.onProgressUpdate)task.onProgressUpdate((event)=>onProgress(event.progress||0))
  })
}
module.exports={chooseAtlas,uploadFile,STATUS_TEXT}
