// Shared, deterministic state calculation; neither clients nor timers write per frame.
const clamp = (n) => Math.max(0, Math.min(100, n))
const NEEDS = [
  {key:'energy',label:'精力',low:'累了，回窝休息吧',decay:8,direction:'down'},
  {key:'satiety',label:'饱腹',low:'肚子饿了，喂食或去碗边吃饭吧',decay:12,direction:'down'},
  {key:'hydration',label:'水分',low:'口渴了，去喷泉喝水吧',decay:18,direction:'down'},
  {key:'pee',label:'嘘嘘',low:'憋不住了，快去草地嘘嘘吧',growth:22.22,direction:'up',threshold:20,relief:20},
  {key:'poop',label:'便便',low:'便意满满，快去庭院外便便吧',growth:11.11,direction:'up',threshold:40,relief:40}
]
const RECOVERY = {sleep:{key:'energy',rate:.16,seconds:900},eat:{key:'satiety',rate:.24,seconds:300},drink:{key:'hydration',rate:.3,seconds:420}}
function sampleNeeds(pet, stamp) {
  const saved=pet.needs||{},since=Number.isFinite(saved.at)?saved.at:stamp
  const seconds=Math.max(0,(stamp-since)/1000),care=pet.care
  const result={at:Math.max(stamp,since)}
  for(const spec of NEEDS) {
    if(spec.direction==='up') {
      const base=Number.isFinite(saved[spec.key])?clamp(saved[spec.key]):0
      result[spec.key]=clamp(base+seconds*(spec.growth||0)/3600)
    } else {
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
  }
  return result
}
function settleNeeds(pet,stamp) {pet.needs=sampleNeeds(pet,stamp);return pet.needs}
function relieveWaste(pet,type,amount,stamp) {
  const current=settleNeeds(pet,stamp)
  const deduction=amount||(type==='pee'?20:40)
  if(type==='pee') current.pee=clamp((current.pee||0)-deduction)
  else if(type==='poop') current.poop=clamp((current.poop||0)-deduction)
  pet.needs=current
  return current
}
function needsView(pet,stamp) {
  const values=sampleNeeds(pet,stamp)
  return NEEDS.map((s)=>{
    const val=Math.round(values[s.key])
    const isUp=s.direction==='up'
    const isLow=isUp?val>=80:val<=20
    return {key:s.key,label:s.label,value:val,low:isLow,message:s.low,direction:s.direction}
  })
}
module.exports={NEEDS,RECOVERY,sampleNeeds,settleNeeds,relieveWaste,needsView}
