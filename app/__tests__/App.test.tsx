import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';
import { fetchPresent, playMemberSound, scanCard, type PresentMember, type ScanResponse } from '../src/api';
import { Pasori, type CardEvent } from '../src/native/Pasori';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

jest.mock('../src/api', () => ({
  ...jest.requireActual('../src/api'),
  fetchPresent: jest.fn(),
  scanCard: jest.fn(),
  playMemberSound: jest.fn(),
}));

jest.mock('../src/native/Pasori', () => ({
  Pasori: {
    isAvailable: jest.fn(() => true),
    start: jest.fn(async () => true),
    stop: jest.fn(async () => true),
    onCard: jest.fn(() => ({ remove: jest.fn() })),
    onReader: jest.fn(() => ({ remove: jest.fn() })),
  },
}));

const person: PresentMember = {
  studentId: 'TEST001',
  displayName: 'Present member',
  enteredAt: '2026-10-31T00:00:00.000Z',
  enteredAtLabel: '2026/10/31 09:00',
};

const card: CardEvent = {
  studentId: person.studentId,
  idm: 'test-idm',
  rawHex: '',
  systemCode: '8277',
  serviceCode: '010B',
  timestamp: 0,
};

const scanResponse: ScanResponse = {
  visitId: 'test-visit',
  studentId: person.studentId,
  displayName: person.displayName,
  eventType: 'enter',
  occurredAt: person.enteredAt,
  soundUrl: null,
  present: [person],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

let renderer: ReactTestRenderer.ReactTestRenderer | undefined;

async function renderApp() {
  await ReactTestRenderer.act(async () => {
    renderer = ReactTestRenderer.create(<App />);
  });
}

async function scan() {
  await ReactTestRenderer.act(async () => {
    jest.mocked(Pasori.onCard).mock.calls[0][0](card);
  });
}

function screen() {
  return JSON.stringify(renderer!.toJSON());
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.mocked(fetchPresent).mockReset().mockResolvedValue([]);
  jest.mocked(scanCard).mockReset().mockResolvedValue(scanResponse);
  jest.mocked(playMemberSound).mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    renderer?.unmount();
    renderer = undefined;
  });
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('fetches the initial present list and renders the waiting screen', async () => {
  jest.mocked(fetchPresent).mockResolvedValue([person]);

  await renderApp();

  expect(fetchPresent).toHaveBeenCalledTimes(1);
  expect(screen()).toContain('学生証をタッチ');
  expect(screen()).toContain(person.displayName);
});

test('polls every 30 seconds rather than every 15 seconds', async () => {
  await renderApp();

  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(15000); });
  expect(fetchPresent).toHaveBeenCalledTimes(1);

  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(15000); });
  expect(fetchPresent).toHaveBeenCalledTimes(2);

  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(30000); });
  expect(fetchPresent).toHaveBeenCalledTimes(3);
});

test('uses the scan response present list without an additional fetch', async () => {
  await renderApp();
  await scan();

  expect(scanCard).toHaveBeenCalledWith({ studentId: person.studentId, idm: card.idm, source: 'reader' });
  expect(fetchPresent).toHaveBeenCalledTimes(1);
  expect(screen()).toContain(person.enteredAtLabel);
  expect(playMemberSound).toHaveBeenCalledWith(null);
});

test('fetches present as a fallback for older scan responses', async () => {
  jest.mocked(scanCard).mockResolvedValue({ ...scanResponse, present: undefined });
  jest.mocked(fetchPresent).mockResolvedValueOnce([]).mockResolvedValueOnce([person]);
  await renderApp();
  await scan();

  expect(fetchPresent).toHaveBeenCalledTimes(2);
  expect(screen()).toContain(person.enteredAtLabel);
});

test('discards a stale poll that completes after a scan response', async () => {
  const poll = deferred<PresentMember[]>();
  jest.mocked(fetchPresent).mockResolvedValueOnce([]).mockReturnValueOnce(poll.promise);
  await renderApp();
  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(30000); });
  await scan();

  await ReactTestRenderer.act(async () => { poll.resolve([]); });

  expect(fetchPresent).toHaveBeenCalledTimes(2);
  expect(screen()).toContain(person.enteredAtLabel);
});

test('does not start another poll while a present request is in flight', async () => {
  const initial = deferred<PresentMember[]>();
  jest.mocked(fetchPresent).mockReturnValueOnce(initial.promise);
  await renderApp();
  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(60000); });

  expect(fetchPresent).toHaveBeenCalledTimes(1);

  await ReactTestRenderer.act(async () => { initial.resolve([]); });
  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(30000); });
  expect(fetchPresent).toHaveBeenCalledTimes(2);
});

test('fetches a fresh fallback even if a poll from before the scan is still pending', async () => {
  const poll = deferred<PresentMember[]>();
  jest.mocked(scanCard).mockResolvedValue({ ...scanResponse, present: undefined });
  jest.mocked(fetchPresent)
    .mockResolvedValueOnce([])
    .mockReturnValueOnce(poll.promise)
    .mockResolvedValueOnce([person]);
  await renderApp();
  await ReactTestRenderer.act(async () => { jest.advanceTimersByTime(30000); });
  await scan();
  await ReactTestRenderer.act(async () => { poll.resolve([]); });

  expect(fetchPresent).toHaveBeenCalledTimes(3);
  expect(screen()).toContain(person.enteredAtLabel);
});
