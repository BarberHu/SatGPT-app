import React from 'react';
import { Streamdown } from 'streamdown';
import CodeBlock from './CodeBlock';

function MarkdownPre({ children }) {
  const child = React.Children.toArray(children)[0];
  const text = React.isValidElement(child) ? child.props.children : children;
  const language = React.isValidElement(child) ? child.props.className?.replace('language-', '') : 'text';
  return <CodeBlock code={String(text ?? '').replace(/\n$/, '')} language={language || 'text'} />;
}
const components = { pre: MarkdownPre };

export default function Markdown({ text, streaming }) {
  return <div className="agent-markdown harness-message-body">
    <Streamdown mode={streaming ? 'streaming' : 'static'} isAnimating={Boolean(streaming)}
      components={components} controls={false} skipHtml>{text}</Streamdown>
  </div>;
}
