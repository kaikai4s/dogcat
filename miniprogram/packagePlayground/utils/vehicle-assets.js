// Shared blue sedan: uploaded transparent 24-frame atlas (4 columns x 6 rows).
const VEHICLE_ATLAS = {
  fileID:'cloud://cloud1-5gnhqn4t0554c1d9.636c-cloud1-5gnhqn4t0554c1d9-1310870236/packagePlayground/2d/baseImage/car/drive.png',
  columns:4, rows:6, frames:24, frameSize:256, anchor:230/256, size:13
}
// Upload cloud-upload/drive-nw-v2.png to the same cloud directory as drive.png.
// The supplied rear atlas faces NW; drawVehicle mirrors each NE frame once.
const VEHICLE_REAR_ATLAS = {
  ...VEHICLE_ATLAS,
  fileID:VEHICLE_ATLAS.fileID.replace(/drive\.png$/,'drive-nw-v2.png')
}
module.exports={VEHICLE_ATLAS,VEHICLE_REAR_ATLAS}
