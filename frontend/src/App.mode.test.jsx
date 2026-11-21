import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ModeRoot from './ModeRoot';
import { FakeMap } from './map/tests/fakeMap';
const state=vi.hoisted(()=>({mounts:{basic:0,agent:0},unmounts:{basic:0,agent:0}}));
vi.mock('mapbox-gl',async()=>{
 const {FakeMap}=await import('./map/tests/fakeMap');
 return {default:{Map:FakeMap, NavigationControl:class {onAdd(){return document.createElement('div');}onRemove(){}}}};
});
vi.mock('./repositories/businessLayerRepository',async original=>({...await original(),default:{load:async()=>[],save:async()=>{}}}));
vi.mock('./utils/mapSnapshot',()=>({downloadMapSnapshot:vi.fn()}));
vi.mock('./map/config', async original => {
  const { mapOptions } = await original();
  const style = 'mapbox://styles/test';
  return { mapOptions: { token: 'pk.test', style,
    basemaps: mapOptions.basemaps.map(option => option.id === 'default' ? { ...option, style } : option),
  } };
});
vi.mock('./App',async()=>{
 const {SharedMapViewport}=await import('./map/SharedMapContext');
 return {default:({active})=>{const [filter,setFilter]=useState('retained');React.useEffect(()=>{state.mounts.basic++;return()=>state.unmounts.basic++;},[]);return <div><SharedMapViewport active={active}/><input aria-label="Basic filter" value={filter} onChange={e=>setFilter(e.target.value)}/></div>;}};
});
vi.mock('./harness/App',async()=>{
 const {SharedMapViewport}=await import('./map/SharedMapContext');
 return {default:({active})=>{React.useEffect(()=>{state.mounts.agent++;return()=>state.unmounts.agent++;},[]);return <div><SharedMapViewport active={active}/><p>Harness analysis</p></div>;}};
});
let node,root,observers,rect;
beforeEach(()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;FakeMap.instances=[];sessionStorage.clear();localStorage.clear();
 for(const group of [state.mounts,state.unmounts])group.basic=group.agent=0;
 observers=[];vi.stubGlobal('ResizeObserver',class {constructor(fn){this.fn=fn;this.disconnect=vi.fn();observers.push(this);}observe(){}});
 rect=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:58,right:1000,bottom:800,width:1000,height:742});
 node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);
});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();rect.mockRestore();vi.unstubAllGlobals();delete globalThis.IS_REACT_ACT_ENVIRONMENT;});
const flush=()=>act(async()=>new Promise(resolve=>setTimeout(resolve,35)));
const select=mode=>act(async()=>node.querySelector(`[role=tab][data-mode=${mode}]`).click());

test('one persistent branded workspace creates one map, preserves mode state and camera through repeated switches, and disposes all resources once',async()=>{
 await act(async()=>root.render(<ModeRoot/>));
 await act(async () => { await vi.waitFor(() => expect(FakeMap.instances).toHaveLength(1)); });
 await flush();
 const raw=FakeMap.instances[0];const canvas=node.querySelector('canvas');const header=node.querySelector('header');
 expect(state.mounts.basic).toBe(1);expect(raw.controls).toHaveLength(1);
 const before={...raw.view};
 for(let i=0;i<3;i++){await select('agent');await flush();await select('basic');await flush();}
 expect(FakeMap.instances).toHaveLength(1);expect(node.querySelector('canvas')).toBe(canvas);expect(node.querySelector('header')).toBe(header);
 expect(state.mounts).toEqual({basic:1,agent:1});expect(state.unmounts).toEqual({basic:0,agent:0});
 expect(raw.remove).not.toHaveBeenCalled();expect(raw.view).toEqual(before);expect(raw.fitBounds).not.toHaveBeenCalled();expect(raw.easeTo).not.toHaveBeenCalled();
 expect(raw.resize).toHaveBeenCalled();expect(raw.controls).toHaveLength(1);
 const count=raw.resize.mock.calls.length;for(const observer of observers)observer.fn();await flush();expect(raw.resize.mock.calls.length).toBeGreaterThan(count);
 expect(node.querySelector('[aria-label="Save map image"]').disabled).toBe(false);
 await act(async()=>node.querySelector('[aria-label="Save map image"]').click());expect(raw.canvas.toDataURL).toHaveBeenCalledTimes(1);
 await act(async()=>root.unmount());root=createRoot(node);
 expect(raw.remove).toHaveBeenCalledTimes(1);expect(raw.events).toHaveLength(0);expect(raw.controls).toHaveLength(0);
 expect(observers.every(o=>o.disconnect.mock.calls.length>0)).toBe(true);
});

