import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const code=await fs.readFile(new URL('../extension/evidence/app.js',import.meta.url),'utf8');
const context=vm.createContext({});
vm.runInContext(code.slice(code.indexOf('function spacedPositions('),code.indexOf("$('#layout-spacing').onclick=")),context);
const items=[
 {n:{id:'b',x:450,y:350},w:300,h:600},
 {n:{id:'a',x:30,y:100},w:240,h:170},
 {n:{id:'c',x:460,y:100},w:300,h:210},
 {n:{id:'d',x:30,y:250},w:300,h:250},
];
context.items=items;
const result=vm.runInContext('spacedPositions(items,140,80)',context);
assert.deepEqual(JSON.parse(JSON.stringify(result.map(({n,x,y})=>[n.id,x,y]))),[
 ['a',30,100],['d',30,350],['c',470,100],['b',470,390],
]);
assert.equal(items[0].n.y,350,'Calculating a layout must not mutate the board');
context.items=[{n:{id:'single',x:333,y:222},w:300,h:800}];
assert.equal(vm.runInContext('spacedPositions(items,0,0)[0].y',context),222);
console.log('PASS: column grouping, variable card sizes, edge gaps, ordering, non-mutation and single-card placement.');
