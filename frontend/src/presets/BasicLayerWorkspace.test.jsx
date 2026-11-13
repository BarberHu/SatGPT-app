import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { test, vi, expect, beforeEach, afterEach } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import BasicLayerWorkspace from './BasicLayerWorkspace';
import { buildAoiFromBounds } from '../utils/aoi';

const state=vi.hoisted(()=>({context:null,scope:null,request:null}));
vi.mock('../map/SharedMapContext',()=>({useSharedMap:()=>({ready:true,service:{scope:()=>state.scope,getCurrentView:()=>({bounds:[100,10,100.1,10.1]})}})}));
vi.mock('../api/presetLayers',()=>({requestPresetLayer:(...args)=>state.request(...args)}));
vi.mock('../repositories/businessLayerRepository',async original=>({...await original(),default:{load:async()=>[],save:async()=>{}}}));
let root,node;
function Probe({active=true}){state.context=useAppContext();return <BasicLayerWorkspace active={active}/>;}
const flush=()=>act(async()=>{for(let i=0;i<12;i++)await Promise.resolve();});
const click=async text=>{const button=[...node.querySelectorAll('button')].find(button=>button.textContent.includes(text) || button.getAttribute('aria-label')===text);expect(button, text).toBeTruthy();await act(async()=>button.click());};
beforeEach(()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;localStorage.clear();
 state.scope={addLayer:vi.fn(),removeLayer:vi.fn(),setVisibility:vi.fn(),setOpacity:vi.fn(),setOrder:vi.fn(),setView:vi.fn(),subscribeTileStatus:()=>()=>{}};
 state.request=vi.fn(async row=>({status:'ready',layer:{id:row.id,name:row.presetId,kind:'gee',url:'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}',metadata:{source:'Verified source',observedAt:'2021',description:'Verified method'},legend:{type:'continuous',colors:['#000000'],min:0,max:1},visible:true,opacity:.8}}));
 vi.stubGlobal('fetch',vi.fn(async()=>({json:async()=>({})})));
 node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();delete globalThis.IS_REACT_ACT_ENVIRONMENT;});
test('loads only on Apply, retains mixed themes, deduplicates and updates an explicitly changed AOI',async()=>{
 await act(async()=>root.render(<AppProvider><Probe/></AppProvider>));await flush();expect(state.request).not.toHaveBeenCalled();
 await act(async()=>state.context.setSelectedAOI(buildAoiFromBounds({west:100,south:10,east:100.1,north:10.1})));
 await click('Load layer');await flush();expect(state.request).toHaveBeenCalledTimes(1);
 await click('Load layer');await flush();expect(state.request).toHaveBeenCalledTimes(1);
 await click('Landslide');await click('Slope Steepness');await click('Load layer');await flush();
 expect(node.querySelectorAll('.preset-layer-card')).toHaveLength(2);
 await click('Wildfire');expect(node.querySelectorAll('.preset-layer-card')).toHaveLength(2);
 expect(node.textContent).toContain('Verified source');expect(node.textContent).toContain('2021');
 await act(async()=>state.context.setSelectedAOI(buildAoiFromBounds({west:101,south:10,east:101.1,north:10.1})));
 expect(node.querySelectorAll('.preset-stale')).toHaveLength(2);expect(state.request).toHaveBeenCalledTimes(2);
 await click('Details for Slope Steepness');
 await click('Edit / update study area');await click('Apply to this layer');await flush();
 expect(state.request).toHaveBeenCalledTimes(3);expect(node.querySelectorAll('.preset-layer-card')).toHaveLength(2);
 expect(node.querySelectorAll('.preset-stale')).toHaveLength(1);
});
test('per-layer visibility, opacity, ordering, focus and removal use the shared scope',async()=>{
 await act(async()=>root.render(<AppProvider><Probe/></AppProvider>));await flush();
 await click('Use current map extent');await click('Load layer');await flush();
 await click('Landslide');await click('Slope Steepness');await click('Load layer');await flush();
 await act(async()=>node.querySelector('[aria-label="Hide Slope Steepness"]').click());
 expect(state.scope.setVisibility).toHaveBeenCalledWith(expect.any(String),false);
 await click('Details for Slope Steepness');
 const slider=node.querySelector('[aria-label="Opacity for Slope Steepness"]');
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'0.35');slider.dispatchEvent(new Event('input',{bubbles:true}));});
 expect(state.scope.setOpacity).toHaveBeenCalledWith(expect.any(String),.35);
 await click('Locate layer');expect(state.scope.setView).toHaveBeenCalled();
 await click('Move down');expect(state.scope.setOrder.mock.lastCall[0]).toHaveLength(2);
 await click('Remove layer');expect(node.querySelectorAll('.preset-layer-card')).toHaveLength(1);expect(state.scope.removeLayer).toHaveBeenCalled();
});

