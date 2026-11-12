const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm')
const { createRequire }=require('node:module')
function fixture(name, api) {
  const entry=require.resolve('../../miniprogram/pages/admin/memorial/'+name), realRequire=createRequire(entry), calls=[], errors=[], routes=[]
  let page
  vm.runInNewContext(fs.readFileSync(entry,'utf8'),{Page:p=>{page=p},require:n=>n.endsWith('/cloud')?{callFunction:async(m,a,d)=>{calls.push({a,d});return api(a,d)},showError:e=>errors.push(e.message)}:realRequire(n),wx:{showToast(){},navigateTo:o=>routes.push(o.url)}})
  page.data.adminSuper=true; page.setData=patch=>{for(const[k,v]of Object.entries(patch)){const parts=k.split('.');let o=page.data;for(const key of parts.slice(0,-1))o=o[key];o[parts.at(-1)]=v}}
  return {page,calls,errors,routes}
}
test('garden form preserves request id, permissions and recovers busy state when save finishes hidden', async () => {
  let complete
  const f=fixture('gardens',async a=>a==='createGarden'?new Promise(r=>{complete=r}):{list:[],hasMore:false})
  await f.page.onShow();f.page.create();f.page.input({detail:{value:'星光园'}})
  const id=f.page.data.form.requestId,p=f.page.save();f.page.onHide();complete({});await p
  assert.equal(f.page.data.busy,false);await f.page.onShow();assert.equal(f.page.data.form,null)
  assert.equal(f.calls.find(c=>c.a==='createGarden').d.requestId,id)
  f.page.data.adminSuper=false;f.page.create();assert.equal(f.page.data.form,null)
})
test('user archive includes Beijing timestamps, navigation and refreshes interrupted detail on return', async () => {
  const waiting=[], row={_id:'app',ownerOpenid:'u',gardenId:'garden-ortho-v2',plotId:'garden-ortho-v2:3:3',createdAt:'2026-11-11T18:30:00Z',status:'approved'}
  const f=fixture('user-archive',async a=>a==='getMemorialAdmin'?new Promise(r=>waiting.push(r)):{list:[row],hasMore:false})
  f.page.onLoad({openid:'u'});await f.page.onShow()
  assert.match(f.page.data.rows[0].createdText,/2026-11-12 02:30/)
  const old=f.page.openContent({currentTarget:{dataset:{id:'app'}}});f.page.onHide();waiting[0]({...row,draft:{text:'old'}});await old
  assert.equal(f.page.data.content,null)
  await f.page.onShow();waiting[1]({...row,reviewStatus:'private',draft:{text:'new'}})
  await new Promise(r=>setImmediate(r));assert.equal(f.page.data.content.draft.text,'new');assert.equal(f.page.data.detailLoading,false)
  f.page.locate({currentTarget:{dataset:{id:'app'}}});assert.match(f.routes[0],/gardenId=garden-ortho-v2&plotId=garden-ortho-v2%3A3%3A3/)
  f.page.closeContent();assert.equal(f.page.data.content,null)
})
