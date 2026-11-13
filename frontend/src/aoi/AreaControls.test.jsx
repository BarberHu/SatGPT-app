import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { IDBFactory } from 'fake-indexeddb';
import { AoiLibraryProvider, useAoiLibrary } from './AoiLibraryContext';
import AreaControls from './AreaControls';
import { aoiSnapshot } from './snapshot';
import { RegionSelection } from '../harness/map/regionSelection';

const geometry = {type:'Polygon',coordinates:[[[100,10],[101,10],[101,11],[100,11],[100,10]]]};
let node, root, state;
const flush = () => act(async () => new Promise(resolve => setTimeout(resolve, 25)));
const click = async text => {
  const button = [...document.querySelectorAll('button')].find(b => (b.textContent === text || b.getAttribute('aria-label') === text) && !b.disabled);
  expect(button,text).toBeTruthy(); await act(async () => button.click()); await flush();
};
const name = async value => {
  const input = document.querySelector('.aoi-dialog input:not([type])');
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})); });
};
function Probe() {
  const library = useAoiLibrary();
  const [basic] = useState(() => aoiSnapshot({geojson:geometry,label:'Original area',source:'draw'}));
  const [selection] = useState(() => new RegionSelection('agent-a',localStorage));
  const [,refresh] = useState(0);
  state = {library,basic,selection};
  return <><section aria-label="Basic controls"><AreaControls current={basic} scopeKey="basic" /></section>
    <section aria-label="Agent controls"><AreaControls current={selection.aoi} scopeKey="agent:a"
      onUse={aoi=>{selection.use(aoi);refresh(n=>n+1);}}
      onClear={()=>{selection.clear();refresh(n=>n+1);}}
      onToggleOutline={()=>{selection.toggleOutline();refresh(n=>n+1);}} outlineVisible={selection.outlineVisible} /></section></>;
}
beforeEach(()=>{globalThis.IS_REACT_ACT_ENVIRONMENT=true;vi.stubGlobal('indexedDB',new IDBFactory());localStorage.clear();node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();vi.unstubAllGlobals();delete globalThis.IS_REACT_ACT_ENVIRONMENT;});

test('one library shares Basic saves with Agent; rename/delete/hide/clear preserve the adopted snapshot', async()=>{
  await act(async()=>root.render(<AoiLibraryProvider><Probe/></AoiLibraryProvider>));await flush();await flush();
  await click('Save area');await name('Shared basin');await click('Save locally');
  expect(state.library.records).toHaveLength(1);
  await click('Close saved areas');
  const agent=node.querySelector('[aria-label="Agent controls"]');
  await act(async()=>agent.querySelector('button').click());await flush();await click('Use');
  expect(state.selection.snapshot()).toEqual(geometry);expect(state.selection.metadata().label).toBe('Shared basin');
  await click('Hide boundary');expect(state.selection.snapshot()).toEqual(geometry);expect(state.selection.outlineVisible).toBe(false);
  await act(async()=>agent.querySelector('button').click());await flush();await click('Rename');await name('New library name');await click('Save changes');
  expect(state.library.records[0].label).toBe('New library name');expect(state.selection.metadata().label).toBe('Shared basin');
  await click('Delete');expect(state.library.records[0].deleted_at).toBeTruthy();expect(state.selection.snapshot()).toEqual(geometry);
  const checkbox=document.querySelector('.aoi-dialog input[type=checkbox]');await act(async()=>checkbox.click());await flush();await click('Restore');
  expect(state.library.records[0].deleted_at).toBeNull();
  await click('Close saved areas');await click('Remove selection');expect(state.selection.snapshot()).toBeNull();expect(state.library.records).toHaveLength(1);
});

test('read failures block writes and migration, while retaining an explicit retry path',async()=>{
  const repository={list:vi.fn().mockRejectedValue(Error('unavailable')),migrate:vi.fn(),save:vi.fn()};
  await act(async()=>root.render(<AoiLibraryProvider repository={repository}><Probe/></AoiLibraryProvider>));await flush();
  expect(state.library.ready).toBe(false);expect(repository.migrate).not.toHaveBeenCalled();
  expect(node.querySelector('[aria-label="Basic controls"] button:nth-child(2)').disabled).toBe(true);
  await click('Saved areas');expect(document.querySelector('[role=alert]').textContent).toContain('Existing data has been kept');
  expect(repository.save).not.toHaveBeenCalled();
});

