import { BrowserQRCodeReader } from '@zxing/browser';
import { Exception, NotFoundException, type Result } from '@zxing/library';

/**
 * Keeps malformed intermediate camera frames retryable and prioritizes the
 * centered square shown by the scanner UI before falling back to the full feed.
 */
export class ResilientQrReader extends BrowserQRCodeReader {
  private centeredCanvas?: HTMLCanvasElement;

  override decodeFromCanvas(source: HTMLCanvasElement): Result {
    const centered = this.centerSquare(source);
    try {
      return super.decodeFromCanvas(centered);
    } catch (centeredError) {
      if (centered !== source) {
        try {
          return super.decodeFromCanvas(source);
        } catch (fullFrameError) {
          return retryZxingError(fullFrameError);
        }
      }
      return retryZxingError(centeredError);
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

function retryZxingError(error: unknown): never {
  if (error instanceof Exception) {
    throw NotFoundException.getNotFoundInstance();
  }
  throw error;
}
