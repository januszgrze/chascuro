import { useEffect, useRef, useState } from 'react';

import type { IScannerControls } from '@zxing/browser';

import { RefreshIcon } from './icons';

interface QrScannerProps {
  disabled?: boolean;
  variant?: 'default' | 'framed' | 'chat';
  onScan(value: string): void;
}

export function QrScanner({
  disabled = false,
  variant = 'default',
  onScan,
}: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const onScanRef = useRef(onScan);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    const video = videoRef.current;
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      controlsRef.current?.stop();
      controlsRef.current = null;
      stopVideoTracks(video);
    };
  }, []);

  async function start() {
    if (disabled || active || videoRef.current === null) {
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setError(undefined);
    setActive(true);
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      if (!isCurrentGeneration(generation)) {
        stopVideoTracks(videoRef.current);
        return;
      }

      const reader = new BrowserQRCodeReader(undefined, {
        delayBetweenScanAttempts: 150,
      });
      const controls = await reader.decodeFromConstraints(
        {
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
          },
        },
        videoRef.current,
        (result, scanError, callbackControls) => {
          if (!isCurrentGeneration(generation)) {
            callbackControls.stop();
            stopVideoTracks(videoRef.current);
            return;
          }

          if (result !== undefined) {
            const value = result.getText();
            generationRef.current += 1;
            callbackControls.stop();
            controlsRef.current = null;
            stopVideoTracks(videoRef.current);
            setActive(false);
            onScanRef.current(value);
            return;
          }

          if (
            scanError !== undefined &&
            scanError.name !== 'NotFoundException'
          ) {
            generationRef.current += 1;
            callbackControls.stop();
            controlsRef.current = null;
            stopVideoTracks(videoRef.current);
            setActive(false);
            setError('The camera could not read a QR code.');
          }
        },
      );

      if (!isCurrentGeneration(generation)) {
        controls.stop();
        stopVideoTracks(videoRef.current);
        return;
      }
      controlsRef.current = controls;
    } catch {
      if (!isCurrentGeneration(generation)) {
        stopVideoTracks(videoRef.current);
        return;
      }

      generationRef.current += 1;
      controlsRef.current?.stop();
      controlsRef.current = null;
      stopVideoTracks(videoRef.current);
      setActive(false);
      setError('Camera access was denied or is unavailable.');
    }
  }

  function stop() {
    generationRef.current += 1;
    controlsRef.current?.stop();
    controlsRef.current = null;
    stopVideoTracks(videoRef.current);
    setActive(false);
  }

  function isCurrentGeneration(generation: number): boolean {
    return mountedRef.current && generationRef.current === generation;
  }

  if (variant === 'chat') {
    return (
      <div className="chat-scan-camera">
        <div className="chat-scan-viewport">
          <video
            ref={videoRef}
            aria-label="QR camera preview"
            hidden={!active}
            muted
            playsInline
          />
          <span className="chat-scan-corner is-tl" aria-hidden="true" />
          <span className="chat-scan-corner is-tr" aria-hidden="true" />
          <span className="chat-scan-corner is-bl" aria-hidden="true" />
          <span className="chat-scan-corner is-br" aria-hidden="true" />
          {!active && (
            <button
              className="chat-scan-start"
              type="button"
              disabled={disabled}
              aria-label="Start camera"
              onClick={() => void start()}
            >
              <RefreshIcon />
            </button>
          )}
        </div>
        <p className="chat-scan-caption" role="status">
          {active ? 'Scanning for a chat address…' : (error ?? 'Camera ready')}
        </p>
      </div>
    );
  }

  if (variant === 'framed') {
    return (
      <div className="scan-frame">
        <video
          ref={videoRef}
          aria-label="QR camera preview"
          hidden={!active}
          muted
          playsInline
        />
        {!active && (
          <>
            <p
              className="scan-frame-text"
              role={error === undefined ? undefined : 'status'}
            >
              {error ?? 'Camera not found.'}
            </p>
            <button
              className="scan-refresh"
              type="button"
              disabled={disabled}
              aria-label="Start camera"
              onClick={() => void start()}
            >
              <RefreshIcon />
            </button>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="qr-scanner">
      <video
        ref={videoRef}
        aria-label="QR camera preview"
        hidden={!active}
        muted
        playsInline
      />
      {error !== undefined && (
        <p className="fine-print" role="status">
          {error}
        </p>
      )}
      <button
        className="secondary-button"
        type="button"
        disabled={disabled && !active}
        onClick={() => void (active ? stop() : start())}
      >
        {active ? 'Stop camera' : 'Scan QR with camera'}
      </button>
    </div>
  );
}

function stopVideoTracks(video: HTMLVideoElement | null): void {
  const stream = video?.srcObject;
  if (typeof MediaStream !== 'undefined' && stream instanceof MediaStream) {
    for (const track of stream.getTracks()) {
      track.stop();
    }
  }
  if (video !== null) {
    video.srcObject = null;
  }
}
