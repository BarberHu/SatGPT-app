import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MapContainer from '../components/MapContainer';
import { AppProvider, useAppContext } from '../context/AppContext';
import { SharedMapProvider, SharedMapSurface } from './SharedMapContext';
import usePresetLayers from '../hooks/usePresetLayers';
import PresetMapController from '../presets/PresetMapController';
import { FakeMap } from './tests/fakeMap';
const observed=vi.hoisted(()=>({context:null,resolve:null}));
vi.mock('mapbox-gl',async()=>{const {FakeMap}=await import('./tests/fakeMap');return {default:{Map:FakeMap,NavigationControl:class{onAdd(){return document.createElement('div');}onRemove(){}}}};});
vi.mock('./config',()=>({mapOptions:{token:'pk.test',style:'mapbox://styles/test'}}));
vi.mock('../repositories/businessLayerRepository',async original=>({...await original(),default:{load:async()=>[],save:async()=>{}}}));
vi.mock('../api/presetLayers',()=>({requestPresetLayer:vi.fn(()=>new Promise(resolve=>{observed.resolve=resolve;}))}));
vi.mock('../utils/fishnetSelection',async original=>{
 const helpers=await original();
 const geojson={type:'FeatureCollection',features:[100,101].map((west,FID)=>({
  type:'Feature',properties:{FID},geometry:{type:'Polygon',coordinates:[[[west,10],[west+1,10],[west+1,11],[west,11],[west,10]]]}
 }))};
 return {...helpers,loadFishnetData:()=>Promise.resolve({geojson,featuresByFid:helpers.indexFishnetFeatures(geojson)})};
});
function Probe({active}) { observed.context=useAppContext();const {rows,store}=usePresetLayers();observed.store=store;return <><MapContainer active={active}/><PresetMapController rows={rows} store={store}/></>; }
function Workspace(){const [mode,setMode]=useState('basic');return <AppProvider><SharedMapProvider mode={mode}><div><SharedMapSurface/><button data-switch onClick={()=>setMode(v=>v==='basic'?'agent':'basic')}>Switch</button><Probe active={mode==='basic'}/></div></SharedMapProvider></AppProvider>;}

test('the Basic grid switch controls selection across modes while late preset results stay in Basic',async()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;FakeMap.instances=[];localStorage.clear();sessionStorage.clear();
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 if(!URL.createObjectURL)URL.createObjectURL=vi.fn(()=> 'blob:gee-code');if(!URL.revokeObjectURL)URL.revokeObjectURL=vi.fn();
 try{
  await act(async()=>root.render(<Workspace/>));await act(async()=>new Promise(resolve=>setTimeout(resolve,60)));
  const raw=FakeMap.instances[0];expect(raw).toBeTruthy();expect(raw.controls).toHaveLength(2);
  expect([...raw.layers.keys()].some(id=>id.startsWith('satgpt-basic-aux:gl-draw-'))).toBe(false);
  const gridToggle=()=>raw.getContainer().querySelector('[aria-label="Toggle grid selection"]');
  const clickGrid=async FID=>{
   raw.queryRenderedFeatures=()=>[{properties:{FID}}];
   await act(async()=>raw.fire('click',{point:{x:20,y:30}}));
  };
  expect(gridToggle().getAttribute('aria-pressed')).toBe('true');
  await clickGrid(0);
  const savedAoi=observed.context.selectedAOI;
  expect(savedAoi.source).toBe('fishnet');
  expect(savedAoi.bounds).toEqual({west:100,south:10,east:101,north:11});
  await act(async()=>gridToggle().click());
  expect(gridToggle().getAttribute('aria-pressed')).toBe('false');
  expect(raw.getLayer('satgpt-basic-aux:grid_cell-layer').layout.visibility).toBe('none');
  await clickGrid(1);
  expect(observed.context.selectedAOI).toBe(savedAoi);
  expect(raw.getSource('satgpt-basic-aux:analysis-aoi').data).toEqual(savedAoi.geojson);
  await act(async()=>node.querySelector('[data-switch]').click());
  await clickGrid(1);
  expect(observed.context.selectedAOI).toBe(savedAoi);
  await act(async()=>node.querySelector('[data-switch]').click());
  expect(gridToggle().getAttribute('aria-pressed')).toBe('false');
  await act(async()=>gridToggle().click());
  expect(raw.getLayer('satgpt-basic-aux:grid_cell-layer').layout.visibility).toBe('visible');
  await clickGrid(1);
  expect(observed.context.selectedAOI.bounds).toEqual({west:101,south:10,east:102,north:11});
  let id;await act(async()=>{id=observed.store.add('slopeSteepness',observed.context.selectedAOI,{});});
  expect(observed.resolve).toBeTypeOf('function');
  const physical=`satgpt-layer-scope--basic%3Apresets--${id}`;
  await act(async()=>node.querySelector('[data-switch]').click());
  raw.isStyleLoaded=()=>false; // Another mode's tiles are still loading.
  const cameraCalls=raw.fitBounds.mock.calls.length;
  await act(async()=>observed.resolve({status:'ready',layer:{id,name:'Slope',kind:'gee',url:'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}'}}));
  expect(raw.fitBounds).toHaveBeenCalledTimes(cameraCalls);
  expect(raw.getLayer(physical)?.layout.visibility).toBe('none');
  await act(async()=>node.querySelector('[data-switch]').click());
  expect(raw.getLayer(physical)?.layout.visibility).toBe('visible');
  await act(async()=>{observed.store.patch(id,{visible:false,opacity:.4});});
  await act(async()=>node.querySelector('[data-switch]').click());await act(async()=>node.querySelector('[data-switch]').click());
  expect(raw.getLayer(physical).layout.visibility).toBe('none');expect(raw.getPaintProperty(physical,'raster-opacity')).toBe(.4);
  expect(FakeMap.instances).toHaveLength(1);expect(raw.remove).not.toHaveBeenCalled();expect(raw.controls).toHaveLength(2);
  await act(async()=>root.unmount());expect(raw.remove).toHaveBeenCalledTimes(1);expect(raw.events).toHaveLength(0);
 }finally{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
