import {
  areFramesComplete,
  framesToData,
  parseFramesReducer,
  progressOfFrames,
  totalNumberOfFrames,
  type State as QrLoopState,
} from 'qrloop';

export type QrAssemblyState = QrLoopState;

export type QrAssemblyResult =
  | { kind: 'complete'; value: string }
  | { kind: 'pending'; progress: number; state: QrAssemblyState };

const MAX_MULTIPART_FRAMES = 1_024;

/** Treat plain QR values as complete and accumulate recognized QRLoop frames. */
export function assembleQrValue(
  state: QrAssemblyState,
  value: string,
): QrAssemblyResult {
  if (!looksLikeQrLoopFrame(value)) {
    return { kind: 'complete', value };
  }

  try {
    const nextState = parseFramesReducer(state, value);
    if (!areFramesComplete(nextState)) {
      return {
        kind: 'pending',
        progress: normalizedProgress(nextState),
        state: nextState,
      };
    }

    try {
      return {
        kind: 'complete',
        value: bytesToQrValue(framesToData(nextState)),
      };
    } catch {
      if (totalNumberOfFrames(nextState) === 1) {
        return { kind: 'complete', value };
      }
      // A later pass can replace a bad frame and satisfy the payload checksum.
      return {
        kind: 'pending',
        progress: Math.min(normalizedProgress(nextState), 0.99),
        state: nextState,
      };
    }
  } catch {
    return { kind: 'complete', value };
  }
}

function normalizedProgress(state: QrAssemblyState): number {
  return Math.max(0, Math.min(progressOfFrames(state), 1));
}

function looksLikeQrLoopFrame(value: string): boolean {
  if (
    value.length < 8 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    return false;
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return false;
  }

  if (binary.length < 6 || btoa(binary) !== value) {
    return false;
  }

  const version = binary.charCodeAt(0);
  if (version === 100) {
    const frameCount = readUint16(binary, 1);
    return (
      frameCount > 0 &&
      frameCount <= MAX_MULTIPART_FRAMES &&
      binary.length > 3 + frameCount * 2
    );
  }

  const frameCount = readUint16(binary, 1);
  const frameIndex = readUint16(binary, 3);
  if (
    version >= 10 ||
    frameCount <= 0 ||
    frameCount > MAX_MULTIPART_FRAMES ||
    frameIndex >= frameCount
  ) {
    return false;
  }

  if (frameIndex === 0) {
    const frameDataSize = binary.length - 5;
    if (frameDataSize < 4) {
      return false;
    }
    const wrappedDataSize = readUint32(binary, 5) + 20;
    if (
      wrappedDataSize <= (frameCount - 1) * frameDataSize ||
      wrappedDataSize > frameCount * frameDataSize
    ) {
      return false;
    }
  }

  return true;
}

function readUint16(value: string, offset: number): number {
  return value.charCodeAt(offset) * 256 + value.charCodeAt(offset + 1);
}

function readUint32(value: string, offset: number): number {
  return (
    value.charCodeAt(offset) * 0x1_00_00_00 +
    value.charCodeAt(offset + 1) * 0x1_00_00 +
    value.charCodeAt(offset + 2) * 0x1_00 +
    value.charCodeAt(offset + 3)
  );
}

function bytesToQrValue(bytes: Uint8Array): string {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!hasBinaryControlCharacter(value)) {
      return value;
    }
  } catch {
    // Binary multipart payloads use base64 at the scanner's string boundary.
  }

  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function hasBinaryControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 8 ||
      codePoint === 11 ||
      codePoint === 12 ||
      (codePoint >= 14 && codePoint <= 31)
    ) {
      return true;
    }
  }
  return false;
}
