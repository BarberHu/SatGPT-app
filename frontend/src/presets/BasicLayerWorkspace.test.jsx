import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { test, vi, expect, beforeEach, afterEach } from 'vitest';
import { AppProvider, useAppContext } from '../context/AppContext';
import BasicLayerWorkspace from './BasicLayerWorkspace';
import httpClient from '../api/httpClient';
import { writeBasicSelection } from '../aoi/snapshot';
import { buildAoiFromBounds, buildAoiFromGridSelection } from '../utils/aoi';
import { ROAD_LEVELS, ROAD_OUTLINE_COLOR } from '../map/roadLevels';

const state=vi.hoisted(()=>({context:null,scope:null,service:null,request:null,tileListeners:null}));
vi.mock('../map/SharedMapContext',()=>({useSharedMap:()=>({service:state.service})}));
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
 state.tileListeners = new Set();
 state.scope={addLayer:vi.fn(),removeLayer:vi.fn(),setVisibility:vi.fn(),setRoadLevels:vi.fn(),setOpacity:vi.fn(),setOrder:vi.fn(),setView:vi.fn(),subscribeTileStatus:listener=>{
   state.tileListeners.add(listener);
   return ()=>state.tileListeners.delete(listener);
 }};
 state.service={scope:()=>state.scope,getCurrentView:()=>({zoom:8}),subscribeView:vi.fn()};
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
 const card = node.querySelector('[aria-label="Layer Slope Steepness"]');
 const locate = card.querySelector('[aria-label="Locate layer"]');
 expect(locate.nextElementSibling.getAttribute('aria-label')).toBe('Show Slope Steepness');
 expect(card.querySelector('.preset-layer-details').hidden).toBe(true);
 await act(async () => locate.click());
 expect(state.scope.setView).toHaveBeenCalledWith({ bounds: [100, 10, 101, 11] });
 expect(card.querySelector('.preset-layer-details').hidden).toBe(true);
 await click('Details for Slope Steepness');
 expect(card.querySelectorAll('[aria-label="Locate layer"]')).toHaveLength(1);
 const slider=node.querySelector('[aria-label="Opacity for Slope Steepness"]');
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'0.35');slider.dispatchEvent(new Event('input',{bubbles:true}));});
 expect(state.scope.setOpacity).toHaveBeenCalledWith(expect.any(String),.35);
 await click('Move down');expect(state.scope.setOrder.mock.lastCall[0]).toHaveLength(2);
 await click('Remove layer');expect(node.querySelectorAll('.preset-layer-card')).toHaveLength(1);expect(state.scope.removeLayer).toHaveBeenCalled();
});

