function createNavigation(bounds, obstacles, radius = 0.65, cell = 0.4) {
  const cols = Math.floor((bounds.maxX - bounds.minX) / cell) + 1
  const rows = Math.floor((bounds.maxZ - bounds.minZ) / cell) + 1
  const blocks = obstacles.map((o) => ({ minX:o.minX-radius, maxX:o.maxX+radius, minZ:o.minZ-radius, maxZ:o.maxZ+radius }))
  const point = (id) => ({ x:bounds.minX+(id%cols)*cell, z:bounds.minZ+Math.floor(id/cols)*cell })
  function walkable(p) {
    return Number.isFinite(p.x) && Number.isFinite(p.z) &&
      p.x >= bounds.minX+radius && p.x <= bounds.maxX-radius && p.z >= bounds.minZ+radius && p.z <= bounds.maxZ-radius &&
      !blocks.some((o) => p.x>=o.minX && p.x<=o.maxX && p.z>=o.minZ && p.z<=o.maxZ)
  }
  function clearSegment(a,b) {
    if (!walkable(a) || !walkable(b)) return false
    // Exact slab intersection avoids sampling hundreds of points per fence check.
    return !blocks.some((o) => {
      let lo=0,hi=1
      for (const [axis,min,max] of [['x','minX','maxX'],['z','minZ','maxZ']]) {
        const d=b[axis]-a[axis]
        if (Math.abs(d)<1e-12) { if(a[axis]<o[min] || a[axis]>o[max]) return false }
        else {
          const t1=(o[min]-a[axis])/d,t2=(o[max]-a[axis])/d
          lo=Math.max(lo,Math.min(t1,t2));hi=Math.min(hi,Math.max(t1,t2))
          if(lo>hi) return false
        }
      }
      return true
    })
  }
  function nearest(p) {
    const cx=Math.round((p.x-bounds.minX)/cell),cz=Math.round((p.z-bounds.minZ)/cell)
    let best=-1,distance=Infinity
    for(let ring=0;ring<Math.max(cols,rows);ring++) {
      for(let x=Math.max(0,cx-ring);x<=Math.min(cols-1,cx+ring);x++)
        for(let z=Math.max(0,cz-ring);z<=Math.min(rows-1,cz+ring);z++) {
          if(ring && Math.abs(x-cx)!==ring && Math.abs(z-cz)!==ring)continue
          const id=z*cols+x,q=point(id),d=Math.hypot(p.x-q.x,p.z-q.z)
          if(d<distance && clearSegment(p,q)) {best=id;distance=d}
        }
      if(best>=0 && (ring+.5)*cell>distance)return best
    }
    return best
  }
  function* search(start,end) {
    if(!walkable(start)||!walkable(end))return null
    if(clearSegment(start,end))return [{...end}]
    const first=nearest(start),last=nearest(end)
    if(first<0||last<0)return null
    const heap=[],cost=new Map([[first,0]]),parent=new Map(),closed=new Set()
    function push(node) {
      let i=heap.length;heap.push(node)
      while(i) {const p=(i-1)>>1;if(heap[p].score<=node.score)break;heap[i]=heap[p];i=p}
      heap[i]=node
    }
    function pop() {
      const top=heap[0],tail=heap.pop()
      if(heap.length) {
        let i=0
        while(i*2+1<heap.length) {
          let child=i*2+1
          if(child+1<heap.length && heap[child+1].score<heap[child].score)child++
          if(heap[child].score>=tail.score)break
          heap[i]=heap[child];i=child
        }
        heap[i]=tail
      }
      return top
    }
    push({id:first,score:0})
    let count=0
    while(heap.length) {
      let current=pop().id
      if(closed.has(current))continue
      if(current===last) {
        const route=[{...end}]
        while(current!==first) {route.push(point(current));current=parent.get(current)}
        route.push(point(first));route.reverse()
        const simple=[]
        let anchor=start
        for(let i=0;i<route.length;i++) {
          if(i+1<route.length && clearSegment(anchor,route[i+1]))continue
          simple.push(route[i]);anchor=route[i]
        }
        return simple
      }
      closed.add(current)
      const x=current%cols,z=Math.floor(current/cols),a=point(current)
      for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx=x+dx,nz=z+dz,id=nz*cols+nx
        if(nx<0||nx>=cols||nz<0||nz>=rows||closed.has(id))continue
        const b=point(id),next=cost.get(current)+cell
        if(next>=(cost.has(id)?cost.get(id):Infinity)||!clearSegment(a,b))continue
        cost.set(id,next);parent.set(id,current)
        push({id,score:next+Math.hypot(b.x-end.x,b.z-end.z)})
      }
      if(++count%128===0)yield
    }
    return null
  }
  function path(start,end) {
    const task=search(start,end)
    let result
    do {result=task.next()}while(!result.done)
    return result.value
  }
  async function pathAsync(start,end,current=()=>true) {
    const task=search(start,end)
    let result
    do {
      if(!current())return null
      result=task.next()
      if(!result.done)await new Promise((resolve)=>setTimeout(resolve,0))
    }while(!result.done)
    return result.value
  }
  return { walkable, clearSegment, path, pathAsync }
}
module.exports = { createNavigation }
