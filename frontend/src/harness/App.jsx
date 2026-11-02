import React, { useCallback, useEffect, useState } from 'react';
import { Map as MapIcon, MessageSquare, PanelLeft, X } from 'lucide-react';
import { useAgentChat } from './hooks/useAgentChat';
import { useAgentMap } from './hooks/useAgentMap';
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
  const chat = useAgentChat();
  const map = useAgentMap(chat.conversationId, chat.messages);
  const narrow = useNarrowLayout();
  const [historyOpen, setHistoryOpen] = useState(() => !window.matchMedia?.('(max-width: 960px)').matches);
  const [mobileView, setMobileView] = useState('chat');
  const [prompt, setPrompt] = useState('');
  const toggleHistory = useCallback(() => setHistoryOpen(open => !open), []);
  useEffect(() => {
    onHistoryToolsChange?.(!active || narrow ? null : { open: historyOpen, toggle: toggleHistory });
    return () => onHistoryToolsChange?.(null);
  }, [onHistoryToolsChange, active, narrow, historyOpen, toggleHistory]);
  useEffect(() => { setPrompt(''); }, [chat.conversationId]);
  useEffect(() => { if (narrow) setHistoryOpen(false); }, [narrow]);
  const changeConversation = async id => {
    map.prepareConversationChange();
    if (await chat.changeConversation(id)) {
      setMobileView('chat');
      if (narrow) setHistoryOpen(false);
    }
  };
  const sidebar = <ConversationSidebar conversations={chat.conversations} currentId={chat.conversationId}
    disabled={chat.busy || chat.pending || chat.loading} onNew={() => changeConversation()}
    onSelect={id => changeConversation(id)} onCollapse={narrow ? () => setHistoryOpen(false) : undefined} />;
  const send = async () => {
    const text = prompt.trim();
    const bounds = map.bounds();
    if (text && bounds && await chat.send(text, bounds)) setPrompt('');
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
            <Composer value={prompt} onChange={setPrompt} onSend={send} busy={chat.busy} pending={chat.pending}
              mapReady={map.ready} disabled={chat.loading || chat.busy || chat.pending || !map.ready} />
          </section>
        </ResizablePanel>
        <ResizableHandle className="agent-resize-handle" aria-label="Resize chat and map" />
        <ResizablePanel defaultSize={48} minSize={28} className="agent-map-panel"><MapWorkspace map={map} active={active && (!narrow || mobileView === 'map')} /></ResizablePanel>
      </ResizablePanelGroup>
    </div>
  </div>;
}
