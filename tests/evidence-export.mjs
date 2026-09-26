import fs from 'node:fs/promises';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=new URL('../extension/evidence/',import.meta.url);
const js=await fs.readFile(new URL('app.js',root),'utf8');
const context=vm.createContext({URL});
vm.runInContext(js.slice(js.indexOf('const safeURL='),js.indexOf('const domain=')),context);
vm.runInContext(js.slice(js.indexOf('function validateBoard('),js.indexOf("$('#import-file').onchange=")),context);
const seed={version:1,title:'Reader export check',subtitle:'A self-contained authored argument',sample:false,nodes:[{id:'claim',type:'claim',x:40,y:100,text:'A source supports this claim.'},{id:'evidence',type:'evidence',x:400,y:100,text:'An exact quotation',url:'https://example.org/policy',quote:'Applications are accepted.',displayedQuote:'Applications are accepted.',sourceCaptureId:'private-capture-id',sourcePageId:'private-page-id',originalImage:'data:image/png;base64,aGVsbG8=',image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',highlights:[],provenance:{view:'original',frameUrl:'https://example.org/policy',anchor:{exact:'Applications are accepted.',prefix:'Private preceding context.',suffix:''}},capturedAt:1}],links:[{id:'edge',from:'evidence',to:'claim',kind:'supports',label:'The relevant words'}],steps:['claim']};
context.fixture=seed;
assert.equal(vm.runInContext('validateBoard(fixture).nodes[1].sourceCaptureId',context),'private-capture-id');
for(const mutate of [b=>b.nodes[0].x=-40000,b=>b.nodes[0].y=NaN,b=>b.nodes[0].id='evidence',b=>b.nodes[1].url='javascript:alert(1)',b=>b.steps.push('absent'),b=>b.nodes[1].image='data:image/svg+xml,<svg/>',b=>b.links[0].to='evidence']){context.fixture=structuredClone(seed);mutate(context.fixture);assert.throws(()=>vm.runInContext('validateBoard(fixture)',context));}
let result;
const handler=js.split("$('#export-reader').onclick=")[1].split('\n')[0].replace(/;$/,'');
await vm.runInNewContext('('+handler+')()', {board:seed,structuredClone,fetch:async p=>({ok:true,text:()=>fs.readFile(new URL(p,root),'utf8')}),download:(_name,data)=>result=data,filename:()=> 'test',notify:message=>{if(!result)throw new Error(message)}});
assert.ok(result.includes('id="seed-board"'));
assert.ok(result.includes('$$=s=>'),'Bundling must preserve JavaScript dollar signs');
assert.ok(!result.includes('private-capture-id'));
assert.ok(!result.includes('private-page-id'));
assert.ok(!result.includes('Private preceding context.'));
assert.ok(!result.includes('aGVsbG8='),'Original uncropped screenshot must not be shared');
assert.ok(result.includes('--surface-inset:'),'Shared theme must be embedded');
const scripts=[...result.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length,2);assert.ok(scripts.every(m=>!m[1].includes('src=')),'No external runtime scripts');
// Groups nest as a tree: loops, second parents and empty groups are dropped on load.
context.fixture=structuredClone(seed);{const [a,b]=context.fixture.nodes.map(n=>n.id);context.fixture.groups=[{id:'g1',label:'Outer',members:[a],groups:['g2'],color:0},{id:'g2',label:'Inner',members:[b],groups:['g1'],color:1},{id:'g3',label:'Also claims Inner',members:[],groups:['g2'],color:2},{id:'g4',label:'Empty',members:['missing'],color:3}];}
{const gs=vm.runInContext('validateBoard(fixture).groups',context),kids=gs.flatMap(g=>g.groups);assert.deepEqual(gs.map(g=>g.id).sort(),['g1','g2']);assert.equal(new Set(kids).size,kids.length);assert.ok(!(gs.find(g=>g.id==='g1').groups.includes('g2')&&gs.find(g=>g.id==='g2').groups.includes('g1')));}
const exported=JSON.parse(scripts.find(m=>m[1].includes('application/json'))[2]);context.fixture=exported;
assert.equal(vm.runInContext('validateBoard(fixture).nodes.length',context),2);
await fs.writeFile('/tmp/things-evidence-reader.mjs',scripts.find(m=>m[1].includes('module'))[2]);
await fs.writeFile(new URL('evidence-reader.generated.html',import.meta.url),result);
console.log('PASS: board round trip; malformed data rejected; standalone reader bundles runtime and theme and omits original images/private capture metadata.');
