import * as db from '../lib/db.js';
import { saveJot } from './workspace.js';
const $=id=>document.getElementById(id);
let records=[], journeyId=null, loading=0;
function openBoard(walk=false){
  const params=new URLSearchParams();if(journeyId)params.set('j',journeyId);
  if($('outline-board').value)params.set('b',$('outline-board').value);
  if(walk)params.set('walk','1');
  chrome.tabs.create({url:chrome.runtime.getURL('evidence/index.html?'+params)});
}
function renderSteps(){
  const board=records.find(b=>b.id===$('outline-board').value)?.content;
  $('outline-list').replaceChildren();
  for(const id of board?.steps||[]){const card=board.nodes.find(n=>n.id===id);if(!card)continue;
    const li=document.createElement('li'),button=document.createElement('button');button.textContent=card.text;button.onclick=()=>{
      const params=new URLSearchParams({j:journeyId,b:$('outline-board').value,focus:id});
      chrome.tabs.create({url:chrome.runtime.getURL('evidence/index.html?'+params)});
    };li.append(button);$('outline-list').append(li);
  }
  $('outline-present').disabled=!board?.steps.length;
  $('outline-status').textContent=board?'Your chosen reading order.':'Create a board from Evidence, then arrange its walkthrough.';
}
async function refresh(){const generation=++loading;try{
  const state=await chrome.runtime.sendMessage({type:'get-state'});
  const id=$('ws-select').value||state.activeJourneyId;
  const list=id?await db.getByIndex('evidenceBoards','byJourney',id):[];
  if(generation!==loading)return;journeyId=id;records=list;
  const selected=$('outline-board').value;
  $('outline-board').replaceChildren(...records.map(record=>{const option=document.createElement('option');option.value=record.id;option.textContent=record.content.title;return option;}));
  if(records.some(b=>b.id===selected))$('outline-board').value=selected;
  renderSteps();
}catch(error){$('outline-status').textContent=error.message;}}
$('evidence-btn').onclick=()=>openBoard();$('outline-present').onclick=()=>openBoard(true);$('outline-board').onchange=renderSteps;
for(const [id,screenshot] of [['outline-capture',false],['outline-screenshot',true]])$(id).onclick=async()=>{
  $(id).disabled=true;$('outline-status').textContent='Capturing…';
  try{const response=await chrome.runtime.sendMessage({type:'capture-evidence-from-panel',journeyId,screenshot});
    if(response.error)throw new Error(response.error);
    $('outline-status').textContent='Saved to the evidence inbox. Open Evidence to place it in your argument.';
  }catch(error){$('outline-status').textContent=error.message;}finally{$(id).disabled=false;}
};
$('ws-select').addEventListener('change',refresh);
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
