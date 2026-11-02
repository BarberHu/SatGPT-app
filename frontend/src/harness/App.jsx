import React, { useEffect, useState } from 'react';
import { Map as MapIcon, MessageSquare, PanelLeft, Plus, X } from 'lucide-react';
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

export default function HarnessApp({ onSwitchBasic }) {
  const chat = useAgentChat();
  const map = useAgentMap(chat.conversationId, chat.messages);
  const narrow = useNarrowLayout();
  const [historyOpen, setHistoryOpen] = useState(() => !window.matchMedia?.('(max-width: 960px)').matches);
  const [mobileView, setMobileView] = useState('chat');
  const [prompt, setPrompt] = useState('');
  useEffect(() => { setPrompt(''); }, [chat.conversationId]);
  useEffect(() => { if (narrow) setHistoryOpen(false); }, [narrow]);
  const changeConversation = async id => {
    if (await chat.changeConversation(id)) {
      setMobileView('chat');
      if (narrow) setHistoryOpen(false);
    }
  };
  const sidebar = <ConversationSidebar conversations={chat.conversations} currentId={chat.conversationId}
    disabled={chat.busy || chat.pending || chat.loading} onNew={() => changeConversation()}
    onSelect={id => changeConversation(id)} onCollapse={() => setHistoryOpen(false)} onSwitchBasic={onSwitchBasic} />;
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
    <Dialog open={narrow && historyOpen} onOpenChange={setHistoryOpen}>
      <DialogContent className="agent-history-dialog">
        <DialogTitle className="sr-only">历史会话</DialogTitle>
        <DialogDescription className="sr-only">新建或恢复已有的地理空间分析对话</DialogDescription>
        {sidebar}
      </DialogContent>
    </Dialog>
    <div className="agent-workspace">
      <div className="agent-mobile-tabs" role="group" aria-label="工作区切换">
        <Button type="button" variant="ghost" size="icon" aria-label="打开历史会话" onClick={() => setHistoryOpen(true)}><PanelLeft /></Button>
        <Button type="button" variant={mobileView === 'chat' ? 'secondary' : 'ghost'} aria-pressed={mobileView === 'chat'} onClick={() => setMobileView('chat')}><MessageSquare />对话</Button>
        <Button type="button" variant={mobileView === 'map' ? 'secondary' : 'ghost'} aria-pressed={mobileView === 'map'} onClick={() => setMobileView('map')}><MapIcon />地图</Button>
      </div>
      <ResizablePanelGroup direction="horizontal" className="agent-panels" autoSaveId="satgpt-agent-workspace">
        <ResizablePanel defaultSize={52} minSize={32} className="agent-chat-panel">
          <section className="agent-chat" aria-label="Agent 对话">
            <header className="agent-chat-header">
              <div>{!historyOpen || narrow ? <Button type="button" variant="ghost" size="icon" className="agent-desktop-history-toggle" aria-label="打开历史会话" onClick={() => setHistoryOpen(true)}><PanelLeft /></Button> : null}
                <strong>SatGPT</strong><span className="agent-mode-badge">Agent</span></div>
              <Button type="button" variant="ghost" size="icon" aria-label="新对话" title="新对话" disabled={chat.busy || chat.pending || chat.loading} onClick={() => changeConversation()}><Plus /></Button>
            </header>
            <MessageList key={chat.conversationId || 'loading'} items={chat.items} loading={chat.loading}
              reconnecting={chat.reconnecting} onSuggest={setPrompt} onFocusLayer={focusLayer} />
            {chat.error ? <div className="agent-chat-error" role="alert"><span>{chat.error}</span><Button type="button" variant="ghost" size="icon" aria-label="关闭错误提示" onClick={chat.clearError}><X /></Button></div> : null}
            <Composer value={prompt} onChange={setPrompt} onSend={send} busy={chat.busy} pending={chat.pending}
              mapReady={map.ready} disabled={chat.loading || chat.busy || chat.pending || !map.ready} />
          </section>
        </ResizablePanel>
        <ResizableHandle className="agent-resize-handle" aria-label="调整对话与地图宽度" />
        <ResizablePanel defaultSize={48} minSize={28} className="agent-map-panel"><MapWorkspace map={map} /></ResizablePanel>
      </ResizablePanelGroup>
    </div>
  </div>;
}
