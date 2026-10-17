const conflict = (error) => /TransactionConflict|DATABASE_TRANSACTION_CONFLICT|Transaction is conflict/i.test(String(error && (error.message || error.errMsg) || error))
async function transaction(db, callback, options = {}) {
  for (let attempt=0; ; attempt++) {
    try { return await db.runTransaction(callback) }
    catch(error) {
      if(!conflict(error)) throw error
      if(attempt>=4) throw Object.assign(new Error('操作人数较多，请稍后重试'),{code:'PLAYGROUND_BUSY'})
      const wait=options.wait || ((ms)=>new Promise((resolve)=>setTimeout(resolve,ms)))
      await wait(40*(2**attempt)+Math.floor(Math.random()*40))
    }
  }
}
module.exports={transaction,conflict}
