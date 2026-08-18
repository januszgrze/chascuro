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

const cameraPreferenceStorage = new Map<string, string>();

vi.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: class {
    options: {
      delayBetweenScanAttempts: number;
      delayBetweenScanSuccess: number;
    };

    constructor(
      _hints?: unknown,
      options: {
        delayBetweenScanAttempts?: number;
        delayBetweenScanSuccess?: number;
      } = {},
    ) {
      this.options = {
        delayBetweenScanAttempts: options.delayBetweenScanAttempts ?? 500,
        delayBetweenScanSuccess: options.delayBetweenScanSuccess ?? 500,
      };
    }

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
  result: { getText(): string } | undefined,
  error: Error | undefined,
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
    async fail(error: Error) {
      await act(async () => {
        scanCallback?.(undefined, error, controls);
      });
    },
  };
}

describe('QR tools', () => {
  beforeEach(() => {
    scannerMock.decodeFromCanvas.mockReset();
    scannerMock.decodeFromConstraints.mockReset();
    cameraPreferenceStorage.clear();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => cameraPreferenceStorage.get(key) ?? null,
        setItem: (key: string, value: string) =>
          cameraPreferenceStorage.set(key, value),
        removeItem: (key: string) => cameraPreferenceStorage.delete(key),
      },
    });
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

  it('keeps browser canvas frame failures retryable', () => {
    scannerMock.decodeFromCanvas.mockImplementation(() => {
      throw new DOMException('Frame is temporarily unavailable.');
    });
    const reader = new ResilientQrReader();
    const canvas = document.createElement('canvas');
    canvas.width = 100;
    canvas.height = 100;

    expect(() => reader.decodeFromCanvas(canvas)).toThrow(NotFoundException);
  });

  it('requires an explicit tap before the first successful camera start', () => {
    const onScan = vi.fn();
    render(<QrScanner onScan={onScan} />);

    expect(
      screen.getByRole('button', { name: 'Scan QR with camera' }),
    ).toBeVisible();
    expect(screen.getByLabelText('QR camera preview')).not.toBeVisible();
    expect(onScan).not.toHaveBeenCalled();
  });

  it('keeps production-minified ZXing misses retryable', async () => {
    const scanner = await renderActiveScanner();
    const frameMiss = new NotFoundException();
    Object.defineProperty(frameMiss, 'name', { value: 't' });

    await scanner.fail(frameMiss);

    expect(scannerMock.decodeFromConstraints).toHaveBeenCalledTimes(1);
    expect(scanner.controls.stop).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stop camera' })).toBeVisible();
  });

  it('remembers camera access and starts on the next scanner screen', async () => {
    const controls = [{ stop: vi.fn() }, { stop: vi.fn() }];
    scannerMock.decodeFromConstraints
      .mockResolvedValueOnce(controls[0])
      .mockResolvedValueOnce(controls[1]);
    const first = render(<QrScanner onScan={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Scan QR with camera' }),
    );
    await waitFor(() =>
      expect(scannerMock.decodeFromConstraints).toHaveBeenCalledTimes(1),
    );
    first.unmount();

    render(<QrScanner onScan={vi.fn()} />);
    await waitFor(() =>
      expect(scannerMock.decodeFromConstraints).toHaveBeenCalledTimes(2),
    );

    expect(screen.getByRole('button', { name: 'Stop camera' })).toBeVisible();
  });

  it('stops auto-starting after the user stops the camera', async () => {
    const controls = { stop: vi.fn() };
    scannerMock.decodeFromConstraints.mockResolvedValue(controls);
    const first = render(<QrScanner onScan={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Scan QR with camera' }),
    );
    await waitFor(() =>
      expect(scannerMock.decodeFromConstraints).toHaveBeenCalledTimes(1),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop camera' }));
    first.unmount();

    render(<QrScanner onScan={vi.fn()} />);
    await Promise.resolve();

    expect(scannerMock.decodeFromConstraints).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('button', { name: 'Scan QR with camera' }),
    ).toBeVisible();
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

  it('waits for video dimensions and retries capture failures in one loop', async () => {
    vi.useFakeTimers();
    const drawImage = vi.fn(() => {
      throw new DOMException('Frame is temporarily unavailable.');
    });
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    let readyState: number = HTMLMediaElement.HAVE_METADATA;
    let videoWidth = 0;
    let videoHeight = 0;
    const video = document.createElement('video');
    Object.defineProperties(video, {
      readyState: { configurable: true, get: () => readyState },
      videoWidth: { configurable: true, get: () => videoWidth },
      videoHeight: { configurable: true, get: () => videoHeight },
    });
    const callback = vi.fn();
    const finalize = vi.fn();
    const reader = new ResilientQrReader(undefined, {
      delayBetweenScanAttempts: 10,
    });

    try {
      const controls = reader.scan(video, callback, finalize);
      expect(callback).not.toHaveBeenCalled();

      readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
      videoWidth = 640;
      videoHeight = 480;
      await act(async () => vi.advanceTimersByTimeAsync(10));

      expect(drawImage).toHaveBeenCalledOnce();
      expect(callback).toHaveBeenCalledWith(
        undefined,
        expect.any(NotFoundException),
        controls,
      );
      expect(finalize).not.toHaveBeenCalled();

      controls.stop();
      controls.stop();
      expect(finalize).toHaveBeenCalledOnce();
    } finally {
      getContext.mockRestore();
      vi.useRealTimers();
    }
  });
});
