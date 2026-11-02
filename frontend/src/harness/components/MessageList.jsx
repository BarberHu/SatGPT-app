import React, { useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, Globe2, ScanLine, Waves } from 'lucide-react';
import ChatMessage from './ChatMessage';
import { Button } from '../ui/button';

export const isNearBottom = node => node.scrollHeight - node.scrollTop - node.clientHeight < 96;
const suggestions = [
  { icon: Waves, title: 'Explore rainfall changes', prompt: 'Analyze rainfall changes in the current map area over the past week. Include data sources and observation dates.' },
  { icon: ScanLine, title: 'Explore satellite imagery', prompt: 'Find the latest available Sentinel-2 imagery for the current map area and display a true-color layer.' },
];
export default function MessageList({ items, loading, reconnecting, onSuggest, onFocusLayer }) {
  const scroll = useRef(null);
  const content = useRef(null);
  const follow = useRef(true);
  const previousTop = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const jump = () => {
    const node = scroll.current;
    if (node) { node.scrollTop = node.scrollHeight; previousTop.current = node.scrollTop; }
    follow.current = true;
    setAtBottom(true);
  };
  useLayoutEffect(() => {
    if (follow.current) jump();
  }, [items]);
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !content.current) return undefined;
    const observer = new ResizeObserver(() => { if (follow.current) jump(); });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  return <div className="agent-message-region">
    <div className="agent-message-scroller harness-conversation" ref={scroll} role="log" aria-label="Conversation messages" aria-live="off"
      onWheel={event => { if (event.deltaY < 0) { follow.current = false; setAtBottom(false); } }}
      onScroll={() => {
        const node = scroll.current;
        if (node.scrollTop < previousTop.current || !isNearBottom(node)) follow.current = false;
        else if (isNearBottom(node)) follow.current = true;
        previousTop.current = node.scrollTop;
        setAtBottom(follow.current);
      }}>
      <div className="agent-message-content" ref={content}>
        {loading ? <p className="agent-loading" role="status">Loading conversation…</p> : null}
        {!loading && !items.length ? <div className="agent-welcome">
          <div className="agent-welcome-icon"><Globe2 size={26} strokeWidth={1.4} /></div>
          <p className="agent-eyebrow">Explore Earth, one question at a time</p><h1>Where would you like to explore?</h1>
          <p>Move the map to your area of interest.<br />Explore satellite data, environmental change, and geospatial analysis.</p>
          <div className="agent-suggestions">{suggestions.map(item => <button key={item.title} type="button" onClick={() => onSuggest(item.prompt)}>
            <item.icon size={18} strokeWidth={1.5} /><span>{item.title}</span><ArrowUpRight size={14} />
          </button>)}</div>
        </div> : null}
        {items.map(message => <ChatMessage key={message.id} message={message} reconnecting={reconnecting} onFocusLayer={onFocusLayer} />)}
      </div>
    </div>
    {!atBottom ? <Button type="button" variant="outline" size="sm" className="agent-jump" onClick={jump}><ArrowDown />Jump to latest</Button> : null}
  </div>;
}
