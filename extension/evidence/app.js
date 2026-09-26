const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>crypto.randomUUID();
const safeURL=s=>{try{const u=new URL(s);return ['https:','http:'].includes(u.protocol)?u.href:''}catch{return ''}};
const domain=s=>{try{return new URL(s).hostname.replace(/^www\./,'')}catch{return 'Source'}};
// Long passages (e.g. a whole paragraph) link by their first and last words,
// which survives small differences in the middle better than the full text.
const textFragment=q=>{q=q.trim().replace(/\s+/g,' ');const enc=t=>encodeURIComponent(t).replace(/-/g,'%2D');if(q.length<=160)return enc(q);const w=q.split(' ');return enc(w.slice(0,6).join(' '))+','+enc(w.slice(-6).join(' '))};
const deepLink=n=>{const u=safeURL(n.url);if(!u)return '';if(n.pdf)return u.split('#')[0]+(n.page?'#page='+n.page:'');return u.split('#')[0]+(n.quote?'#:~:text='+textFragment(n.quote):'')};
const readerMode=!!document.getElementById('seed-board');
// Read once, before anything rewrites the URL: this is how a reload or a
// reopened tab gets back to exactly where you were.
const initialParams=new URLSearchParams(location.search);let restored=false,inboxOpen=false;
const workspace = readerMode ? null : await import('./workspace.js');
let session = null;
if (workspace) {
  try { session = await workspace.openWorkspace(new URLSearchParams(location.search)); }
  catch (error) {
    document.body.replaceChildren();
    const message = document.createElement('p'); message.textContent = error.message;
    const back = document.createElement('a'); back.href = '../journey/journey.html'; back.textContent = 'Return to workspaces';
    document.body.append(message, back);
    throw error;
  }
}

let board=readerMode?validateBoard(JSON.parse(document.getElementById('seed-board').textContent)):validateBoard(session.record.content), multi=new Set(), selected=null, author=false, zoom=.85, allRoutes=false, tab='map', walking=false, step=0;
const route=()=>board.kind==='trade'?'A':board.profit==='above'?'B':'C';
const active=n=>!board.sample||!n.route||n.route===route();
// Evidence folds away under the card it backs up, so the board reads as the
// line of reasoning; open a card's sources (or all of them) to dig in.
// Unattached evidence stays visible so it isn't lost. Remembered per board.
const evidenceKey=()=>'evidence.shown.'+(session?.record?.id||'reader');
let evidenceView={all:false,open:new Set()};
try{const v=JSON.parse(localStorage.getItem(evidenceKey())||'null');if(v)evidenceView={all:!!v.all,open:new Set(v.open||[])}}catch{}
const saveEvidenceView=()=>{try{localStorage.setItem(evidenceKey(),JSON.stringify({all:evidenceView.all,open:[...evidenceView.open]}))}catch{}};
const neighbors=id=>board.links.filter(l=>l.from===id||l.to===id).map(l=>l.from===id?l.to:l.from).map(get).filter(Boolean);
const evidenceOf=id=>neighbors(id).filter(x=>x.type==='evidence');
function evidenceHidden(n){if(n.type!=='evidence'||evidenceView.all||selected===n.id||multi.has(n.id))return false;const owners=neighbors(n.id).filter(x=>x.type!=='evidence');return owners.length>0&&!owners.some(x=>evidenceView.open.has(x.id))}
function showEvidenceFor(id,open=true){open?evidenceView.open.add(id):evidenceView.open.delete(id);saveEvidenceView()}
const visibleNodes=()=>board.nodes.filter(n=>(allRoutes||active(n))&&!evidenceHidden(n)&&!collapsedOf(n.id));
const get=id=>board.nodes.find(n=>n.id===id);
// Captured wording that can't be linked to the original (a translated view,
// an old highlight, saved page text) still shows as the passage; its status
// is a small label, with the explanation on hover.
const VIEW_BADGE={translated:['Translated','Captured from a translated view of the page. The link opens the page, not the exact passage; paste the original wording in the editor to link to it.'],'legacy-unverified':['Unverified wording','The exact wording couldn’t be checked against the page. Verify it before relying on it.'],'saved-text':['Saved text','Picked from the text saved when you visited. The live page may have changed since.']};
const viewBadge=n=>{const b=VIEW_BADGE[n.provenance?.view];return b?`<span class="view-badge" title="${esc(b[1])}">${esc(b[0])}</span>`:''};
const passage=n=>n.quote?`<p class="excerpt"><mark>${esc(n.quote)}</mark></p>`:n.displayedQuote?`<p class="excerpt is-unverified"><mark>${esc(n.displayedQuote)}</mark></p>`:'';
const typeLabel=t=>({gap:'OPEN QUESTION',note:'THOUGHT'})[t]||String(t).toUpperCase();
// A conclusion that is itself a reason for something else is an interim
// conclusion; the one that feeds nothing answers the board's question.
// Cards backing a card: direct reasons, plus for a "so" the lines joined to
// its first card by "and"/"but" (in "A and B, so C", C rests on A and B).
function supportersOf(id){const out=new Set();for(const l of board.links){const r=linkRole(l);if(r.supported!==id||!get(r.supporter))continue;out.add(r.supporter);if(l.word==='so'){let b=l.from;for(let g=0;g<60;g++){const prev=board.links.find(k=>k.to===b&&(k.word==='and'||k.word==='but'));if(!prev||out.has(prev.from))break;out.add(prev.from);b=prev.from}}}return [...out]}
const objectionsTo=id=>board.links.filter(l=>linkRole(l).target===id).map(l=>l.to).filter(get);
const supportsSomething=id=>board.links.some(l=>linkRole(l).supporter===id&&get(linkRole(l).supported));
const isInterim=n=>n.type==='conclusion'&&supportsSomething(n.id);
const nodeLabel=n=>n.type==='conclusion'&&mainConclusion()?.id===n.id?'THE ANSWER':isInterim(n)?'INTERIM CONCLUSION':typeLabel(n.type);
// The answer to the board's question: the conclusion you picked, else the
// first conclusion that doesn't lead on to anything.
function mainConclusion(){const pick=get(board.answerId);if(pick?.type==='conclusion'&&active(pick))return pick;const all=board.nodes.filter(n=>n.type==='conclusion'&&active(n)),gs=board.groups||[],pool=gs.length?all.filter(n=>!gs.some(g=>g.members.includes(n.id))):all;return pool.find(n=>!isInterim(n))||pool[0]}const renderHooks=[];
const wording=n=>n.dynamic==='kind'?(board.kind==='trade'?'Self-employed with a trade licence':'Freelance work, no trade licence'):n.dynamic==='profit'?(board.profit==='above'?'Expected annual profit above €6,613.20':'Expected annual profit at or below €6,613.20'):n.text;
// The board is an open canvas: you can always pan half a screen past the
// outermost card in every direction, so any group of cards can be centred.
// origin is where canvas (0,0) sits inside the scrolled area.
let bounds={x:0,y:0,w:800,h:600},origin=null,vpSize={w:1000,h:700},zoomTarget=null,zoomFrame=0;
const ZOOM_MIN=.15,ZOOM_MAX=2,clampZoom=z=>Math.min(ZOOM_MAX,Math.max(ZOOM_MIN,z));
function measureBounds(){const cs=[...document.querySelectorAll('#canvas [data-node],#canvas .group,#canvas .group-card')];if(!cs.length){bounds={x:0,y:0,w:800,h:600};return}let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(const c of cs){x0=Math.min(x0,c.offsetLeft);y0=Math.min(y0,c.offsetTop);x1=Math.max(x1,c.offsetLeft+c.offsetWidth);y1=Math.max(y1,c.offsetTop+c.offsetHeight)}bounds={x:x0,y:y0,w:x1-x0,h:y1-y0}}
// Keeps the canvas point under `at` (viewport pixels; default the centre) in place.
function layoutCanvas(at){const vp=document.getElementById('viewport');if(vp.hidden||!vp.clientWidth)return;vpSize={w:vp.clientWidth,h:vp.clientHeight};
 const keep=at||{cx:vpSize.w/2,cy:vpSize.h/2},prev=origin&&{x:(vp.scrollLeft+keep.cx-origin.x)/origin.zoom,y:(vp.scrollTop+keep.cy-origin.y)/origin.zoom};
 const mx=vpSize.w/2,my=vpSize.h/2;origin={x:mx-bounds.x*zoom,y:my-bounds.y*zoom,zoom};
 const c=document.getElementById('canvas');c.style.left=origin.x+'px';c.style.top=origin.y+'px';c.style.transform=`scale(${zoom})`;c.style.setProperty('--gz',Math.max(1,.85/zoom));c.style.setProperty('--inv',1/zoom);const wasFar=c.classList.contains('far');c.classList.toggle('far',zoom<.5);
 // Far out, headlines keep a minimum size, so cards change height as you zoom.
 if((wasFar||zoom<.5)&&!layoutCanvas.inRender){renderGroups();renderEdges()}
 const sz=document.getElementById('sizer');sz.style.width=bounds.w*zoom+2*mx+'px';sz.style.height=bounds.h*zoom+2*my+'px';document.getElementById('zoom-label').textContent=Math.round(zoom*100)+'%';
 if(prev){vp.scrollLeft=origin.x+prev.x*zoom-keep.cx;vp.scrollTop=origin.y+prev.y*zoom-keep.cy}else{vp.scrollLeft=mx-40;vp.scrollTop=my-40}}
const viewAt=()=>{const vp=document.getElementById('viewport');return {x:(vp.scrollLeft-(origin?.x||0))/zoom,y:(vp.scrollTop-(origin?.y||0))/zoom}};
function scrollToCanvas(x,y,smooth){if(!origin)return;document.getElementById('viewport').scrollTo({left:origin.x+x*zoom,top:origin.y+y*zoom,behavior:smooth?'smooth':'auto'})}
// Glides toward the target zoom (⌘/Ctrl+scroll, trackpad pinch, the +/− buttons).
function zoomTo(z,at){zoomTarget=clampZoom(z);if(zoomFrame)return;const step=()=>{const d=zoomTarget-zoom;zoom=Math.abs(d)<.002?zoomTarget:zoom+d*.35;layoutCanvas(zoomAnchor);if(zoom!==zoomTarget)zoomFrame=requestAnimationFrame(step);else{zoomFrame=0;syncUrl()}};zoomAnchor=at;zoomFrame=requestAnimationFrame(step)}
let zoomAnchor;
const pos=n=>({x:n.x,y:n.y+(allRoutes&&n.route?(['A','B','C'].indexOf(n.route))*1050:0)});
// The walkthrough follows the level you're on: inside a group, just its steps
// (or, if none were ordered, its lines in outline order).
const sequence=()=>{const all=board.steps.map(get).filter(n=>n&&active(n)),g=typeof focusGroup!=='undefined'&&focusGroup&&groupById(focusGroup);if(!g)return all;const ids=new Set(allCards(g)),mine=all.filter(n=>ids.has(n.id));
 return mine.length?mine:[...ids].map(get).filter(n=>n&&active(n)&&!['note','evidence'].includes(n.type)).sort((a,b)=>(a.ord??1e9)-(b.ord??1e9)||a.y-b.y)};
