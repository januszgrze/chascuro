import { useCallback, useEffect, useRef, useState } from 'react';

import type { IScannerControls } from '@zxing/browser';

import { RefreshIcon } from './icons';
import { assembleQrValue, type QrAssemblyState } from './QrPayloadAssembler';

interface QrScannerProps {
  disabled?: boolean;
  variant?: 'default' | 'framed' | 'chat';
  onScan(value: string): void;
}

const CAMERA_AUTO_START_KEY = 'chascuro.camera-auto-start.v1';

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
  const assemblyStateRef = useRef<QrAssemblyState>(null);
  const [active, setActive] = useState(false);
  const [assemblyProgress, setAssemblyProgress] = useState(0);
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
      assemblyStateRef.current = null;
      stopVideoTracks(video);
    };
  }, []);

  const isCurrentGeneration = useCallback(
    (generation: number): boolean =>
      mountedRef.current && generationRef.current === generation,
    [],
  );

  const start = useCallback(
    async (rememberConsent = true) => {
      if (disabled || active || videoRef.current === null) {
        return;
      }

      const generation = generationRef.current + 1;
      generationRef.current = generation;
      setError(undefined);
      assemblyStateRef.current = null;
      setAssemblyProgress(0);
      setActive(true);
      try {
        const [
          { ResilientQrReader },
          {
            ChecksumException,
            DecodeHintType,
            FormatException,
            NotFoundException,
          },
        ] = await Promise.all([
          import('./ResilientQrReader'),
          import('@zxing/library'),
        ]);
        if (!isCurrentGeneration(generation)) {
          stopVideoTracks(videoRef.current);
          return;
        }

        const hints = new Map([[DecodeHintType.TRY_HARDER, true]]);
        const reader = new ResilientQrReader(hints, {
          delayBetweenScanAttempts: 150,
          delayBetweenScanSuccess: 100,
        });
        try {
          const controls = await reader.decodeFromConstraints(
            {
              audio: false,
              video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
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
                if (rememberConsent) {
                  rememberCameraAutoStart();
                }
                const rawValue = result.getText();
                const assembled = assembleQrValue(
                  assemblyStateRef.current,
                  rawValue,
                );
                if (assembled.kind === 'pending') {
                  assemblyStateRef.current = assembled.state;
                  setAssemblyProgress(assembled.progress);
                  return;
                }

                generationRef.current += 1;
                callbackControls.stop();
                controlsRef.current = null;
                assemblyStateRef.current = null;
                setAssemblyProgress(0);
                stopVideoTracks(videoRef.current);
                setActive(false);
                onScanRef.current(
                  assembled.kind === 'complete' ? assembled.value : rawValue,
                );
                return;
              }

              if (
                scanError === undefined ||
                scanError instanceof NotFoundException ||
                scanError instanceof ChecksumException ||
                scanError instanceof FormatException
              ) {
                return;
              }

              failScan('The camera could not read a QR code.');
            },
          );

          if (!isCurrentGeneration(generation)) {
            controls.stop();
            stopVideoTracks(videoRef.current);
            return;
          }
          if (rememberConsent) {
            rememberCameraAutoStart();
          }
          controlsRef.current = controls;
        } catch {
          if (!isCurrentGeneration(generation)) {
            stopVideoTracks(videoRef.current);
            return;
          }
          failScan('Camera access was denied or is unavailable.');
        }

        function failScan(message: string): void {
          generationRef.current += 1;
          controlsRef.current?.stop();
          controlsRef.current = null;
          assemblyStateRef.current = null;
          setAssemblyProgress(0);
          forgetCameraAutoStart();
          stopVideoTracks(videoRef.current);
          setActive(false);
          setError(message);
        }
      } catch {
        if (!isCurrentGeneration(generation)) {
          stopVideoTracks(videoRef.current);
          return;
        }

        generationRef.current += 1;
        controlsRef.current?.stop();
        controlsRef.current = null;
        assemblyStateRef.current = null;
        setAssemblyProgress(0);
        forgetCameraAutoStart();
        stopVideoTracks(videoRef.current);
        setActive(false);
        setError('Camera access was denied or is unavailable.');
      }
    },
    [active, disabled, isCurrentGeneration],
  );

  useEffect(() => {
    if (!disabled && shouldAutoStartCamera()) {
      void start(false);
    }
  }, [disabled, start]);

  function stop() {
    generationRef.current += 1;
    controlsRef.current?.stop();
    controlsRef.current = null;
    assemblyStateRef.current = null;
    setAssemblyProgress(0);
    forgetCameraAutoStart();
    stopVideoTracks(videoRef.current);
    setActive(false);
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
          <QrScanProgress value={assemblyProgress} />
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
        <QrScanProgress value={assemblyProgress} />
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
      <div className="qr-scanner-viewport">
        <video
          ref={videoRef}
          aria-label="QR camera preview"
          hidden={!active}
          muted
          playsInline
        />
        <QrScanProgress value={assemblyProgress} />
      </div>
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

function QrScanProgress({ value }: { value: number }) {
  if (value <= 0) {
    return null;
  }

  const percent = Math.max(1, Math.min(100, Math.round(value * 100)));
  return (
    <div
      className="qr-scan-progress"
      role="progressbar"
      aria-label="Multipart QR scan progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span
        className="qr-scan-progress-fill"
        style={{ width: `${percent}%` }}
        aria-hidden="true"
      />
      <span className="qr-scan-progress-label">{percent}%</span>
    </div>
  );
}

function shouldAutoStartCamera(): boolean {
  try {
    return window.localStorage.getItem(CAMERA_AUTO_START_KEY) === 'true';
  } catch {
    return false;
  }
}

function rememberCameraAutoStart(): void {
  try {
    window.localStorage.setItem(CAMERA_AUTO_START_KEY, 'true');
  } catch {
    // Camera scanning still works when persistent browser storage is blocked.
  }
}

function forgetCameraAutoStart(): void {
  try {
    window.localStorage.removeItem(CAMERA_AUTO_START_KEY);
  } catch {
    // There is no stored preference to clear when storage is unavailable.
  }
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
