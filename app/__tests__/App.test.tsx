import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

test('renders waiting screen', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(() => {
    renderer = ReactTestRenderer.create(<App />);
  });
  await ReactTestRenderer.act(() => {
    renderer!.unmount();
  });
});

afterEach(() => {
  jest.clearAllTimers();
});
