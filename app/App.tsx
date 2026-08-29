import { useCallback, useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Pasori, type CardEvent, type ReaderEvent } from './src/native/Pasori';
import { isApiConfigured, playMemberSound, scanCard, type ScanResponse } from './src/api';
import { loadConfig, nativeConfig, saveConfig, type AppConfig } from './src/config';

function statusLabel(event: ReaderEvent | null): string {
  if (!Pasori.isAvailable()) {
    return 'Android USB Host 専用です';
  }
  if (!event) {
    return 'リーダーを待っています';
  }
  switch (event.status) {
    case 'attached':
      return 'RC-S380 接続済み。学生証をタッチしてください';
    case 'detached':
      return 'RC-S380 が未接続です';
    case 'permission-required':
      return 'USB 権限を許可してください';
    case 'permission-denied':
      return 'USB 権限が拒否されました';
    case 'error':
      return event.message;
    case 'stopped':
      return '読み取りを停止しました';
    default:
      return event.message;
  }
}

function App() {
  const [reader, setReader] = useState<ReaderEvent | null>(null);
  const [card, setCard] = useState<CardEvent | null>(null);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demoId, setDemoId] = useState('AE19051');
  const [config, setConfig] = useState<AppConfig>(nativeConfig());

  const sendScan = useCallback(async (studentId: string, idm?: string, source: 'reader' | 'demo' = 'reader') => {
    setBusy(true);
    setError(null);
    try {
      const result = await scanCard({ studentId, idm, source });
      setScan(result);
      await playMemberSound(result.soundUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    loadConfig().then(setConfig).catch(() => {});
    const cardSub = Pasori.onCard(event => {
      setCard(event);
      setDemoId(event.studentId);
      sendScan(event.studentId, event.idm, 'reader');
    });
    const readerSub = Pasori.onReader(event => {
      setReader(event);
      if (event.status === 'error' || event.status === 'permission-denied') {
        setError(event.message);
      }
    });
    let cancelled = false;
    Pasori.start().catch(err => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
      cardSub.remove();
      readerSub.remove();
      Pasori.stop().catch(() => {});
    };
  }, [sendScan]);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
            <Text style={styles.kicker}>Lab Student Card Reader</Text>
            <Text style={styles.status}>{statusLabel(reader)}</Text>
            <View style={styles.cardBox}>
              <Text style={styles.cardLabel}>学籍番号</Text>
              <Text style={styles.studentId}>{card?.studentId ?? scan?.studentId ?? '--------'}</Text>
              <Text style={styles.meta}>{scan?.displayName || '未登録'}</Text>
              <Text style={styles.meta}>
                {scan ? (scan.eventType === 'enter' ? '入室' : '退室') : 'サーバー未送信'}
              </Text>
              <Text style={styles.meta}>IDm {card?.idm ?? '-'}</Text>
            </View>

            <View style={styles.cardBox}>
              <Text style={styles.cardLabel}>デモ送信</Text>
              <TextInput
                value={demoId}
                onChangeText={setDemoId}
                autoCapitalize="characters"
                autoCorrect={false}
                placeholder="AE19051"
                placeholderTextColor="#6F8479"
                style={styles.input}
              />
              <Pressable
                style={[styles.button, busy && styles.buttonDisabled]}
                disabled={busy}
                onPress={() => {
                  const studentId = demoId.trim().toUpperCase();
                  setCard({
                    studentId,
                    idm: 'DEMO',
                    rawHex: '',
                    systemCode: 'DEMO',
                    serviceCode: 'DEMO',
                    timestamp: Date.now(),
                  });
                  sendScan(studentId, 'DEMO', 'demo');
                }}>
                <Text style={styles.buttonText}>{busy ? '送信中...' : 'この学籍番号を送信'}</Text>
              </Pressable>
            </View>

            <View style={styles.cardBox}>
              <Text style={styles.cardLabel}>API 設定</Text>
              <TextInput
                value={config.apiBaseUrl}
                onChangeText={value => setConfig(current => ({ ...current, apiBaseUrl: value }))}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="https://lab-attendance.manabe-lab.workers.dev"
                placeholderTextColor="#6F8479"
                style={styles.input}
              />
              <TextInput
                value={config.apiKey}
                onChangeText={value => setConfig(current => ({ ...current, apiKey: value }))}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="ltn_..."
                placeholderTextColor="#6F8479"
                style={styles.input}
              />
              <Pressable
                style={styles.secondaryButton}
                onPress={() => {
                  saveConfig(config)
                    .then(() => setError(null))
                    .catch(err => setError(err instanceof Error ? err.message : String(err)));
                }}>
                <Text style={styles.buttonText}>接続設定を保存</Text>
              </Pressable>
              {!isApiConfigured(config) ? (
                <Text style={styles.meta}>設定画面で発行した API キーを保存してください</Text>
              ) : (
                <Text style={styles.meta}>API 接続設定済み</Text>
              )}
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}
            <Pressable
              style={styles.secondaryButton}
              onPress={() => {
                setError(null);
                Pasori.start().catch(err => {
                  setError(err instanceof Error ? err.message : String(err));
                });
              }}>
              <Text style={styles.buttonText}>リーダー再接続</Text>
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safe: { flex: 1, backgroundColor: '#101418' },
  container: {
    paddingHorizontal: 24,
    paddingVertical: 24,
    gap: 16,
  },
  kicker: {
    color: '#8BE9B0',
    fontSize: 16,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  status: {
    color: '#F4F7F5',
    fontSize: 24,
    lineHeight: 32,
    fontWeight: '600',
  },
  cardBox: {
    backgroundColor: '#1B2420',
    borderRadius: 24,
    padding: 20,
    gap: 10,
  },
  cardLabel: { color: '#9BB0A4', fontSize: 16 },
  studentId: {
    color: '#FFFFFF',
    fontSize: 48,
    fontWeight: '700',
    letterSpacing: 2,
  },
  meta: { color: '#9BB0A4', fontSize: 16 },
  error: { color: '#FF8A80', fontSize: 16 },
  input: {
    backgroundColor: '#101418',
    color: '#FFFFFF',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
  },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: '#2F6F4E',
    borderRadius: 16,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  secondaryButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#2A3530',
    borderRadius: 16,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#FFFFFF', fontSize: 18, fontWeight: '600' },
});

export default App;
