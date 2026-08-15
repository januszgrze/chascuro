import { useEffect, useMemo, useState } from 'react';

import { Buffer } from 'buffer';
import QRCode from 'qrcode';
import { dataToFrames } from 'qrloop';

interface QrCodeProps {
  allowMultipart?: boolean;
  contentType?: 'bolt11' | 'ecash';
  value: string;
  label: string;
}

// Keep fixed-size wallet QRs below the density that proved unreliable on phones.
const MAX_STATIC_QR_BYTES = 320;
const MULTIPART_FRAME_DATA_BYTES = 120;
const MULTIPART_FRAME_LOOPS = 4;
const MULTIPART_FRAME_INTERVAL_MS = 200;

export function QrCode({
  allowMultipart = false,
  contentType,
  value,
  label,
}: QrCodeProps) {
  const qrValue = contentType === 'bolt11' ? value.toUpperCase() : value;
  const frames = useMemo(() => {
    const rawByteLength = new TextEncoder().encode(qrValue).byteLength;
    const frameData =
      contentType === 'ecash' ? ecashToQrFrameData(qrValue) : qrValue;
    return allowMultipart && rawByteLength > MAX_STATIC_QR_BYTES
      ? dataToFrames(
          frameData,
          MULTIPART_FRAME_DATA_BYTES,
          MULTIPART_FRAME_LOOPS,
        )
      : [qrValue];
  }, [allowMultipart, contentType, qrValue]);
  const [activeFrameState, setActiveFrameState] = useState<{
    frames: string[];
    index: number;
  }>(() => ({ frames, index: 0 }));
  const [result, setResult] = useState<{
    value: string;
    frame: string;
    dataUrl?: string;
    failed?: boolean;
  }>();
  const activeFrame =
    activeFrameState.frames === frames ? activeFrameState.index : 0;
  const frame = frames[activeFrame % frames.length];
  const isMultipart = frames.length > 1;

  useEffect(() => {
    if (
      !isMultipart ||
      result?.value !== value ||
      result.frame !== frame ||
      result.dataUrl === undefined
    ) {
      return;
    }
    const timeout = window.setTimeout(
      () =>
        setActiveFrameState((current) => ({
          frames,
          index:
            ((current.frames === frames ? current.index : 0) + 1) %
            frames.length,
        })),
      MULTIPART_FRAME_INTERVAL_MS,
    );
    return () => window.clearTimeout(timeout);
  }, [frame, frames, isMultipart, result, value]);

  useEffect(() => {
    let active = true;
    void QRCode.toString(frame, {
      type: 'svg',
      errorCorrectionLevel: isMultipart ? 'M' : 'L',
      margin: isMultipart || contentType === 'bolt11' ? 4 : 2,
      width: 280,
      color: {
        dark: '#000000ff',
        light: '#ffffffff',
      },
    }).then(
      (svg) => {
        if (active) {
          setResult({
            value,
            frame,
            dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
          });
        }
      },
      () => {
        if (active) {
          setResult({ value, frame, failed: true });
        }
      },
    );

    return () => {
      active = false;
    };
  }, [contentType, frame, isMultipart, value]);

  if (result?.value === value && result.frame === frame && result.failed) {
    return (
      <p className="fine-print" role="status">
        QR rendering failed. Use the explicit copy control instead.
      </p>
    );
  }

  return result?.value !== value || result.dataUrl === undefined ? (
    <p className="fine-print" role="status">
      Rendering QR…
    </p>
  ) : (
    <div className="qr-frame">
      <img src={result.dataUrl} alt={label} width={280} height={280} />
    </div>
  );
}

/** Match Fedi's QRLoop boundary: v2 text stays UTF-8; legacy base64 is binary. */
function ecashToQrFrameData(ecash: string): Buffer {
  return ecash.startsWith('fedimint')
    ? Buffer.from(ecash, 'utf8')
    : Buffer.from(ecash, 'base64');
}
