const test=require('node:test')
const assert=require('node:assert/strict')
const {createCollectionStore}=require('./helpers')

test('CloudBase-style updates reject nested writes into null; command.set replaces the object atomically in and outside transactions',async()=>{
  const db=createCollectionStore({records:[{_id:'a',appearance:null,keep:'unchanged'}]},{cloudObjectUpdates:true})
  const update={appearance:{id:'new'}}
  await assert.rejects(()=>db.collection('records').where({_id:'a'}).update({data:update}),/Cannot create field 'id'.*appearance: null/)
  assert.equal(db.state.records[0].appearance,null)
  await assert.rejects(()=>db.runTransaction((tx)=>tx.collection('records').doc('a').update({data:update})),/Cannot create field 'id'/)
  await db.runTransaction((tx)=>tx.collection('records').doc('a').update({data:{appearance:db.command.set(update.appearance)}}))
  assert.deepEqual(db.state.records[0],{_id:'a',appearance:{id:'new'},keep:'unchanged'})
})

test('CloudBase-style updates merge plain objects while explicit set removes obsolete fields without replacing neighbors',async()=>{
  const db=createCollectionStore({records:[{_id:'a',items:{player:{appearance:{id:'old',run:'old-run'},deleted:true},neighbor:{position:{x:2,z:3}}}}]}, {cloudObjectUpdates:true})
  const doc=db.collection('records').doc('a'),neighbor=structuredClone(db.state.records[0].items.neighbor)
  await doc.update({data:{'items.player':{appearance:{id:'new'}}}})
  assert.deepEqual(db.state.records[0].items.player,{appearance:{id:'new',run:'old-run'},deleted:true})
  await doc.update({data:{'items.player':db.command.set({appearance:{id:'new'}})}})
  assert.deepEqual(db.state.records[0].items.player,{appearance:{id:'new'}})
  assert.deepEqual(db.state.records[0].items.neighbor,neighbor)
})
