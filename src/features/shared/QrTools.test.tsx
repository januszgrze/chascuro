import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException, ReedSolomonException } from '@zxing/library';
import QRCode from 'qrcode';
import { dataToFrames } from 'qrloop';

import { QrCode } from './QrCode';
import { QrScanner } from './QrScanner';
import { ResilientQrReader } from './ResilientQrReader';

const scannerMock = vi.hoisted(() => ({
  decodeFromCanvas: vi.fn(),
  decodeFromConstraints: vi.fn(),
}));

vi.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: class {
    decodeFromCanvas(canvas: HTMLCanvasElement) {
      return scannerMock.decodeFromCanvas(canvas);
    }

    decodeFromConstraints(...args: unknown[]) {
      return scannerMock.decodeFromConstraints(...args);
    }
  },
}));

interface TestScannerControls {
  stop(): void;
}

type TestScanCallback = (
  result: { getText(): string },
  error: undefined,
  controls: TestScannerControls,
) => void;

async function renderActiveScanner() {
  const controls = { stop: vi.fn() };
  let scanCallback: TestScanCallback | undefined;
  scannerMock.decodeFromConstraints.mockImplementation(
    (_constraints: unknown, _video: unknown, callback: TestScanCallback) => {
      scanCallback = callback;
      return Promise.resolve(controls);
    },
  );
  const onScan = vi.fn();
  render(<QrScanner onScan={onScan} />);

  fireEvent.click(screen.getByRole('button', { name: 'Scan QR with camera' }));
  await waitFor(() =>
    expect(scannerMock.decodeFromConstraints).toHaveBeenCalledTimes(1),
  );

  return {
    controls,
    onScan,
    async scan(value: string) {
      await act(async () => {
        scanCallback?.({ getText: () => value }, undefined, controls);
      });
    },
  };
}

describe('QR tools', () => {
  beforeEach(() => {
    scannerMock.decodeFromCanvas.mockReset();
    scannerMock.decodeFromConstraints.mockReset();
  });

  it('renders a local data URL without exposing the payload as text', async () => {
    const secret = 'fedimint-ecash:5000:fed-a:secret';
    render(<QrCode value={secret} label="Ecash QR code" />);

    const image = await screen.findByRole('img', { name: 'Ecash QR code' });
    expect(image).toHaveAttribute('src', expect.stringMatching(/^data:image/));
    expect(image).toHaveAttribute(
      'src',
      expect.stringMatching(/^data:image\/svg\+xml/),
    );
    expect(document.body).not.toHaveTextContent(secret);
  });

  it('animates oversized ecash as multipart QR frames', async () => {
    const secret = `fedimint${'a'.repeat(500)}`;

    render(
      <QrCode allowMultipart value={secret} label="Multipart ecash QR code" />,
    );

    const image = await screen.findByRole('img', {
      name: 'Multipart ecash QR code',
    });
    const firstFrame = image.getAttribute('src');
    expect(firstFrame).toMatch(/^data:image\/svg\+xml/);

    await waitFor(() => expect(image).not.toHaveAttribute('src', firstFrame), {
      timeout: 1_500,
    });
    expect(document.body).not.toHaveTextContent(secret);
  });

  it('renders BOLT11 QR content in compact uppercase form', async () => {
    const invoice = `lnbc1${'q'.repeat(200)}`;
    const renderQr = vi.spyOn(QRCode, 'toString');

    render(
      <QrCode
        contentType="bolt11"
        value={invoice}
        label="Lightning invoice QR code"
      />,
    );

    expect(
      await screen.findByRole('img', { name: 'Lightning invoice QR code' }),
    ).toBeVisible();
    expect(renderQr).toHaveBeenCalledWith(
      invoice.toUpperCase(),
      expect.objectContaining({
        errorCorrectionLevel: 'L',
        margin: 4,
      }),
    );
    renderQr.mockRestore();
  });

  it('renders without allocating a browser canvas', async () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');

    render(<QrCode value="lnbc1canvasindependent" label="Invoice QR code" />);

    expect(
      await screen.findByRole('img', { name: 'Invoice QR code' }),
    ).toBeVisible();
    expect(getContext).not.toHaveBeenCalled();
    getContext.mockRestore();
  });

  it('keeps ZXing frame-decoding failures retryable', () => {
    scannerMock.decodeFromCanvas.mockImplementation(() => {
      throw new ReedSolomonException();
    });
    const reader = new ResilientQrReader();
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;

    expect(() => reader.decodeFromCanvas(canvas)).toThrow(NotFoundException);
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
    let scanCallback: TestScanCallback | undefined;
    scannerMock.decodeFromConstraints.mockImplementation(
      (_constraints: unknown, _video: unknown, callback: TestScanCallback) => {
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

  it('submits an uppercase BOLT11 QR as one static value', async () => {
    const invoice = `LNBC1${'Q'.repeat(200)}`;
    const scanner = await renderActiveScanner();

    await scanner.scan(invoice);

    expect(scanner.onScan).toHaveBeenCalledOnce();
    expect(scanner.onScan).toHaveBeenCalledWith(invoice);
    expect(scanner.controls.stop).toHaveBeenCalledOnce();
  });

  it('collects multipart QR frames before submitting one complete value', async () => {
    const payload = 'https://example.com/a-multipart-qr-payload';
    const frames = dataToFrames(payload, 8);
    const scanner = await renderActiveScanner();

    await scanner.scan(frames[0]);
    expect(scanner.onScan).not.toHaveBeenCalled();

    for (const frame of frames.slice(1)) {
      await scanner.scan(frame);
      if (scanner.onScan.mock.calls.length > 0) {
        break;
      }
    }

    expect(scanner.onScan).toHaveBeenCalledOnce();
    expect(scanner.onScan).toHaveBeenCalledWith(payload);
    expect(scanner.controls.stop).toHaveBeenCalledOnce();
  });

  it('keeps a repeated multipart frame pending until the payload is complete', async () => {
    const payload = 'https://example.com/a-slow-multipart-qr-payload';
    const frames = dataToFrames(payload, 8);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const scanner = await renderActiveScanner();

    await scanner.scan(frames[0]);
    expect(scanner.onScan).not.toHaveBeenCalled();

    now.mockReturnValue(2_100);
    await scanner.scan(frames[0]);
    now.mockRestore();
    expect(scanner.onScan).not.toHaveBeenCalled();

    for (const frame of frames.slice(1)) {
      await scanner.scan(frame);
      if (scanner.onScan.mock.calls.length > 0) {
        break;
      }
    }

    expect(scanner.onScan).toHaveBeenCalledOnce();
    expect(scanner.onScan).toHaveBeenCalledWith(payload);
  });
});