function notify(text,action){const t=$('#toast');t.textContent=text;t.classList.toggle('has-action',!!action);if(action){const b=document.createElement('button');b.type='button';b.textContent=action.label;b.onclick=()=>{t.classList.remove('visible');action.run()};t.append(b)}t.classList.add('visible');clearTimeout(notify.timer);notify.timer=setTimeout(()=>t.classList.remove('visible'),action?6000:3200)}
function persist(){commitBoard();}
function figure(n){return n.image?`<div class="crop"><img src="${esc(n.image)}" alt="Screenshot evidence: ${esc(n.text)}">${(n.highlights||[]).map(h=>`<span class="highlight" style="left:${h.x*100}%;top:${h.y*100}%;width:${h.w*100}%;height:${h.h*100}%"></span>`).join('')}</div><div class="image-label">USER-SUPPLIED SCREENSHOT</div>`:''}
function card(n,inline=false){const p=pos(n);const title=wording(n),challenged=objectionsTo(n.id).length>0;const hasSource=supportersOf(n.id).some(id=>get(id)?.type==='evidence');return `<article tabindex="0" role="button" aria-label="${author&&!readerMode?'Select':'Inspect'} ${esc(n.type)}: ${esc(title)}" data-node="${esc(n.id)}" class="card ${n.type} ${author&&!readerMode?'is-editable':''} ${selected===n.id||multi.has(n.id)?'selected':''}" style="left:${p.x}px;top:${p.y}px">${author&&!readerMode?`<span class="drag-hint" title="Drag this card to move it. With the card focused, use arrow keys; Shift moves farther.">⠿ Drag to move</span>${inline?'':`<button class="connect-handle" data-connect-handle="${esc(n.id)}" title="Drag to the card that comes next when you read it aloud" aria-label="Connect ${esc(n.type)} to another card">→</button>`}<button class="edit-affordance card-edit" data-edit="${esc(n.id)}" aria-label="Edit ${esc(n.type)}: ${esc(title)}">✎ Edit</button><button class="card-delete" data-delete="${esc(n.id)}" title="Delete this card (Undo brings it back)" aria-label="Delete ${esc(n.type)}: ${esc(title)}"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg></button><button class="card-inspect" data-inspect-card="${esc(n.id)}" aria-label="Inspect connections for ${esc(title)}">Connections</button>`:''}${n.type==='evidence'?`<div class="source-head"><span class="domain">${esc(domain(n.url))}</span><span class="pill ${n.tier==='Primary'?'primary':''}">${esc(n.tier||'Unreviewed')}</span>${viewBadge(n)}</div>${figure(n)}<div class="source-body"><p class="source-title">${esc(title)}</p>${passage(n)}${n.note?`<p class="translation">${esc(n.note)}</p>`:''}</div><div class="source-footer">${deepLink(n)?`<a href="${esc(deepLink(n))}" target="_blank" rel="noopener noreferrer">${n.pdf?'Open PDF ↗':n.quote?'Open at passage ↗':'Open source ↗'}</a>`:'<span>No source URL</span>'}<span>${esc(n.checked||'Not checked')}</span></div>`:`<p class="eyebrow">${esc(nodeLabel(n))}${challenged?' · OBJECTION RAISED':''}</p>${n.type==='fact'?`<p>${esc(title)}</p>`:`<h3>${esc(title)}</h3>`}${(()=>{const k=evidenceOf(n.id).length,open=evidenceView.all||evidenceView.open.has(n.id),toggle=k?`<button class="evidence-toggle" data-evidence-toggle="${esc(n.id)}" aria-expanded="${open}">${open?'▾ Hide':'▸ Show'} ${k} source${k>1?'s':''}</button>`:'';return n.type==='claim'||k?`<div class="status">${challenged?'<span>↯ Objection raised</span>':''}${toggle||(n.type==='claim'?(hasSource?'↳ Linked evidence':'○ No evidence attached'):'')}</div>`:''})()}`}</article>`}
function render(){for(const id of multi)if(!get(id))multi.delete(id);for(const id of groupSel)if(!groupById(id))groupSel.delete(id);
 // While you're inside a group, anything new you add belongs to it.
 {const ids=board.nodes.map(n=>n.id),g=focusGroup&&groupById(focusGroup);if(render.known&&g){const fresh=ids.filter(id=>!render.known.has(id)&&!groupList().some(x=>x.members.includes(id)));if(fresh.length){g.members.push(...fresh);queueMicrotask(persist)}}render.known=new Set(ids)}
 // The side panel opens when you select something (or pin it) and steps aside otherwise.
 if(!readerMode){const want=!!(selected||multi.size||groupSel.size||walking||panelPinned),key=[selected,...multi,...groupSel].join('|'),main=$('main');if(want&&key!==lastPanelKey&&key)main.classList.remove('side-collapsed');lastPanelKey=key;main.classList.toggle('panel-idle',!want&&!inboxOpen);$('#panel-toggle')?.setAttribute('aria-pressed',String(panelPinned))}
 const untitled=board.title==='What am I trying to establish?';$('#board-title').textContent=untitled?'Untitled question':board.title;$('#board-title').classList.toggle('is-placeholder',untitled);$('.subtitle').textContent=board.subtitle||'';$('.subtitle').hidden=!board.subtitle;$('.case-heading .eyebrow').textContent=board.sample?'CASE 001 / HEALTH INSURANCE IN AUSTRIA':(session?session.journey.name.toUpperCase()+' / EVIDENCE BOARD':'SHARED EVIDENCE BOARD');
 const conclusion=mainConclusion();$('#verdict').textContent=conclusion?wording(conclusion):'';$('.verdict').hidden=!conclusion;$('#edit-heading').hidden=!author||readerMode;$('#edit-conclusion').hidden=!author||readerMode||!conclusion;$('#edit-conclusion').dataset.edit=conclusion?.id||'';for(const el of [$('#board-title'),$('.subtitle'),$('#verdict')]){el.classList.toggle('click-to-edit',author&&!readerMode);if(author&&!readerMode){el.tabIndex=0;el.title='Click to edit'}else{el.removeAttribute('tabindex');el.removeAttribute('title')}}
 // Inside a group, the heading is that level's question and answer.
 {const g=focusGroup&&groupById(focusGroup);$('.verdict .eyebrow').textContent=g?'Its answer':'Conclusion';if(g){const face=faceOf(g),base=board.title==='What am I trying to establish?'?'Untitled question':board.title;$('#board-title').textContent=g.label||'Untitled group';$('#board-title').classList.remove('is-placeholder');$('.subtitle').hidden=false;$('.subtitle').textContent='Part of: '+[base,...ancestors(g).reverse().map(a=>a.label||'Untitled group')].join(' › ');$('.case-heading .eyebrow').textContent='INSIDE A GROUP · ESC STEPS OUT';$('#verdict').textContent=face?wording(face):'';$('.verdict').hidden=!face;$('#edit-heading').hidden=true;$('#edit-conclusion').hidden=true;for(const el of [$('#board-title'),$('.subtitle'),$('#verdict')]){el.classList.remove('click-to-edit');el.removeAttribute('tabindex');el.removeAttribute('title')}}}
 $('.segmented').hidden=readerMode||tab==='outline';$('#mode-hint').textContent=tab==='outline'&&!readerMode?'Outline · type to edit':readerMode?'Read-only export':author?'Click to select · Shift-click or drag a box for several · Space+drag to pan · ✎ or double-click to edit':'Viewing · switch to Author to edit';
 $$('.field-inline').forEach(el=>el.hidden=!board.sample);$('#kind').value=board.kind||'trade';$('#profit').value=board.profit||'above';$('.check-label').hidden=!board.sample;
 $('#view').setAttribute('aria-pressed',!author);$('#author').setAttribute('aria-pressed',author);$('#authorbar').hidden=!author||walking||tab==='outline';$('#walk').textContent=walking?'■ End walkthrough':'▶ Walk through';
 $('#viewport').hidden=walking||tab!=='map';if($('#outline-view')){$('#outline-view').hidden=walking||tab!=='outline';$('#outline-tab').classList.toggle('active',tab==='outline');$('#outline-tab').hidden=readerMode}$('#source-list').hidden=walking||tab!=='sources';$('#walkthrough').hidden=!walking;$('.canvas-footer').hidden=walking||tab!=='map';$('.board-bar').hidden=walking;
 $('#map-tab').classList.toggle('active',tab==='map');$('#sources-tab').classList.toggle('active',tab==='sources');$('#source-count').textContent=board.nodes.filter(n=>n.type==='evidence').length;
 const nodes=visibleNodes();let width=Math.max(1480,...nodes.map(n=>n.x+360)),height=Math.max(850,...nodes.map(n=>pos(n).y+460));
 $('#canvas').style.width=width+'px';$('#canvas').style.height=height+'px';
 $('#canvas').innerHTML=`<svg width="${width}" height="${height}" aria-hidden="true"></svg>${board.sample?`<div class="lane-label" style="left:30px;top:55px">01 / YOUR FACTS</div><div class="lane-label" style="left:340px;top:55px">02 / THE RULES & THEIR SOURCES</div><div class="lane-label" style="left:1100px;top:55px">03 / WHAT FOLLOWS</div>`:''}${nodes.map(n=>card(n)).join('')}${!board.nodes.some(active)?'<div class="empty"><h2>Start with a question.<br>Build from the evidence.</h2><p>Add a fact, a claim, or a source using the authoring toolbar.</p>'+(readerMode?'':'<div class="empty-actions"><button class="dark" data-open-outline>✎ Start jotting</button><button data-guide="tour">▶ Take the guided tour</button><button data-guide="primer">How this works</button><button data-guide="author">Start authoring</button></div>')+'</div>':''}`;
 $('#source-list').innerHTML=`<p class="eyebrow">SOURCE LIBRARY · ALL ROUTES</p><div class="source-grid">${board.nodes.filter(n=>n.type==='evidence').map(n=>card(n,true)).join('')}</div>`;
 if($('#inbox-panel')){$('#inbox-panel').hidden=!inboxOpen||readerMode;$('#inspector').hidden=inboxOpen&&!readerMode;$('#inbox-button')?.setAttribute('aria-pressed',inboxOpen)}
 $('.legend').innerHTML='<span>Read each arrow as a sentence: <em>[from] word [to]</em> · click a word to change it</span>';
 if($('#mode-hint')&&$('#author'))$('#author').title=$('#mode-hint').textContent;if($('#compact-title')){const g=focusGroup&&groupById(focusGroup),ans=g?faceOf(g):mainConclusion();$('#compact-title').textContent=(g?g.label||'Untitled group':board.title==='What am I trying to establish?'?'Untitled question':board.title)+(ans?' → '+wording(ans):'')}
 {const b=$('#evidence-all');if(b){b.hidden=!board.nodes.some(x=>x.type==='evidence')||tab!=='map';b.textContent=evidenceView.all?'Hide evidence':'Show all evidence';b.setAttribute('aria-pressed',String(evidenceView.all))}}
 renderGroups();measureBounds();layoutCanvas.inRender=true;layoutCanvas();layoutCanvas.inRender=false;
 renderEdges();renderInspector();if(walking)renderWalk();
 // Tool buttons carry an icon and a label; the label hides when the board is narrow.
 if(document.body.classList.contains('compact-chrome'))for(const [id,icon] of [['#assist-open','✦'],['#layout-spacing','↔'],['#order-steps','⇅'],['#walk',walking?'■':'▶']]){const b=$(id);if(!b||b.querySelector('.l')&&b.dataset.icon===icon)continue;const label=b.textContent.replace(/^[✦↔⇅▶■]\s*/,'').trim();b.dataset.icon=icon;b.title=label;b.innerHTML=`<span class="i" aria-hidden="true">${icon}</span><span class="l"> ${esc(label)}</span>`}
 for(const hook of renderHooks)hook();
 syncUrl();
}
// Groups: named sets of cards, drawn as a tinted outline behind them. Groups
// hold groups too, to any depth, so an argument reads at any level: a group
// of groups is a board within the board. A group has one home (one parent
// group, or the board itself); a card can sit in several groups, so
// overlapping arguments show as overlapping outlines. Collapsed, a group
// becomes its face card (the conclusion it argues for) and connections to
// anything inside attach there.
const GROUP_COLORS=['#3f8a63','#4a78b0','#8766b5','#b58324','#b5566a','#6f7582'];
let focusGroup=null,groupSel=new Set(),panelPinned=false,lastPanelKey='';
try{panelPinned=localStorage.getItem('evidence.panelPinned')==='1'}catch{}
const groupList=()=>board.groups||(board.groups=[]);
const groupById=id=>groupList().find(g=>g.id===id);
const parentOf=g=>groupList().find(p=>(p.groups||[]).includes(g.id));
function ancestors(g){const out=[];for(let p=parentOf(g);p&&p!==g&&!out.includes(p);p=parentOf(p))out.push(p);return out}
const within=(g,outer)=>g===outer||ancestors(g).includes(outer);
// Every card in a group, including those in the groups inside it.
function allCards(g,seen=new Set()){if(!g||seen.has(g.id))return [];seen.add(g.id);const out=new Set(g.members);for(const c of g.groups||[])for(const id of allCards(groupById(c),seen))out.add(id);return [...out]}
const groupsOf=id=>groupList().filter(g=>g.members.includes(id));
const groupColor=g=>GROUP_COLORS[g.color%GROUP_COLORS.length];
// The outermost collapsed group a card disappears into.
function collapsedOf(id){let best=null;for(const g of groupList())if(g.collapsed&&allCards(g).includes(id)&&(!best||within(best,g)||allCards(g).length>allCards(best).length))best=g;return best}
// What a group says when collapsed: the card you chose, else the card inside
// it that nothing else inside it leads to (a conclusion before a claim).
function faceOf(g){const ids=allCards(g);if(g.face&&ids.includes(g.face))return get(g.face);if(board.answerId&&ids.includes(board.answerId))return get(board.answerId);
 const inside=new Set(ids),feeds=new Set();for(const l of board.links){const r=linkRole(l);if(r.supporter&&inside.has(r.supporter)&&inside.has(r.supported))feeds.add(r.supporter)}
 const rank=n=>({conclusion:0,claim:1,gap:2,fact:3,note:4,evidence:5})[n.type]??6;return ids.map(get).filter(Boolean).sort((a,b)=>feeds.has(a.id)-feeds.has(b.id)||rank(a)-rank(b)||(a.y-b.y))[0]||null}
// Where a card is drawn right now: its own card, its collapsed group's card, or nowhere.
function endpoint(id,visible){const g=collapsedOf(id);if(g){const el=$(`#canvas [data-group-card="${CSS.escape(g.id)}"]`);return el&&{key:'g:'+g.id,group:g,el,p:{x:el.offsetLeft,y:el.offsetTop}}}
 const n=get(id);if(!n||!visible.has(id))return null;const el=$(`#canvas [data-node="${CSS.escape(id)}"]`);return el&&{key:id,el,p:pos(n)}}
function groupHead(g){const edit=author&&!readerMode,parent=parentOf(g);
 return `<div class="group-tab" data-group-drag="${esc(g.id)}" style="--g:${groupColor(g)}"><button class="group-fold" data-group-fold="${esc(g.id)}" aria-label="${g.collapsed?'Expand':'Collapse'} group" title="${g.collapsed?'Expand':'Collapse into its face card'}">${g.collapsed?'▸':'▾'}</button><span class="group-label" data-group-rename="${esc(g.id)}" title="${edit?'Double-click to rename · drag to move the group':''}">${esc(g.label||'Untitled group')}</span><button class="group-focus" data-group-focus="${esc(g.id)}" aria-label="Focus on this group" title="Focus on this group">⤢</button>${edit?`<button class="group-color" data-group-color="${esc(g.id)}" aria-label="Change colour" title="Change colour"></button>${parent?`<button class="group-out" data-group-out="${esc(g.id)}" aria-label="Take out of ${esc(parent.label||'its group')}" title="Take out of “${esc(parent.label||'Untitled group')}”">⇱</button>`:''}<button class="group-remove" data-group-remove="${esc(g.id)}" aria-label="Ungroup" title="Ungroup (keeps the cards)">✕</button>`:''}</div>`}
function cleanGroups(){const gs=groupList();for(const g of gs){g.members=g.members.filter(id=>get(id));g.groups=(g.groups||[]).filter(id=>groupById(id)&&id!==g.id)}
 board.groups=gs.filter(g=>allCards(g).length);if(focusGroup&&!groupById(focusGroup))focusGroup=null}
function renderGroups(){const canvas=$('#canvas');if(!canvas)return;canvas.querySelectorAll('.group,.group-card').forEach(e=>e.remove());cleanGroups();
 canvas.classList.toggle('focusing',!!focusGroup);renderCrumbs();if(tab!=='map'||walking)return;
 const visible=new Set(visibleNodes().map(n=>n.id)),first=canvas.firstChild,frag=document.createDocumentFragment();
 // Collapsed groups first: their cards are what other groups and connections
 // attach to. A collapsed group sits where its face card was.
 for(const g of groupList()){const ids=allCards(g);if(!g.collapsed||!ids.some(id=>collapsedOf(id)===g))continue;
  const ps=ids.map(get).filter(active).map(pos);if(!ps.length)continue;const face=faceOf(g),at=face&&active(face)?pos(face):{x:Math.min(...ps.map(p=>p.x)),y:Math.min(...ps.map(p=>p.y))},x=at.x,y=at.y,inner=(g.groups||[]).length;
  const el=document.createElement('div');el.className='group-card';el.dataset.groupCard=g.id;el.style.cssText=`left:${x}px;top:${y}px;--g:${groupColor(g)}`;
  el.innerHTML=`${groupHead(g)}<p class="group-card-count">${face?esc(nodeLabel(face))+' · ':''}${ids.length} card${ids.length>1?'s':''}${inner?` · ${inner} group${inner>1?'s':''}`:''} inside</p>${face?`<p class="group-card-lead">${esc(wording(face)||face.quote||'')}</p>`:''}<button class="group-open" data-group-fold="${esc(g.id)}">▸ Open</button>`;
  canvas.append(el)}
 const rects=[];for(const g of groupList()){if(g.collapsed||ancestors(g).some(a=>a.collapsed))continue;
  const ends=[...new Map(allCards(g).map(id=>endpoint(id,visible)).filter(Boolean).map(e=>[e.key,e])).values()];if(!ends.length||ends.length===1&&ends[0].group)continue;
  rects.push({g,ids:allCards(g),box:{x:Math.min(...ends.map(e=>e.el.offsetLeft)),y:Math.min(...ends.map(e=>e.el.offsetTop)),r:Math.max(...ends.map(e=>e.el.offsetLeft+e.el.offsetWidth)),b:Math.max(...ends.map(e=>e.el.offsetTop+e.el.offsetHeight))}})}
 // Each level of groups inside gets more room, so an outer outline and its tab clear the inner ones.
 const depth=new Map(),inside=(o,r)=>o!==r&&(within(o.g,r.g)||o.ids.length<r.ids.length&&o.ids.every(id=>r.ids.includes(id)));
 const level=r=>{if(depth.has(r))return depth.get(r);depth.set(r,0);const d=Math.max(-1,...rects.filter(o=>inside(o,r)).map(level))+1;depth.set(r,d);return d};
 for(const r of rects){const pad=16+34*level(r),el=document.createElement('div');el.className='group';el.dataset.group=r.g.id;
  el.style.cssText=`left:${r.box.x-pad}px;top:${r.box.y-pad}px;width:${r.box.r-r.box.x+2*pad}px;height:${r.box.b-r.box.y+2*pad}px;--g:${groupColor(r.g)}`;el.innerHTML=groupHead(r.g);frag.append(el)}
 canvas.insertBefore(frag,first);
 canvas.querySelectorAll('.group,.group-card').forEach(e=>e.classList.toggle('selected',groupSel.has(e.dataset.group||e.dataset.groupCard)));
 if(focusGroup){const f=groupById(focusGroup),ids=new Set(allCards(f));canvas.querySelectorAll('[data-node]').forEach(c=>c.classList.toggle('in-focus',ids.has(c.dataset.node)));canvas.querySelectorAll('.group,.group-card').forEach(e=>{const g=groupById(e.dataset.group||e.dataset.groupCard);e.classList.toggle('in-focus',!!g&&within(g,f))})}}
// Breadcrumbs while focused: Whole board › Outer › This group.
function renderCrumbs(){const foot=$('.canvas-footer');if(!foot)return;let nav=$('#group-crumbs');if(!nav){nav=document.createElement('nav');nav.id='group-crumbs';nav.setAttribute('aria-label','Group');foot.prepend(nav)}
 const f=focusGroup&&groupById(focusGroup);nav.hidden=!f;$('.legend')?.toggleAttribute('hidden',!!f);if(!f)return;
 const base=board.title==='What am I trying to establish?'?'Whole board':board.title;nav.innerHTML=`<button data-crumb="" title="The whole board">${esc(base.length>44?base.slice(0,43)+'…':base)}</button>${[...ancestors(f).reverse(),f].map(g=>`<span>›</span><button data-crumb="${esc(g.id)}" ${g===f?'aria-current="true"':''} style="--g:${groupColor(g)}">${esc(g.label||'Untitled group')}</button>`).join('')}<span class="crumb-hint">Esc to leave</span>`}
function focusOn(id){focusGroup=id||null;const f=focusGroup&&groupById(focusGroup);if(f)for(const g of [f,...ancestors(f)])g.collapsed=false;api.requestLayout?.();render();fitView();syncUrl()}
// Fit the view to the focused group, or to every card.
function fitView(){const boxOf=()=>{const f=focusGroup&&$(`#canvas .group[data-group="${CSS.escape(focusGroup)}"]`);return f?{x:f.offsetLeft,y:f.offsetTop-40,w:f.offsetWidth,h:f.offsetHeight+40}:{...bounds}};
 cancelAnimationFrame(zoomFrame);zoomFrame=0;zoomTarget=null;
 // Twice: far out, cards grow to keep headlines readable, which changes what fits.
 for(let i=0;i<2;i++){const box=boxOf();zoom=clampZoom(Math.min(1,(vpSize.w-80)/box.w,(vpSize.h-80)/box.h));render()}
 const box=boxOf();scrollToCanvas(box.x+box.w/2-vpSize.w/2/zoom,box.y+box.h/2-vpSize.h/2/zoom);syncUrl()}
