import React, { createContext, useContext } from 'react';
import { Streamdown, useIsCodeFenceIncomplete } from 'streamdown';
import CodeBlock from './CodeBlock';
import ChartBlock from '../echarts/ChartBlock';

const StreamingContext = createContext(false);

function MarkdownPre({ children }) {
  const streaming = useContext(StreamingContext);
  const incomplete = useIsCodeFenceIncomplete();
  const child = React.Children.toArray(children)[0];
  const text = React.isValidElement(child) ? child.props.children : children;
  const language = React.isValidElement(child) ? child.props.className?.replace('language-', '') : 'text';
  const code = String(text ?? '').replace(/\n$/, '');
  if (language === 'echarts') return <ChartBlock code={code} pending={streaming || incomplete} />;
  return <CodeBlock code={code} language={language || 'text'} />;
}
const components = { pre: MarkdownPre };

export default function Markdown({ text, streaming }) {
  return <StreamingContext.Provider value={Boolean(streaming)}><div className="agent-markdown harness-message-body">
    <Streamdown mode={streaming ? 'streaming' : 'static'} isAnimating={Boolean(streaming)}
      components={components} controls={false} skipHtml>{text}</Streamdown>
  </div></StreamingContext.Provider>;
}
