import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Pasori, type ReaderEvent } from './src/native/Pasori';
import { fetchPresent, isApiConfigured, playMemberSound, scanCard, type PresentMember, type ScanResponse } from './src/api';
import { loadConfig, nativeConfig, saveConfig, scanNativeQr, type AppConfig } from './src/config';
import { applyPairingPayload } from './src/qr';

const DEMO_PASSWORD = 'test';
const leftCornerImage = require('./src/assets/mario-left.png');
const rightCornerImage = require('./src/assets/mario-right.png');

function readerConnected(event: ReaderEvent | null): boolean {
  return event?.status === 'attached';
}

function readerStatusText(event: ReaderEvent | null): string {
  if (!Pasori.isAvailable()) return 'この端末では USB Host を使えません';
  if (!event) return 'リーダーを待っています';
  switch (event.status) {
    case 'attached':
      return 'リーダー接続済み';
    case 'detached':
      return 'リーダー未接続';
    case 'permission-required':
      return 'USB 権限の許可が必要です';
    case 'permission-denied':
      return 'USB 権限が拒否されました';
    case 'error':
      return event.message;
    default:
      return event.message;
  }
}

function App() {
  const [reader, setReader] = useState<ReaderEvent | null>(null);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [present, setPresent] = useState<PresentMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [demoUnlocked, setDemoUnlocked] = useState(false);
  const [demoPassword, setDemoPassword] = useState('');
  const [demoId, setDemoId] = useState('AE19051');
  const [qrText, setQrText] = useState('');
  const [config, setConfig] = useState<AppConfig>(nativeConfig());
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

  const refreshPresent = useCallback(async () => {
    try {
      const people = await fetchPresent();
      setPresent(people);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const sendScan = useCallback(async (studentId: string, idm?: string, source: 'reader' | 'demo' = 'reader') => {
    setBusy(true);
    setError(null);
    try {
      const result = await scanCard({ studentId, idm, source });
      setScan(result);
      if (result.present) setPresent(result.present);
      await playMemberSound(result.soundUrl);
      await refreshPresent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refreshPresent]);

  useEffect(() => {
    if (!scan) return;
    const timer = setTimeout(() => setScan(null), 3000);
    return () => clearTimeout(timer);
  }, [scan]);

  useEffect(() => {
    let cancelled = false;
    loadConfig().then(value => {
      if (!cancelled) setConfig(value);
    }).catch(() => {});
    refreshPresent().catch(() => {});
    const cardSub = Pasori.onCard(event => {
      sendScan(event.studentId, event.idm, 'reader');
    });
    const readerSub = Pasori.onReader(event => {
      setReader(event);
      if (event.status === 'error' || event.status === 'permission-denied') {
        setError(event.message);
      }
    });
    Pasori.start().catch(err => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err));
    });
    const timer = setInterval(() => {
      if (!cancelled) refreshPresent().catch(() => {});
    }, 15000);
    return () => {
      cancelled = true;
      cardSub.remove();
      readerSub.remove();
      clearInterval(timer);
      Pasori.stop().catch(() => {});
    };
  }, [refreshPresent, sendScan]);

  const headline = scan?.displayName || '学生証をタッチ';
  const stateLabel = useMemo(() => {
    if (!scan) return '';
    return scan.eventType === 'enter' ? '入室' : '退室';
  }, [scan]);
  const disconnected = !readerConnected(reader);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        <View style={styles.screen}>
          <Pressable style={styles.gear} onPress={() => setSettingsOpen(true)}>
            <Text style={styles.gearIcon}>⚙</Text>
          </Pressable>

          <View style={styles.center}>
            <Text style={styles.headline}>{headline}</Text>
            {stateLabel ? <Text style={styles.state}>{stateLabel}</Text> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>

          <View style={styles.presentPane}>
            <Text style={styles.presentTitle}>いまいる人</Text>
            <ScrollView>
              {present.length ? (
                present.map(person => (
                  <View key={person.studentId} style={styles.presentRow}>
                    <Text style={styles.presentName}>{person.displayName}</Text>
                    <Text style={styles.presentMeta}>{person.enteredAtLabel}</Text>
                  </View>
                ))
              ) : (
                <Text style={styles.presentMeta}>だれもいません</Text>
              )}
            </ScrollView>
          </View>

          {disconnected ? <Text style={styles.disconnected}>リーダー未接続</Text> : null}
          <Image source={leftCornerImage} style={styles.cornerLeft} resizeMode="contain" />
          <Image source={rightCornerImage} style={styles.cornerRight} resizeMode="contain" />
        </View>

        <Modal visible={settingsOpen} animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
          <SafeAreaView style={styles.safe}>
            <ScrollView contentContainerStyle={styles.settings} keyboardShouldPersistTaps="handled">
              <View style={styles.settingsHeader}>
                <Text style={styles.settingsTitle}>設定</Text>
                <Pressable onPress={() => setSettingsOpen(false)}>
                  <Text style={styles.close}>閉じる</Text>
                </Pressable>
              </View>

              {error ? <Text style={styles.settingsError}>{error}</Text> : null}

              <Text style={styles.cardLabel}>リーダー</Text>
              <Text style={styles.meta}>{readerStatusText(reader)}</Text>
              <Pressable
                style={styles.button}
                onPress={() => {
                  setError(null);
                  Pasori.start().catch(err => setError(err instanceof Error ? err.message : String(err)));
                }}>
                <Text style={styles.buttonText}>リーダー再接続</Text>
              </Pressable>

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
                style={styles.button}
                onPress={() => {
                  saveConfig(config)
                    .then(() => setError(null))
                    .catch(err => setError(err instanceof Error ? err.message : String(err)));
                }}>
                <Text style={styles.buttonText}>接続設定を保存</Text>
              </Pressable>
              <Text style={styles.meta}>{isApiConfigured(config) ? 'API 接続設定済み' : 'API キー未設定'}</Text>

              <Text style={styles.cardLabel}>QR / JSON 読み取り</Text>
              <Pressable
                style={styles.button}
                onPress={() => {
                  scanNativeQr()
                    .then(raw => applyPairingPayload(raw))
                    .then(next => {
                      setConfig(next);
                      setError(null);
                      setSettingsNotice('QR から API 設定を読み込みました');
                    })
                    .catch(err => {
                      const message = err instanceof Error ? err.message : String(err);
                      if (!message.toLowerCase().includes('cancel')) {
                        setError(message);
                      }
                    });
                }}>
                <Text style={styles.buttonText}>カメラで QR を読む</Text>
              </Pressable>
              {settingsNotice ? <Text style={styles.meta}>{settingsNotice}</Text> : null}
              <TextInput
                value={qrText}
                onChangeText={setQrText}
                autoCapitalize="none"
                autoCorrect={false}
                multiline
                placeholder='{"apiBaseUrl":"...","apiKey":"ltn_..."}'
                placeholderTextColor="#6F8479"
                style={[styles.input, styles.multiline]}
              />
              <Pressable
                style={styles.secondaryButton}
                onPress={() => {
                  applyPairingPayload(qrText)
                    .then(next => {
                      setConfig(next);
                      setQrText('');
                      setError(null);
                    })
                    .catch(err => setError(err instanceof Error ? err.message : String(err)));
                }}>
                <Text style={styles.buttonText}>読み取った設定を適用</Text>
              </Pressable>

              <Text style={styles.cardLabel}>デモ送信</Text>
              {!demoUnlocked ? (
                <>
                  <TextInput
                    value={demoPassword}
                    onChangeText={setDemoPassword}
                    secureTextEntry
                    placeholder="パスワード"
                    placeholderTextColor="#6F8479"
                    style={styles.input}
                  />
                  <Pressable
                    style={styles.secondaryButton}
                    onPress={() => {
                      if (demoPassword === DEMO_PASSWORD) {
                        setDemoUnlocked(true);
                        setError(null);
                      } else {
                        setError('デモパスワードが違います');
                      }
                    }}>
                    <Text style={styles.buttonText}>デモ解除</Text>
                  </Pressable>
                </>
              ) : (
                <>
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
                    onPress={() => sendScan(demoId.trim().toUpperCase(), 'DEMO', 'demo')}>
                    <Text style={styles.buttonText}>{busy ? '送信中...' : 'この学籍番号を送信'}</Text>
                  </Pressable>
                </>
              )}
            </ScrollView>
          </SafeAreaView>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#101418' },
  screen: { flex: 1, flexDirection: 'row' },
  gear: { position: 'absolute', top: 12, left: 16, zIndex: 2, padding: 8 },
  gearIcon: { color: '#C5D5CC', fontSize: 28 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  headline: { color: '#FFFFFF', fontSize: 72, fontWeight: '700', textAlign: 'center' },
  state: { color: '#8BE9B0', fontSize: 36, marginTop: 12, fontWeight: '600' },
  presentPane: {
    width: 280,
    backgroundColor: '#171E1B',
    padding: 20,
    borderLeftWidth: 1,
    borderLeftColor: '#2B3732',
  },
  presentTitle: { color: '#9BB0A4', fontSize: 16, marginBottom: 12 },
  presentRow: { marginBottom: 14 },
  presentName: { color: '#FFFFFF', fontSize: 22, fontWeight: '600' },
  presentMeta: { color: '#9BB0A4', fontSize: 14, marginTop: 4 },
  disconnected: { position: 'absolute', left: 20, bottom: 210, color: '#FF8A80', fontSize: 16, zIndex: 2 },
  cornerLeft: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    width: 180,
    height: 190,
  },
  cornerRight: {
    position: 'absolute',
    right: 288,
    bottom: 8,
    width: 190,
    height: 210,
  },
  settings: { padding: 24, gap: 12 },
  settingsHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  settingsTitle: { color: '#FFFFFF', fontSize: 32, fontWeight: '700' },
  close: { color: '#8BE9B0', fontSize: 18 },
  cardLabel: { color: '#9BB0A4', fontSize: 16, marginTop: 8 },
  meta: { color: '#9BB0A4', fontSize: 16 },
  error: { color: '#FF8A80', fontSize: 18, marginTop: 16, textAlign: 'center' },
  settingsError: { color: '#FF8A80', fontSize: 16 },
  input: {
    backgroundColor: '#171E1B',
    color: '#FFFFFF',
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
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