test('a failed preset stays locatable at its original grid with details closed', async () => {
  state.request.mockRejectedValueOnce(new Error('Generation failed'));
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  await selectGrid(100);
  await click('Load layer');
  await flush();
  await selectGrid(101);

  const card = node.querySelector('[aria-label="Layer JRC annual water classification"]');
  expect(card.querySelector('.preset-layer-warning').textContent).toContain('Generation failed');
  expect(card.querySelector('.preset-layer-details').hidden).toBe(true);
  await act(async () => card.querySelector('[aria-label="Locate layer"]').click());
  expect(state.scope.setView).toHaveBeenCalledWith({ bounds: [100, 10, 101, 11] });
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

test('hazard themes switch the layer list without repeating their names as headings', async () => {
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  const library = node.querySelector('[aria-label="Layer library"]');
  const themeButtons = [...library.querySelectorAll('[aria-label="Hazard theme"] button')];
  const expectedLayers = [
    ['JRC annual water classification', 'Inundation Hotspot'],
    ['Wildfire Risk', 'Burn History'],
    ['Landslide Risk', 'Slope Steepness'],
  ];
  expect(themeButtons.map(button => button.textContent)).toEqual(['Flood', 'Wildfire', 'Landslide']);

  for (const [index, button] of themeButtons.entries()) {
    await act(async () => button.click());
    expect(themeButtons.filter(theme => theme.getAttribute('aria-pressed') === 'true')).toEqual([button]);
    expect([...library.querySelectorAll('.preset-list:first-of-type .preset-select strong')].map(title => title.textContent))
      .toEqual(expectedLayers[index]);
    expect([...library.querySelectorAll('.preset-list h3')].map(title => title.textContent)).toEqual(['Context']);
  }
});

test('Basic population cards use the same six count classes for multiple grids', async () => {
  const dataset = 'JRC/GHSL/P2023A/GHS_POP/2020';
  const previewUrl = 'https://earthengine.googleapis.com/v1/projects/p/thumbnails/preview:getPixels';
  const labels = ['>0 to 1', '>1 to 5', '>5 to 20', '>20 to 100', '>100 to 500', '>500'];
  const palette = ['ffffe7', 'ffc869', 'ffac1d', 'e17735', 'f2552c', '9f0c21'];
  const post = vi.spyOn(httpClient, 'post').mockResolvedValue({ data: {
    status: 'ready', effective_params: {}, layer: {
      name: 'Population Count', kind: 'gee',
      url: 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}',
      thumbnail: { url: previewUrl }, visualization: { min: 0, max: 5, palette },
      legend: { type: 'categorical', labels, note: '0 is transparent' },
      metadata: { source: 'JRC GHSL', dataset_id: dataset, observed_at: '2020', unit: 'people/pixel' },
    },
  } });
  const { requestPresetLayer } = await vi.importActual('../api/presetLayers');
  state.request.mockImplementation(requestPresetLayer);
  try {
    await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
    await click('Population Count');
    expect(node.querySelector('.preset-parameters').textContent).toContain('2020 · 100 m');
    await selectGrid();
    await click('Load layer');
    await flush();

    expect(post).toHaveBeenCalledWith('/api/preset-layers', {
      preset_id: 'populationDensity', aoi: expect.objectContaining({ geojson: state.context.selectedAOI.geojson }),
    }, expect.any(Object));
    await selectGrid(101);
    await click('Load layer');
    await flush();
    const cards = [...node.querySelectorAll('[aria-label="Layer Population Count"]')];
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card.textContent).toContain('JRC GHSL');
      expect(card.textContent).toContain('2020');
      expect(card.textContent).toContain('people/pixel');
      expect(card.textContent).toContain('0 is transparent');
      expect([...card.querySelectorAll('.agent-layer-categories li > span:nth-child(2)')].map(item => item.textContent)).toEqual(labels);
      expect(card.querySelector('img').getAttribute('src')).toBe(previewUrl);
      expect(card.querySelector('.preset-method').textContent).toContain(dataset);
    }
    expect(cards[0].querySelector('.agent-layer-categories').innerHTML).toBe(cards[1].querySelector('.agent-layer-categories').innerHTML);
  } finally {
    post.mockRestore();
  }
});

const sendTileStatus = (id, stateName) => act(async () => {
  for (const listener of state.tileListeners) {
    listener({ id, url: 'mapbox://mapbox.mapbox-streets-v8', state: stateName });
  }
});
const roadCard = longitude => node.querySelector(`[aria-label="Layer Road network, Grid 10.500° N, ${longitude}.500° E"]`);
const buildingCard = longitude => node.querySelector(`[aria-label="Layer Building footprints, Grid 10.500° N, ${longitude}.500° E"]`);

