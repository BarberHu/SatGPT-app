import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { test, vi, expect, beforeEach, afterEach } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import BasicLayerWorkspace from './BasicLayerWorkspace';
import { writeBasicSelection } from '../aoi/snapshot';
import { buildAoiFromBounds, buildAoiFromGridSelection } from '../utils/aoi';

const state=vi.hoisted(()=>({context:null,scope:null,request:null}));
vi.mock('../map/SharedMapContext',()=>({useSharedMap:()=>({service:{scope:()=>state.scope}})}));
vi.mock('../api/presetLayers',()=>({requestPresetLayer:(...args)=>state.request(...args)}));
vi.mock('../repositories/businessLayerRepository',async original=>({...await original(),default:{load:async()=>[],save:async()=>{}}}));
let root,node;
function Probe(){state.context=useAppContext();return <BasicLayerWorkspace/>;}
const flush=()=>act(async()=>{for(let i=0;i<12;i++)await Promise.resolve();});
const click=async text=>{const button=[...node.querySelectorAll('button')].find(button=>button.textContent.includes(text) || button.getAttribute('aria-label')===text);expect(button, text).toBeTruthy();await act(async()=>button.click());};
const selectGrid = (west = 100) => act(async () => {
  const ring = [[west, 10], [west + 1, 10], [west + 1, 11], [west, 11], [west, 10]];
  state.context.setSelectedAOI(buildAoiFromGridSelection(ring));
});
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
 await selectGrid();
 await click('Load layer');await flush();expect(state.request).toHaveBeenCalledTimes(1);
 await click('Load layer');await flush();expect(state.request).toHaveBeenCalledTimes(1);
 await click('Landslide');await click('Slope Steepness');await click('Load layer');await flush();
 expect(node.querySelectorAll('.preset-layer-card')).toHaveLength(2);
 await click('Wildfire');expect(node.querySelectorAll('.preset-layer-card')).toHaveLength(2);
 expect(node.textContent).toContain('Verified source');expect(node.textContent).toContain('2021');
 await selectGrid(101);
 expect(node.querySelectorAll('.preset-stale')).toHaveLength(2);expect(state.request).toHaveBeenCalledTimes(2);
 await click('Details for Slope Steepness');
 await click('Edit layer');await click('Apply to this layer');await flush();
 expect(state.request).toHaveBeenCalledTimes(3);expect(node.querySelectorAll('.preset-layer-card')).toHaveLength(2);
 expect(state.request.mock.calls[2][0].aoi.geojson).toEqual(state.context.selectedAOI.geojson);
 expect(node.querySelectorAll('.preset-stale')).toHaveLength(1);
});
test('per-layer visibility, opacity, ordering, focus and removal use the shared scope',async()=>{
 await act(async()=>root.render(<AppProvider><Probe/></AppProvider>));await flush();
 await selectGrid();await click('Load layer');await flush();
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

test('the layer library has no study area tools and enables loading after grid selection', async () => {
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  await flush();
  const library = node.querySelector('[aria-label="Layer library"]');
  const loadButton = [...library.querySelectorAll('button')].find(button => button.textContent === 'Load layer');
  expect(library.textContent).not.toMatch(/Study area|Select grid|GeoJSON|Saved areas|Draw area/i);
  expect(library.querySelector('input[type=file]')).toBeNull();
  expect(loadButton.disabled).toBe(true);
  await selectGrid();
  expect(loadButton.disabled).toBe(false);
  expect(state.request).not.toHaveBeenCalled();
});

test('Apply captures the visible date fields and cloud threshold as one explicit request',async()=>{
 await act(async()=>root.render(<AppProvider><Probe/></AppProvider>));await flush();await selectGrid();await click('Wildfire');
 // Date pickers can defer React change events until blur. Submit must use the visible form values.
 for(const [name,value] of Object.entries({time_start:'2021-09-01',time_end:'2021-11-01',cloud_threshold:'25'}))
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node.querySelector(`[name="${name}"]`),value);
 expect(state.request).not.toHaveBeenCalled();await click('Load layer');await flush();
 expect(state.request.mock.calls[0][0].params).toEqual({time_start:'2021-09-01',time_end:'2021-11-01',cloud_threshold:25});
});

test('a previous selection is restored and a new grid changes only subsequent requests', async () => {
  const previous = buildAoiFromBounds({ west: 102, south: 10, east: 102.1, north: 10.1 }, { source: 'upload' });
  writeBasicSelection(localStorage, previous, false);
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  await flush();
  expect(state.context.selectedAOI.geojson.geometry).toEqual(previous.geojson.geometry);
  expect(state.context.aoiOutlineVisible).toBe(false);
  expect(state.request).not.toHaveBeenCalled();
  await click('Load layer');
  await flush();
  await selectGrid();
  expect(state.context.aoiOutlineVisible).toBe(true);
  expect(state.request.mock.calls[0][0].aoi.geojson.geometry).toEqual(previous.geojson.geometry);
  expect(state.request).toHaveBeenCalledTimes(1);
  await click('Load layer');
  await flush();
  expect(state.request.mock.calls[1][0].aoi.source).toBe('fishnet');
});
