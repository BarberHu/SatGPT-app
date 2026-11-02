import React, { useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, Globe2, ScanLine, Waves } from 'lucide-react';
import ChatMessage from './ChatMessage';
import { Button } from '../ui/button';

export const isNearBottom = node => node.scrollHeight - node.scrollTop - node.clientHeight < 96;
const suggestions = [
  { icon: Waves, title: '了解降雨变化', prompt: '分析当前区域最近一周的降水变化，说明数据来源与观测时间。' },
  { icon: ScanLine, title: '探索卫星影像', prompt: '查询当前区域最新可用的 Sentinel-2 影像，并显示自然色图层。' },
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
    <div className="agent-message-scroller harness-conversation" ref={scroll} role="log" aria-label="对话消息" aria-live="off"
      onWheel={event => { if (event.deltaY < 0) { follow.current = false; setAtBottom(false); } }}
      onScroll={() => {
        const node = scroll.current;
        if (node.scrollTop < previousTop.current || !isNearBottom(node)) follow.current = false;
        else if (isNearBottom(node)) follow.current = true;
        previousTop.current = node.scrollTop;
        setAtBottom(follow.current);
      }}>
      <div className="agent-message-content" ref={content}>
        {loading ? <p className="agent-loading" role="status">正在载入对话…</p> : null}
        {!loading && !items.length ? <div className="agent-welcome">
          <div className="agent-welcome-icon"><Globe2 size={26} strokeWidth={1.4} /></div>
          <p className="agent-eyebrow">从一个问题，探索地球</p><h1>今天想了解哪里？</h1>
          <p>移动右侧地图，选定你关心的区域。<br />一起探索卫星数据、环境变化与空间分析。</p>
          <div className="agent-suggestions">{suggestions.map(item => <button key={item.title} type="button" onClick={() => onSuggest(item.prompt)}>
            <item.icon size={18} strokeWidth={1.5} /><span>{item.title}</span><ArrowUpRight size={14} />
          </button>)}</div>
        </div> : null}
        {items.map(message => <ChatMessage key={message.id} message={message} reconnecting={reconnecting} onFocusLayer={onFocusLayer} />)}
      </div>
    </div>
    {!atBottom ? <Button type="button" variant="outline" size="sm" className="agent-jump" onClick={jump}><ArrowDown />回到最新</Button> : null}
  </div>;
}