// Moves a group to a new home, keeping one parent per group and no loops.
function reparent(g,to){if(to&&within(to,g))return false;const from=parentOf(g);if(from)from.groups=from.groups.filter(id=>id!==g.id);if(to)(to.groups=to.groups||[]).push(g.id);return true}
// New group from a selection. Groups the selection fully covers go inside it
// as groups; the remaining cards become its own cards.
function groupCards(ids){ids=[...new Set(ids)].filter(id=>get(id));if(!ids.length)return;const chosen=new Set(ids);
 let kids=groupList().filter(g=>allCards(g).every(id=>chosen.has(id)));kids=kids.filter(k=>!kids.some(o=>o!==k&&within(k,o)));
 const covered=new Set(kids.flatMap(k=>allCards(k))),homes=new Set([...kids.map(parentOf),...ids.filter(id=>!covered.has(id)).map(id=>groupsOf(id).find(p=>!kids.includes(p)))]),home=homes.size===1?[...homes][0]:null;
 const g={id:uid(),label:'',members:ids.filter(id=>!covered.has(id)),groups:[],color:groupList().length%GROUP_COLORS.length};groupList().push(g);
 for(const k of kids)reparent(k,g);if(home){home.members=home.members.filter(id=>!g.members.includes(id));(home.groups=home.groups||[]).push(g.id)}
 groupSel.clear();multi.clear();selected=null;persist();render();renameGroup(g.id)}