test('building footprints append by grid and have their own visibility and removal', async () => {
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  const load = [...node.querySelectorAll('button')].find(button => button.textContent === 'Load buildings');
  expect(load.disabled).toBe(true);
  await selectGrid();
  expect(load.disabled).toBe(false);
  await click('Load buildings');
  expect(buildingCard(100).textContent).toContain('Zoom in to see building footprints.');
  await act(async () => state.service.subscribeView.mock.lastCall[0]({zoom:16}));
  expect(buildingCard(100).textContent).not.toContain('Zoom in');
  await selectGrid(101);
  expect(buildingCard(100)).not.toBeNull();
  expect(load.disabled).toBe(false);
  await click('Load buildings');
  expect(state.scope.addLayer.mock.calls.map(([layer]) => layer)).toEqual([
    expect.objectContaining({ sourceLayer: 'building', renderAs: 'fill', bounds: [100, 10, 101, 11] }),
    expect.objectContaining({ sourceLayer: 'building', renderAs: 'fill', bounds: [101, 10, 102, 11] }),
  ]);
  await selectGrid();
  expect(load.disabled).toBe(true);
  await click('Load buildings');
  expect(state.scope.addLayer).toHaveBeenCalledTimes(2);
  expect(node.querySelector('.workspace-layer-count').textContent).toBe('2');
  await click('Hide Building footprints, Grid 10.500° N, 100.500° E');
  expect(state.scope.setVisibility).toHaveBeenCalledExactlyOnceWith('basic-building-footprints-1', false);
  expect(buildingCard(101).classList.contains('is-hidden')).toBe(false);
  const threeD = [...node.querySelectorAll('.preset-map-options label')].find(label => label.textContent === '3D Buildings');
  const before = state.context.isBuildingsEnabled;
  await act(async () => threeD.querySelector('input').click());
  expect(state.context.isBuildingsEnabled).toBe(!before);
  expect(state.scope.setVisibility).toHaveBeenCalledTimes(1);
  await click('Remove Building footprints, Grid 10.500° N, 100.500° E');
  expect(state.scope.removeLayer).toHaveBeenCalledExactlyOnceWith('basic-building-footprints-1');
  expect(buildingCard(100)).toBeNull();
  expect(buildingCard(101)).not.toBeNull();
  expect(load.disabled).toBe(false);
});

test('loads, toggles, and removes the selected grid road tiles without posting to the road API', async () => {
  const post = vi.spyOn(httpClient, 'post');
  try {
    await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
    const load = [...node.querySelectorAll('button')].find(button => button.textContent === 'Load roads');
    expect(load.disabled).toBe(true);
    await selectGrid();
    expect(load.disabled).toBe(false);
    expect(state.scope.addLayer).not.toHaveBeenCalled();
    await click('Load roads');
    expect(post).not.toHaveBeenCalled();
    expect(state.scope.addLayer).toHaveBeenCalledOnce();
    expect(state.scope.addLayer).toHaveBeenCalledWith({
      id: 'basic-road-network-1', name: 'Road network', kind: 'vector', renderAs: 'line', roadLevels: ['major'], visible: true,
      url: 'mapbox://mapbox.mapbox-streets-v8', sourceLayer: 'road', bounds: [100, 10, 101, 11],
    });
    const card = roadCard(100);
    expect(card.textContent).toContain('Mapbox Streets v8');
    const swatches = [...card.querySelectorAll('.preset-road-levels [aria-hidden="true"]')];
    expect(swatches.map(({ style }) => [
      style.getPropertyValue('--road-swatch-color'),
      style.getPropertyValue('--road-swatch-width'),
      style.getPropertyValue('--road-swatch-outline-color'),
      style.getPropertyValue('--road-swatch-outline-width'),
    ])).toEqual(ROAD_LEVELS.map(({ color, width, outlineWidth }) => [color, `${width}px`, ROAD_OUTLINE_COLOR, `${outlineWidth}px`]));
    const [major, secondary, local] = card.querySelectorAll('input');
    expect([major.checked, secondary.checked, local.checked]).toEqual([true, false, false]);
    await act(async () => { secondary.click(); local.click(); });
    expect(state.scope.setRoadLevels).toHaveBeenLastCalledWith('basic-road-network-1', ['major', 'secondary', 'local']);
    await act(async () => major.click());
    expect([major.checked, secondary.checked, local.checked]).toEqual([false, true, true]);
    expect(state.scope.setRoadLevels).toHaveBeenLastCalledWith('basic-road-network-1', ['secondary', 'local']);
    expect(state.scope.addLayer).toHaveBeenCalledOnce();
    expect(node.textContent).toContain('Loading road tiles');
    await sendTileStatus('basic-road-network-1', 'ready');
    expect(node.textContent).not.toContain('Loading road tiles');
    await click('Hide Road network, Grid 10.500° N, 100.500° E');
    expect(state.scope.setVisibility).toHaveBeenLastCalledWith('basic-road-network-1', false);
    await click('Show Road network, Grid 10.500° N, 100.500° E');
    expect(state.scope.setVisibility).toHaveBeenLastCalledWith('basic-road-network-1', true);
    await click('Remove Road network, Grid 10.500° N, 100.500° E');
    expect(state.scope.removeLayer).toHaveBeenCalledWith('basic-road-network-1');
    expect(roadCard(100)).toBeNull();
    expect(load.disabled).toBe(false);
  } finally {
    post.mockRestore();
  }
});

