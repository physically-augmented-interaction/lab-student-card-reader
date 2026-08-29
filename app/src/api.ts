import { loadConfig, playNativeSound, type AppConfig } from './config';

export type ScanResponse = {
  visitId: string;
  studentId: string;
  displayName: string;
  eventType: 'enter' | 'leave';
  occurredAt: string;
  soundUrl: string | null;
  soundSource?: 'member' | 'default' | 'none';
};

export function isApiConfigured(config?: AppConfig): boolean {
  const current = config;
  return Boolean(current?.apiBaseUrl && current?.apiKey);
}

export async function scanCard(input: {
  studentId: string;
  idm?: string;
  source?: string;
}): Promise<ScanResponse> {
  const config = await loadConfig();
  if (!isApiConfigured(config)) {
    throw new Error('API URL / API キーが未設定です');
  }
  const response = await fetch(config.apiBaseUrl + '/api/scan', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + config.apiKey,
    },
    body: JSON.stringify({
      studentId: input.studentId,
      idm: input.idm,
      deviceId: config.deviceId,
      source: input.source || 'reader',
    }),
  });
  const data = (await response.json()) as ScanResponse & { error?: string };
  if (!response.ok) {
    throw new Error(data.error || 'scan failed');
  }
  return data;
}

export function soundUrl(path: string | null, apiBaseUrl?: string): string | null {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return (apiBaseUrl || '') + path;
}

export async function playMemberSound(path: string | null): Promise<void> {
  const config = await loadConfig();
  const url = soundUrl(path, config.apiBaseUrl);
  const play = playNativeSound;
  if (!url) return;
  const nativePlay = play(url);
  if (nativePlay) await nativePlay;
}
