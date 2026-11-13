import React, { useCallback, useEffect, useState } from 'react';
import { Map as MapIcon, MessageSquare, PanelLeft, X } from 'lucide-react';
import { useAgentChat } from './hooks/useAgentChat';
import { useAgentMap } from './hooks/useAgentMap';
import { useAgentRegion } from './hooks/useAgentRegion';
import AreaControls from '../aoi/AreaControls';
import { getBoundsFromGeometry } from '../utils/aoi';
import { regionKey, selectionKey } from './map/regionSelection';
import ConversationSidebar from './components/ConversationSidebar';
import MessageList from './components/MessageList';
import Composer from './components/Composer';
import MapWorkspace from './components/MapWorkspace';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from './ui/resizable';
import './app.css';
import '../styles/theme.css';

function useNarrowLayout() {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.('(max-width: 960px)').matches || false);
  useEffect(() => {
    const media = window.matchMedia?.('(max-width: 960px)');
    if (!media) return undefined;
    const update = () => setNarrow(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

export default function HarnessApp({ active = true, onHistoryToolsChange }) {
  const narrow = useNarrowLayout();
  const [historyOpen, setHistoryOpen] = useState(() => !window.matchMedia?.('(max-width: 960px)').matches);
  const [mobileView, setMobileView] = useState('chat');
  const [prompt, setPrompt] = useState('');
  const chat = useAgentChat({ visible: active && (!narrow || (mobileView === 'chat' && !historyOpen)) });
  const map = useAgentMap(chat.conversationId, chat.messages);
  const region = useAgentRegion(chat.conversationId, chat.messages, active);
  const toggleHistory = useCallback(() => setHistoryOpen(open => !open), []);
  useEffect(() => {
    onHistoryToolsChange?.(!active || narrow ? null : { open: historyOpen, toggle: toggleHistory });
    return () => onHistoryToolsChange?.(null);
  }, [onHistoryToolsChange, active, narrow, historyOpen, toggleHistory]);
  useEffect(() => { setPrompt(''); }, [chat.conversationId]);
  useEffect(() => { if (narrow) setHistoryOpen(false); }, [narrow]);
  const changeConversation = async id => {
    if (chat.deleting) return;
    map.prepareConversationChange();
    if (await chat.changeConversation(id)) {
      setMobileView('chat');
      if (narrow) setHistoryOpen(false);
    }
  };
  const deleteConversation = async id => {
    if (!await chat.deleteConversation(id)) return false;
    map.forgetConversation(id);
    try {
      localStorage.removeItem(regionKey(id));
      localStorage.removeItem(selectionKey(id));
    } catch { /* A storage restriction must not turn a successful deletion into a failure. */ }
    return true;
  };
  const sidebar = <ConversationSidebar conversations={chat.conversations} currentId={chat.conversationId}
    disabled={chat.loading || chat.pending || chat.stopping || chat.deleting} onNew={() => changeConversation()}
    onDelete={deleteConversation} deleteError={chat.error}
    onSelect={id => changeConversation(id)} onCollapse={narrow ? () => setHistoryOpen(false) : undefined} />;
  const send = async () => {
    if (region.editing || region.error || chat.loading || chat.deleting) return;
    const text = prompt.trim();
    const geometry = region.snapshot();
    const area = geometry ? getBoundsFromGeometry(geometry) : null;
    const bounds = area ? [area.west, area.south, area.east, area.north] : map.bounds();
    if (text && bounds && await chat.send(text, bounds, geometry, region.metadata())) setPrompt('');
  };
  const editRegion = () => {
    if (region.begin() && narrow) setMobileView('map');
  };
  const focusLayer = layer => {
    if (narrow) {
      setMobileView('map');
      window.requestAnimationFrame(() => map.focusLayer(layer));
    } else map.focusLayer(layer);
  };
  return <div className="harness-app harness-shell" data-mobile-view={mobileView}>
    {!narrow && historyOpen ? sidebar : null}
    <Dialog open={active && narrow && historyOpen} onOpenChange={setHistoryOpen}>
      <DialogContent className="agent-history-dialog">
        <DialogTitle className="sr-only">Conversation history</DialogTitle>
        <DialogDescription className="sr-only">Start a new geospatial analysis conversation or resume an existing one</DialogDescription>
        {sidebar}
      </DialogContent>
    </Dialog>
    <div className="agent-workspace">
      <div className="agent-mobile-tabs" role="group" aria-label="Switch workspace">
        <Button type="button" variant="ghost" size="icon" aria-label="Open conversation history" onClick={() => setHistoryOpen(true)}><PanelLeft /></Button>
        <Button type="button" variant={mobileView === 'chat' ? 'secondary' : 'ghost'} aria-pressed={mobileView === 'chat'} onClick={() => setMobileView('chat')}><MessageSquare />Chat</Button>
        <Button type="button" variant={mobileView === 'map' ? 'secondary' : 'ghost'} aria-pressed={mobileView === 'map'} onClick={() => setMobileView('map')}><MapIcon />Map</Button>
      </div>
      <ResizablePanelGroup direction="horizontal" className="agent-panels" autoSaveId="satgpt-agent-workspace">
        <ResizablePanel defaultSize={52} minSize={32} className="agent-chat-panel">
          <section className="agent-chat" aria-label="Agent conversation">
            <MessageList key={chat.conversationId || 'loading'} items={chat.items} loading={chat.loading}
              reconnecting={chat.reconnecting} onSuggest={setPrompt} onFocusLayer={focusLayer} />
            {chat.error ? <div className="agent-chat-error" role="alert"><span>{chat.error}</span><Button type="button" variant="ghost" size="icon" aria-label="Dismiss error" onClick={chat.clearError}><X /></Button></div> : null}
            <Composer value={prompt} onChange={setPrompt} onSend={send} onStop={chat.stop}
              region={region} onEditRegion={editRegion}
              areaControls={<AreaControls hideEditAction current={region.aoi} scopeKey={`${active ? 'agent' : 'inactive'}:${chat.conversationId}`} disabled={!active || !region.ready || region.editing || chat.loading || chat.pending}
                onUse={region.use} onEdit={aoi => { if (region.begin(aoi) && narrow) setMobileView('map'); }}
                onLocate={aoi => focusLayer({ bounds: [aoi.bounds.west,aoi.bounds.south,aoi.bounds.east,aoi.bounds.north] })}
                outlineVisible={region.outlineVisible} onToggleOutline={region.toggleOutline} /> }
              busy={chat.busy} pending={chat.pending} stopping={chat.stopping} stopDisabled={chat.loading || chat.deleting}
              mapReady={map.ready} disabled={chat.loading || chat.busy || chat.pending || chat.stopping || chat.deleting || !map.ready || region.editing || Boolean(region.error)} />
          </section>
        </ResizablePanel>
        <ResizableHandle className="agent-resize-handle" aria-label="Resize chat and map" />
        <ResizablePanel defaultSize={48} minSize={28} className="agent-map-panel"><MapWorkspace map={map} region={region}
          onConfirmRegion={() => { if (region.confirm() && narrow) setMobileView('chat'); }}
          active={active && (!narrow || mobileView === 'map')} /></ResizablePanel>
      </ResizablePanelGroup>
    </div>
  </div>;
}