function renameGroup(id){const g=groupById(id),span=$(`#canvas [data-group-rename="${CSS.escape(id)}"]`);if(!g||!span||readerMode)return;
 const input=document.createElement('input');input.className='group-input';input.value=g.label;input.placeholder='Its question, or a name';span.replaceWith(input);input.focus();input.select();
 let done=false;const finish=save=>{if(done)return;done=true;if(save&&input.value.trim()!==g.label){g.label=input.value.trim().slice(0,300);persist()}render()};
 input.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Enter')finish(true);if(e.key==='Escape')finish(false)});input.addEventListener('blur',()=>finish(true));input.addEventListener('pointerdown',e=>e.stopPropagation(),true)}
document.addEventListener('click',e=>{const t=e.target.closest('[data-group-fold],[data-group-color],[data-group-remove],[data-group-multi],[data-group-leave],[data-group-focus],[data-group-out],[data-group-face],[data-crumb],[data-group-pick],[data-group-cards],[data-group-rename-btn],[data-group-promote],#wrap-board');if(!t)return;const d=t.dataset;
 if(d.crumb!==undefined)return focusOn(d.crumb);if(d.groupFocus)return focusOn(d.groupFocus===focusGroup?(parentOf(groupById(d.groupFocus))?.id||''):d.groupFocus);
 if(readerMode&&!d.groupFold)return;
 if(t.id==='wrap-board')return wrapBoard();if(d.groupPromote)return promoteGroup(groupById(d.groupPromote));
 if(d.groupFold){const g=groupById(d.groupFold);if(g){g.collapsed=!g.collapsed;if(g.collapsed){const ids=allCards(g);if(ids.includes(selected)||[...multi].some(id=>ids.includes(id))){selected=null;multi.clear()}if(focusGroup&&groupById(focusGroup)&&within(groupById(focusGroup),g)&&focusGroup!==g.id)focusGroup=g.id}api.requestLayout?.();persist();render()}}
 else if(d.groupColor){const g=groupById(d.groupColor);if(g){g.color=(g.color+1)%GROUP_COLORS.length;persist();render()}}
 else if(d.groupRemove){const g=groupById(d.groupRemove),p=g&&parentOf(g);if(!g)return;for(const k of g.groups||[]){const kid=groupById(k);if(kid)reparent(kid,p)}if(p){p.groups=p.groups.filter(id=>id!==g.id);p.members=[...new Set([...p.members,...g.members])]}board.groups=groupList().filter(x=>x!==g);if(focusGroup===g.id)focusGroup=p?.id||null;persist();render();notify('Ungrouped. The cards stay where they are.',{label:'Undo',run:()=>undo()})}
 else if(d.groupOut){const g=groupById(d.groupOut),p=g&&parentOf(g);if(g&&p){reparent(g,parentOf(p));persist();render();notify(`Took “${g.label||'Untitled group'}” out of “${p.label||'Untitled group'}”.`,{label:'Undo',run:()=>undo()})}}
 else if(d.groupFace){const[gid,id]=d.groupFace.split('|'),g=groupById(gid);if(g){g.face=id;persist();render()}}
 else if(d.groupMulti!==undefined)groupCards(selectionCards());
 else if(d.groupPick){groupSel=new Set([d.groupPick]);multi.clear();selected=null;render()}
 else if(d.groupCards){const ids=allCards(groupById(d.groupCards)||{members:[]}).filter(id=>$(`#canvas [data-node="${CSS.escape(id)}"]`));groupSel.clear();multi=new Set(ids.length>1?ids:[]);selected=ids.at(-1)||null;render()}
 else if(d.groupRenameBtn)renameGroup(d.groupRenameBtn);
 else if(d.groupLeave){const[gid,id]=d.groupLeave.split('|'),g=groupById(gid);if(g){g.members=g.members.filter(m=>m!==id);persist();render()}}});
document.addEventListener('change',e=>{const s=e.target.closest('[data-group-add]');if(!s||!s.value)return;const g=groupById(s.value),ids=multi.size?[...multi]:[selected];if(g){g.members=[...new Set([...g.members,...ids])];persist();render();notify(`Added to “${g.label||'Untitled group'}”.`)}});
document.addEventListener('dblclick',e=>{const t=e.target.closest('[data-group-rename]');if(t&&author&&!readerMode){e.preventDefault();renameGroup(t.dataset.groupRename);return}const c=e.target.closest('.group-card');if(c&&!e.target.closest('button,input')){const g=groupById(c.dataset.groupCard);if(g){g.collapsed=false;api.requestLayout?.();persist();render()}}});
// Drag a group by its label (or a collapsed group by its card) to move
// everything in it; drop it on another group to put it inside. A click
// selects its cards (Shift-click adds them to the selection).
$('#viewport').addEventListener('pointerdown',e=>{const h=e.target.closest('[data-group-drag],.group-card');if(!h||e.button!==0||e.target.closest('button,input,a')||spaceDown)return;
 const g=groupById(h.dataset.groupDrag||h.dataset.groupCard);if(!g)return;e.stopImmediatePropagation();e.preventDefault();
 const sx=e.clientX,sy=e.clientY,origin=allCards(g).map(get).filter(Boolean).map(n=>({n,x:n.x,y:n.y})),adding=e.shiftKey||e.metaKey||e.ctrlKey;let moved=false,target=null;
 const move=ev=>{const dx=ev.clientX-sx,dy=ev.clientY-sy;if(!moved&&Math.hypot(dx,dy)<4)return;if(!author||readerMode)return;moved=true;
  for(const o of origin){o.n.x=o.x+dx/zoom;o.n.y=o.y+dy/zoom;const el=$(`#canvas [data-node="${CSS.escape(o.n.id)}"]`);if(el){const p=pos(o.n);el.style.left=p.x+'px';el.style.top=p.y+'px'}}renderGroups();renderEdges();
  target=showGroupDrop(ev,{group:g})};
 const up=()=>{removeEventListener('pointermove',move);removeEventListener('pointerup',up);
  if(moved){origin.forEach(o=>delete o.n.auto);if(target&&reparent(g,target))notify(`Put “${g.label||'Untitled group'}” inside “${target.label||'Untitled group'}”.`,{label:'Undo',run:()=>undo()});persist();render()}
  else{if(!adding){multi.clear();selected=null;groupSel=new Set()}else if(selected&&!multi.size)multi.add(selected);if(adding&&groupSel.has(g.id))groupSel.delete(g.id);else groupSel.add(g.id);if(multi.size<2)multi.clear();render()}};
 addEventListener('pointermove',move);addEventListener('pointerup',up)},{capture:true});
function groupControls(ids){if(!author||readerMode)return '';const one=ids.length===1?ids[0]:null,direct=one?groupsOf(one):[],chain=[...new Set(direct.flatMap(g=>[g,...ancestors(g)]))],others=groupList().filter(g=>!ids.every(id=>allCards(g).includes(id)));
 const chip=g=>{const isDirect=direct.includes(g),isFace=faceOf(g)?.id===one,path=ancestors(g).reverse().map(a=>esc(a.label||'Untitled group')+' › ').join('');
  return `<span class="group-chip ${isDirect?'':'is-outer'}" style="--g:${groupColor(g)}"><button class="chip-face ${isFace?'on':''}" data-group-face="${esc(g.id)}|${esc(one)}" title="${isFace?'This card is what the group says when collapsed':'Make this card the face of the group: what it says when collapsed'}" aria-label="Face of ${esc(g.label||'group')}">${isFace?'★':'☆'}</button><span class="chip-path">${path}</span>${esc(g.label||'Untitled group')}${isDirect?`<button data-group-leave="${esc(g.id)}|${esc(one)}" aria-label="Take out of this group">✕</button>`:''}</span>`};
 return `<div class="group-controls"><p class="eyebrow">GROUPS</p>${chain.map(chip).join('')}
 <div class="detail-actions"><button data-group-multi>▭ New group${ids.length>1?` of ${ids.length}`:''}</button>${others.length?`<select data-group-add aria-label="Add to a group"><option value="">Add to group…</option>${others.map(g=>`<option value="${esc(g.id)}">${esc(ancestors(g).reverse().map(a=>(a.label||'Untitled')+' › ').join('')+(g.label||'Untitled group'))}</option>`).join('')}</select>`:''}</div><p class="ui-hint">⌘G groups the selection; groups it fully covers go inside the new one. ☆ picks what a group says when collapsed.</p></div>`}
// Levels: the board's own question and answer are always the furthest out.
// A group that holds every card is really that outermost level, so it can
// take over as the base question; the old one becomes a group around its
// answer and everything that leads to it.
const coversBoard=g=>!parentOf(g)&&board.nodes.filter(active).every(n=>allCards(g).includes(n.id));
function promoteGroup(g){if(!g)return;const old=mainConclusion(),oldQ=board.title,face=faceOf(g),untitled=oldQ==='What am I trying to establish?';
 if(old&&old.id!==face?.id&&!untitled){const inside=new Set(allCards(g)),seen=new Set([old.id]),queue=[old.id];
  while(queue.length){const id=queue.shift();for(const l of board.links){const o=l.from===id?l.to:l.to===id?l.from:null;if(o&&!seen.has(o)&&inside.has(o)&&o!==face?.id){seen.add(o);queue.push(o)}}}
  const kids=(g.groups||[]).map(groupById).filter(k=>k&&allCards(k).every(id=>seen.has(id))),covered=new Set(kids.flatMap(k=>allCards(k)));
  const og={id:uid(),label:oldQ,members:[...seen].filter(id=>!covered.has(id)),groups:[],color:(g.color+1)%GROUP_COLORS.length,face:old.id};groupList().push(og);for(const k of kids)reparent(k,og)}
 board.title=g.label||oldQ;board.answerId=face?.type==='conclusion'?face.id:undefined;
 for(const k of [...(g.groups||[])])reparent(groupById(k),null);board.groups=groupList().filter(x=>x!==g);groupSel.clear();if(focusGroup===g.id)focusGroup=null;
 persist();render();notify(untitled||!old?'This is now the base question.':`This is now the base question; “${oldQ}” is a group around its answer.`,{label:'Undo',run:()=>undo()})}
// Everything so far becomes one group inside a new, bigger question.
function wrapBoard(){if(readerMode||!board.nodes.length)return;const tops=groupList().filter(g=>!parentOf(g)),inTops=new Set(tops.flatMap(t=>allCards(t))),old=mainConclusion(),untitled=board.title==='What am I trying to establish?';
 const g={id:uid(),label:untitled?'':board.title,members:board.nodes.map(n=>n.id).filter(id=>!inTops.has(id)),groups:tops.map(t=>t.id),color:groupList().length%GROUP_COLORS.length,...(old?{face:old.id}:{})};groupList().push(g);
 board.title='What am I trying to establish?';board.answerId=undefined;focusGroup=null;author=true;persist();render();fitView();
 notify('Everything is now one group inside a new question. Name the bigger question.',{label:'Undo',run:()=>undo()});setTimeout(()=>$('#edit-heading')?.click(),60)}
// Cards the selection stands for: selected cards plus everything in selected groups.
const selectionCards=()=>[...(multi.size?multi:selected?[selected]:[]),...[...groupSel].flatMap(id=>allCards(groupById(id)))];
function groupInspector(){const gs=[...groupSel].map(groupById).filter(Boolean),cards=multi.size?[...multi]:selected?[selected]:[],edit=author&&!readerMode,name=g=>esc(g.label||'Untitled group'),plural=(n,w)=>n+' '+w+(n===1?'':'s');
 if(gs.length===1&&!cards.length){const g=gs[0],face=faceOf(g),ids=allCards(g),kids=(g.groups||[]).map(groupById).filter(Boolean),path=ancestors(g).reverse(),parent=parentOf(g);
  return `<div class="detail-heading"><span class="eyebrow">GROUP${path.length?' · IN '+path.map(name).join(' › '):''}</span><button data-deselect aria-label="Clear selection">✕</button></div>
  <p class="detail-copy group-title" style="--g:${groupColor(g)}">${name(g)}</p><p class="ui-hint">${plural(ids.length,'card')}${kids.length?' · '+plural(kids.length,'group')+' inside':''}${g.collapsed?' · collapsed':''}</p>
  ${face?`<p class="eyebrow" style="margin-top:20px">WHAT IT SAYS WHEN COLLAPSED</p><div class="detail-box"><button data-select="${esc(face.id)}">${esc(wording(face)||face.quote||'')}</button><small>To pick another, select a card inside and press ☆.</small></div>`:''}
  ${kids.length?`<p class="eyebrow" style="margin-top:20px">GROUPS INSIDE</p>${kids.map(k=>`<div class="detail-box"><button data-group-pick="${esc(k.id)}"><span class="group-dot" style="--g:${groupColor(k)}"></span>${name(k)}</button><small>${plural(allCards(k).length,'card')}${k.collapsed?' · collapsed':''}</small></div>`).join('')}`:''}
  <div class="detail-actions"><button data-group-focus="${esc(g.id)}">⤢ Focus</button><button data-group-fold="${esc(g.id)}">${g.collapsed?'▸ Expand':'▾ Collapse'}</button><button data-group-cards="${esc(g.id)}">Select its cards</button>${edit?`<button data-group-rename-btn="${esc(g.id)}">✎ Rename</button>${parent?`<button data-group-out="${esc(g.id)}">⇱ Take out of “${name(parent)}”</button>`:''}<button class="danger" data-group-remove="${esc(g.id)}">Ungroup</button>`:''}</div>
  ${edit&&coversBoard(g)?`<div class="notice">This group holds every card, so it is really the board's furthest-out question.<div class="detail-actions"><button data-group-promote="${esc(g.id)}">Make it the base question</button></div></div>`:''}
  ${edit?'<p class="ui-hint">Shift-click other groups or cards, then ⌘G, to put them together in a bigger group.</p>':''}`}
 return `<div class="detail-heading"><span class="eyebrow">${plural(gs.length,'GROUP').toUpperCase()}${cards.length?' + '+plural(cards.length,'CARD').toUpperCase():''} SELECTED</span><button data-deselect aria-label="Clear selection">✕</button></div>
 <ul class="multi-list">${gs.map(g=>`<li><span class="pick-type">GROUP</span> ${name(g)}</li>`).join('')}${cards.map(get).filter(Boolean).map(m=>`<li><span class="pick-type">${esc(nodeLabel(m))}</span> ${esc((wording(m)||m.quote||'').slice(0,70))}</li>`).join('')}</ul>
 ${edit?`<div class="detail-actions"><button data-group-multi>▭ Group these</button><button data-deselect>Clear selection</button></div><p class="ui-hint">⌘G does the same; the selected groups go inside the new one.</p>`:''}`}
// While dragging: the innermost group under the pointer that can take what
// you're carrying lights up and says what dropping will do.
function showGroupDrop(ev,{ids,group}){const p=canvasAt(ev.clientX,ev.clientY);let best=null,area=Infinity;
 for(const el of document.querySelectorAll('#canvas .group,#canvas .group-card')){const g=groupById(el.dataset.group||el.dataset.groupCard);if(!g)continue;
  if(group?within(g,group)||parentOf(group)===g:ids.every(id=>allCards(g).includes(id)))continue;
  const x=el.offsetLeft,y=el.offsetTop,w=el.offsetWidth,h=el.offsetHeight;if(p.x<x||p.x>x+w||p.y<y||p.y>y+h||w*h>=area)continue;best={g,el};area=w*h}
 if(best){best.el.classList.add('drop-target');best.el.querySelector('.group-tab')?.insertAdjacentHTML('beforeend',`<span class="group-drop-hint">＋ ${group?`Put “${esc(group.label||'Untitled group')}” inside`:`Drop to add ${ids.length>1?ids.length+' cards':'this card'}`}</span>`)}
 return best?.g||null}
function renderEdges(){const ids=new Set(visibleNodes().map(n=>n.id)),seenPairs=new Set();const svg=$('#canvas svg');if(!svg)return;svg.innerHTML=`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="context-stroke"/></marker></defs>`+board.links.map(l=>{const A=endpoint(l.from,ids),B=endpoint(l.to,ids);if(!A||!B||A.key===B.key)return '';if(A.group||B.group){const pair=A.key+'>'+B.key+'>'+l.word;if(seenPairs.has(pair))return '';seenPairs.add(pair)}const a=get(l.from),b=get(l.to),ap=A.p,bp=B.p,ae=A.el,be=B.el,fade=focusGroup&&!(ae.classList.contains('in-focus')&&be.classList.contains('in-focus'))?' faded':'';let sx,sy,tx,ty,d;
 if(bp.x>ap.x+ae.offsetWidth-10){sx=ap.x+ae.offsetWidth;sy=ap.y+Math.min(120,ae.offsetHeight)/2;tx=bp.x-6;ty=bp.y+Math.min(120,be.offsetHeight)/2;d=`M${sx},${sy} C${sx+45},${sy} ${tx-45},${ty} ${tx},${ty}`;}else{sx=ap.x+ae.offsetWidth/2;tx=bp.x+be.offsetWidth/2;const down=bp.y>ap.y;sy=ap.y+(down?ae.offsetHeight:0);ty=bp.y+(down?-7:be.offsetHeight+7);d=`M${sx},${sy} C${sx},${(sy+ty)/2} ${tx},${(sy+ty)/2} ${tx},${ty}`;}
 const color={objection:'#ac402d',but:'#a0661c',so:'#2e5b46',answer:'#8a6d1a'}[l.word]||'#817969',dash={and:'6 5',question:'6 5',answer:'2 5',objection:'6 4'}[l.word];return `<path class="edge${fade}" d="${d}" fill="none" stroke="${color}" stroke-width="1.5" ${dash?'stroke-dasharray="'+dash+'"':''} marker-end="url(#arrow)"/>${`<text class="edge-label k-${l.word}${fade}" data-edit-link="${l.id}" text-anchor="middle" x="${(sx+tx)/2}" y="${(sy+ty)/2-10}">${esc(wordLabel(l.word,b.type))}${l.label?' · '+esc(l.label):''}</text>`}`}).join('');
 // Labels live in their own layer above the cards so a card never hides them.
 let top=$('#canvas svg.edge-labels');if(!top){top=document.createElementNS('http://www.w3.org/2000/svg','svg');top.setAttribute('class','edge-labels');top.setAttribute('aria-hidden','true');$('#canvas').append(top)}
 top.setAttribute('width',svg.getAttribute('width'));top.setAttribute('height',svg.getAttribute('height'));top.replaceChildren(...svg.querySelectorAll('text.edge-label'));}
function renderInspector(){if(groupSel.size){$('#inspector').innerHTML=groupInspector();return}if(multi.size>1){$('#inspector').innerHTML=`<div class="detail-heading"><span class="eyebrow">${multi.size} CARDS SELECTED</span><button data-deselect aria-label="Clear selection">✕</button></div><p class="ui-hint">Drag any of them to move them together, or nudge with the arrow keys (Shift for bigger steps). Shift- or ⌘-click to add or remove a card; Esc clears.</p><ul class="multi-list">${[...multi].map(get).filter(Boolean).map(m=>`<li><span class="pick-type">${esc(nodeLabel(m))}</span> ${esc((wording(m)||m.quote||'').slice(0,70))}</li>`).join('')}</ul>${groupControls([...multi])}${author&&!readerMode?`<div class="detail-actions"><button class="danger" data-delete-multi>Remove ${multi.size} cards</button><button data-deselect>Clear selection</button></div>`:''}`;return}const n=get(selected);if(!n){const activeNodes=board.nodes.filter(active),steps=sequence();const counts=[[activeNodes.filter(n=>n.type==='claim').length,'claims'],[activeNodes.filter(n=>n.type==='evidence').length,'sources'],[board.links.filter(l=>l.word==='objection'&&active(get(l.to)||{})).length,'objections'],[activeNodes.filter(n=>n.type==='gap').length,'open questions']];$('#inspector').innerHTML=`<h2 class="panel-label">Walkthrough</h2><div class="reading-list">${steps.map((n,i)=>`<button data-select="${n.id}"><span class="num">${String(i+1).padStart(2,'0')}</span><span>${esc(wording(n))}</span></button>`).join('')}</div>${!steps.length?'<p class="ui-hint">No steps yet. In Author mode, select a card and add it to the walkthrough.</p>':''}<p class="board-summary">${counts.filter(([count])=>count).map(([count,label])=>`<span>${count} ${count===1?label.replace(/s$/,''):label}</span>`).join('')}</p><details class="reading-help"><summary>Reading this board</summary><p>Select a step or card to inspect its evidence and connections. Use Walk through to read in order.</p><p>${readerMode?'Shared board · read only.':'Evidence snapshots stay in this workspace. Save a board file for a portable backup.'}</p></details>${board.sample?'<p class="ui-hint">Example case · assumptions and open questions remain.</p>':''}`;return}
 const relations=board.links.filter(l=>l.to===n.id||l.from===n.id);$('#inspector').innerHTML=`<div class="detail-heading"><span class="eyebrow">${esc(nodeLabel(n))}</span><button data-deselect aria-label="Close inspector">✕</button></div><p class="detail-copy">${esc(wording(n))}</p>${!readerMode?`<button class="edit-affordance" data-edit="${n.id}">✎ Edit ${n.type==='evidence'?'evidence & notes':'text & notes'}</button>${n.type==='conclusion'?(mainConclusion()?.id===n.id?(board.answerId===n.id?'<button class="edit-affordance" data-answer="">Let the board pick the answer</button>':'<p class="ui-hint">The answer to the question: chosen because nothing else follows from it.</p>'):`<button class="edit-affordance" data-answer="${n.id}">★ Make this the answer</button>`):''}`:'<span class="content-access">Read only</span>'}${n.type==='evidence'?`${figure(n)}${n.image?`<button data-inspect-image="${n.id}">Inspect screenshot ⤢</button>`:''}${passage(n)}${viewBadge(n)}${deepLink(n)?`<a class="full-link" href="${esc(deepLink(n))}" target="_blank" rel="noopener noreferrer">${n.pdf?'Open PDF':n.quote?'Open source at passage':'Open source'} ↗</a><button data-copy-link="${n.id}">Copy source link</button>`:''}<dl class="detail-meta"><dt>Publisher</dt><dd>${esc(domain(n.url))}</dd><dt>Authority</dt><dd>${esc(n.tier||'Unreviewed')} · author-assigned</dd><dt>Checked</dt><dd>${esc(n.checked||'Not recorded')}</dd><dt>Captured <span class="fixed-label">recorded</span></dt><dd>${n.capturedAt?esc(new Date(n.capturedAt).toLocaleString()):'Not recorded'}</dd><dt>Page view <span class="fixed-label">recorded</span></dt><dd>${esc(({original:'Original page',translated:'Translated view','legacy-unverified':'Not verified','saved-text':'Text saved when you visited'})[n.provenance?.view]||n.provenance?.view||'Manually supplied')}</dd><dt>Capture</dt><dd>${n.image?'Uploaded screenshot':'Text excerpt · not a screenshot'}</dd></dl><details class="reading-help"><summary>About passage links</summary><p>Passage links depend on browser support and unchanged source text. PDFs use the page number when provided.</p></details>`:''}${n.note?`<div class="authored-note"><span class="eyebrow">Note</span><p>${esc(n.note)}</p></div>`:''}<p class="eyebrow" style="margin-top:25px">${relations.length?'CONNECTIONS':'NO CONNECTIONS YET'}</p>${relations.map(l=>{const incoming=l.to===n.id,other=get(incoming?l.from:l.to);return other?`<div class="detail-box"><small class="relation-word ${l.word==='objection'?'is-against':''}">${incoming?`“${esc(wording(other).slice(0,50))}” <em>${esc(wordLabel(l.word,n.type))}</em> this`:`this <em>${esc(wordLabel(l.word,other.type))}</em>`}${l.label?' · '+esc(l.label):''}</small><button data-select="${other.id}">${esc(wording(other))}</button>${author?`<button data-edit-link="${l.id}" style="font-size:12px;margin-top:8px">Edit connection</button><button class="danger" data-remove-link="${l.id}" style="font-size:12px;margin-top:8px">Remove connection</button>`:''}</div>`:''}).join('')}${groupControls([n.id])}${author?`<div class="detail-actions"><button data-connect="${n.id}">＋ Connect</button><button data-step="${n.id}">${board.steps.includes(n.id)?'Remove from':'Add to'} walkthrough</button><button data-delete="${n.id}" class="danger">Delete card</button></div>`:''}`;
}
// A click selects; editing is explicit (✎ Edit, or double-click in Author mode).
function activateCard(id,center=false){select(id,center)}
document.addEventListener('dblclick',e=>{const el=e.target.closest('#canvas [data-node]');if(!el||!author||readerMode||e.target.closest('a,button'))return;const n=get(el.dataset.node);if(n)openCard(n.type,n.id)});
function select(id,center=false){if(!multi.has(id))multi.clear();groupSel.clear();const target=get(id);for(let g;target&&(g=collapsedOf(id));){g.collapsed=false;api?.requestLayout?.()}if(target&&evidenceHidden(target)){neighbors(id).filter(x=>x.type!=='evidence').forEach(x=>evidenceView.open.add(x.id));saveEvidenceView();api?.requestLayout?.()}selected=id;if(center&&get(id)){const n=get(id);if(board.sample&&n.route&&n.route!==route()){allRoutes=true;$('#all-routes').checked=true;}render();const p=pos(n),el=$(`#canvas [data-node="${CSS.escape(id)}"]`),w=el?.offsetWidth||300,h=el?.offsetHeight||200;const top=h*zoom>vpSize.h-80?p.y-40/zoom:p.y+h/2-vpSize.h/2/zoom;scrollToCanvas(p.x+w/2-vpSize.w/2/zoom,top,true);}else render();}
function renderWalk(){const seq=sequence();step=Math.max(0,Math.min(step,seq.length-1));syncUrl();const n=seq[step];if(!n){$('#walkthrough').innerHTML='<div class="empty"><h2>No walkthrough steps yet.</h2><p>In Author mode, select cards and add them to the walkthrough.</p></div>';return}const ev=[...supportersOf(n.id).map(get).filter(x=>x?.type==='evidence').map(x=>({n:x,label:'as the source says'})),...objectionsTo(n.id).map(get).map(x=>({n:x,label:wordLabel('objection',x.type),against:true}))];$('#walkthrough').innerHTML=`<div class="walk-shell"><p class="walk-count">STEP ${String(step+1).padStart(2,'0')} / ${String(seq.length).padStart(2,'0')} · ${esc(n.type.toUpperCase())}</p>${seq.slice(0,step).some(p=>supportersOf(n.id).includes(p.id))?'<p class="walk-so">and so</p>':''}<h2 class="walk-title">${esc(wording(n))}</h2>${author&&!readerMode?`<button class="edit-affordance" data-edit="${n.id}">✎ Edit this step</button>`:''}${n.note?`<p class="walk-note">${esc(n.note)}</p>`:''}<div class="walk-evidence">${n.type==='evidence'?card(n,true):ev.map(e=>`<p class="walk-relation ${e.against?'is-against':''}">${esc(e.label)}</p>${card(e.n,true)}`).join('')||`<p class="ui-hint">${n.type==='fact'?'Author-stated fact':n.type==='gap'?'Open question':'No supporting sources linked'}</p>`}</div><div class="walk-controls"><button id="prev-step" ${step===0?'disabled':''}>← Back</button><div class="progress">${seq.map((_,i)=>`<button data-walk-step="${i}" class="${i<=step?'done':''}" aria-label="Go to step ${i+1}"></button>`).join('')}</div><button id="next-step" class="dark">${step===seq.length-1?'Finish':'Next →'}</button></div></div>`;$('#inspector').innerHTML=`<h2 class="panel-label">Walkthrough</h2><div class="reading-list">${seq.map((s,i)=>`<button data-walk-step="${i}" ${i===step?'aria-current="step" style="color:var(--green);font-weight:600"':''}><span class="num">${String(i+1).padStart(2,'0')}</span>${esc(wording(s))}</button>`).join('')}</div>`}
$('#kind').onchange=e=>{board.kind=e.target.value;selected=null;persist();render()};$('#profit').onchange=e=>{board.profit=e.target.value;selected=null;persist();render()};$('#all-routes').onchange=e=>{allRoutes=e.target.checked;render()};$('#view').onclick=()=>{author=false;render()};$('#author').onclick=()=>{author=true;render()};$('#map-tab').onclick=()=>{tab='map';render()};if($('#outline-tab'))$('#outline-tab').onclick=()=>{tab='outline';render()};$('#sources-tab').onclick=()=>{tab='sources';render()};$('#zoom-in').onclick=()=>zoomTo((zoomTarget??zoom)*1.2);$('#zoom-out').onclick=()=>zoomTo((zoomTarget??zoom)/1.2);$('#fit').onclick=()=>fitView();
$('#viewport').addEventListener('wheel',e=>{if(!(e.metaKey||e.ctrlKey)||tab!=='map')return;e.preventDefault();const d=Math.max(-80,Math.min(80,e.deltaMode===1?e.deltaY*16:e.deltaY)),r=$('#viewport').getBoundingClientRect();zoomTo((zoomTarget??zoom)*Math.exp(-d*.004),{cx:e.clientX-r.left,cy:e.clientY-r.top})},{passive:false});
addEventListener('resize',()=>{if(tab==='map'&&!walking)layoutCanvas()});$('#walk').onclick=()=>{walking=!walking;step=0;render()};
// Show/hide evidence: per card, or all at once from the footer.
document.addEventListener('click',e=>{const t=e.target.closest('[data-evidence-toggle]');if(t){const id=t.dataset.evidenceToggle,open=evidenceView.all||evidenceView.open.has(id);if(open&&evidenceView.all){evidenceView.all=false;board.nodes.forEach(x=>{if(x.type!=='evidence'&&evidenceOf(x.id).length)evidenceView.open.add(x.id)})}showEvidenceFor(id,!open);api.requestLayout?.();render();return}
 if(e.target.closest('#evidence-all')){evidenceView.all=!evidenceView.all;if(!evidenceView.all)evidenceView.open.clear();saveEvidenceView();api.requestLayout?.();render()}});
document.addEventListener('click',e=>{const el=e.target.closest('[data-select],[data-deselect],[data-walk-step],#prev-step,#next-step,[data-node]');if(!el||e.target.closest('a,[data-edit],[data-inspect-card],#edit-heading,[data-connect-handle],[data-delete],[data-evidence-toggle]'))return;if(el.hasAttribute('data-select'))activateCard(el.dataset.select,true);else if(el.hasAttribute('data-deselect')){selected=null;multi.clear();groupSel.clear();render()}else if(el.hasAttribute('data-walk-step')){step=Number(el.dataset.walkStep);renderWalk()}else if(el.id==='prev-step'){step--;renderWalk()}else if(el.id==='next-step'){if(step===sequence().length-1){walking=false;render()}else{step++;renderWalk()}}else if(el.dataset.node&&!dragMoved){if((e.shiftKey||e.metaKey||e.ctrlKey)&&author&&!readerMode)toggleMulti(el.dataset.node);else{multi.clear();activateCard(el.dataset.node)}}});
document.addEventListener('keydown',e=>{if(e.target.matches('[data-node]')&&['Enter',' '].includes(e.key)){e.preventDefault();activateCard(e.target.dataset.node)}if(walking&&!e.target.matches('input,textarea,select,[contenteditable]')&&!$('dialog[open]')){if(e.key==='ArrowRight')$('#next-step')?.click();if(e.key==='ArrowLeft')$('#prev-step')?.click();if(e.key==='Escape'){walking=false;render()}}});
// Drag from a card's → handle onto another card to connect them. The kind
// follows from the card you start at (a quote is a source, a question raises
// a question, anything else is a reason); flip it from the card's details.
$('#viewport').addEventListener('pointerdown',e=>{const h=e.target.closest('[data-connect-handle]');if(!h||e.button!==0||!author||readerMode)return;e.preventDefault();e.stopPropagation();
 const from=get(h.dataset.connectHandle);if(!from)return;const canvas=$('#canvas'),svg=$('#canvas svg'),p=pos(from),src=$(`#canvas [data-node="${CSS.escape(from.id)}"]`);
 const sx=p.x+src.offsetWidth,sy=p.y+Math.min(60,src.offsetHeight/2);const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('class','connect-preview');svg.append(line);let target=null;
 const at=ev=>{const r=canvas.getBoundingClientRect();return {x:(ev.clientX-r.left)/zoom,y:(ev.clientY-r.top)/zoom}};
 const move=ev=>{const q=at(ev);line.setAttribute('d',`M${sx},${sy} C${sx+60},${sy} ${q.x-60},${q.y} ${q.x},${q.y}`);const hit=document.elementFromPoint(ev.clientX,ev.clientY)?.closest('#canvas [data-node]');const next=hit&&hit.dataset.node!==from.id?hit:null;if(next!==target){target?.classList.remove('connect-target');target=next;target?.classList.add('connect-target')}};
 const up=()=>{window.removeEventListener('pointermove',move);line.remove();target?.classList.remove('connect-target');if(!target)return;const to=get(target.dataset.node),word=fitWord(from.type,to.type,'so');
  if(board.links.some(l=>l.from===from.id&&l.to===to.id)){notify('These cards are already connected. Open the card to change how.');return}
  board.links.push({id:uid(),from:from.id,to:to.id,word,label:''});persist();render();
  const short=t=>t.length>40?t.slice(0,39)+'…':t;notify(`“${short(wording(from)||from.quote||'')}” ${wordLabel(word,to.type)} “${short(wording(to)||to.quote||'')}”. Click the word on the arrow to change it.`)};
 window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});move(e)},true);
// Drag the divider between the board and the side panel to trade space;
// double-click (or Enter) collapses the panel. Remembered per browser.
{const split=$('#side-splitter'),main=$('main'),KEY='evidence.sideWidth';
 const apply=w=>{const collapsed=w<120;main.classList.toggle('side-collapsed',collapsed);if(!collapsed)main.style.setProperty('--side-w',Math.round(Math.min(Math.max(w,220),window.innerWidth*.6))+'px');split.setAttribute('aria-valuenow',Math.round(w))};
 const save=w=>{try{localStorage.setItem(KEY,String(Math.round(w)))}catch{}};
 let saved=null;try{saved=Number(localStorage.getItem(KEY))}catch{}
 if(split&&!readerMode){if(saved)apply(saved);
  split.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();split.setPointerCapture(e.pointerId);document.body.classList.add('is-resizing');
   const move=ev=>{const w=main.getBoundingClientRect().right-ev.clientX;apply(w)};const up=ev=>{split.removeEventListener('pointermove',move);document.body.classList.remove('is-resizing');const w=main.getBoundingClientRect().right-ev.clientX;save(w<120?0:Math.min(Math.max(w,220),window.innerWidth*.6));renderEdges()};
   split.addEventListener('pointermove',move);split.addEventListener('pointerup',up,{once:true})});
  const current=()=>main.classList.contains('side-collapsed')?0:parseFloat(getComputedStyle(main).getPropertyValue('--side-w'))||($('#inspector').offsetWidth||340);
  const toggle=()=>{const w=current()?0:(saved&&saved>=120?saved:340);apply(w);save(w);if(w)saved=w;renderEdges()};
  split.addEventListener('dblclick',toggle);
  split.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();toggle()}else if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const w=Math.max(0,current()+(e.key==='ArrowLeft'?40:-40));apply(w);save(w);renderEdges()}});}}
