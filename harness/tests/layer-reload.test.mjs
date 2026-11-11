import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../frontend/package.json',import.meta.url));
const previousEnv = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
const React = require('react'); const {renderToStaticMarkup} = require('react-dom/server');
previousEnv === undefined ? delete process.env.NODE_ENV : process.env.NODE_ENV = previousEnv;
const {buildSync} = require('esbuild');
const root = fileURLToPath(new URL('../../frontend',import.meta.url));
const compiled = buildSync({stdin:{contents:`export {MapService} from '${root.replaceAll('\\','/')}/src/map/mapService.js'; export {default as MapLayerCard} from '${root.replaceAll('\\','/')}/src/harness/components/MapLayerCard.jsx';`,resolveDir:root},
  bundle:true,platform:'node',format:'cjs',write:false,external:['react'],alias:{'@':`${root}/src`},define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
const module = {exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(require,module,module.exports);
const {MapService,MapLayerCard} = module.exports;
const tile = value => `https://earthengine.googleapis.com/v1/projects/p/maps/${value}/tiles/{z}/{x}/{y}`;
const spec = (id,version=0) => ({id,kind:'gee',name:`Layer ${id}`,url:tile(`v${version}`),
  code:`result = ee.Image(${id==='one'?1:2})`,generation:{version:1,code:`result = ee.Image(${id==='one'?1:2})`},
  reloadable:true,reload_version:version,bounds:[100,10,101,11]});

function workspace() {
  const paint = new Map(), moves = []; let cameraMoves = 0;
  const engine = {onStyleReady:()=>()=>{},addLayer:layer=>{paint.delete(layer.id);paint.set(layer.id,layer);},
    removeLayer:id=>paint.delete(id),setVisibility:(id,visible)=>{paint.get(id).visible=visible;},
    moveLayer:id=>{const value=paint.get(id);paint.delete(id);paint.set(id,value);moves.push(id);},
    setView:()=>cameraMoves++,setBasicActive:()=>{}};
  const service = new MapService(engine); service.setMode('agent'); service.selectConversation('a');
  return {service,paint,moves,cameraMoves:()=>cameraMoves};
}

test('generation code survives normalization and reload preserves identity, visibility, opacity and paint order',()=>{
  const {service,paint,cameraMoves} = workspace(); const scope=service.scope('agent:a');
  scope.addLayer({...spec('one'),visible:false,opacity:.35}); scope.addLayer(spec('two'));
  const before=[...paint.keys()];
  const next=scope.replaceLayer('one',{...spec('one',1),reloaded_at:'2026-11-09T00:00:00Z'});
  assert.equal(next.id,'one'); assert.equal(next.visible,false); assert.equal(next.opacity,.35);
  assert.equal(next.code,'result = ee.Image(1)'); assert.equal(next.generation.code,next.code);
  assert.equal(next.reloadVersion,1); assert.deepEqual([...paint.keys()],before);
  assert.equal(cameraMoves(),0); assert.equal(scope.listLayers().length,2);
  assert.equal(scope.replaceLayer('one',spec('one',0)),false,'stale history cannot replace a refreshed URL');
});

test('late reloads stay in the original hidden conversation and cannot resurrect removed layers',()=>{
  const {service,paint}=workspace(), first=service.scope('agent:a'), other=service.scope('agent:b');
  first.addLayer(spec('one')); other.addLayer(spec('two')); service.selectConversation('b');
  first.replaceLayer('one',spec('one',1));
  assert.equal(paint.get(service.physical('agent:a','one')).visible,false);
  assert.equal(other.listLayers()[0].url,tile('v0'));
  first.removeLayer('one'); assert.equal(first.replaceLayer('one',spec('one',2)),false);
  assert.equal(first.listLayers().length,0);
});

test('layer card offers reload with loading/error states and disables unavailable legacy replay',()=>{
  const render=layer=>renderToStaticMarkup(React.createElement(MapLayerCard,{layer,onToggle:()=>{},onFocus:()=>{},onRemove:()=>{},onReload:()=>{}}));
  const base={...spec('one'),visible:true,metadata:{},visualization:{},legend:{type:'unavailable'}};
  assert.match(render(base),/aria-label="Reload Layer one"/);
  const loading=render({...base,reload:{reloading:true}});
  assert.match(loading,/Reloading from Earth Engine/); assert.match(loading,/disabled=""/);
  const failed=render({...base,reload:{tiles:'error',error:'GEE unavailable'}});
  assert.match(failed,/Layer unavailable or expired/); assert.match(failed,/role="alert"/);
  assert.match(failed,/GEE unavailable/);
  const legacy=render({...base,reloadable:false,reloadUnavailableReason:'Missing original scope'});
  assert.match(legacy,/title="Missing original scope"/); assert.match(legacy,/disabled=""/);
});
