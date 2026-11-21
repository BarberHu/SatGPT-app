import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import MapContainer from '../components/MapContainer';
import { AppProvider, useAppContext } from '../context/AppContext';
import { SharedMapProvider, SharedMapSurface, useSharedMap } from './SharedMapContext';
import { basicSelectionKey } from '../aoi/snapshot';
import usePresetLayers from '../hooks/usePresetLayers';
import PresetMapController from '../presets/PresetMapController';
import { FakeMap } from './tests/fakeMap';
import { MapboxAdapter } from './mapboxAdapter';
import { MapService } from './mapService';
import { MAPBOX_STREETS_V8 } from './layerSpec';
import { ROAD_LEVELS, ROAD_OUTLINE_COLOR } from './roadLevels';
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
function Probe({active}) { observed.context=useAppContext();observed.map=useSharedMap();const {rows,store}=usePresetLayers();observed.store=store;return <><MapContainer active={active}/><PresetMapController rows={rows} store={store}/></>; }
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
  const selectionVisibility = () => ['grid_cell-layer', 'analysis-aoi-fill', 'analysis-aoi-outline']
   .map(id => raw.getLayer(`satgpt-basic-aux:${id}`).layout.visibility);
  const clickGrid=async FID=>{
   raw.queryRenderedFeatures=()=>[{properties:{FID}}];
   await act(async()=>raw.fire('click',{point:{x:20,y:30}}));
  };
  expect(gridToggle().getAttribute('aria-pressed')).toBe('true');
  await clickGrid(0);
  const savedAoi=observed.context.selectedAOI;
  const savedSelection=localStorage.getItem(basicSelectionKey);
  const fitsAfterSelection=raw.fitBounds.mock.calls.length;
  expect(savedAoi.source).toBe('fishnet');
  expect(savedAoi.bounds).toEqual({west:100,south:10,east:101,north:11});
  expect(selectionVisibility()).toEqual(['visible','visible','visible']);
  await act(async()=>gridToggle().click());
  expect(gridToggle().getAttribute('aria-pressed')).toBe('false');
  expect(selectionVisibility()).toEqual(['none','none','none']);
  await clickGrid(1);
  expect(observed.context.selectedAOI).toBe(savedAoi);
  expect(raw.getSource('satgpt-basic-aux:analysis-aoi').data).toEqual(savedAoi.geojson);
  await act(async()=>node.querySelector('[data-switch]').click());
  await clickGrid(1);
  expect(observed.context.selectedAOI).toBe(savedAoi);
  await act(async()=>node.querySelector('[data-switch]').click());
  expect(gridToggle().getAttribute('aria-pressed')).toBe('false');
  expect(selectionVisibility()).toEqual(['none','none','none']);
  await act(async()=>gridToggle().click());
  expect(selectionVisibility()).toEqual(['visible','visible','visible']);
  expect(observed.context.selectedAOI).toBe(savedAoi);
  expect(localStorage.getItem(basicSelectionKey)).toBe(savedSelection);
  expect(raw.fitBounds).toHaveBeenCalledTimes(fitsAfterSelection);
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
  await act(async()=>gridToggle().click());
  expect(selectionVisibility()).toEqual(['none','none','none']);
  expect(raw.getLayer(physical).layout.visibility).toBe('visible');
  await act(async()=>{observed.store.patch(id,{visible:false,opacity:.4});});
  await act(async () => { observed.context.setIs3DEnabled(true); observed.context.setIsBuildingsEnabled(true); });
  const beforeStyleSwitch = observed.context.selectedAOI;
  const cameraCallsBeforeStyleSwitch = raw.fitBounds.mock.calls.length;
  let styleSwitch;
  await act(async () => { styleSwitch = observed.map.service.setBasemap('mapbox://styles/mapbox/light-v11'); });
  await act(async () => { raw.finishStyle(); await styleSwitch; });
  expect(selectionVisibility()).toEqual(['none','none','none']);
  expect(observed.context.selectedAOI).toBe(beforeStyleSwitch);
  expect(raw.getSource('satgpt-basic-aux:analysis-aoi').data).toEqual(beforeStyleSwitch.geojson);
  expect(raw.getSource('satgpt-basic:mapbox-dem')).toMatchObject({ type: 'raster-dem' });
  expect(raw.getLayer('satgpt-basic:3d-buildings')).toBeUndefined();
  expect(raw.fitBounds).toHaveBeenCalledTimes(cameraCallsBeforeStyleSwitch);
  await act(async()=>node.querySelector('[data-switch]').click());await act(async()=>node.querySelector('[data-switch]').click());
  expect(raw.getLayer(physical).layout.visibility).toBe('none');expect(raw.getPaintProperty(physical,'raster-opacity')).toBe(.4);
  expect(FakeMap.instances).toHaveLength(1);expect(raw.remove).not.toHaveBeenCalled();expect(raw.controls).toHaveLength(2);
  await act(async()=>root.unmount());expect(raw.remove).toHaveBeenCalledTimes(1);expect(raw.events).toHaveLength(0);
 }finally{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();delete globalThis.IS_REACT_ACT_ENVIRONMENT;}
});