// The word on a board arrow is editable: click it to change the connection.
document.addEventListener('click',e=>{const w=e.target.closest('svg [data-edit-link]');if(!w||readerMode)return;author=true;render();openConnection(null,w.dataset.editLink)});
// Pick which conclusion answers the board's question (empty = automatic).
document.addEventListener('click',e=>{const b=e.target.closest('[data-answer]');if(!b||readerMode)return;board.answerId=b.dataset.answer||undefined;persist();render();notify(b.dataset.answer?'This is now the answer to the question.':'The board picks the answer again.')});
// Drag the divider under the heading to give the board more height; drag it
// all the way up (or double-click) to fold the heading into one line.
{const split=$('#header-splitter'),head=$('.case-heading'),KEY='evidence.headingHeight';
 const natural=()=>{const prev=head.style.maxHeight;head.style.maxHeight='none';const h=head.scrollHeight;head.style.maxHeight=prev;return h};
 const apply=h=>{const full=natural(),v=Math.max(0,Math.min(full,h)),folded=v<30;document.body.classList.toggle('heading-folded',folded);head.style.maxHeight=folded?'0px':v>=full-2?'none':Math.round(v)+'px';renderEdges()};
 const save=()=>{try{localStorage.setItem(KEY,document.body.classList.contains('heading-folded')?'0':head.style.maxHeight==='none'||!head.style.maxHeight?'full':String(parseFloat(head.style.maxHeight)))}catch{}};
 let saved=null;try{saved=localStorage.getItem(KEY)}catch{}
 if(split&&head&&!readerMode){if(saved&&saved!=='full')apply(Number(saved));
  split.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();split.setPointerCapture(e.pointerId);document.body.classList.add('is-resizing-v');const y0=e.clientY,h0=document.body.classList.contains('heading-folded')?0:head.offsetHeight;
   const move=ev=>apply(h0+ev.clientY-y0);split.addEventListener('pointermove',move);split.addEventListener('pointerup',()=>{split.removeEventListener('pointermove',move);document.body.classList.remove('is-resizing-v');save()},{once:true})});
  const toggle=()=>{apply(document.body.classList.contains('heading-folded')?natural():0);save()};
  split.addEventListener('dblclick',toggle);
  split.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();toggle()}else if(['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const h=document.body.classList.contains('heading-folded')?0:head.offsetHeight;apply(h+(e.key==='ArrowDown'?40:-40));save()}});}}
// Editor dropdowns use the same searchable picker as the outline's "+ also".
// The native <select> stays the source of truth (values, validation, change
// events); the picker only replaces how it looks and is operated.
let pickOpen=null;
function closePick(){pickOpen?.btn.setAttribute('aria-expanded','false');pickOpen?.pop.remove();pickOpen=null}
function pickLabel(o){const m=/^([a-z][\w ]*?): (.*)$/i.exec(o.text);return m?`<span class="pick-type">${esc(m[1])}</span> ${esc(m[2])}`:esc(o.text)}
function enhanceSelect(sel){
 if(sel._pick)return;
 const btn=document.createElement('button');btn.type='button';btn.className='pick-button';btn.setAttribute('aria-haspopup','listbox');
 if(sel.id){const lab=document.querySelector(`label[for="${CSS.escape(sel.id)}"]`);if(lab)btn.setAttribute('aria-label',lab.textContent)}
 sel.classList.add('pick-native');sel.tabIndex=-1;sel.after(btn);
 const refresh=()=>{const o=sel.selectedOptions[0];btn.innerHTML=`<span class="pick-current">${o?pickLabel(o):'Choose…'}</span><span class="pick-caret" aria-hidden="true">▾</span>`;btn.disabled=sel.disabled};
 sel._pick={refresh};sel.addEventListener('change',refresh);refresh();
 const open=()=>{closePick();const opts=[...sel.options].filter(o=>!o.hidden&&!o.disabled),host=sel.closest('dialog')||document.body,pop=document.createElement('div');
  pop.className='pick-pop';pop.tabIndex=-1;pop.innerHTML=`${opts.length>7?'<input type="search" class="pick-search" placeholder="Type to find…" autocomplete="off" aria-label="Filter the list">':''}<ul class="pick-list" role="listbox"></ul>`;host.append(pop);
  const search=pop.querySelector('.pick-search');let active=Math.max(0,opts.findIndex(o=>o.selected)),shown=opts;
  const draw=()=>{const q=(search?.value||'').trim().toLowerCase();shown=opts.filter(o=>!q||o.text.toLowerCase().includes(q));active=Math.min(active,Math.max(0,shown.length-1));
   pop.querySelector('.pick-list').innerHTML=shown.map((o,i)=>`<li><button type="button" role="option" tabindex="-1" data-value="${esc(o.value)}" aria-selected="${o.selected}" class="${i===active?'is-active':''} ${o.selected?'is-current':''}">${pickLabel(o)}</button></li>`).join('')||'<li class="pick-none">Nothing matches.</li>';
   pop.querySelector('.is-active')?.scrollIntoView({block:'nearest'})};
  const choose=v=>{sel.value=v;sel.dispatchEvent(new Event('change',{bubbles:true}));refresh();closePick();btn.focus()};
  pop.addEventListener('click',e=>{const b=e.target.closest('[data-value]');if(b)choose(b.dataset.value)});
  pop.addEventListener('keydown',e=>{const n=shown.length;if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();active=(active+(e.key==='ArrowDown'?1:-1)+n)%Math.max(1,n);draw()}else if(e.key==='Enter'){e.preventDefault();const o=shown[active];if(o)choose(o.value)}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closePick();btn.focus()}else if(e.key==='Tab'){closePick()}});
  search?.addEventListener('input',()=>{active=0;draw()});
  draw();
  const r=btn.getBoundingClientRect(),h=pop.offsetHeight;pop.style.minWidth=r.width+'px';
  pop.style.left=Math.max(8,Math.min(r.left,innerWidth-pop.offsetWidth-8))+'px';
  pop.style.top=(r.bottom+4+h>innerHeight-8?Math.max(8,r.top-4-h):r.bottom+4)+'px';
  (search||pop).focus();pickOpen={pop,btn};btn.setAttribute('aria-expanded','true')};
 btn.addEventListener('click',()=>pickOpen?.btn===btn?closePick():open());
 btn.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();open()}});
}
document.addEventListener('mousedown',e=>{if(pickOpen&&!pickOpen.pop.contains(e.target)&&!pickOpen.btn.contains(e.target))closePick()},true);
// Enhance every dropdown the editor dialogs render.
new MutationObserver(()=>{$$('#editor select').forEach(enhanceSelect)}).observe($('#editor'),{childList:true,subtree:true});
$('#editor').addEventListener('close',closePick);
// Canvas selection. Shift/⌘-click toggles a card; in Author mode dragging on
// empty space draws a selection box (Shift adds to it) and Space+drag pans;
// dragging a selected card moves the whole group.
function toggleMulti(id){if(selected&&!multi.size)multi.add(selected);multi.has(id)?multi.delete(id):multi.add(id);selected=multi.size?[...multi].at(-1):null;if(multi.size===1)multi.clear();render()}
const canvasAt=(cx,cy)=>{const r=$('#canvas').getBoundingClientRect();return {x:(cx-r.left)/zoom,y:(cy-r.top)/zoom}};
function removeCards(ids){const gone=new Set(ids);board.nodes=board.nodes.filter(n=>!gone.has(n.id));board.links=board.links.filter(l=>!gone.has(l.from)&&!gone.has(l.to));board.steps=board.steps.filter(id=>!gone.has(id));multi.clear();selected=null;persist();render();notify(`${gone.size===1?'Card':gone.size+' cards'} deleted.`,{label:'Undo',run:()=>undo()})}
// Shift/⌘-click is also the browser's "extend text selection" gesture; stop
// it so adding a card doesn't flash-highlight the text between cards.
$('#viewport').addEventListener('mousedown',e=>{if((e.shiftKey||e.metaKey||e.ctrlKey)&&author&&!readerMode&&e.target.closest('#canvas [data-node]'))e.preventDefault()});
let dragMoved=false,spaceDown=false,dropGroup=null;
document.addEventListener('keydown',e=>{if(e.code==='Space'&&!e.target.matches('input,textarea,select,button,[contenteditable]')&&tab==='map'&&!walking){spaceDown=true;document.body.classList.add('space-pan');e.preventDefault()}});
document.addEventListener('keyup',e=>{if(e.code==='Space'){spaceDown=false;document.body.classList.remove('space-pan')}});
$('#viewport').addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('a,button'))return;const vp=$('#viewport'),el=e.target.closest('[data-node]'),n=el&&get(el.dataset.node);if(n&&!author)return;
 const sx=e.clientX,sy=e.clientY,sl=vp.scrollLeft,st=vp.scrollTop;dragMoved=false;
 const group=n&&!spaceDown?(multi.has(n.id)?[...multi].map(get).filter(Boolean):[n]):[];
 const origin=group.map(g=>({g,x:g.x,y:g.y,el:$(`#canvas [data-node="${CSS.escape(g.id)}"]`)}));
 const boxing=!n&&author&&!readerMode&&!spaceDown,adding=e.shiftKey||e.metaKey||e.ctrlKey;let box=null,hit=null,ghit=null;
 const move=ev=>{const dx=ev.clientX-sx,dy=ev.clientY-sy;if(Math.hypot(dx,dy)<4&&!dragMoved)return;dragMoved=true;
  if(group.length){for(const o of origin){o.g.x=o.x+dx/zoom;o.g.y=o.y+dy/zoom;const p=pos(o.g);if(o.el){o.el.style.left=p.x+'px';o.el.style.top=p.y+'px';o.el.classList.add('dragging')}}renderGroups();renderEdges();dropGroup=showGroupDrop(ev,{ids:group.map(g=>g.id)})}
  else if(boxing){const a=canvasAt(sx,sy),b=canvasAt(ev.clientX,ev.clientY),r={x:Math.min(a.x,b.x),y:Math.min(a.y,b.y),w:Math.abs(a.x-b.x),h:Math.abs(a.y-b.y)};
   if(!box){box=document.createElement('div');box.className='marquee';$('#canvas').append(box)}Object.assign(box.style,{left:r.x+'px',top:r.y+'px',width:r.w+'px',height:r.h+'px'});
   hit=new Set(adding?[...multi,...(selected?[selected]:[])]:[]);for(const m of visibleNodes()){const c=$(`#canvas [data-node="${CSS.escape(m.id)}"]`);if(!c)continue;const p=pos(m);if(p.x<r.x+r.w&&p.x+c.offsetWidth>r.x&&p.y<r.y+r.h&&p.y+c.offsetHeight>r.y)hit.add(m.id)}
   $$('#canvas [data-node]').forEach(c=>c.classList.toggle('selected',hit.has(c.dataset.node)));
   ghit=new Set(adding?groupSel:[]);for(const c of $$('#canvas .group-card'))if(c.offsetLeft<r.x+r.w&&c.offsetLeft+c.offsetWidth>r.x&&c.offsetTop<r.y+r.h&&c.offsetTop+c.offsetHeight>r.y)ghit.add(c.dataset.groupCard);$$('#canvas .group-card').forEach(c=>c.classList.toggle('selected',ghit.has(c.dataset.groupCard)))}
  else{vp.scrollLeft=sl-dx;vp.scrollTop=st-dy}};
 const up=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);
  if(group.length&&dragMoved){group.forEach(g=>delete g.auto);if(dropGroup){dropGroup.members=[...new Set([...dropGroup.members,...group.map(g=>g.id)])];if(dropGroup.collapsed){selected=null;multi.clear()}notify(`Added ${group.length>1?group.length+' cards to':'to'} “${dropGroup.label||'Untitled group'}”.`,{label:'Undo',run:()=>undo()})}persist();setTimeout(render,0)}dropGroup=null;
  if(boxing){box?.remove();if(dragMoved&&hit){const ids=[...hit];multi=new Set(ids.length>1?ids:[]);selected=ids.at(-1)||null;groupSel=new Set(ghit||[]);render()}else if(!dragMoved&&!adding&&(multi.size||selected||groupSel.size)){multi.clear();selected=null;groupSel.clear();render()}}
  setTimeout(()=>dragMoved=false,50)};
 window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});});
