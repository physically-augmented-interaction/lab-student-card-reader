import { parsePairingPayload } from '../qr';

test('parses a pairing QR payload', () => {
  const parsed = parsePairingPayload(
    JSON.stringify({
      v: 1,
      apiBaseUrl: 'https://lab-attendance.manabe-lab.workers.dev/',
      apiKey: 'ltn_test',
      deviceId: 'tablet-1',
    }),
  );
  expect(parsed).toEqual({
    apiBaseUrl: 'https://lab-attendance.manabe-lab.workers.dev',
    apiKey: 'ltn_test',
    deviceId: 'tablet-1',
  });
});

test('rejects incomplete QR payloads', () => {
  expect(parsePairingPayload('not-json')).toBeNull();
  expect(parsePairingPayload(JSON.stringify({ apiBaseUrl: 'https://example.test' }))).toBeNull();
});