test('the Streets v8 grid overlays retain their bounds and levels across basemap and mode changes', async () => {
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  const engine = new MapboxAdapter(document.createElement('div'), { token: 'pk.test', style: 'mapbox://styles/test' });
  const service = new MapService(engine);
  const group = 'basic:presets';
  const scope = service.scope(group);
  const physical = service.physical(group, 'roads');
  const source = `satgpt-source-${physical}`;
  const layer = `satgpt-layer-${physical}`;
  const bounds = [113.504, 29.304, 115.254, 31.054];
  const adjacent = service.physical(group, 'adjacent-roads');
  const adjacentLayer = `satgpt-layer-${adjacent}`;
  const adjacentSource = `satgpt-source-${adjacent}`;
  const adjacentBounds = [115.254, 29.304, 117.004, 31.054];
  const roadCanvases = () => [...engine.map.getContainer().querySelectorAll('.road-tiles-canvas')];
  try {
    scope.addLayer({ id: 'roads', kind: 'vector', url: MAPBOX_STREETS_V8, sourceLayer: 'road', bounds, roadLevels: ['major'] });
    expect(engine.map.getSource(source)).toMatchObject({ type: 'vector', url: MAPBOX_STREETS_V8, bounds });
    expect(engine.map.getSource(source)).not.toHaveProperty('tiles');
    expect(engine.map.getLayer(layer)).toMatchObject({
      source, 'source-layer': 'road', type: 'line',
      paint: { 'line-opacity': 0 },
      filter: ['all', ['==', ['geometry-type'], 'LineString'], ['in', ['get', 'class'], ['literal', [
        'motorway', 'trunk', 'primary', 'secondary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link',
        'tertiary', 'tertiary_link', 'street', 'street_limited', 'service', 'track',
      ]]]],
    });
    let overlay = engine.map.getContainer().querySelector('.road-tiles-canvas');
    expect(overlay.hidden).toBe(false);
    const sourceBefore = engine.map.getSource(source);
    scope.setRoadLevels('roads', ['secondary', 'local']);
    expect(engine.map.getSource(source)).toBe(sourceBefore);
    expect(scope.listLayers()[0].roadLevels).toEqual(['secondary', 'local']);
    scope.addLayer({ id: 'adjacent-roads', kind: 'vector', url: MAPBOX_STREETS_V8, sourceLayer: 'road',
      bounds: adjacentBounds, roadLevels: ['major'] });
    expect(roadCanvases().map(canvas => canvas.hidden)).toEqual([false, false]);

    const switchStyle = service.setBasemap('mapbox://styles/mapbox/satellite-streets-v12', { hideRoads: true });
    engine.map.addLayer({ id: 'road-primary', type: 'line', source: 'composite', 'source-layer': 'road' });
    engine.map.finishStyle();
    await switchStyle;
    expect(engine.map.getLayoutProperty('road-primary', 'visibility')).toBe('none');
    expect(engine.map.getLayoutProperty(layer, 'visibility')).toBe('visible');
    expect(engine.map.getLayoutProperty(adjacentLayer, 'visibility')).toBe('visible');
    expect(engine.map.getSource(source)).toMatchObject({ type: 'vector', url: MAPBOX_STREETS_V8, bounds });
    expect(engine.map.getSource(adjacentSource)).toMatchObject({ type: 'vector', url: MAPBOX_STREETS_V8, bounds: adjacentBounds });
    expect(scope.listLayers().map(item => item.roadLevels)).toEqual([['secondary', 'local'], ['major']]);
    expect(overlay.parentNode).toBeNull();
    overlay = roadCanvases()[0];
    expect(roadCanvases().map(canvas => canvas.hidden)).toEqual([false, false]);

    service.setMode('agent');
    expect(engine.map.getLayoutProperty(layer, 'visibility')).toBe('none');
    expect(engine.map.getLayoutProperty(adjacentLayer, 'visibility')).toBe('none');
    expect(roadCanvases().map(canvas => canvas.hidden)).toEqual([true, true]);
    engine.map.fire('style.load');
    expect(engine.map.getLayoutProperty(layer, 'visibility')).toBe('none');
    expect(overlay.isConnected).toBe(false);
    service.setMode('basic');
    expect(engine.map.getLayoutProperty(layer, 'visibility')).toBe('visible');
    expect(engine.map.getLayoutProperty(adjacentLayer, 'visibility')).toBe('visible');
    expect(roadCanvases().map(canvas => canvas.hidden)).toEqual([false, false]);
    scope.removeLayer('roads');
    expect(engine.map.getSource(source)).toBeUndefined();
    expect(engine.map.getLayer(layer)).toBeUndefined();
    expect(engine.map.getLayer(adjacentLayer)).toBeDefined();
    expect(roadCanvases().map(canvas => canvas.hidden)).toEqual([false]);
  } finally {
    service.dispose();
    context.mockRestore();
  }
});