// Keyboard for the selection: Esc clears, ⌘A selects all, Delete removes.
document.addEventListener('keydown',e=>{if(readerMode||walking||tab!=='map'||$('dialog[open]')||e.target.matches('input,textarea,select,[contenteditable]'))return;
 if(e.key==='Escape'&&(multi.size||selected||groupSel.size)){multi.clear();selected=null;groupSel.clear();render()}
 else if(e.key==='Escape'&&focusGroup)focusOn(parentOf(groupById(focusGroup))?.id||'');
 else if(author&&(e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='g'&&(multi.size||selected||groupSel.size)){e.preventDefault();groupCards(selectionCards())}
 else if(author&&(e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='a'){e.preventDefault();multi=new Set(visibleNodes().map(n=>n.id));selected=[...multi].at(-1)||null;if(multi.size<2)multi.clear();groupSel=new Set($$('#canvas .group-card').map(c=>c.dataset.groupCard));render()}
 else if(author&&(e.key==='Delete'||e.key==='Backspace')&&(multi.size||(selected&&get(selected)))){e.preventDefault();removeCards(multi.size?[...multi]:[selected])}});
document.addEventListener('click',e=>{if(e.target.closest('[data-delete-multi]')&&!readerMode)removeCards([...multi])});
window.addEventListener('resize',()=>renderEdges());document.fonts.ready.then(renderEdges);document.addEventListener('load',e=>{if(e.target.tagName==='IMG')renderEdges()},true);
let history=[],future=[],lastSnapshot=JSON.stringify(board),unsaved=false;
let saveQueue=Promise.resolve(), saveBlocked=false, saveSerial=0;
function commitBoard(record=true) {
  if(readerMode)return;
  const content=structuredClone(board), current=JSON.stringify(content);
  if(record&&current!==lastSnapshot){history.push(lastSnapshot);if(history.length>25)history.shift();future=[]}
  lastSnapshot=current;unsaved=true;updateHistory();
  const serial=++saveSerial;
  $('#save-status').textContent='Saving to workspace…';
  saveQueue=saveQueue.then(async()=>{
    if(saveBlocked)throw new Error('Saving paused after a conflict. Save a board file before reloading.');
    session.record=await workspace.saveBoard(session.record.id,session.record.revision,content);
    if(serial===saveSerial){unsaved=false;$('#save-status').textContent='Saved in '+session.journey.name;}
    const option=$('#board-picker')?.selectedOptions[0];if(option)option.textContent=content.title==='What am I trying to establish?'?'Untitled question':content.title;
  }).catch(error=>{saveBlocked=true;$('#save-status').textContent='Not saved · export your board';notify(error.message);});
}
function updateHistory(){if($('#undo')){$('#undo').disabled=!history.length;$('#redo').disabled=!future.length}}
function undo(redo=false){const src=redo?future:history,dst=redo?history:future;if(!src.length)return;dst.push(JSON.stringify(board));board=JSON.parse(src.pop());lastSnapshot=JSON.stringify(board);selected=null;walking=false;commitBoard(false);render();notify(redo?'Change restored':'Change undone')}
function download(name,content,type='application/json'){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([content],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000)}
const filename=()=>board.title.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,65)||'evidence-board';
$('.top-actions').insertAdjacentHTML('afterbegin','<button id="new-board">＋ New board</button>');
$('#authorbar').insertAdjacentHTML('afterbegin','<button id="add-fact">＋ Fact</button>');
// One "+ Add" menu instead of a row of add buttons. The original buttons move
// into it, so their handlers and ids are unchanged.
{const bar=$('#authorbar');if(bar&&!readerMode){
 bar.insertAdjacentHTML('afterbegin','<div class="add-menu"><button id="add-toggle" aria-haspopup="menu" aria-expanded="false">＋ Add <span aria-hidden="true">▾</span></button><div class="add-menu-list" role="menu" hidden></div></div>');
 const list=bar.querySelector('.add-menu-list'),toggle=$('#add-toggle');
 const extra=(id,label,type)=>{const b=document.createElement('button');b.id=id;b.textContent=label;b.onclick=()=>openCard(type);return b};
 const items=[extra('add-note','Thought','note'),$('#add-fact'),$('#add-claim'),extra('add-conclusion','Conclusion','conclusion'),$('#add-gap'),$('#add-source')].filter(Boolean);
 const labels={'add-fact':'Fact','add-claim':'Claim','add-gap':'Open question','add-source':'Evidence · a quote or screenshot'};
 for(const b of items){if(labels[b.id])b.textContent=labels[b.id];b.setAttribute('role','menuitem');b.tabIndex=-1;list.append(b)}
 const setOpen=v=>{list.hidden=!v;toggle.setAttribute('aria-expanded',String(v));if(v)items[0].focus()};
 toggle.onclick=()=>setOpen(list.hidden);
 toggle.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();setOpen(true)}});
 list.addEventListener('click',e=>{if(e.target.closest('[role=menuitem]'))setOpen(false)});
 list.addEventListener('keydown',e=>{const i=items.indexOf(document.activeElement);if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();items[(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length].focus()}else if(e.key==='Escape'){e.preventDefault();setOpen(false);toggle.focus()}else if(e.key==='Tab')setOpen(false)});
 document.addEventListener('mousedown',e=>{if(!list.hidden&&!e.target.closest('.add-menu'))setOpen(false)});}}

$('#authorbar').insertAdjacentHTML('beforeend','<button id="layout-spacing">↔ Spacing</button><button id="order-steps">Order steps</button><button id="undo" aria-label="Undo change">↶</button><button id="redo" aria-label="Redo change">↷</button>');
$('#new-board').onclick=async()=>{
  await saveQueue;if(saveBlocked){notify('Save your board file and reload before switching boards.');return;}
  const record=await workspace.createBoard(session.journey.id);
  location.href='?'+new URLSearchParams({j:session.journey.id,b:record.id,author:'1',new:'1'});
};
$('#undo').onclick=()=>undo();$('#redo').onclick=()=>undo(true);
$('#export').onclick=()=>{download(filename()+'.evidence.json',JSON.stringify(board,null,2));notify('Board file saved, including screenshot crops and highlights')};
$('#import').onclick=()=>$('#import-file').click();
function validateBoard(input){
 const bad=msg=>{throw new Error(msg)};
 if(!input||input.version!==1||typeof input.title!=='string'||!Array.isArray(input.nodes)||!Array.isArray(input.links)||!Array.isArray(input.steps))bad('This is not a supported Evidence Walkthrough board.');
 if(input.nodes.length>500||input.links.length>2000||input.steps.length>500)bad('This board exceeds the 500-card limit.');
 const str=(s,max=30000)=>typeof s==='string'&&s.length<=max;const ids=new Set();
 const nodes=input.nodes.map(n=>{if(!n||!str(n.id,100)||ids.has(n.id)||!['note','fact','claim','conclusion','gap','evidence'].includes(n.type)||!str(n.text)||![n.x,n.y].every(v=>Number.isFinite(v)&&Math.abs(v)<=30000))bad('A card contains invalid data.');ids.add(n.id);
 const clean={id:n.id,type:n.type,text:n.text,x:n.x,y:n.y};for(const k of ['note','quote','url','tier','checked','route','dynamic','sourceCaptureId','sourcePageId','displayedQuote'])if(n[k]!==undefined){if(!str(n[k]))bad('Invalid card text.');clean[k]=n[k]}
 if(clean.type==='evidence'&&clean.note){const shown=/^Displayed text \(original not verified\): ([\s\S]*)$/m.exec(clean.note);if(shown&&!clean.displayedQuote)clean.displayedQuote=shown[1].trim();clean.note=clean.note.split('\n').filter(l=>!/^(Captured from a translated page view\.|Displayed text \(original not verified\):|Existing highlight: original\/translated view|Page access was restricted;|The original selection could not be revalidated;|Picked from the page text saved when you visited)/.test(l)).join('\n').trim()}
 if(n.capturedAt!==undefined){if(!Number.isFinite(n.capturedAt))bad('Invalid capture date.');clean.capturedAt=n.capturedAt;}
 if(n.provenance){const v=n.provenance;if(!v||!str(v.view,100)||!str(v.frameUrl||'',10000))bad('Invalid provenance.');clean.provenance={view:v.view,frameUrl:v.frameUrl||''};if(v.anchor){for(const k of ['exact','prefix','suffix'])if(!str(v.anchor[k]||''))bad('Invalid source anchor.');clean.provenance.anchor={exact:v.anchor.exact||'',prefix:v.anchor.prefix||'',suffix:v.anchor.suffix||''};}}
 if(clean.url&&!safeURL(clean.url))bad('Source links must start with https:// or http://.');
 for(const k of ['image','originalImage'])if(n[k]){if(!str(n[k],22000000)||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(n[k]))bad('Unsupported screenshot format.');clean[k]=n[k]}
 if(n.pdf)clean.pdf=true;if(n.auto===true)clean.auto=true;if(n.ord!==undefined){if(!Number.isFinite(n.ord))bad('Invalid outline order.');clean.ord=n.ord}if(n.page!==undefined){if(!Number.isInteger(Number(n.page))||n.page<1||n.page>100000)bad('Invalid PDF page.');clean.page=Number(n.page)}
 if(n.highlights!==undefined){if(!Array.isArray(n.highlights)||n.highlights.length>200)bad('Invalid highlights.');clean.highlights=n.highlights.map(h=>{if(!h||!['x','y','w','h'].every(k=>Number.isFinite(h[k])&&h[k]>=0&&h[k]<=1)||h.x+h.w>1.001||h.y+h.h>1.001)bad('Invalid highlight coordinates.');return {x:h.x,y:h.y,w:h.w,h:h.h}})}return clean;});
 const linkIds=new Set();const links=input.links.map(l=>{if(!l||!str(l.id,100)||linkIds.has(l.id)||!ids.has(l.from)||!ids.has(l.to)||l.from===l.to||!(['because','so','and','but','objection','question','answer'].includes(l.word)||['supports','challenges','reasoning','questions'].includes(l.kind))||!str(l.label||'',500))bad('A connection contains invalid data.');linkIds.add(l.id);const r=l.word?{id:l.id,from:l.from,to:l.to,word:l.word,label:l.label||''}:fromLegacy(l);const type=id=>nodes.find(n=>n.id===id).type;r.word=fitWord(type(r.from),type(r.to),r.word);return r});
 if(input.groups!==undefined&&(!Array.isArray(input.groups)||input.groups.length>200))bad('Invalid groups.');const groups=(input.groups||[]).map(g=>{if(!g||!str(g.id,100)||!str(g.label||'',300)||!Array.isArray(g.members)||g.groups!==undefined&&!Array.isArray(g.groups))bad('Invalid group.');return {id:g.id,label:g.label||'',members:[...new Set(g.members.filter(id=>ids.has(id)))],groups:[...new Set((g.groups||[]).filter(id=>typeof id==='string'))],color:Number.isInteger(g.color)&&g.color>=0?g.color%6:0,...(g.collapsed===true?{collapsed:true}:{}),...(typeof g.face==='string'&&ids.has(g.face)?{face:g.face}:{})}});
 // Groups nest as a tree: one parent each, no loops, no missing children.
 {const gid=new Set(groups.map(g=>g.id)),parent=new Map();for(const g of groups)g.groups=g.groups.filter(k=>gid.has(k)&&k!==g.id&&!parent.has(k)&&(parent.set(k,g.id),true));
  for(const g of groups){const seen=new Set([g.id]);for(let p=parent.get(g.id);p;p=parent.get(p)){if(seen.has(p)){const owner=groups.find(x=>x.id===parent.get(g.id));owner.groups=owner.groups.filter(k=>k!==g.id);parent.delete(g.id);break}seen.add(p)}}}
 const nonEmpty=g=>g.members.length||g.groups.some(k=>nonEmpty(groups.find(x=>x.id===k)));for(let i=0;i<2;i++){const keep=groups.filter(nonEmpty);for(const g of keep)g.groups=g.groups.filter(k=>keep.some(x=>x.id===k));groups.splice(0,groups.length,...keep)}
 if(!input.steps.every(id=>ids.has(id))||new Set(input.steps).size!==input.steps.length)bad('Invalid walkthrough sequence.');
 return {version:1,title:input.title.slice(0,500),subtitle:str(input.subtitle)?input.subtitle:'',sample:input.sample===true,answerId:typeof input.answerId==='string'&&nodes.some(n=>n.id===input.answerId&&n.type==='conclusion')?input.answerId:undefined,kind:input.kind==='trade'?'trade':'freelance',profit:input.profit==='above'?'above':'below',nodes,links,steps:[...input.steps],groups};
}
// A connection's kind follows from the card it starts at: a quote is a source
// for (or against) something, a question raises a question, anything else is
// a reason for (or against) it. Declared as functions so loading can use them.
// Connections are stored in reading order, "[from] word [to]", and the word
// alone says what supports what. One word per circumstance.
function allowedWords(fromType,toType){return toType==='gap'?['question','and','but']:fromType==='gap'?['answer','and','but']:['because','so','and','but','objection']}
function fitWord(fromType,toType,w){const a=allowedWords(fromType,toType);return a.includes(w)?w:a[0]}
// Boards saved before reading order stored who-supports-whom; they read the
// way the outline showed them: the supported line, then its reason.
function fromLegacy(l){return {id:l.id,from:l.to,to:l.from,word:{challenges:'objection',questions:'question'}[l.kind]||'because',label:l.label||''}}
// What a connection means, independent of reading order.
function linkRole(l){switch(l.word){case 'because':return {supporter:l.to,supported:l.from};case 'so':return {supporter:l.from,supported:l.to};case 'objection':return {objector:l.to,target:l.from};case 'question':return {question:l.to,about:l.from};case 'answer':return {answer:l.to,question:l.from};default:return {}}}
// How a connection reads from its first card to its second.
function wordLabel(word,toType,again=false){if(word==='because')return toType==='evidence'?(again?'and as the source says':'as the source says'):(again?'and because':'because');if(word==='objection')return toType==='evidence'?(again?'another objection, from the source':'one objection, from the source'):(again?'another objection':'one objection');if(word==='question')return again?'which also raises the question':'which raises the question';return word}
const WORD_CHOICES=[['because','because'],['so','so'],['and','and'],['but','but'],['objection','one objection'],['question','which raises the question'],['answer','answer']];
$('#import-file').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{if(file.size>40*1024*1024)throw new Error('Please choose a board file smaller than 40 MB.');const next=validateBoard(JSON.parse(await file.text()));await saveQueue;if(saveBlocked)throw new Error('Save the current board file and reload first.');const imported=await workspace.createBoard(session.journey.id,next);session.record=imported;session.boards.push(imported);window.history.replaceState(null,'','?'+new URLSearchParams({j:session.journey.id,b:imported.id}));history=[];future=[];board=next;lastSnapshot=JSON.stringify(board);refreshPicker();selected=null;walking=false;tab='map';allRoutes=false;$('#all-routes').checked=false;persist();render();notify('Imported as a new board in this workspace.')}catch(err){notify(err.message||'Could not read this board file.')}finally{e.target.value=''}};
let editorMode='',editingId=null,capture={image:'',originalImage:'',highlights:[]},captureMode='highlight',cropRect=null,captureBusy=false;
// The source link reads as a link (one click opens the source) with an
// Edit button; the field underneath stays the value that gets saved.
const urlField=url=>{const safe=safeURL(url);return `<label class="form-label" for="card-url">Source URL</label>${safe?`<div class="url-view" id="url-view"><a href="${esc(safe)}" target="_blank" rel="noopener noreferrer">${esc(safe.replace(/^https?:\/\/(www\.)?/,''))} ↗</a><button type="button" class="edit-affordance" data-edit-url>✎ Edit</button></div>`:''}<input id="card-url" type="url" value="${esc(url)}" ${safe?'hidden':''}>`};
document.addEventListener('click',e=>{if(!e.target.closest('[data-edit-url]'))return;$('#url-view')?.remove();const f=$('#card-url');if(f){f.hidden=false;f.focus();f.select()}});
const input=(id,label,value='',type='text',required=false)=>`<label class="form-label" for="${id}">${label}</label><input id="${id}" type="${type}" value="${esc(value)}" ${required?'required':''}>`;
const area=(id,label,value='',required=false)=>`<label class="form-label" for="${id}">${label}</label><textarea id="${id}" rows="3" ${required?'required':''}>${esc(value)}</textarea>`;
const options=(values,current)=>values.map(([v,l])=>`<option value="${esc(v)}" ${v===current?'selected':''}>${esc(l)}</option>`).join('');
function showEditor(title,html,mode){editorMode=mode;$('#editor-delete').hidden=true;$('#editor-title').textContent=title;$('#editor-fields').innerHTML=html;$('#form-error').textContent='';$('#editor-form button[type=submit]').textContent=mode==='order'?'Save order':'Save to board';$('#editor').showModal()}
function openSpacing(){
 let dialog=$('#spacing-dialog');
 if(!dialog){dialog=document.createElement('dialog');dialog.id='spacing-dialog';document.body.append(dialog)}
 const n=get(selected);
 dialog.innerHTML=`<div class="dialog-heading"><h2>Arrange cards</h2><button data-close aria-label="Close spacing">✕</button></div><p class="form-help">Drag any card in Author mode. For precise movement, focus a card and use arrow keys (10 px), or Shift + arrows (50 px).</p>
 ${n?`<fieldset><legend>Selected card</legend><p>${esc(wording(n))}</p><div class="form-row"><div>${input('position-x','Left (px)',Math.round(n.x),'number')}</div><div>${input('position-y','Top (px)',Math.round(n.y),'number')}</div></div><button id="apply-position">Move card</button></fieldset>`:''}
 <fieldset><legend>Space visible columns</legend><p class="form-help">Cards with left edges within 80 px are treated as a column. Keeps column order and each column’s top-to-bottom order. Hidden routes stay unchanged.</p><div class="form-row"><div>${input('column-gap','Between columns (px)',140,'number')}</div><div>${input('row-gap','Between cards (px)',80,'number')}</div></div><p class="form-help">Measured from card edges, including tall evidence cards. Apply once; Undo restores the previous layout.</p><button id="apply-spacing">Apply spacing</button></fieldset><p id="spacing-error" class="error" role="alert"></p>`;
 dialog.querySelectorAll('input').forEach(el=>{el.min=0;el.max=10000;el.step=10});
 const value=id=>{const el=$(id),v=Number(el.value);if(!el.value.trim()||!Number.isFinite(v)||v<0||v>10000)throw new Error('Use a distance between 0 and 10,000 px.');return v};
 $('#apply-position')?.addEventListener('click',()=>{try{const x=value('#position-x'),y=value('#position-y');Object.assign(n,{x,y});delete n.auto;persist();render();dialog.close();select(n.id,true)}catch(e){$('#spacing-error').textContent=e.message}});
 $('#apply-spacing').onclick=()=>{try{
 const gapX=value('#column-gap'),gapY=value('#row-gap');
 const nodes=visibleNodes().map(n=>{const el=$(`#canvas [data-node="${CSS.escape(n.id)}"]`);return {n,w:el?.offsetWidth||300,h:el?.offsetHeight||200}});
 if(!nodes.length)throw new Error('Add cards before adjusting spacing.');
 const positions=spacedPositions(nodes,gapX,gapY);
 positions.forEach(({n,x,y})=>{Object.assign(n,{x,y});delete n.auto});persist();render();dialog.close();notify('Spacing applied. Undo restores the previous layout.');
 }catch(e){$('#spacing-error').textContent=e.message}};
 dialog.showModal();
}
function spacedPositions(nodes,gapX,gapY){
 const columns=[];
 for(const item of [...nodes].sort((a,b)=>a.n.x-b.n.x||a.n.y-b.n.y)){
  let column=columns.at(-1);
  if(!column||item.n.x-column.left>80){column={left:item.n.x,items:[]};columns.push(column)}
  column.items.push(item);
 }
 let x=Math.min(...nodes.map(({n})=>n.x));const result=[];
 for(const column of columns){
  let y=Math.min(...column.items.map(({n})=>n.y));
  for(const {n,h} of column.items.sort((a,b)=>a.n.y-b.n.y)){
   result.push({n,x,y});y+=h+gapY;
  }
  x+=Math.max(...column.items.map(item=>item.w))+gapX;
 }
 return result;
}
$('#layout-spacing').onclick=openSpacing;
function openTitle(){showEditor('Your base question',input('title-text','The question this board answers',board.title,'text',true)+area('subtitle-text','Context or scope',board.subtitle),'title')}
$('#edit-title').onclick=openTitle;$('#edit-heading').onclick=openTitle;
for(const el of [$('#board-title'),$('.subtitle'),$('#verdict')]){
 const edit=()=>{if(!author||readerMode)return;const g=focusGroup&&groupById(focusGroup);if(g){if(el.id==='verdict'){const f=faceOf(g);if(f)activateCard(f.id)}else if(el.id==='board-title')renameGroup(g.id);return}if(el.id==='verdict'){const n=mainConclusion();if(n)activateCard(n.id)}else openTitle()};
 el.onclick=edit;el.onkeydown=e=>{if(['Enter',' '].includes(e.key)&&author&&!readerMode){e.preventDefault();edit()}};
}
function openCard(type='claim',id=null){queueMicrotask(()=>{const del=$('#editor-delete');if(!id||!get(id))return;del.hidden=false;del.onclick=()=>{$('#editor').close();removeCards([id])}});const n=id?get(id):null;editingId=id;capture={image:n?.image||'',originalImage:n?.originalImage||n?.image||'',highlights:structuredClone(n?.highlights||[])};cropRect=null;captureMode='highlight';
 const shared=area('card-note',type==='evidence'?'Translation, context or annotation':'Notes, assumptions or reasoning',n?.note||'')+(board.sample?`<label class="form-label" for="card-route">Case route</label><select id="card-route">${options([['','All routes'],['A','Trade licence'],['B','Freelance · above threshold'],['C','Freelance · at or below threshold']],n?.route||(!n?route():''))}</select>`:'');
 if(type==='evidence'){showEditor(id?'Edit evidence':'Attach evidence',(n?.sourceCaptureId?'<p class="form-help">Editing this board’s copy. The original capture in your inbox stays unchanged.</p>':'')+input('card-text','Source title',n?.text||'','text',true)+urlField(n?.url||'')+(n?.displayedQuote&&!n.quote?`<div class="notice"><b>Captured text · original not verified</b><p>${esc(n.displayedQuote)}</p><small>You can keep this as captured evidence. Paste verified original wording below only after checking the source.</small></div>`:'')+area('card-quote','Exact passage (creates a highlighted deep link)',n?.quote||'')+'<p class="form-help">Paste the exact original wording. The source URL is kept with the screenshot; no page is fetched automatically.</p>'+shared+`<div class="form-row"><div><label class="form-label" for="card-tier">Source authority · your assessment</label><select id="card-tier">${options([['Unreviewed','Unreviewed'],['Primary','Primary'],['Secondary','Secondary']],n?.tier||'Unreviewed')}</select></div><div>${input('card-checked','Date checked',n?.checked||'','date')}</div></div><div class="form-row"><div><label class="form-label check-label"><input type="checkbox" id="card-pdf" ${n?.pdf?'checked':''}> This source is a PDF</label></div><div>${input('card-page','PDF page (optional)',n?.page||'','number')}</div></div><label class="form-label" for="capture-file">Screenshot · upload or paste an image</label><input type="file" id="capture-file" accept="image/png,image/jpeg,image/webp"><p class="form-help">PNG, JPEG or WebP, up to 12 MB. Drag over the image to highlight or crop. Images stay in your board.</p><div id="capture-tools"></div>`,'card');$('#capture-file').onchange=async e=>{if(e.target.files[0])await readImage(e.target.files[0]);e.target.value=''};renderCapture();}
 else showEditor(id?'Edit card':'Add '+(type==='gap'?'open question':type),`<label class="form-label" for="card-type">Card type</label><select id="card-type">${options([['note','Thought (not sorted yet)'],['fact','Fact'],['claim','Claim'],['conclusion','Conclusion'],['gap','Open question']],n?.type||type)}</select>`+area('card-text','Text',n?wording(n):'',true)+shared,'card');
}
$('#add-claim').onclick=()=>openCard('claim');$('#add-fact').onclick=()=>openCard('fact');$('#add-gap').onclick=()=>openCard('gap');$('#add-source').onclick=()=>openCard('evidence');
function openConnection(id,linkId=null){const l=linkId&&board.links.find(l=>l.id===linkId),n=get(id);editingId=linkId;const opts=board.nodes.map(n=>[n.id,(({gap:'question',note:'thought',evidence:'quote'})[n.type]||n.type)+': '+(wording(n)||n.quote||'').slice(0,85)]);showEditor(l?'Edit connection':'Connect two cards',`<label class="form-label" for="link-from">From</label><select id="link-from">${options(opts,l?.from||id)}</select><label class="form-label" for="link-kind">…then the word you'd say between them</label><select id="link-kind">${options(WORD_CHOICES,l?.word||'because')}</select><label class="form-label" for="link-to">To</label><select id="link-to">${options(opts,l?.to||board.nodes.find(n=>n.id!==id)?.id)}</select>`+input('link-label','Why are these connected?',l?.label||'')+'<p class="form-help">Connections are authored by you. “Is a source for” does not verify a claim. Objections stay visible until you edit or remove the connection.</p>','connection');$('#link-from').onchange=syncLinkKinds;$('#link-to').onchange=syncLinkKinds;syncLinkKinds()}
function syncLinkKinds(){const sel=$('#link-kind'),allowed=allowedWords(get($('#link-from').value)?.type,get($('#link-to').value)?.type);for(const o of sel.options)o.hidden=o.disabled=!allowed.includes(o.value);if(!allowed.includes(sel.value))sel.value=allowed[0];sel._pick?.refresh()}
let draftSteps=[];
function openOrder(){draftSteps=[...board.steps];showEditor('Arrange the walkthrough','<p class="form-help">These steps define the reading order. Sample-case routes only show their applicable steps.</p><div id="step-order"></div>','order');renderOrder()}
function renderOrder(){$('#step-order').innerHTML=draftSteps.map((id,i)=>`<div class="order-row"><span>${String(i+1).padStart(2,'0')}</span><p>${esc(wording(get(id)))}</p><button type="button" data-order-up="${i}" aria-label="Move step ${i+1} up" ${i===0?'disabled':''}>↑</button><button type="button" data-order-down="${i}" aria-label="Move step ${i+1} down" ${i===draftSteps.length-1?'disabled':''}>↓</button><button type="button" data-order-remove="${i}" aria-label="Remove step ${i+1}">✕</button></div>`).join('')+`<label class="form-label" for="step-add">Add another card</label><div class="form-row"><select id="step-add">${options(board.nodes.filter(n=>!draftSteps.includes(n.id)).map(n=>[n.id,wording(n).slice(0,80)]),'')}</select><button type="button" id="step-add-button" ${draftSteps.length===board.nodes.length?'disabled':''}>Add step</button></div>`}
$('#order-steps').onclick=openOrder;
document.addEventListener('click',e=>{const el=e.target.closest('button');if(!el)return;const d=el.dataset;if('close'in d)el.closest('dialog').close();else if(d.inspectCard){select(d.inspectCard)}else if(d.edit&&!readerMode){author=true;render();openCard(get(d.edit).type,d.edit);}else if(d.connect)openConnection(d.connect);else if(d.editLink)openConnection(null,d.editLink);else if(d.delete){removeCards([d.delete])}else if(d.removeLink){board.links=board.links.filter(l=>l.id!==d.removeLink);persist();render()}else if(d.step){board.steps=board.steps.includes(d.step)?board.steps.filter(id=>id!==d.step):[...board.steps,d.step];persist();render()}else if(d.inspectImage)inspectImage(d.inspectImage);else if(d.copyLink)copyText(deepLink(get(d.copyLink)));else if('orderUp'in d||'orderDown'in d){const i=Number(d.orderUp??d.orderDown),j=i+('orderUp'in d?-1:1);[draftSteps[i],draftSteps[j]]=[draftSteps[j],draftSteps[i]];renderOrder()}else if('orderRemove'in d){draftSteps.splice(Number(d.orderRemove),1);renderOrder()}else if(el.id==='step-add-button'){const id=$('#step-add').value;if(id&&!draftSteps.includes(id)){draftSteps.push(id);renderOrder()}}});
$('#editor-form').onsubmit=e=>{e.preventDefault();try{if(editorMode==='title'){const title=$('#title-text').value.trim();if(!title)throw new Error('Give this board a question or title.');board.title=title;board.subtitle=$('#subtitle-text').value.trim()}
 else if(editorMode==='order')board.steps=[...draftSteps];
 else if(editorMode==='connection'){const from=$('#link-from').value,to=$('#link-to').value,word=$('#link-kind').value;if(!get(from)||!get(to)||from===to)throw new Error('Choose two different cards.');if(!allowedWords(get(from).type,get(to).type).includes(word))throw new Error('That word doesn’t fit these two cards. Pick another word, or change a card’s type.');const link={id:editingId||uid(),from,to,word,label:$('#link-label').value.trim()};if(board.links.some(l=>l.id!==editingId&&l.from===from&&l.to===to))throw new Error('These cards are already connected. Edit that connection instead.');if(editingId)board.links=board.links.map(l=>l.id===editingId?link:l);else board.links.push(link)}
 else{if(captureBusy)throw new Error('Wait for the image to finish loading.');const prior=editingId&&get(editingId),type=$('#card-type')?.value||'evidence',text=$('#card-text').value.trim();if(!text)throw new Error('Add text or a source title.');const vp=$('#viewport'),place=freePosition();const n={...(prior||{}),id:editingId||uid(),type,text,note:$('#card-note').value.trim(),x:prior?.x??place.x,y:prior?.y??place.y};delete n.dynamic;n.route=$('#card-route')?.value||'';
 if(type==='evidence'){const url=$('#card-url').value.trim();if(url&&!safeURL(url))throw new Error('Use an http:// or https:// source URL.');Object.assign(n,{url,quote:$('#card-quote').value.trim(),tier:$('#card-tier').value,checked:$('#card-checked').value,pdf:$('#card-pdf').checked,...capture});delete n.page;const page=$('#card-page').value;if(page){if(!Number.isInteger(Number(page))||Number(page)<1)throw new Error('PDF page must be a positive whole number.');n.page=Number(page)}if(!n.quote&&!n.image&&!n.displayedQuote)throw new Error('Paste a passage or attach a screenshot.');}
 if(prior)board.nodes=board.nodes.map(x=>x.id===editingId?n:x);else {board.nodes.push(n);if(!['evidence','note'].includes(type))board.steps.push(n.id)}if(prior&&prior.type==='note'&&!['evidence','note'].includes(type)&&!board.steps.includes(n.id))board.steps.push(n.id);board.links.forEach(l=>{if(l.from===n.id||l.to===n.id)l.word=fitWord(get(l.from).type,get(l.to).type,l.word)});selected=n.id;
 }persist();$('#editor').close();render();notify('Saved to board');}catch(err){$('#form-error').textContent=err.message}};
