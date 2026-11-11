import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ChatBox from './ChatBox';
import { sendChatMessage, getHistoricalMap } from '../services/api';
import { buildAoiFromGeoJSON } from '../utils/aoi';

const testState = vi.hoisted(() => ({ context: null, selectedAOI: null }));
const setIsResultVisible = vi.fn();
const setIsLoading = vi.fn();

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
  const [resultText, setResultText] = useState('');
  const [gridClickEnabled, setGridClickEnabled] = useState(false);
  testState.context = {
    chatInput, setChatInput,
    resultText, setResultText, gridClickEnabled, setGridClickEnabled,
    setIsLoading, setIsResultVisible, setWarning: vi.fn(),
    selectedAOI: testState.selectedAOI, countries: {}, mapInstance: null,
  };
  return <ChatBox />;
}

describe('Basic questions are independent of preset analysis', () => {
  let container;
  let root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    testState.selectedAOI = null;
    sendChatMessage.mockResolvedValue({ message: JSON.stringify({ response: [{
      Content: 'Flood summary', CountryCode: 'CN',
      start_date: '2021-07-01', end_date: '2021-07-31',
    }] }) });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Harness />));
  });

  afterEach(async () => {
    // Let the suggestion blur timer settle before tearing down jsdom.
    await act(async () => new Promise(resolve => setTimeout(resolve, 250)));
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  });

  test('sends Enter and shows the answer without changing the study area or requesting a map', async () => {
    const input = container.querySelector('input');
    act(() => input.focus());
    const event = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    });
    await act(async () => { input.dispatchEvent(event); });

    expect(event.defaultPrevented).toBe(true);
    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(getHistoricalMap).not.toHaveBeenCalled();
    expect(testState.context.resultText).toBe('Flood summary');
    expect(setIsResultVisible).toHaveBeenCalledWith(true);
    expect(testState.context.gridClickEnabled).toBe(false);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test.each([
    { isComposing: true },
    { keyCode: 229 },
  ])('does not submit an Enter used to confirm IME input: %j', (imeState) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true, ...imeState,
    });
    act(() => container.querySelector('input').dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  test('mouse submission returns the answer without opening the retired grid prompt', async () => {
    await act(async () => { container.querySelector('.send-btn-gemini').click(); });
    expect(testState.context.resultText).toBe('Flood summary');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test('answers with an existing AOI without starting a legacy map request', async () => {
    testState.selectedAOI = buildAoiFromGeoJSON({
      type: 'Polygon', coordinates: [[[113, 33], [115, 33], [115, 35], [113, 35], [113, 33]]],
    });
    act(() => root.render(<Harness />));
    getHistoricalMap.mockImplementation(() => new Promise(() => {}));

    await act(async () => { container.querySelector('.send-btn-gemini').click(); });

    expect(testState.context.resultText).toBe('Flood summary');
    expect(getHistoricalMap).not.toHaveBeenCalled();
    expect(setIsLoading).toHaveBeenLastCalledWith(false);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

// A late answer from a disposed composer must never write back into the workspace.
test('unmount aborts the pending question and prevents stale result updates', async () => {
  let resolve;
  sendChatMessage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const write = vi.fn();
  testState.context = { chatInput: 'Question', setChatInput: vi.fn(), setResultText: write,
    setIsResultVisible: vi.fn(), setIsLoading: vi.fn(), countries: {}, mapInstance: null };
  const node = document.createElement('div'); document.body.appendChild(node);
  const root = createRoot(node);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(async () => root.render(<ChatBox />));
    await act(async () => node.querySelector('button').click());
    const signal = sendChatMessage.mock.lastCall[1].signal;
    await act(async () => root.unmount());
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ message: { response: [{ Content: 'Late answer' }] } }));
    expect(write).not.toHaveBeenCalled();
  } finally {
    node.remove(); vi.clearAllMocks(); delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
