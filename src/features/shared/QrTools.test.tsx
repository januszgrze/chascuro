import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { QrCode } from './QrCode';
import { QrScanner } from './QrScanner';

const scannerMock = vi.hoisted(() => ({
  decodeFromConstraints: vi.fn(),
}));

vi.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: class {
    decodeFromConstraints = scannerMock.decodeFromConstraints;
  },
}));

describe('QR tools', () => {
  beforeEach(() => {
    scannerMock.decodeFromConstraints.mockReset();
  });

  it('renders a local data URL without exposing the payload as text', async () => {
    const secret = 'fedimint-ecash:5000:fed-a:secret';
    render(<QrCode value={secret} label="Ecash QR code" />);

    const image = await screen.findByRole('img', { name: 'Ecash QR code' });
    expect(image).toHaveAttribute('src', expect.stringMatching(/^data:image/));
    expect(document.body).not.toHaveTextContent(secret);
  });

  it('never starts scanning or submits a payload without an explicit tap', () => {
    const onScan = vi.fn();
    render(<QrScanner onScan={onScan} />);

    expect(
      screen.getByRole('button', { name: 'Scan QR with camera' }),
    ).toBeVisible();
    expect(screen.getByLabelText('QR camera preview')).not.toBeVisible();
    expect(onScan).not.toHaveBeenCalled();
  });

  it('stops camera controls that arrive after the user cancels startup', async () => {
    const controls = { stop: vi.fn() };
    let resolveControls: ((value: typeof controls) => void) | undefined;
    scannerMock.decodeFromConstraints.mockReturnValue(
      new Promise((resolve) => {
        resolveControls = resolve;
      }),
    );
    const onScan = vi.fn();
    render(<QrScanner onScan={onScan} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Scan QR with camera' }),
    );
    await waitFor(() =>
      expect(scannerMock.decodeFromConstraints).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop camera' }));

    await act(async () => {
      resolveControls?.(controls);
      await Promise.resolve();
    });

    expect(controls.stop).toHaveBeenCalledTimes(1);
    expect(onScan).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Scan QR with camera' }),
    ).toBeVisible();
  });

  it('stops delayed camera startup and ignores callbacks after unmount', async () => {
    const controls = { stop: vi.fn() };
    let resolveControls: ((value: typeof controls) => void) | undefined;
    let scanCallback:
      | ((
          result: { getText(): string },
          error: undefined,
          callbackControls: { stop(): void },
        ) => void)
      | undefined;
    scannerMock.decodeFromConstraints.mockImplementation(
      (
        _constraints: unknown,
        _video: unknown,
        callback: typeof scanCallback,
      ) => {
        scanCallback = callback;
        return new Promise((resolve) => {
          resolveControls = resolve;
        });
      },
    );
    const onScan = vi.fn();
    const rendered = render(<QrScanner onScan={onScan} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Scan QR with camera' }),
    );
    await waitFor(() =>
      expect(scannerMock.decodeFromConstraints).toHaveBeenCalledTimes(1),
    );
    rendered.unmount();

    await act(async () => {
      scanCallback?.({ getText: () => 'fed1late' }, undefined, controls);
      resolveControls?.(controls);
      await Promise.resolve();
    });

    expect(controls.stop).toHaveBeenCalled();
    expect(onScan).not.toHaveBeenCalled();
  });
});
