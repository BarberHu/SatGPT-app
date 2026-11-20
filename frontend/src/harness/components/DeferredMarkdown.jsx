import React, { lazy, Suspense } from 'react';

function PlainMarkdown({ text }) {
  return <div className="agent-markdown harness-message-body agent-markdown-plain">{text}</div>;
}

let rendererPromise;
function loadMarkdown() {
  if (!rendererPromise) {
    rendererPromise = import('./Markdown').catch(error => {
      rendererPromise = undefined;
      throw error;
    });
  }
  return rendererPromise;
}

const Markdown = lazy(() => loadMarkdown().catch(error => {
  console.warn('Unable to load the Agent Markdown renderer.', error);
  return { default: PlainMarkdown };
}));

export function preloadMarkdown() {
  // The first message can retry if this preload fails.
  void loadMarkdown().catch(() => {});
}

export default function DeferredMarkdown(props) {
  return <Suspense fallback={<PlainMarkdown text={props.text} />}>
    <Markdown {...props} />
  </Suspense>;
}
