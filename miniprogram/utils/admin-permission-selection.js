function indexTree(tree) {
  return new Map((tree || []).flatMap(node => node.children.map(child => [child.id, child])))
}
function includeDependencies(tree, selection) {
  const index = indexTree(tree), selected = new Set(selection.filter(id => index.has(id)))
  const visit = id => {
    for (const key of index.get(id)?.requires || []) {
      if (!index.has(key) || selected.has(key)) continue
      selected.add(key)
      visit(key)
    }
  }
  for (const id of [...selected]) visit(id)
  return [...selected]
}
function removeDependencies(tree, selection, removed) {
  const index = indexTree(tree), selected = new Set(selection), blocked = new Set(removed)
  let changed = true
  while (changed) {
    changed = false
    for (const id of selected) {
      if (blocked.has(id) || (index.get(id)?.requires || []).some(key => blocked.has(key))) {
        selected.delete(id); blocked.add(id); changed = true
      }
    }
  }
  return [...selected]
}
module.exports = { indexTree, includeDependencies, removeDependencies }