test('late saves remain global library records without applying to another conversation',async()=>{
  let finish;
  const record={...aoiSnapshot({geojson:geometry,label:'Session A'}),revision:1};
  const repository={list:vi.fn().mockResolvedValue([]),migrate:vi.fn().mockResolvedValue({invalid:0}),save:vi.fn(()=>new Promise(resolve=>{finish=resolve;}))};
  function Session({id}) {return <AreaControls current={record} scopeKey={id} onUse={vi.fn()}/>;}
  const render=id=>root.render(<AoiLibraryProvider repository={repository}><Session id={id}/></AoiLibraryProvider>);
  await act(async()=>render('a'));await flush();await click('Save area');await click('Save locally');
  await act(async()=>render('b'));await act(async()=>finish(record));await flush();
  expect(document.querySelector('[role=dialog]')).toBeNull();expect(node.textContent).not.toContain('saved locally.');
  expect(repository.save).toHaveBeenCalledTimes(1);
});

test('GeoJSON export and import preserve geometry and name in a separate library record',async()=>{
  let exported;
  const createURL=vi.fn(blob=>{exported=blob;return 'blob:area-export';});
  const previousCreate=URL.createObjectURL, previousRevoke=URL.revokeObjectURL;
  URL.createObjectURL=createURL; URL.revokeObjectURL=vi.fn();
  const download=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
  try {
    await act(async()=>root.render(<AoiLibraryProvider><Probe/></AoiLibraryProvider>));await flush();await flush();
    await click('Save area');await name('Exported basin');await click('Save locally');
    const original=state.library.records[0];
    await click('Export GeoJSON');
    const text=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsText(exported);});
    const feature=JSON.parse(text);
    expect(feature.geometry).toEqual(geometry);expect(feature.properties.label).toBe('Exported basin');
    expect(download).toHaveBeenCalledTimes(1);
    const input=document.querySelector('input[aria-label="Import saved area GeoJSON"]');
    Object.defineProperty(input,'files',{configurable:true,value:[{name:'backup.geojson',size:text.length,text:async()=>text}]});
    await act(async()=>input.dispatchEvent(new Event('change',{bubbles:true})));await flush();
    expect(document.querySelector('.aoi-dialog input:not([type])').value).toBe('Exported basin');
    await click('Save locally');
    expect(state.library.records).toHaveLength(2);
    expect(new Set(state.library.records.map(row=>row.id)).size).toBe(2);
    expect(state.library.records.find(row=>row.id!==original.id).geojson.geometry).toEqual(geometry);
    expect(state.selection.snapshot()).toBeNull();
  } finally {download.mockRestore();URL.createObjectURL=previousCreate;URL.revokeObjectURL=previousRevoke;}
});

test('saving through the Composer portal never submits the surrounding chat form',async()=>{
  const send=vi.fn();
  const current=aoiSnapshot({geojson:geometry,label:'Composer area'});
  await act(async()=>root.render(<AoiLibraryProvider><form onSubmit={event=>{event.preventDefault();send();}}>
    <AreaControls current={current} scopeKey="composer"/>
  </form></AoiLibraryProvider>));await flush();await flush();
  await click('Save area');await click('Save locally');
  expect(send).not.toHaveBeenCalled();
  expect(document.querySelector('.aoi-list').textContent).toContain('Composer area');
});

test('invalid legacy data remains visibly reported after opening or refreshing the library',async()=>{
  const repository={list:vi.fn().mockResolvedValue([]),migrate:vi.fn().mockResolvedValue({invalid:1})};
  await act(async()=>root.render(<AoiLibraryProvider repository={repository}><Probe/></AoiLibraryProvider>));await flush();await flush();
  await click('Saved areas');
  expect(document.querySelector('[role=alert]').textContent).toContain('1 legacy area(s)');
  await click('Retry / refresh');
  expect(document.querySelector('[role=alert]').textContent).toContain('Original data has been kept');
  expect(state.library.ready).toBe(true);
});

test('compact area actions require an explicit expansion and keep boundary hiding separate from clearing',async()=>{
  const onClear=vi.fn(),onToggleOutline=vi.fn();
  const current=aoiSnapshot({geojson:geometry,label:'Compact basin'});
  await act(async()=>root.render(<AoiLibraryProvider><AreaControls compact current={current} scopeKey="basic"
    onClear={onClear} onToggleOutline={onToggleOutline}/></AoiLibraryProvider>));await flush();await flush();
  const group=document.querySelector('.aoi-secondary-actions');expect(group.hidden).toBe(true);
  await click('More area actions');expect(group.hidden).toBe(false);
  await click('Hide boundary');expect(onToggleOutline).toHaveBeenCalledTimes(1);expect(onClear).not.toHaveBeenCalled();
  await click('Remove selection');expect(onClear).toHaveBeenCalledTimes(1);
});
