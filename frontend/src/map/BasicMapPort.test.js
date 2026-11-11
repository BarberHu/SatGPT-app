import { BasicMapPort } from './BasicMapPort';
import { FakeMap } from './tests/fakeMap';
import { MapService } from './mapService';

test('Basic namespaces layers, sources and events, and group hiding does not overwrite visibility or opacity', () => {
 const raw=new FakeMap();const extension=new BasicMapPort(raw);const map=extension.port;extension.activate(true);
 map.addSource('water',{type:'raster',tiles:['https://example.test/{z}/{x}/{y}']});
 map.addLayer({id:'water-layer',source:'water',type:'raster',layout:{visibility:'visible'},paint:{'raster-opacity':.3}});
 map.addSource('grid_cell',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
 map.addLayer({id:'grid_cell-layer',source:'grid_cell',type:'fill'});
 expect(raw.getLayer('satgpt-basic:water-layer').source).toBe('satgpt-basic:water');
 expect(raw.getLayer('satgpt-basic-aux:grid_cell-layer')).toBeTruthy();
 const clicked=vi.fn();map.on('click','grid_cell-layer',clicked);raw.fire('click',{point:{x:1,y:1}});expect(clicked).toHaveBeenCalledTimes(1);
 const lease=map.createViewLease();extension.activate(false);
 raw.fire('click');expect(clicked).toHaveBeenCalledTimes(1);
 expect(raw.getLayoutProperty('satgpt-basic:water-layer','visibility')).toBe('none');
 expect(map.getLayoutProperty('water-layer','visibility')).toBe('visible');
 map.setLayoutProperty('water-layer','visibility','none');extension.activate(true);
 expect(raw.getLayoutProperty('satgpt-basic:water-layer','visibility')).toBe('none');
 expect(raw.getPaintProperty('satgpt-basic:water-layer','raster-opacity')).toBe(.3);
 lease.fitBounds([[1,1],[2,2]]);expect(raw.fitBounds).not.toHaveBeenCalled();
 map.fitBounds([[1,1],[2,2]]);expect(raw.fitBounds).toHaveBeenCalledTimes(1);
 map.removeLayer('grid_cell-layer');map.off('click','grid_cell-layer',clicked);expect(raw.events).toHaveLength(0);
 extension.dispose();extension.dispose();
});

test('session scopes use different physical IDs and hide groups without changing saved user visibility',()=>{
 const driver={onStyleReady:()=>()=>{},addLayer:vi.fn(),removeLayer:vi.fn(),setVisibility:vi.fn(),setBasicActive:vi.fn(),setView:vi.fn(),dispose:vi.fn()};
 const service=new MapService(driver);const one=service.scope('agent:one');const two=service.scope('agent:two');
 const layer={id:'job-0',kind:'geojson',data:{type:'FeatureCollection',features:[]}};
 one.addLayer(layer);two.addLayer(layer);expect(driver.addLayer.mock.calls[0][0].id).not.toBe(driver.addLayer.mock.calls[1][0].id);
 service.selectConversation('one');service.setMode('agent');one.setVisibility('job-0',false);
 service.setMode('basic');service.selectConversation('two');two.setView({zoom:8});expect(driver.setView).not.toHaveBeenCalled();
 service.setMode('agent');expect(one.listLayers()[0].visible).toBe(false);expect(two.listLayers()[0].visible).toBe(true);
 expect(driver.setVisibility).toHaveBeenLastCalledWith(service.physical('agent:two','job-0'),true);
 service.dispose();service.dispose();expect(driver.dispose).toHaveBeenCalledTimes(1);
});

test('Basic controls, native DOM listeners and draw gesture preferences suspend and restore without duplication',()=>{
 const raw=new FakeMap();const ext=new BasicMapPort(raw);const port=ext.port;ext.activate(true);
 const control={onAdd:vi.fn(()=>document.createElement('div')),onRemove:vi.fn()};port.addControl(control);port.addControl(control);
 port.doubleClickZoom.disable();const key=vi.fn();port.getContainer().addEventListener('keydown',key);
 raw.getContainer().dispatchEvent(new KeyboardEvent('keydown',{key:'Delete'}));expect(key).toHaveBeenCalledTimes(1);
 ext.activate(false);expect(raw.controls).toHaveLength(1);expect(raw.doubleClickZoom.isEnabled()).toBe(true);
 raw.getContainer().dispatchEvent(new KeyboardEvent('keydown',{key:'Delete'}));expect(key).toHaveBeenCalledTimes(1);
 ext.activate(true);expect(raw.doubleClickZoom.isEnabled()).toBe(false);expect(control.onAdd).toHaveBeenCalledTimes(1);
 ext.dispose();expect(control.onRemove).toHaveBeenCalledTimes(1);
 raw.getContainer().dispatchEvent(new KeyboardEvent('keydown'));expect(key).toHaveBeenCalledTimes(1);
});

test('no terrain operation runs before the initial style is ready',()=>{
 const raw=new FakeMap();raw.isStyleLoaded=()=>false;
 const ext=new BasicMapPort(raw);ext.activate(true);ext.activate(false);
 expect(raw.setTerrain).not.toHaveBeenCalled();ext.dispose();
});

test('Mapbox prototype-backed GeoJSON features retain geometry for Draw hit testing and fishnet selection',()=>{
 const raw=new FakeMap();const ext=new BasicMapPort(raw);ext.activate(true);ext.port.addSource('grid_cell',{type:'geojson'});ext.port.addLayer({id:'grid_cell-layer',source:'grid_cell',type:'fill'});
 const geometry={type:'Polygon',coordinates:[[[1,1],[2,1],[2,2],[1,1]]]};
 const feature=Object.create({get geometry(){return geometry;},get type(){return 'Feature';},get properties(){return {meta:'feature'};}});
 feature.layer={id:'satgpt-basic-aux:grid_cell-layer',source:'satgpt-basic-aux:grid_cell',type:'fill'};
 raw.queryRenderedFeatures=()=>[feature];
 const result=ext.port.queryRenderedFeatures({x:1,y:1},{layers:['grid_cell-layer']})[0];
 expect(result.geometry).toEqual(geometry);expect(result.properties.meta).toBe('feature');expect(result.layer.id).toBe('grid_cell-layer');ext.dispose();
});