test('uploaded polygon becomes the study area without auto-loading; invalid files show an English error',async()=>{
 await act(async()=>root.render(<AppProvider><Probe/></AppProvider>));await flush();
 const input=node.querySelector('input[type=file]');
 const geometry={type:'Polygon',coordinates:[[[100,10],[100.1,10],[100.1,10.1],[100,10.1],[100,10]]]};
 Object.defineProperty(input,'files',{configurable:true,value:[{name:'study.geojson',size:150,text:async()=>JSON.stringify(geometry)}]});
 await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));await flush();
 expect(state.context.selectedAOI.source).toBe('upload');expect(state.context.selectedAOI.label).toBe('study');
 expect(state.request).not.toHaveBeenCalled();await click('Load layer');await flush();expect(state.request).toHaveBeenCalledTimes(1);
 Object.defineProperty(input,'files',{configurable:true,value:[{name:'broken.json',size:10,text:async()=>'{invalid'}]});
 await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));await flush();
 expect(node.textContent).toContain('Upload a valid polygon GeoJSON file smaller than 2 MB.');
 expect(state.context.selectedAOI.label).toBe('study');
});

test('Apply captures the visible date fields and cloud threshold as one explicit request',async()=>{
 await act(async()=>root.render(<AppProvider><Probe/></AppProvider>));await flush();await click('Use current map extent');await click('Wildfire');
 // Date pickers can defer React change events until blur. Submit must use the visible form values.
 for(const [name,value] of Object.entries({time_start:'2021-09-01',time_end:'2021-11-01',cloud_threshold:'25'}))
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node.querySelector(`[name="${name}"]`),value);
 expect(state.request).not.toHaveBeenCalled();await click('Load layer');await flush();
 expect(state.request.mock.calls[0][0].params).toEqual({time_start:'2021-09-01',time_end:'2021-11-01',cloud_threshold:25});
});

test('a delayed upload cannot replace the selection after leaving Basic or choosing another area',async()=>{
 let finish;
 const render=active=>root.render(<AppProvider><Probe active={active}/></AppProvider>);
 const geometry=buildAoiFromBounds({west:102,south:10,east:102.1,north:10.1}).geojson;
 await act(async()=>render(true));await flush();
 const input=node.querySelector('input[type=file]');
 const start=async()=>{
  Object.defineProperty(input,'files',{configurable:true,value:[{name:'late.geojson',size:150,text:()=>new Promise(resolve=>{finish=resolve;})}]});
  await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));
 };
 await start();await act(async()=>render(false));await act(async()=>render(true));
 await act(async()=>finish(JSON.stringify(geometry)));await flush();
 expect(state.context.selectedAOI).toBeNull();
 await start();await click('Use current map extent');
 const selected=state.context.selectedAOI;
 await act(async()=>finish(JSON.stringify(geometry)));await flush();
 expect(state.context.selectedAOI).toBe(selected);expect(state.request).not.toHaveBeenCalled();
 await start();await act(async()=>state.context.startAoiEdit());
 await act(async()=>finish(JSON.stringify(geometry)));await flush();
 expect(state.context.selectedAOI).toBe(selected);
 expect([...node.querySelectorAll('button')].find(button=>button.textContent==='Use current map extent').disabled).toBe(true);
 await act(async()=>state.context.cancelDraftAoi());expect(state.context.selectedAOI).toBe(selected);
});
