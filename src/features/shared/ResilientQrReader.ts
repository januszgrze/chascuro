import {
  BrowserQRCodeReader,
  type HTMLVisualMediaElement,
  type IScannerControls,
} from '@zxing/browser';
import { Exception, NotFoundException, type Result } from '@zxing/library';

type ScanCallback = Parameters<BrowserQRCodeReader['scan']>[1];
type FinalizeCallback = Parameters<BrowserQRCodeReader['scan']>[2];

/**
 * Keeps malformed intermediate camera frames retryable and prioritizes the
 * centered square shown by the scanner UI before falling back to the full feed.
 */
export class ResilientQrReader extends BrowserQRCodeReader {
  private centeredCanvas?: HTMLCanvasElement;

  /**
   * ZXing's stock loop permanently sizes its canvas from the first video frame
   * and finalizes the media stream after any non-ZXing exception. Keep transient
   * video/canvas failures retryable while the camera track is still live.
   */
  override scan(
    element: HTMLVisualMediaElement,
    callback: ScanCallback,
    finalize?: FinalizeCallback,
  ): IScannerControls {
    let captureCanvas: HTMLCanvasElement | undefined;
    let captureContext: CanvasRenderingContext2D | undefined;
    let timeoutId: number | undefined;
    let stopped = false;
    let finalized = false;

    const disposeCanvas = (): void => {
      captureContext = undefined;
      captureCanvas = undefined;
    };
    const finish = (error?: Error): void => {
      if (finalized) {
        return;
      }
      finalized = true;
      stopped = true;
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
      disposeCanvas();
      finalize?.(error);
    };
    const controls: IScannerControls = {
      stop: () => finish(),
    };
    const schedule = (delayMs: number): void => {
      if (!stopped) {
        timeoutId = window.setTimeout(scanFrame, delayMs);
      }
    };

    const scanFrame = (): void => {
      if (stopped) {
        return;
      }

      if (hasEndedVideoTrack(element)) {
        const error = new Exception('Camera stream ended.');
        callback(undefined, error, controls);
        finish(error);
        return;
      }

      const dimensions = readyDimensions(element);
      if (dimensions === undefined) {
        schedule(this.options.delayBetweenScanAttempts);
        return;
      }

      try {
        if (
          captureCanvas === undefined ||
          captureCanvas.width !== dimensions.width ||
          captureCanvas.height !== dimensions.height
        ) {
          captureCanvas = document.createElement('canvas');
          captureCanvas.width = dimensions.width;
          captureCanvas.height = dimensions.height;
          captureContext = getCaptureContext(captureCanvas);
        }
        if (captureContext === undefined || captureCanvas === undefined) {
          throw new Error('Canvas capture is unavailable.');
        }

        captureContext.drawImage(
          element,
          0,
          0,
          dimensions.width,
          dimensions.height,
        );
        const result = this.decodeFromCanvas(captureCanvas);
        callback(result, undefined, controls);
        schedule(this.options.delayBetweenScanSuccess);
      } catch {
        if (hasEndedVideoTrack(element)) {
          const error = new Exception('Camera stream ended.');
          callback(undefined, error, controls);
          finish(error);
          return;
        }

        callback(undefined, NotFoundException.getNotFoundInstance(), controls);
        schedule(this.options.delayBetweenScanAttempts);
      }
    };

    scanFrame();
    return controls;
  }

  override decodeFromCanvas(source: HTMLCanvasElement): Result {
    let centered: HTMLCanvasElement;
    try {
      centered = this.centerSquare(source);
    } catch {
      return retryFrameDecode();
    }
    try {
      return super.decodeFromCanvas(centered);
    } catch {
      if (centered !== source) {
        try {
          return super.decodeFromCanvas(source);
        } catch {
          return retryFrameDecode();
        }
      }
      return retryFrameDecode();
    }
  }

  private centerSquare(source: HTMLCanvasElement): HTMLCanvasElement {
    if (source.width === source.height) {
      return source;
    }

    const size = Math.min(source.width, source.height);
    const target = this.centeredCanvas ?? document.createElement('canvas');
    this.centeredCanvas = target;
    if (target.width !== size || target.height !== size) {
      target.width = size;
      target.height = size;
    }
    let context: CanvasRenderingContext2D | null;
    try {
      context = target.getContext('2d', { willReadFrequently: true });
    } catch {
      context = target.getContext('2d');
    }
    if (context === null) {
      return source;
    }

    const sourceX = Math.floor((source.width - size) / 2);
    const sourceY = Math.floor((source.height - size) / 2);
    context.drawImage(source, sourceX, sourceY, size, size, 0, 0, size, size);
    return target;
  }
}

function retryFrameDecode(): never {
  throw NotFoundException.getNotFoundInstance();
}

function readyDimensions(
  element: HTMLVisualMediaElement,
): { width: number; height: number } | undefined {
  if (element instanceof HTMLVideoElement) {
    if (
      element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      element.videoWidth <= 0 ||
      element.videoHeight <= 0
    ) {
      return undefined;
    }
    return { width: element.videoWidth, height: element.videoHeight };
  }

  const width = element.naturalWidth || element.width;
  const height = element.naturalHeight || element.height;
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function hasEndedVideoTrack(element: HTMLVisualMediaElement): boolean {
  if (!(element instanceof HTMLVideoElement)) {
    return false;
  }
  const stream = element.srcObject;
  if (typeof MediaStream === 'undefined' || !(stream instanceof MediaStream)) {
    return false;
  }
  const track = stream.getVideoTracks()[0];
  return track !== undefined && track.readyState === 'ended';
}

function getCaptureContext(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | undefined {
  try {
    return canvas.getContext('2d', { willReadFrequently: true }) ?? undefined;
  } catch {
    return canvas.getContext('2d') ?? undefined;
  }
}
