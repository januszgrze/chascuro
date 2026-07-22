import { useEffect, useState } from 'react';

import QRCode from 'qrcode';

interface QrCodeProps {
  value: string;
  label: string;
}

export function QrCode({ value, label }: QrCodeProps) {
  const [result, setResult] = useState<{
    value: string;
    dataUrl?: string;
    failed?: boolean;
  }>();

  useEffect(() => {
    let active = true;
    void QRCode.toDataURL(value, {
      errorCorrectionLevel: 'L',
      margin: 2,
      width: 280,
      color: {
        dark: '#000000ff',
        light: '#ffffffff',
      },
    }).then(
      (url) => {
        if (active) {
          setResult({ value, dataUrl: url });
        }
      },
      () => {
        if (active) {
          setResult({ value, failed: true });
        }
      },
    );

    return () => {
      active = false;
    };
  }, [value]);

  if (result?.value === value && result.failed) {
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
