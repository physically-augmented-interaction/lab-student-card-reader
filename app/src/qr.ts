import { loadConfig, saveConfig, type AppConfig } from './config';

export type PairingPayload = {
  v?: number;
  apiBaseUrl?: string;
  apiKey?: string;
  deviceId?: string;
};

export function parsePairingPayload(raw: string): AppConfig | null {
  try {
    const parsed = JSON.parse(raw.trim()) as PairingPayload;
    if (!parsed.apiBaseUrl || !parsed.apiKey) return null;
    return {
      apiBaseUrl: parsed.apiBaseUrl.endsWith('/') ? parsed.apiBaseUrl.slice(0, -1) : parsed.apiBaseUrl,
      apiKey: parsed.apiKey,
      deviceId: parsed.deviceId || 'tablet-1',
    };
  } catch {
    return null;
  }
}

export async function applyPairingPayload(raw: string): Promise<AppConfig> {
  const parsed = parsePairingPayload(raw);
  if (!parsed) {
    throw new Error('QR の内容を読めませんでした');
  }
  const current = await loadConfig();
  const next = {
    ...current,
    ...parsed,
    deviceId: parsed.deviceId || current.deviceId,
  };
  await saveConfig(next);
  return next;
}
