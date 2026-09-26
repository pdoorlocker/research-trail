import * as db from '../lib/db.js';
import { saveJot } from './workspace.js';
import { openBoard as openBoardTab } from './open.js';
const $=id=>document.getElementById(id);
let records=[], journeyId=null, loading=0;
function openBoard(walk=false){
  const params=new URLSearchParams();if(journeyId)params.set('j',journeyId);
  if($('outline-board').value)params.set('b',$('outline-board').value);
  // Reuse a tab already showing the board; only a walkthrough request changes its view.
  const b=params.get('b');params.delete('b');
  openBoardTab(b?{j:journeyId,b}:{j:journeyId},walk?{walk:'1',step:'0'}:{});
}
function renderSteps(){
  const board=records.find(b=>b.id===$('outline-board').value)?.content;
  $('outline-list').replaceChildren();
  for(const id of board?.steps||[]){const card=board.nodes.find(n=>n.id===id);if(!card)continue;
    const li=document.createElement('li'),button=document.createElement('button');button.textContent=card.text;button.onclick=()=>{
      const params=new URLSearchParams({j:journeyId,b:$('outline-board').value,focus:id});
      openBoardTab({j:journeyId,b:$('outline-board').value},{focus:id,tab:'map'});
    };li.append(button);$('outline-list').append(li);
  }
  $('outline-present').disabled=!board?.steps.length;
  $('outline-list').dataset.empty=board?(board.steps.length?'':'No walkthrough order yet. Set it with Order steps on the board.'):'No board in this workspace yet. Open board to start one.';
}
async function refresh(){const generation=++loading;try{
  const state=await chrome.runtime.sendMessage({type:'get-state'});
  const id=state.activeJourneyId;
  const list=id?await db.getByIndex('evidenceBoards','byJourney',id):[];
  if(generation!==loading)return;journeyId=id;records=list;
  const selected=$('outline-board').value;
  $('outline-board').replaceChildren(...records.map(record=>{const option=document.createElement('option');option.value=record.id;option.textContent=record.content.title==='What am I trying to establish?'?'Untitled question':record.content.title;return option;}));
  $('outline-board').hidden=!records.length;
  if(records.some(b=>b.id===selected))$('outline-board').value=selected;
  renderSteps();
}catch(error){$('outline-status').textContent=error.message;}}
$('evidence-btn').onclick=()=>openBoard();$('outline-present').onclick=()=>openBoard(true);$('outline-board').onchange=renderSteps;
for(const [id,screenshot] of [['outline-capture',false],['outline-screenshot',true]])$(id).onclick=async()=>{
  $(id).disabled=true;$('outline-status').textContent=screenshot?'Drag a box on the page (Esc cancels)…':'Saving…';
  try{const response=await chrome.runtime.sendMessage({type:'capture-evidence-from-panel',journeyId,screenshot});
    if(response.error)throw new Error(response.error==='Select a passage on the page first.'?'Highlight some text on the page first, then click Save selection.':response.error);
    $('outline-status').textContent=screenshot?'Screenshot saved to the evidence inbox.':'Passage saved to the evidence inbox.';
    showAttach(response.id);
  }catch(error){$('outline-status').textContent=error.message;}finally{$(id).disabled=false;}
};
document.addEventListener('workspace-changed',refresh);
chrome.runtime.onMessage.addListener(msg=>{if(msg.type==='trail-updated')refresh();});
refresh();setInterval(refresh,10000);

// Jot a thought without leaving the page. It goes to the workspace inbox,
// with the page it was written on as context, and shows up in the board's
// outline ready to be added.
$('jot-form').onsubmit=async e=>{
  e.preventDefault();const text=$('jot-input').value.trim();if(!text)return;
  try{
    if(!journeyId)throw new Error('Choose a workspace first.');
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    await saveJot(journeyId,text,{url:tab?.url,title:tab?.title});
    $('jot-input').value='';$('outline-status').textContent='Saved. It will be in the board’s Outline, ready to add.';
    chrome.runtime.sendMessage({type:'jot-saved',journeyId}).catch(()=>{});
  }catch(error){$('outline-status').textContent=error.message;}
};

// After capturing from the panel: attach the passage under a line of the
// board shown above, without opening the board.
async function showAttach(captureId){
  const box=$('outline-attach');box.hidden=false;
  box.innerHTML='<button id="attach-open">Attach to a line…</button>';
  $('attach-open').onclick=async()=>{
    const res=await chrome.runtime.sendMessage({type:'capture-attach-options',journeyId,boardId:$('outline-board').value});
    if(!res?.lines?.length){box.innerHTML='<p class="hint">This board has no lines yet.</p>';return}
    let word='because';
    box.innerHTML=`<div class="attach-seg"><button data-w="because" aria-pressed="true">backs it up</button><button data-w="objection" aria-pressed="false">objects to it</button></div><input id="attach-find" placeholder="Find a line" aria-label="Find a line"><ul id="attach-lines"></ul>`;
    const draw=()=>{const q=$('attach-find').value.toLowerCase();$('attach-lines').replaceChildren(...res.lines.filter(l=>!q||l.text.toLowerCase().includes(q)).slice(0,30).map(l=>{const li=document.createElement('li'),b=document.createElement('button');b.textContent=l.text;b.onclick=async()=>{const r=await chrome.runtime.sendMessage({type:'capture-attach',captureId,boardId:res.boardId,lineId:l.id,word});box.hidden=true;$('outline-status').textContent=r?.error||`Attached under “${l.text.slice(0,60)}”.`};li.append(b);return li}))};
    box.querySelectorAll('[data-w]').forEach(b=>b.onclick=()=>{word=b.dataset.w;box.querySelectorAll('[data-w]').forEach(x=>x.setAttribute('aria-pressed',String(x===b)))});
    $('attach-find').oninput=draw;draw();$('attach-find').focus();
  };
}
