// Shared, deterministic state calculation; neither clients nor timers write per frame.
const clamp = (n) => Math.max(0, Math.min(100, n))
const NEEDS = [
  {key:'energy',label:'精力',low:'累了，回窝休息吧',decay:8},
  {key:'satiety',label:'饱腹',low:'肚子饿了，喂食或去碗边吃饭吧',decay:12},
  {key:'hydration',label:'水分',low:'口渴了，去喷泉喝水吧',decay:18}
]
const RECOVERY = {sleep:{key:'energy',rate:.16,seconds:900},eat:{key:'satiety',rate:.24,seconds:300},drink:{key:'hydration',rate:.3,seconds:420}}
function sampleNeeds(pet, stamp) {
  const saved=pet.needs||{},since=Number.isFinite(saved.at)?saved.at:stamp
  const seconds=Math.max(0,(stamp-since)/1000),care=pet.care
  const result={at:Math.max(stamp,since)}
  for(const spec of NEEDS) {
    const base=Number.isFinite(saved[spec.key])?clamp(saved[spec.key]):100
    const recovery=care&&RECOVERY[care.type]
    const recovering=recovery&&recovery.key===spec.key?
      Math.max(0,(Math.min(stamp,care.endsAt)-Math.max(since,care.startsAt))/1000):0
    // Clamp before recovery so a long absence before arrival cannot eat a future meal.
    const before=Math.min(seconds,care?Math.max(0,(care.startsAt-since)/1000):seconds)
    const after=seconds-before-recovering
    const recovered=clamp(clamp(base-before*spec.decay/3600)+recovering*(recovery?recovery.rate:0))
    result[spec.key]=clamp(recovered-Math.max(0,after)*spec.decay/3600)
  }
  return result
}
function settleNeeds(pet,stamp) {pet.needs=sampleNeeds(pet,stamp);return pet.needs}
function needsView(pet,stamp) {
  const values=sampleNeeds(pet,stamp)
  return NEEDS.map((s)=>({key:s.key,label:s.label,value:Math.round(values[s.key]),low:values[s.key]<=20,message:s.low}))
}
module.exports={NEEDS,RECOVERY,sampleNeeds,settleNeeds,needsView}
