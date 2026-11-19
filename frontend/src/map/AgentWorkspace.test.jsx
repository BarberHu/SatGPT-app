vi.mock('../harness/browserSession.js', () => ({ ensureBrowserSession: async () => {} }));
beforeEach(() => sessionStorage.clear());
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ModeRoot from '../ModeRoot';
import { FakeMap } from './tests/fakeMap';
vi.mock('mapbox-gl',async()=>{const {FakeMap}=await import('./tests/fakeMap');return {default:{Map:FakeMap,NavigationControl:class{onAdd(){return document.createElement('div');}onRemove(){}}}};});
vi.mock('./config',()=>({mapOptions:{token:'pk.test',style:'mapbox://styles/test'}}));
vi.mock('../App',async()=>{const {SharedMapViewport}=await import('./SharedMapContext');return {default:({active})=><SharedMapViewport active={active}/>};});
vi.mock('../repositories/businessLayerRepository',async original=>({...await original(),default:{load:async()=>[],save:async()=>{}}}));

test('an actual Agent SSE subscription survives repeated business switches and settles one answer with preview without creating a task again',async()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;sessionStorage.clear();FakeMap.instances=[];
 const sources=[];class Source{constructor(){this.close=vi.fn();sources.push(this);}}
 vi.stubGlobal('EventSource',Source);vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 let active='job';let messages=[{id:'user',role:'user',job_id:'job',content:'question'}];
 const fetcher=vi.fn(async url=>({ok:true,json:async()=>url.endsWith('/conversations')?{conversations:[{id:'webgis-test',title:'question'}]}:{conversation_id:'webgis-test',messages,active_task:active}}));
 vi.stubGlobal('fetch',fetcher);
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
 const flush=()=>act(async()=>new Promise(resolve=>setTimeout(resolve,50)));
 const select=mode=>act(async()=>node.querySelector(`[role=tab][data-mode=${mode}]`).click());
 const emit=(id,type,data)=>act(async()=>sources[0].onmessage({data:JSON.stringify({id,type,task_id:'job',conversation_id:'webgis-test',...data})}));
 try{
  await act(async()=>root.render(<ModeRoot/>));await select('agent');for(let i=0;i<30&&!sources.length;i++)await flush();
  expect(sources).toHaveLength(1);
  await emit(0,'snapshot',{task:{id:'job',status:'running',timeline:[]},answer:null});
  await emit(1,'answer.start',{answer:{attempt_id:'a',text:'',status:'streaming'}});
  await emit(2,'answer.delta',{attempt_id:'a',text:'Live body',timeline_ops:[{op:'put',row:{id:'text',seq:1,kind:'text',text:'Live body',committed:false,attempt_id:'a',turn:1,step:1}}]});
  expect(node.querySelector('.agent-markdown').textContent).toBe('Live body');
  await select('basic');expect(sources[0].close).not.toHaveBeenCalled();
  await act(async()=>sources[0].onerror());await act(async()=>sources[0].onopen());
  await emit(2,'answer.delta',{attempt_id:'a',text:'Live body'});
  expect(node.querySelector('.agent-markdown').textContent).toBe('Live body');
  await select('agent');expect(sources).toHaveLength(1);expect(FakeMap.instances).toHaveLength(1);
  messages=[...messages,{id:'final',role:'assistant',job_id:'job',content:'Formal answer',timeline:[],previews:[{name:'Preview',url:'/api/previews/test.png'}]}];active=null;
  await emit(3,'task',{patch:{status:'completed',output:{message:'Formal answer'},timeline:[]}});await flush();
  await select('basic');await select('agent');
  expect(node.textContent.match(/Formal answer/g)).toHaveLength(1);expect(node.textContent).not.toContain('Live body');
  expect(node.querySelector('.harness-preview')).toBeTruthy();expect(sources).toHaveLength(1);expect(sources[0].close).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls.filter(([,options])=>options?.method==='POST')).toHaveLength(0);
 }finally{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
},15000);
