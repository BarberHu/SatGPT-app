import React from 'react';
import { Sparkles } from 'lucide-react';
import Markdown from './Markdown';
import RunTimeline from './RunTimeline';
import ResultCards from './ResultCards';

export default function ChatMessage({ message, reconnecting, onFocusLayer }) {
  const user = message.role === 'user';
  return <article className={`agent-message harness-message harness-message--${message.role}`} aria-label={user ? '你的消息' : '智能体回答'}>
    {user ? <div className="agent-user-bubble">{message.text}</div> : <>
      <div className="agent-assistant-label"><Sparkles size={16} /><span>SatGPT</span>
        {message.streaming ? <small>正在生成</small> : null}
        {message.failed ? <small className="agent-failure">未完成</small> : null}
      </div>
      <RunTimeline rows={message.timeline} run={message.run} pending={message.pending} reconnecting={reconnecting} />
      {message.text ? <Markdown text={message.text} streaming={message.streaming} /> : null}
      <ResultCards message={message} onFocusLayer={onFocusLayer} />
    </>}
  </article>;
}