async function readImage(file){captureBusy=true;try{if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Choose a PNG, JPEG or WebP image.');if(file.size>12*1024*1024)throw new Error('Choose an image smaller than 12 MB.');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file)});const img=await loadImage(data);if(img.width*img.height>45000000)throw new Error('This image is too large. Use a smaller screenshot.');const ratio=Math.min(1,3000/img.width,9000/img.height);const c=document.createElement('canvas');c.width=Math.round(img.width*ratio);c.height=Math.round(img.height*ratio);c.getContext('2d').drawImage(img,0,0,c.width,c.height);const normalized=c.toDataURL('image/png');capture={image:normalized,originalImage:normalized,highlights:[]};cropRect=null;renderCapture();}catch(err){$('#form-error').textContent=err.message||'Unable to read this screenshot.'}finally{captureBusy=false}}
const loadImage=src=>new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('The screenshot could not be decoded.'));i.src=src});
function renderCapture(){const box=$('#capture-tools');if(!box)return;box.innerHTML=capture.image?`<div class="capture-actions"><button type="button" id="highlight-mode" ${captureMode==='highlight'?'class="dark"':''}>Highlight</button><button type="button" id="crop-mode" ${captureMode==='crop'?'class="dark"':''}>Crop</button><button type="button" id="apply-crop" ${!cropRect?'disabled':''}>Apply crop</button><button type="button" id="undo-highlight" ${!capture.highlights.length?'disabled':''}>Undo highlight</button><button type="button" id="reset-crop">Full image</button><button type="button" id="remove-image">Remove image</button></div><p class="form-help">${captureMode==='crop'?'Drag a rectangle, then choose Apply crop.':'Drag over the exact area you want to highlight.'}</p><div class="capture-preview" id="capture-preview"><img draggable="false" src="${esc(capture.image)}" alt="Evidence screenshot being annotated">${capture.highlights.map(h=>`<span class="highlight" style="left:${h.x*100}%;top:${h.y*100}%;width:${h.w*100}%;height:${h.h*100}%"></span>`).join('')}${cropRect?rectHTML(cropRect,'crop-selection'):''}</div>`:'';
 if(!capture.image)return;
 $('#highlight-mode').onclick=()=>{captureMode='highlight';cropRect=null;renderCapture()};$('#crop-mode').onclick=()=>{captureMode='crop';renderCapture()};$('#undo-highlight').onclick=()=>{capture.highlights.pop();renderCapture()};$('#reset-crop').onclick=()=>{capture.image=capture.originalImage;capture.highlights=[];cropRect=null;renderCapture()};$('#remove-image').onclick=()=>{capture={image:'',originalImage:'',highlights:[]};renderCapture()};$('#apply-crop').onclick=async()=>{if(!cropRect||captureBusy)return;captureBusy=true;try{const img=await loadImage(capture.image),r=cropRect,c=document.createElement('canvas');c.width=Math.max(1,Math.round(r.w*img.width));c.height=Math.max(1,Math.round(r.h*img.height));c.getContext('2d').drawImage(img,r.x*img.width,r.y*img.height,r.w*img.width,r.h*img.height,0,0,c.width,c.height);capture.image=c.toDataURL('image/png');capture.highlights=capture.highlights.map(h=>{const x=Math.max(h.x,r.x),y=Math.max(h.y,r.y),x2=Math.min(h.x+h.w,r.x+r.w),y2=Math.min(h.y+h.h,r.y+r.h);return {x:(x-r.x)/r.w,y:(y-r.y)/r.h,w:(x2-x)/r.w,h:(y2-y)/r.h}}).filter(h=>h.w>0&&h.h>0);cropRect=null;renderCapture()}catch(err){$('#form-error').textContent=err.message}finally{captureBusy=false}};
 $('#capture-preview').onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();const el=e.currentTarget,b=el.getBoundingClientRect(),clamp=v=>Math.min(1,Math.max(0,v)),sx=clamp((e.clientX-b.left)/b.width),sy=clamp((e.clientY-b.top)/b.height);let r=null;const temp=document.createElement('span');temp.className=captureMode==='crop'?'crop-selection':'highlight';el.append(temp);el.setPointerCapture(e.pointerId);el.onpointermove=ev=>{const x=clamp((ev.clientX-b.left)/b.width),y=clamp((ev.clientY-b.top)/b.height);r={x:Math.min(x,sx),y:Math.min(y,sy),w:Math.abs(x-sx),h:Math.abs(y-sy)};Object.assign(temp.style,{left:r.x*100+'%',top:r.y*100+'%',width:r.w*100+'%',height:r.h*100+'%'})};el.onpointerup=()=>{el.onpointermove=null;el.onpointerup=null;if(r&&r.w>.005&&r.h>.005){if(captureMode==='crop')cropRect=r;else capture.highlights.push(r)}renderCapture()};el.onpointercancel=()=>renderCapture()};
}
const rectHTML=(r,cls)=>`<span class="${cls}" style="left:${r.x*100}%;top:${r.y*100}%;width:${r.w*100}%;height:${r.h*100}%"></span>`;
function freePosition(){const vp=$('#viewport'),x0=Math.round(viewAt().x+40),y0=Math.round(viewAt().y+90);for(let row=0;row<100;row++){for(let col=0;col<3;col++){const x=x0+col*370,y=y0+row*540;const overlaps=board.nodes.filter(active).some(n=>{const el=$(`#canvas [data-node="${CSS.escape(n.id)}"]`),w=el?.offsetWidth||300,h=el?.offsetHeight||400;return x<n.x+w+30&&x+330>n.x&&y<n.y+h+30&&y+450>n.y});if(!overlaps)return {x,y}}}return {x:x0,y:Math.max(0,...board.nodes.map(n=>n.y))+600}}
function inspectImage(id){const n=get(id);if(!n?.image)return;let dialog=$('#image-dialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='image-dialog';document.body.append(dialog)}let scale=1,original=false;const draw=()=>{dialog.innerHTML=`<div class="dialog-heading"><h2>${esc(n.text)}</h2><button data-close aria-label="Close screenshot">✕</button></div><div class="capture-actions"><button id="image-smaller">− Zoom</button><button id="image-larger">＋ Zoom</button>${n.originalImage?'<button id="image-context">'+(original?'Show annotated crop':'Show full context')+'</button>':''}</div><div class="image-scroll"><div style="width:${Math.round(100*scale)}%">${figure(original?{...n,image:n.originalImage,highlights:[]}:n)}</div></div>`;$('#image-smaller').onclick=()=>{scale=Math.max(.5,scale-.5);draw()};$('#image-larger').onclick=()=>{scale=Math.min(4,scale+.5);draw()};if($('#image-context'))$('#image-context').onclick=()=>{original=!original;draw()}};draw();dialog.showModal()}
document.addEventListener('paste',async e=>{if(!$('#editor').open||editorMode!=='card'||!$('#capture-tools'))return;const item=[...(e.clipboardData?.items||[])].find(i=>i.type.startsWith('image/'));if(item){e.preventDefault();await readImage(item.getAsFile())}});
function brief(){const lines=['# '+board.title,board.subtitle||'','Authored evidence map. Connections express the author’s reasoning; they do not independently verify claims.',''];for(const [i,n] of sequence().entries()){lines.push(`## ${i+1}. ${wording(n)}`,`Type: ${n.type}`,n.note||'');const related=board.links.filter(l=>l.to===n.id||l.from===n.id);if(n.type==='evidence')lines.push(n.quote?'Passage: '+n.quote:'',deepLink(n));for(const l of related){const other=get(l.from===n.id?l.to:l.from);if(!other)continue;lines.push(`${l.from===n.id?'This, '+wordLabel(l.word,other.type):'“'+wording(other)+'”, '+wordLabel(l.word,n.type)+' this'}${l.label?' ('+l.label+')':''}: ${wording(other)}`);if(other.type==='evidence')lines.push(other.quote?'Passage: '+other.quote:'',`Source: ${deepLink(other)}`,`Authority (author-assigned): ${other.tier||'Unreviewed'}; checked: ${other.checked||'not recorded'}`,other.image?'Screenshot and highlights included in the companion board file.':'')}lines.push('')}lines.push('## Other cards',...board.nodes.filter(n=>active(n)&&!sequence().some(s=>s.id===n.id)&&n.type!=='evidence').map(n=>`- [${n.type}] ${wording(n)}`),'','## Source register',...board.nodes.filter(n=>n.type==='evidence'&&active(n)).map(n=>`- ${n.text}: ${deepLink(n)} (checked ${n.checked||'not recorded'})`));return lines.filter(l=>l!==undefined).join('\n')}
$('#share').onclick=()=>{$('#brief-text').value=brief();$('#brief-dialog').showModal()};
$('#brief-dialog .dialog-actions').insertAdjacentHTML('afterbegin','<button id="export-reader">Interactive reader .html</button>');
$('#export-reader').onclick=async()=>{try{const [html,css,js,theme]=await Promise.all(['index.html','style.css','app.js','../shared/theme.css'].map(async p=>{const r=await fetch(p);if(!r.ok)throw new Error('Could not prepare the reader export.');return r.text()}));const publicBoard=structuredClone(board);publicBoard.nodes.forEach(n=>{delete n.originalImage;delete n.sourceCaptureId;delete n.sourcePageId;if(n.provenance?.anchor)delete n.provenance.anchor;});const end='</scr'+'ipt>';const seed=JSON.stringify(publicBoard).replace(/</g,'\\u003c');const out=html.replace('<link rel="stylesheet" href="../shared/theme.css">','').replace('<link rel="stylesheet" href="style.css">',()=>'<style>'+css+'\n'+theme+'</style>').replace('<script type="module" src="app.js">'+end,()=>'<script type="application/json" id="seed-board">'+seed+end+'<script type="module">'+js+end);download(filename()+'.reader.html',out,'text/html');notify('Interactive reader saved. It includes the visible screenshot crops.')}catch(err){notify(err.message)}};
async function copyText(text){try{await navigator.clipboard.writeText(text);notify('Copied')}catch{notify('Clipboard unavailable. Select and copy the text manually.')}}
$('#copy-brief').onclick=()=>copyText($('#brief-text').value);$('#download-brief').onclick=()=>download(filename()+'.md',$('#brief-text').value,'text/markdown');$('#print-brief').onclick=()=>{let el=$('#print-output');if(!el){el=document.createElement('pre');el.id='print-output';el.hidden=true;document.body.append(el)}el.textContent=$('#brief-text').value;window.print()};
window.addEventListener('beforeunload',e=>{if(unsaved){e.preventDefault();e.returnValue=''}});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!e.target.matches('input,textarea,select,[contenteditable]')&&!$('dialog[open]')){e.preventDefault();undo(e.shiftKey)}if(e.target.matches('#canvas [data-node]')&&author&&!readerMode&&!walking&&!$('dialog[open]')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const n=get(e.target.dataset.node),amount=e.shiftKey?50:10;for(const m of (multi.has(n.id)?[...multi].map(get).filter(Boolean):[n])){delete m.auto;m.x=(m.x+(e.key==='ArrowLeft'?-amount:e.key==='ArrowRight'?amount:0));m.y=(m.y+(e.key==='ArrowUp'?-amount:e.key==='ArrowDown'?amount:0))}persist();render();$(`#canvas [data-node="${CSS.escape(n.id)}"]`)?.focus()}});
if(readerMode){['#new-board','#import','#export','#export-reader','.segmented'].forEach(s=>$(s).hidden=true);$('#save-status').textContent='Shared reader · read only';}
else await initializeWorkspaceUI();
if(document.modelContext?.registerTool){const life=new AbortController();for(const tool of [{name:'read_evidence_board',title:'Read evidence board',description:'Read authored cards, relationships and walkthrough order without modifying the board.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:()=>({title:board.title,nodes:board.nodes.map(({image,originalImage,...n})=>({...n,hasScreenshot:!!image})),links:board.links,steps:board.steps})},{name:'inspect_evidence_card',title:'Inspect evidence card',description:'Select an existing card and reveal its details in the visible board. Does not edit content.',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:input=>{if(!input||typeof input.id!=='string'||!get(input.id))throw new Error('Unknown card ID');walking=false;tab='map';select(input.id,true);return {selected:input.id}}}]){try{Promise.resolve(document.modelContext.registerTool(tool,{signal:life.signal})).catch(()=>{})}catch{}}window.addEventListener('pagehide',()=>life.abort(),{once:true})}
// Narrow bridge for the optional modules (guided tour, local-AI drafting).
// They change the board only through these functions, so undo and saving
// behave exactly as they do for manual edits.
const api={get board(){return board},get session(){return session},workspace,get,uid,esc,notify,render,persist,freePosition,select,validateBoard,
 async flush(){await saveQueue;if(saveBlocked)throw new Error('Save your board file and reload before switching boards.');},
 setAuthor(v){author=!!v;render()},get inboxOpen(){return inboxOpen},setInbox(v){inboxOpen=!!v;render()},get zoom(){return zoom},canvasPoint(cx,cy){const r=$('#canvas').getBoundingClientRect();return {x:Math.round((cx-r.left)/zoom),y:Math.round((cy-r.top)/zoom)}},get tab(){return tab},scope(){const g=focusGroup&&groupById(focusGroup);if(!g)return null;const base=board.title==='What am I trying to establish?'?'the whole board':board.title;return {ids:new Set(allCards(g)),label:g.label,outer:parentOf(g)?.label||base,setLabel(v){g.label=v.slice(0,300);persist();render()},exit(){focusOn(parentOf(g)?.id||'')}}},isHidden:id=>{const n=get(id);return !!n&&evidenceHidden(n)},showEvidenceFor,wordLabel,allowedWords,fitWord,linkRole,supportersOf,WORD_CHOICES,mainConclusion,isInterim,setTab(t){tab=t;render()},openCard,onRender(f){renderHooks.push(f)},commit(record=true){commitBoard(record)},typeLabel,startWalk(){walking=true;step=0;tab='map';render()},currentStep:()=>walking?sequence()[step]?.id:null,sequence:()=>sequence().map(n=>n.id)};
if(!readerMode){import('./guide.js').then(m=>m.init(api)).catch(e=>console.warn('Guide unavailable',e));import('./inbox-panel.js').then(m=>m.init(api)).catch(e=>console.warn('Inbox panel unavailable',e));import('./outline-editor.js').then(m=>m.init(api)).catch(e=>console.warn('Outline unavailable',e));import('./assist.js').then(m=>m.init(api)).catch(e=>console.warn('Local AI drafting unavailable',e));}
// One row for navigation, one for the board's tools: the board gets the height.
function compactChrome(){const top=$('.topline'),nav=$('.workspace-nav'),bar=$('.board-bar'),acts=$('.top-actions');if(!top||!nav||!bar||!acts)return;document.body.classList.add('compact-chrome');
 top.insertBefore(nav,acts);
 acts.insertAdjacentHTML('afterbegin','<div class="board-menu"><button id="board-menu-toggle" aria-haspopup="menu" aria-expanded="false">Board ▾</button><div class="board-menu-list" role="menu" hidden></div></div>');
 const list=acts.querySelector('.board-menu-list'),toggle=$('#board-menu-toggle'),open=v=>{list.hidden=!v;toggle.setAttribute('aria-expanded',String(v))};
 for(const b of [...acts.querySelectorAll(':scope > button')]){b.setAttribute('role','menuitem');list.append(b)}
 list.insertAdjacentHTML('afterbegin','<button id="wrap-board" role="menuitem" title="Put everything so far in one group, inside a new, bigger question">⤴ Wrap in a bigger question</button>');
 if($('#edit-title')){$('#edit-title').setAttribute('role','menuitem');$('#edit-title').textContent='✎ Edit base question';list.prepend($('#edit-title'))}
 toggle.onclick=()=>open(list.hidden);list.addEventListener('click',()=>open(false));document.addEventListener('mousedown',e=>{if(!e.target.closest('.board-menu'))open(false)});document.addEventListener('keydown',e=>{if(e.key==='Escape')open(false)});
 const right=document.createElement('div');right.className='board-bar-right';
 right.insertAdjacentHTML('beforeend','<button id="panel-toggle" title="Keep the side panel open (walkthrough steps and board summary). It also opens by itself when you select something." aria-pressed="false" aria-label="Side panel">◧</button>');
 right.append($('.segmented'),$('#walk'));
 bar.insertBefore($('#compact-title'),bar.children[1]||null);if($('#authorbar'))bar.insertBefore($('#authorbar'),$('#compact-title').nextSibling);bar.append(right);
 $('#map-tab').innerHTML='Spatial<span class="l"> board</span>';
 $('#panel-toggle').onclick=()=>{panelPinned=!panelPinned;try{localStorage.setItem('evidence.panelPinned',panelPinned?'1':'0')}catch{}render()}}
if(!readerMode)compactChrome();
render();updateHistory();
if(!readerMode){
 const params=initialParams;
 if(params.get('author'))author=true;if(params.get('inbox'))inboxOpen=true;
 const t=params.get('tab');if(['map','outline','sources'].includes(t))tab=t;else if(params.get('new'))tab='outline';
 const z=Number(params.get('zoom'));if(z>=ZOOM_MIN&&z<=ZOOM_MAX)zoom=z;
 if(params.get('walk')){walking=true;step=Math.max(0,parseInt(params.get('step'),10)||0);}
 if(params.get('group'))focusGroup=params.get('group');const focus=params.get('focus');if(focus&&get(focus))selected=focus;
 render();
 if(params.has('sx'))scrollToCanvas(Number(params.get('sx'))||0,Number(params.get('sy'))||0);
 else if(selected)select(selected,true);
 // From here the URL mirrors the view; one-shot flags (inbox, error, new) drop out.
 restored=true;syncUrl();
 $('#viewport').addEventListener('scroll',()=>{clearTimeout(syncUrl.scrollTimer);syncUrl.scrollTimer=setTimeout(syncUrl,250)},{passive:true});
 if(params.get('captureError'))notify(params.get('captureError'));
}
function syncUrl(){
 if(readerMode||!restored||!session)return;
 const p=new URLSearchParams({j:session.journey.id,b:session.record.id});
 if(tab!=='map')p.set('tab',tab);if(author)p.set('author','1');
 if(walking){p.set('walk','1');if(step)p.set('step',String(step));}
 if(selected&&get(selected))p.set('focus',selected);if(focusGroup)p.set('group',focusGroup);
 if(Math.abs(zoom-.85)>.001)p.set('zoom',zoom.toFixed(2));if(inboxOpen)p.set('inbox','1');
 const vp=$('#viewport');if(tab==='map'&&!walking&&origin&&!vp.hidden){const v=viewAt();p.set('sx',String(Math.round(v.x)));p.set('sy',String(Math.round(v.y)));}
 const next='?'+p;if(location.search!==next)window.history.replaceState(null,'',next);
 clearTimeout(syncUrl.saveTimer);syncUrl.saveTimer=setTimeout(()=>workspace.rememberView(location.href,{boardId:session.record.id,title:board.title,journeyId:session.journey.id,journeyName:session.journey.name}),400);
}


async function initializeWorkspaceUI(){
  window.history.replaceState(null,'','?'+new URLSearchParams({...Object.fromEntries(new URLSearchParams(location.search)),j:session.journey.id,b:session.record.id}));
  $('.brand').href='../journey/journey.html?j='+encodeURIComponent(session.journey.id);
  $('.brand').innerHTML='<span class="brandmark">▧</span> THE THINGS WE LEARNED';
  $('.brand').setAttribute('aria-label','Return to browsing trail');
  $('.topline').insertAdjacentHTML('afterend','<nav class="workspace-nav"><a id="trail-link">Browsing trail</a><span aria-current="page">Evidence board</span><label for="board-picker">Argument</label><select id="board-picker"></select><button id="inbox-button">Evidence inbox</button></nav>');
  $('#trail-link').href='../journey/journey.html?j='+encodeURIComponent(session.journey.id);
  refreshPicker();
  $('#board-picker').onchange=async e=>{const id=e.target.value;await saveQueue;if(saveBlocked){e.target.value=session.record.id;notify('Save your board file and reload before switching arguments.');return;}location.href='?'+new URLSearchParams({j:session.journey.id,b:id});};
  $('#inbox-button').onclick=()=>{inboxOpen=!inboxOpen;render()};
  $('#save-status').textContent='Saved in '+session.journey.name;
  globalThis.chrome?.runtime?.onMessage?.addListener(msg=>{if(msg.type==='trail-updated'&&msg.journeyId===session.journey.id)$('#inbox-button').textContent='Evidence inbox · updated';});
}
function refreshPicker(){if(!$('#board-picker'))return;$('#board-picker').innerHTML=session.boards.map(b=>`<option value="${esc(b.id)}" ${b.id===session.record.id?'selected':''}>${esc((t=>t==='What am I trying to establish?'?'Untitled question':t)(b.id===session.record.id?board.title:b.content.title))}</option>`).join('');}

