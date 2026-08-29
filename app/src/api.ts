import { NativeModules } from 'react-native';

export type ScanResponse = {
  visitId: string;
  studentId: string;
  displayName: string;
  eventType: 'enter' | 'leave';
  occurredAt: string;
  soundUrl: string | null;
  soundSource?: 'member' | 'default' | 'none';
};

type ConfigModule = {
  API_BASE_URL?: string;
  API_KEY?: string;
  DEVICE_ID?: string;
};

const config = (NativeModules.PasoriConfig || {}) as ConfigModule;

export const API_BASE_URL = (() => {
  const value = config.API_BASE_URL || '';
  return value.endsWith('/') ? value.slice(0, -1) : value;
})();
export const API_KEY = config.API_KEY || '';
export const DEVICE_ID = config.DEVICE_ID || 'tablet-1';

export function isApiConfigured(): boolean {
  return Boolean(API_BASE_URL && API_KEY);
}

export async function scanCard(input: {
  studentId: string;
  idm?: string;
}): Promise<ScanResponse> {
  if (!isApiConfigured()) {
    return Promise.reject(new Error('API is not configured'));
  }
  const response = await fetch(API_BASE_URL + '/api/scan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + API_KEY,
    },
    body: JSON.stringify({
      studentId: input.studentId,
      idm: input.idm,
      deviceId: DEVICE_ID,
    }),
  });
  const data = (await response.json()) as ScanResponse & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || 'scan failed');
  }
  return data;
}

export function soundUrl(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return API_BASE_URL + path;
}

export async function playMemberSound(path: string | null): Promise<void> {
  const url = soundUrl(path);
  const player = config as ConfigModule & { playSound?: (url: string) => Promise<boolean> };
  if (!url || !player.playSound) return;
  await player.playSound(url);
}
