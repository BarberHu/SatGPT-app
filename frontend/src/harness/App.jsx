import React, { useEffect, useRef, useState } from 'react';
import { History, Map as MapIcon, MessageSquare, PanelLeft, PanelLeftClose, X } from 'lucide-react';
import { useAgentChat } from './hooks/useAgentChat';
import { useAgentMap } from './hooks/useAgentMap';
import { useAgentRegion } from './hooks/useAgentRegion';
import { chatApi } from './chatApi';
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

const REASONING_PREFERENCE = 'satgpt:harness:reasoning-effort';

function readReasoningPreference() {
  try { return localStorage.getItem(REASONING_PREFERENCE) ?? ''; }
  catch { return ''; }
}

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

export default function HarnessApp({ active = true }) {
  const narrow = useNarrowLayout();
  const [conversationOpen, setConversationOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [mobileView, setMobileView] = useState('chat');
  const [prompt, setPrompt] = useState('');
  const [reasoning, setReasoning] = useState({ status: 'loading' });
  const [reasoningRequest, setReasoningRequest] = useState(0);
  const [reasoningPreference, setReasoningPreference] = useState(readReasoningPreference);
  const collapseButton = useRef(null);
  const restoreButton = useRef(null);
  const historyButton = useRef(null);
  const historyCollapseButton = useRef(null);
  const mobileHistoryButton = useRef(null);
  const focusAfterRender = useRef(null);
  const desktopCollapsed = !narrow && !conversationOpen;
  const chat = useAgentChat({ visible: active && (narrow ? mobileView === 'chat' && !mobileHistoryOpen : conversationOpen) });
  const conversationKey = chat.conversationId ?? chat.draftKey;
  const map = useAgentMap(chat.conversationId, chat.messages);
  const region = useAgentRegion(chat.conversationId, chat.messages, active, chat.draftKey);
  useEffect(() => {
    if (!active) return undefined;
    const request = new AbortController();
    setReasoning({ status: 'loading' });
    chatApi.reasoning(request.signal).then(options => {
      if (!request.signal.aborted) setReasoning({ ...options, status: 'ready' });
    }).catch(error => {
      if (!request.signal.aborted) setReasoning({ status: error.status === 404 ? 'missing' : 'failed' });
    });
    return () => request.abort();
  }, [active, reasoningRequest]);
  const reasoningEffort = reasoning.levels?.some(level => level.id === reasoningPreference) ? reasoningPreference : '';
  const chooseReasoning = effort => {
    setReasoningPreference(effort);
    try { localStorage.setItem(REASONING_PREFERENCE, effort); }
    catch { /* The preference still applies while the page is open. */ }
  };
  useEffect(() => {
    const target = focusAfterRender.current?.current;
    if (target?.isConnected) { target.focus(); focusAfterRender.current = null; }
  }, [desktopCollapsed, historyOpen, narrow]);
  useEffect(() => { setPrompt(''); }, [conversationKey]);
  useEffect(() => { setMobileHistoryOpen(false); }, [narrow]);
  const conversationTitle = chat.conversations.find(item => item.id === chat.conversationId)?.title
    || chat.messages.find(item => item.role === 'user')?.content || 'New chat';
  const changeConversation = async id => {
    if (chat.deleting) return;
    map.prepareConversationChange(Boolean(id && id !== chat.conversationId));
    if (await chat.changeConversation(id)) {
      setMobileView('chat');
      if (narrow) setMobileHistoryOpen(false);
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
    onDelete={deleteConversation} deleteError={chat.error} collapseButtonRef={historyCollapseButton} onRecovered={chat.refreshList}
    onSelect={id => changeConversation(id)} onCollapse={() => {
      if (narrow) setMobileHistoryOpen(false);
      else { focusAfterRender.current = historyButton; setHistoryOpen(false); }
    }} />;
  const send = async () => {
    if (region.editing || region.error || chat.loading || chat.deleting) return;
    const text = prompt.trim();
    const geometry = region.snapshot();
    const area = geometry ? getBoundsFromGeometry(geometry) : null;
    const bounds = area ? [area.west, area.south, area.east, area.north] : map.bounds();
    if (text && bounds && await chat.send(text, bounds, geometry, region.metadata(), region.attach, reasoningEffort)) setPrompt('');
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
  return <div className="harness-app harness-shell" data-mobile-view={mobileView} data-chat-collapsed={desktopCollapsed}>
    {desktopCollapsed ? <Button ref={restoreButton} type="button" variant="outline" className="agent-chat-reopen"
      aria-label="Open conversation panel" aria-expanded={false} onClick={() => {
        focusAfterRender.current = collapseButton; setConversationOpen(true);
      }}><MessageSquare size={16} />Open chat</Button> : null}
    {!narrow && !desktopCollapsed && historyOpen ? sidebar : null}
    <Dialog open={active && narrow && mobileHistoryOpen} onOpenChange={setMobileHistoryOpen}>
      <DialogContent className="agent-history-dialog" onCloseAutoFocus={event => {
        event.preventDefault();
        (narrow ? mobileHistoryButton.current : desktopCollapsed ? restoreButton.current : collapseButton.current)?.focus();
      }}>
        <DialogTitle className="sr-only">Conversation history</DialogTitle>
        <DialogDescription className="sr-only">Start a new geospatial analysis conversation or resume an existing one</DialogDescription>
        {sidebar}
      </DialogContent>
    </Dialog>
    <div className="agent-workspace">
      <div className="agent-mobile-tabs" role="group" aria-label="Switch workspace">
        <Button ref={mobileHistoryButton} type="button" variant="ghost" size="icon" aria-label="Open conversation history" onClick={() => setMobileHistoryOpen(true)}><PanelLeft /></Button>
        <Button type="button" variant={mobileView === 'chat' ? 'secondary' : 'ghost'} aria-pressed={mobileView === 'chat'} onClick={() => setMobileView('chat')}><MessageSquare />Chat</Button>
        <Button type="button" variant={mobileView === 'map' ? 'secondary' : 'ghost'} aria-pressed={mobileView === 'map'} onClick={() => setMobileView('map')}><MapIcon />Map</Button>
      </div>
      <ResizablePanelGroup direction="horizontal" className="agent-panels" autoSaveId="satgpt-agent-workspace">
        <ResizablePanel defaultSize={38} minSize={32} className="agent-chat-panel" hidden={desktopCollapsed}>
          <section className="agent-chat" aria-label="Agent conversation">
            <div className="agent-conversation-header">
              {!narrow && !historyOpen ? <Button ref={historyButton} type="button" variant="ghost" size="icon"
                aria-expanded={false} aria-label="Open conversation history" title="Open conversation history"
                onClick={() => { focusAfterRender.current = historyCollapseButton; setHistoryOpen(true); }}><History size={18} /></Button> : null}
              <h2 title={conversationTitle}>{conversationTitle}</h2>
              {!narrow ? <Button ref={collapseButton} type="button" variant="ghost" size="icon"
                aria-label="Collapse conversation panel" aria-expanded={true} title="Collapse conversation panel"
                onClick={() => { focusAfterRender.current = restoreButton; setConversationOpen(false); }}><PanelLeftClose size={18} /></Button> : null}
            </div>
            <MessageList key={conversationKey} items={chat.items} loading={chat.loading}
              reconnecting={chat.reconnecting} onSuggest={setPrompt} onFocusLayer={focusLayer} />
            {chat.error ? <div className="agent-chat-error" role="alert"><span>{chat.error}</span><Button type="button" variant="ghost" size="icon" aria-label="Dismiss error" onClick={chat.clearError}><X /></Button></div> : null}
            <Composer value={prompt} onChange={setPrompt} onSend={send} onStop={chat.stop}
              region={region} onEditRegion={editRegion}
              reasoning={reasoning} reasoningEffort={reasoningEffort} onReasoningChange={chooseReasoning}
              onReasoningRetry={() => setReasoningRequest(request => request + 1)}
              areaControls={<AreaControls hideEditAction current={region.aoi} scopeKey={`${active ? 'agent' : 'inactive'}:${conversationKey}`} disabled={!active || !region.ready || region.editing || chat.loading || chat.pending}
                onUse={region.use} onEdit={aoi => { if (region.begin(aoi) && narrow) setMobileView('map'); }}
                onLocate={aoi => focusLayer({ bounds: [aoi.bounds.west,aoi.bounds.south,aoi.bounds.east,aoi.bounds.north] })}
                outlineVisible={region.outlineVisible} onToggleOutline={region.toggleOutline} /> }
              busy={chat.busy} pending={chat.pending} stopping={chat.stopping} stopDisabled={chat.loading || chat.deleting}
              mapReady={map.ready} disabled={chat.loading || chat.busy || chat.pending || chat.stopping || chat.deleting || !map.ready || region.editing || Boolean(region.error)} />
          </section>
        </ResizablePanel>
        <ResizableHandle className="agent-resize-handle" aria-label="Resize chat and map" hidden={desktopCollapsed} />
        <ResizablePanel defaultSize={62} minSize={28} className="agent-map-panel"><MapWorkspace map={map} region={region}
          onConfirmRegion={() => { if (region.confirm() && narrow) setMobileView('chat'); }}
          active={active && (!narrow || mobileView === 'map')} /></ResizablePanel>
      </ResizablePanelGroup>
    </div>
  </div>;
}
