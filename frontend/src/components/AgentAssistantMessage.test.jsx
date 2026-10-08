import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { UNSUPPORTED_TOOL_MESSAGE } from '../utils/floodWorkflow';
import AgentAssistantMessage from './AgentAssistantMessage';

vi.mock('@copilotkit/react-ui', () => ({
  AssistantMessage: ({ message }) => <div>{message.content}</div>,
}));

describe('assistant workflow feedback', () => {
  let container;
  let root;
  beforeEach(() => {
    global.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    delete global.IS_REACT_ACT_ENVIRONMENT;
  });

  test('shows an explicit failure message instead of raw tool markup', () => {
    act(() => root.render(<AgentAssistantMessage message={{ content: '<｜DSML｜invoke name="execute_workflow">' }} />));
    expect(container.textContent).toBe(UNSUPPORTED_TOOL_MESSAGE);
  });

  test('shows progress while the unsupported response is still streaming', () => {
    act(() => root.render(<AgentAssistantMessage isGenerating message={{ content: '<｜DSML｜' }} />));
    expect(container.textContent).toBe('Thinking');
  });

  test('keeps normal candidate text visible', () => {
    const content = 'Please confirm the Rasuwa flood event and dates.';
    act(() => root.render(<AgentAssistantMessage message={{ content }} />));
    expect(container.textContent).toBe(content);
  });
});
