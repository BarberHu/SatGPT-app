import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MapContainer from '../components/MapContainer';
import { AppProvider, useAppContext } from '../context/AppContext';
import { SharedMapProvider, SharedMapSurface } from './SharedMapContext';
import useMapData from '../hooks/useMapData';
import { FakeMap } from './tests/fakeMap';
const observed=vi.hoisted(()=>({context:null,draw:null,resolve:null}));
vi.mock('mapbox-gl',async()=>{const {FakeMap}=await import('./tests/fakeMap');return {default:{Map:FakeMap,NavigationControl:class{onAdd(){return document.createElement('div');}onRemove(){}}}};});
vi.mock('./config',()=>({mapOptions:{token:'pk.test',style:'mapbox://styles/test'}}));
vi.mock('@mapbox/mapbox-gl-draw',async original=>{
 const module=await original();return {default:function(...args){observed.draw=new module.default(...args);return observed.draw;}};
});
vi.mock('../repositories/businessLayerRepository',async original=>({...await original(),default:{load:async()=>[],save:async()=>{}}}));
vi.mock('../services/api',()=>({getHistoricalMap:vi.fn(()=>new Promise(resolve=>{observed.resolve=resolve;})),getFloodHotspotMap:vi.fn()}));
vi.mock('../utils/fishnetSelection',async original=>{
 const helpers=await original();
 const geojson={type:'FeatureCollection',features:[{type:'Feature',properties:{FID:0},geometry:{type:'Polygon',coordinates:[[[100,10],[101,10],[101,11],[100,11],[100,10]]]}}]};
 return {...helpers,loadFishnetData:()=>Promise.resolve({geojson,featuresByFid:helpers.indexFishnetFeatures(geojson)})};
});
function Probe({active}) { observed.context=useAppContext();useMapData();return <MapContainer active={active}/>; }
function Workspace(){const [mode,setMode]=useState('basic');return <AppProvider><SharedMapProvider mode={mode}><div><SharedMapSurface/><button data-switch onClick={()=>setMode(v=>v==='basic'?'agent':'basic')}>Switch</button><Probe active={mode==='basic'}/></div></SharedMapProvider></AppProvider>;}

test('real Basic draw extension and grid survive mode switching; late map results stay in the Basic namespace',async()=>{
 globalThis.IS_REACT_ACT_ENVIRONMENT=true;FakeMap.instances=[];
 const node=document.createElement('div');document.body.appendChild(node);const root=createRoot(node);
 vi.stubGlobal('ResizeObserver',class{observe(){}disconnect(){}});
 if(!URL.createObjectURL)URL.createObjectURL=vi.fn(()=> 'blob:gee-code');if(!URL.revokeObjectURL)URL.revokeObjectURL=vi.fn();
 try{
  await act(async()=>root.render(<Workspace/>));await act(async()=>new Promise(resolve=>setTimeout(resolve,60)));
  const raw=FakeMap.instances[0];expect(raw).toBeTruthy();expect(raw.controls).toHaveLength(3);
  expect([...raw.layers.keys()].some(id=>id.startsWith('satgpt-basic-aux:gl-draw-'))).toBe(true);
  await act(async()=>new Promise(resolve=>setTimeout(resolve,10)));
  const polygon={type:'Feature',id:'polygon',properties:{},geometry:{type:'Polygon',coordinates:[[[100,10],[101,10],[101,11],[100,11],[100,10]]]}};
  await act(async()=>{observed.draw.add(polygon);observed.context.mapInstance.fire('draw.create',{features:[polygon]});});
  expect(observed.context.draftAOI?.bounds).toEqual({west:100,south:10,east:101,north:11});
  const draft=observed.context.draftAOI;
  await act(async()=>node.querySelector('[data-switch]').click());
  await act(async()=>raw.fire('draw.create',{features:[{...polygon,id:'foreign'}]}));
  expect(observed.context.draftAOI).toBe(draft);
  await act(async()=>node.querySelector('[data-switch]').click());
  raw.queryRenderedFeatures=()=>[{...polygon,properties:{FID:0}}];
  await act(async()=>raw.fire('click',{point:{x:20,y:30}}));
  expect(observed.context.selectedAOI.source).toBe('fishnet');expect(observed.resolve).toBeTypeOf('function');
  await act(async()=>node.querySelector('[data-switch]').click());
  raw.isStyleLoaded=()=>false; // Another mode's tiles are still loading.
  const cameraCalls=raw.fitBounds.mock.calls.length;
  await act(async()=>observed.resolve({eeMapURLWater:'https://example.test/water/{z}/{x}/{y}'}));
  expect(raw.fitBounds).toHaveBeenCalledTimes(cameraCalls);
  expect(raw.getLayer('satgpt-basic:water-layer')?.layout.visibility).toBe('none');
  await act(async()=>node.querySelector('[data-switch]').click());
  expect(raw.getLayer('satgpt-basic:water-layer')?.layout.visibility).toBe('visible');
  await act(async()=>{observed.context.toggleLayerVisibility('water');observed.context.updateLayerOpacity('water',.4);});
  await act(async()=>node.querySelector('[data-switch]').click());await act(async()=>node.querySelector('[data-switch]').click());
  expect(raw.getLayer('satgpt-basic:water-layer').layout.visibility).toBe('none');expect(raw.getPaintProperty('satgpt-basic:water-layer','raster-opacity')).toBe(.4);
  expect(FakeMap.instances).toHaveLength(1);expect(raw.remove).not.toHaveBeenCalled();expect(raw.controls).toHaveLength(3);
  await act(async()=>root.unmount());expect(raw.remove).toHaveBeenCalledTimes(1);expect(raw.events).toHaveLength(0);
 }finally{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});