test('keyboard mode navigation, persistent Basic state and reserved settings remain available',async()=>{
 await act(async()=>root.render(<ModeRoot/>));await flush();
 await act(async()=>node.querySelector('[role=tablist]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));await flush();
 expect(sessionStorage.getItem('satgpt:mode')).toBe('agent');expect(document.activeElement.dataset.mode).toBe('agent');
 await select('basic');expect(node.querySelector('[aria-label="Basic filter"]').value).toBe('retained');
 await act(async()=>node.querySelector('[aria-label="Settings"]').click());const dialog=document.querySelector('[role=dialog]');
 expect(dialog.querySelector('input').disabled).toBe(true);expect(dialog.querySelector('form')).toBeNull();
 await act(async()=>dialog.querySelector('[aria-label="Close settings"]').click());
});

test('hiding a narrow-screen map slot suspends capture and restores the same canvas at its new size',async()=>{
 await act(async()=>root.render(<ModeRoot/>));await flush();
 const raw=FakeMap.instances[0],canvas=node.querySelector('canvas');
 rect.mockReturnValue({left:0,top:100,right:0,bottom:100,width:0,height:0});
 for(const observer of observers)observer.fn();await flush();
 expect(node.querySelector('.satgpt-map-surface').style.visibility).toBe('hidden');
 expect(node.querySelector('[aria-label="Save map image"]').disabled).toBe(true);
 rect.mockReturnValue({left:0,top:100,right:390,bottom:844,width:390,height:744});
 for(const observer of observers)observer.fn();await flush();
 expect(node.querySelector('.satgpt-map-surface').style.width).toBe('390px');
 expect(node.querySelector('[aria-label="Save map image"]').disabled).toBe(false);
 expect(node.querySelector('canvas')).toBe(canvas);expect(FakeMap.instances).toHaveLength(1);expect(raw.remove).not.toHaveBeenCalled();
});

test('the shared basemap selector applies boundary and road settings on switch and rollback', async () => {
  await act(async () => root.render(<ModeRoot />));
  await vi.waitFor(() => expect(FakeMap.instances).toHaveLength(1));
  const raw = FakeMap.instances[0];
  const selector = node.querySelector('select[aria-label="Basemap"]');
  const choose = id => act(async () => {
    selector.value = id;
    selector.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const boundaryIds = ['admin-1-boundary-bg', 'admin-0-boundary-bg', 'admin-1-boundary', 'admin-0-boundary', 'admin-0-boundary-disputed'];
  const roadLayers = [
    ['road-primary-case', 'line', 'road'], ['tunnel-primary', 'line', 'road'], ['bridge-primary', 'line', 'road'],
    ['road-label', 'symbol', 'road'], ['road-intersection', 'symbol', 'road'], ['road-number-shield', 'symbol', 'road'],
    ['path-pedestrian-label', 'symbol', 'road'], ['road-exit-shield', 'symbol', 'motorway_junction'],
  ];
  const preservedLayers = [
    ['coastline', 'line', 'water'], ['country-label', 'symbol', 'place_label'],
    ['aerialway', 'line', 'road'], ['ferry-aerialway-label', 'symbol', 'road'],
  ];
  const finishStyle = () => act(async () => {
    for (const id of boundaryIds) raw.addLayer({ id, type: 'line', source: 'composite', 'source-layer': 'admin' });
    for (const [id, type, sourceLayer] of [...roadLayers, ...preservedLayers]) {
      raw.addLayer({ id, type, source: 'composite', 'source-layer': sourceLayer });
    }
    raw.addLayer({ id: 'satellite', type: 'raster', source: 'mapbox-satellite' });
    raw.finishStyle();
  });
  const visibility = id => raw.getLayoutProperty(id, 'visibility') ?? 'visible';
  const checkVisibility = (boundaryVisibility, roadVisibility = 'visible') => {
    for (const id of boundaryIds) expect(visibility(id), id).toBe(boundaryVisibility);
    for (const [id] of roadLayers) expect(visibility(id), id).toBe(roadVisibility);
    for (const [id] of preservedLayers) expect(visibility(id), id).toBe('visible');
    expect(visibility('satellite')).toBe('visible');
  };
  expect(Array.from(selector.options, option => option.text)).toEqual(['Default', 'Light', 'Satellite Streets', 'Outdoors']);
  expect(selector.value).toBe('default');
  await finishStyle();
  checkVisibility('visible');
  for (const [id, style] of [['light', 'light-v11'], ['satellite-streets', 'satellite-streets-v12'], ['outdoors', 'outdoors-v12']]) {
    await choose(id);
    expect(selector.disabled).toBe(true);
    expect(raw.setStyle).toHaveBeenLastCalledWith(`mapbox://styles/mapbox/${style}`, { diff: false });
    await finishStyle();
    expect(selector.value).toBe(id);
    checkVisibility('none', id === 'satellite-streets' ? 'none' : 'visible');
  }
  await choose('default');
  await finishStyle();
  expect(selector.value).toBe('default');
  checkVisibility('visible');
  await choose('satellite-streets');
  await finishStyle();
  await select('agent');
  expect(selector.value).toBe('satellite-streets');
  await choose('outdoors');
  const styleRequests = raw.setStyle.mock.calls.length;
  await act(async () => raw.fire('error', { error: new Error('Simulated tile error'), sourceId: 'tile-source' }));
  expect(raw.setStyle).toHaveBeenCalledTimes(styleRequests);
  await act(async () => raw.fire('error', { error: new Error('Simulated style load failure') }));
  expect(raw.setStyle).toHaveBeenLastCalledWith('mapbox://styles/mapbox/satellite-streets-v12', { diff: false });
  expect(selector.disabled).toBe(true);
  await finishStyle();
  expect(selector.value).toBe('satellite-streets');
  expect(selector.disabled).toBe(false);
  checkVisibility('none', 'none');
  expect(node.querySelector('[role="alert"]').textContent).toMatch(/Unable to switch basemaps/);
  expect(FakeMap.instances).toEqual([raw]);
  expect(raw.fitBounds).not.toHaveBeenCalled();
});
