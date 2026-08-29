import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';

type NativeConfig = {
  API_BASE_URL?: string;
  API_KEY?: string;
  DEVICE_ID?: string;
  playSound?: (url: string) => Promise<boolean>;
  scanQr?: () => Promise<string>;
};

export type AppConfig = {
  apiBaseUrl: string;
  apiKey: string;
  deviceId: string;
};

const STORAGE_KEY = 'lab.reader.config';
const native = (NativeModules.PasoriConfig || {}) as NativeConfig;

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

export function nativeConfig(): AppConfig {
  return {
    apiBaseUrl: normalizeBaseUrl(native.API_BASE_URL || ''),
    apiKey: native.API_KEY || '',
    deviceId: native.DEVICE_ID || 'tablet-1',
  };
}

export async function loadConfig(): Promise<AppConfig> {
  const fallback = nativeConfig();
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return {
      apiBaseUrl: normalizeBaseUrl(parsed.apiBaseUrl || fallback.apiBaseUrl),
      apiKey: parsed.apiKey || fallback.apiKey,
      deviceId: parsed.deviceId || fallback.deviceId,
    };
  } catch {
    return fallback;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      apiBaseUrl: normalizeBaseUrl(config.apiBaseUrl),
      apiKey: config.apiKey.trim(),
      deviceId: config.deviceId.trim() || 'tablet-1',
    }),
  );
}

export function playNativeSound(url: string): Promise<boolean> | null {
  if (!native.playSound) return null;
  return native.playSound(url);
}

export function scanNativeQr(): Promise<string> {
  if (!native.scanQr) {
    return Promise.reject(new Error('この端末では QR カメラを使えません'));
  }
  return native.scanQr().catch(error => {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code || '') : '';
    const message = error instanceof Error ? error.message : String(error);
    if (code === 'QR_CANCELLED' || message.toLowerCase().includes('cancel')) {
      const cancelled = new Error('cancelled');
      cancelled.name = 'QRCancelled';
      throw cancelled;
    }
    throw error instanceof Error ? error : new Error(message);
  });
}
