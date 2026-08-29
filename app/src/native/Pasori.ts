import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type ReaderStatus =
  | 'attached'
  | 'detached'
  | 'permission-required'
  | 'permission-denied'
  | 'stopped'
  | 'error';

export type CardEvent = {
  idm: string;
  studentId: string;
  rawHex: string;
  systemCode: string;
  serviceCode: string;
  timestamp: number;
};

export type ReaderEvent = {
  status: ReaderStatus;
  message: string;
  timestamp: number;
};

type PasoriNative = {
  start(): Promise<boolean>;
  stop(): Promise<boolean>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

const native = NativeModules.PasoriModule as PasoriNative | undefined;
const emitter = native ? new NativeEventEmitter(native as never) : null;

export const Pasori = {
  isAvailable(): boolean {
    return Platform.OS === 'android' && native != null;
  },

  start(): Promise<boolean> {
    if (!native) {
      return Promise.resolve(false);
    }
    return native.start();
  },

  stop(): Promise<boolean> {
    if (!native) {
      return Promise.resolve(false);
    }
    return native.stop();
  },

  onCard(listener: (event: CardEvent) => void) {
    if (!emitter) {
      return { remove() {} };
    }
    return emitter.addListener('onCard', (event: Object) => listener(event as CardEvent));
  },

  onReader(listener: (event: ReaderEvent) => void) {
    if (!emitter) {
      return { remove() {} };
    }
    return emitter.addListener('onReader', (event: Object) => listener(event as ReaderEvent));
  },
};
