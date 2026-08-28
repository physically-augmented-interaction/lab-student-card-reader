import { useEffect, useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Pasori, type CardEvent, type ReaderEvent } from './src/native/Pasori';
import { isApiConfigured, playMemberSound, scanCard, type ScanResponse } from './src/api';

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

  useEffect(() => {
    const cardSub = Pasori.onCard(event => {
      setCard(event);
      setError(null);
      scanCard({ studentId: event.studentId, idm: event.idm })
        .then(async result => {
          setScan(result);
          await playMemberSound(result.soundUrl);
        })
        .catch(err => {
          if (isApiConfigured()) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
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
  }, []);

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        <View style={styles.container}>
          <Text style={styles.kicker}>Lab Student Card Reader</Text>
          <Text style={styles.status}>{statusLabel(reader)}</Text>
          <View style={styles.cardBox}>
            <Text style={styles.cardLabel}>学籍番号</Text>
            <Text style={styles.studentId}>{card?.studentId ?? '--------'}</Text>
            <Text style={styles.meta}>{scan?.displayName || '未登録'}</Text>
            <Text style={styles.meta}>
              {scan ? (scan.eventType === 'enter' ? '入室' : '退室') : 'サーバー未送信'}
            </Text>
            <Text style={styles.meta}>IDm {card?.idm ?? '-'}</Text>
            <Text style={styles.meta}>
              {card ? card.systemCode + ' / ' + card.serviceCode : '8277 / 010B'}
            </Text>
            {!isApiConfigured() ? (
              <Text style={styles.meta}>LAB_API_BASE_URL / LAB_API_KEY を設定してください</Text>
            ) : null}
          </View>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable
            style={styles.button}
            onPress={() => {
              setError(null);
              Pasori.start().catch(err => {
                setError(err instanceof Error ? err.message : String(err));
              });
            }}>
            <Text style={styles.buttonText}>再接続</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#101418',
  },
  container: {
    flex: 1,
    paddingHorizontal: 32,
    paddingVertical: 24,
    justifyContent: 'center',
    gap: 18,
  },
  kicker: {
    color: '#8BE9B0',
    fontSize: 18,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  status: {
    color: '#F4F7F5',
    fontSize: 28,
    lineHeight: 36,
    fontWeight: '600',
  },
  cardBox: {
    backgroundColor: '#1B2420',
    borderRadius: 24,
    padding: 28,
    gap: 8,
  },
  cardLabel: {
    color: '#9BB0A4',
    fontSize: 18,
  },
  studentId: {
    color: '#FFFFFF',
    fontSize: 64,
    fontWeight: '700',
    letterSpacing: 2,
  },
  meta: {
    color: '#9BB0A4',
    fontSize: 16,
  },
  error: {
    color: '#FF8A80',
    fontSize: 16,
  },
  button: {
    alignSelf: 'flex-start',
    backgroundColor: '#2F6F4E',
    borderRadius: 16,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  buttonText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '600',
  },
});

export default App;