test('the road canvas clips outlined lines, preserves road hierarchy and is exported', () => {
  const strokes = [];
  const roadStrokes = ({ width, outlineWidth, color }) => [
    { width: outlineWidth, color: ROAD_OUTLINE_COLOR }, { width, color },
  ];
  const draw = Object.fromEntries([
    'setTransform', 'clearRect', 'save', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'clip', 'restore',
  ].map(name => [name, vi.fn()]));
  draw.stroke = vi.fn(() => strokes.push({ width: draw.lineWidth, color: draw.strokeStyle }));
  const composite = { drawImage: vi.fn() };
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function getContext() {
    return this.classList.contains('road-tiles-canvas') ? draw : composite;
  });
  const png = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,roads');
  const engine = new MapboxAdapter(document.createElement('div'), { token: 'pk.test', style: 'mapbox://styles/test' });
  const service = new MapService(engine);
  const group = 'basic:presets';
  const scope = service.scope(group);
  const physical = service.physical(group, 'roads');
  const source = `satgpt-source-${physical}`;
  const layer = `satgpt-layer-${physical}`;
  const bounds = [100, 10, 102, 12];
  const raw = engine.map;
  let offset = 0;
  raw.project = ([lng, lat]) => ({ x: Math.round(50 + (lng - 100) * 100) + offset, y: 100 - (lat - 10) * 40 });
  raw.queryRenderedFeatures = vi.fn(() => ['motorway', 'tertiary_link', 'service', 'rail'].map(kind => ({
    properties: { class: kind }, geometry: { type: 'LineString', coordinates: [[99.7, 11], [102.3, 11]] },
  })));

  try {
    scope.addLayer({ id: 'roads', kind: 'vector', url: MAPBOX_STREETS_V8, sourceLayer: 'road', bounds, roadLevels: ['major'] });
    raw.fire('render');
    expect(raw.queryRenderedFeatures).toHaveBeenLastCalledWith([[50, 20], [250, 100]], { layers: [layer] });
    expect(draw.moveTo.mock.calls).toEqual([[50, 100], [20, 60]]);
    expect(draw.lineTo).toHaveBeenLastCalledWith(280, 60);
    expect(draw.clip.mock.invocationCallOrder[0]).toBeLessThan(draw.stroke.mock.invocationCallOrder[0]);
    expect(strokes).toEqual(roadStrokes(ROAD_LEVELS[0]));
    raw.fire('render');
    expect(raw.queryRenderedFeatures).toHaveBeenCalledTimes(1);
    offset = 25;
    raw.fire('move').fire('render');
    expect(raw.queryRenderedFeatures).toHaveBeenLastCalledWith([[75, 20], [275, 100]], { layers: [layer] });
    raw.fire('resize').fire('render');
    raw.fire('sourcedata', { sourceId: source }).fire('render');
    expect(raw.queryRenderedFeatures).toHaveBeenCalledTimes(4);

    strokes.length = 0;
    scope.setRoadLevels('roads', ['major', 'secondary', 'local']);
    raw.fire('render');
    expect(strokes).toEqual([...ROAD_LEVELS].reverse().flatMap(roadStrokes));
    const overlay = raw.getContainer().querySelector('.road-tiles-canvas');
    expect(service.captureSnapshot()).toBe('data:image/png;base64,roads');
    expect(composite.drawImage.mock.calls).toEqual([
      [raw.getCanvas(), 0, 0], [overlay, 0, 0, raw.getCanvas().width, raw.getCanvas().height],
    ]);
    scope.setRoadLevels('roads', []);
    expect(overlay.hidden).toBe(true);
    expect(service.captureSnapshot()).toBe('data:image/png;base64,AA==');
  } finally {
    service.dispose();
    context.mockRestore();
    png.mockRestore();
  }
});