test('adjacent grids append road tiles, deduplicate by grid and keep independent controls', async () => {
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  await selectGrid();
  await click('Load roads');
  await selectGrid(101);
  expect(roadCard(100)).not.toBeNull();
  expect(roadCard(101)).toBeNull();
  expect(state.scope.addLayer).toHaveBeenCalledOnce();
  await click('Load roads');
  expect(state.scope.addLayer).toHaveBeenLastCalledWith(expect.objectContaining({ bounds: [101, 10, 102, 11] }));
  expect(roadCard(101)).not.toBeNull();
  expect(node.querySelector('.workspace-layer-count').textContent).toBe('2');
  await sendTileStatus('basic-road-network-1', 'ready');
  await selectGrid();
  const load = [...node.querySelectorAll('button')].find(button => button.textContent === 'Load roads');
  expect(load.disabled).toBe(true);
  await click('Load roads');
  expect(state.scope.addLayer).toHaveBeenCalledTimes(2);
  expect(state.scope.removeLayer).not.toHaveBeenCalled();
  await act(async () => roadCard(100).querySelectorAll('input')[1].click());
  expect(state.scope.setRoadLevels).toHaveBeenCalledExactlyOnceWith('basic-road-network-1', ['major', 'secondary']);
  expect(roadCard(101).querySelectorAll('input')[1].checked).toBe(false);
  await click('Hide Road network, Grid 10.500° N, 100.500° E');
  expect(state.scope.setVisibility).toHaveBeenCalledExactlyOnceWith('basic-road-network-1', false);
  expect(roadCard(101).classList.contains('is-hidden')).toBe(false);
  await click('Remove Road network, Grid 10.500° N, 100.500° E');
  expect(state.scope.removeLayer).toHaveBeenCalledExactlyOnceWith('basic-road-network-1');
  expect(roadCard(100)).toBeNull();
  expect(roadCard(101)).not.toBeNull();
  expect(load.disabled).toBe(false);
  expect(node.querySelector('.workspace-layer-count').textContent).toBe('1');
});

test('retry uses the failed card’s original grid and ignores errors from its old source', async () => {
  await act(async () => root.render(<AppProvider><Probe /></AppProvider>));
  await selectGrid();
  await click('Load roads');
  await act(async () => roadCard(100).querySelectorAll('input')[1].click());
  await selectGrid(101);
  await click('Load roads');
  await sendTileStatus('basic-road-network-2', 'ready');
  await sendTileStatus('basic-road-network-1', 'error');
  expect(roadCard(100).textContent).toContain('Mapbox road tiles failed to load.');
  expect(roadCard(101).querySelector('[role="status"]')).toBeNull();
  await act(async () => [...roadCard(100).querySelectorAll('button')].find(button => button.textContent === 'Retry').click());
  expect(state.scope.removeLayer).toHaveBeenCalledExactlyOnceWith('basic-road-network-1');
  expect(state.scope.addLayer).toHaveBeenLastCalledWith(expect.objectContaining({
    id: 'basic-road-network-3', bounds: [100, 10, 101, 11], roadLevels: ['major', 'secondary'],
  }));
  expect(roadCard(101).querySelector('[role="status"]')).toBeNull();
  await sendTileStatus('basic-road-network-3', 'ready');
  await sendTileStatus('basic-road-network-1', 'error');
  expect(roadCard(100).querySelector('[role="status"]')).toBeNull();
  expect(roadCard(101).querySelector('[role="status"]')).toBeNull();
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
