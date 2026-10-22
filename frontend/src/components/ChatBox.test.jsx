import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ChatBox from './ChatBox';
import Modals from './Modals';
import { sendChatMessage } from '../services/api';

const testState = vi.hoisted(() => ({ context: null }));

vi.mock('../context/AppContext', () => ({
  useAppContext: () => testState.context,
}));

vi.mock('../services/api', () => ({
  sendChatMessage: vi.fn(),
  getHistoricalMap: vi.fn(),
  getFloodHotspotMap: vi.fn(),
}));

function Harness() {
  const [chatInput, setChatInput] = useState('Tell me about the 2021 Zhengzhou floods');
  const [activeModal, setActiveModal] = useState(null);
  testState.context = {
    chatInput, setChatInput, activeModal, setActiveModal,
    selectedAOI: null, dataType: 'historical', countries: {},
  };
  return <><ChatBox /><Modals /></>;
}

describe('Ask keyboard submission', () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  test('consumes Enter before focusing the AOI prompt confirmation button', () => {
    const input = container.querySelector('input');
    act(() => input.focus());
    const event = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    });
    act(() => input.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement.textContent).toBe('OK');
    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  test.each([
    { isComposing: true },
    { keyCode: 229 },
  ])('does not submit an Enter used to confirm IME input: %j', (imeState) => {
    const input = container.querySelector('input');
    const event = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true, ...imeState,
    });
    act(() => input.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  test('mouse submission still opens an AOI prompt that the user can dismiss', () => {
    act(() => container.querySelector('.send-btn-gemini').click());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => container.querySelector('.info-modal-btn').click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
