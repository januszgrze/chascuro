import { useEffect, useMemo, useState } from 'react';
import type { ClipboardEvent, ChangeEvent } from 'react';

import type { SecretMnemonic } from '../../domain';
import { BitcoinMark } from '../shared/BitcoinMark';
import { CopyIcon, RefreshIcon, WarningTriangleIcon } from '../shared/icons';
import { OnboardingProgress } from '../shared/OnboardingProgress';
import { ScreenError } from '../shared/ScreenFrame';

interface IdentitySetupScreenProps {
  busy: boolean;
  error?: string;
  startMode?: IdentityStartMode;
  onCreate(): Promise<SecretMnemonic>;
  onConfirmBackup(): Promise<void>;
  onRestore(words: string): Promise<void>;
}

type IdentityMode = 'choice' | 'create' | 'restore';
export type IdentityStartMode = 'choice' | 'restore';

const RECOVERY_WORD_COUNT = 12;

function createEmptyRecoveryWords(): string[] {
  return Array.from({ length: RECOVERY_WORD_COUNT }, () => '');
}

function parseRecoveryWords(value: string): string[] {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, RECOVERY_WORD_COUNT);
}

export function IdentitySetupScreen({
  busy,
  error,
  startMode = 'choice',
  onCreate,
  onConfirmBackup,
  onRestore,
}: IdentitySetupScreenProps) {
  const [mode, setMode] = useState<IdentityMode>(() =>
    startMode === 'restore' ? 'restore' : 'choice',
  );
  const [mnemonic, setMnemonic] = useState<SecretMnemonic>();
  const [restoreWords, setRestoreWords] = useState(createEmptyRecoveryWords);
  const [restoreFocusIndex, setRestoreFocusIndex] = useState(0);
  const [copied, setCopied] = useState(false);
  const words = useMemo(() => mnemonic?.reveal() ?? [], [mnemonic]);
  const restorePhrase = useMemo(
    () =>
      restoreWords
        .map((word) => word.trim())
        .filter(Boolean)
        .join(' '),
    [restoreWords],
  );
  const canRestore = restoreWords.every((word) => word.trim().length > 0);

  useEffect(
    () => () => {
      mnemonic?.clear();
    },
    [mnemonic],
  );

  async function createWalletIdentity() {
    try {
      const created = await onCreate();
      setMnemonic(created);
      setCopied(false);
      setMode('create');
    } catch {
      // The controller owns the sanitized public error state.
    }
  }

  async function confirmBackup() {
    await onConfirmBackup();
    mnemonic?.clear();
    setMnemonic(undefined);
  }

  async function copyWords() {
    if (navigator.clipboard === undefined) {
      return;
    }
    try {
      await navigator.clipboard.writeText(words.join(' '));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function fillRestoreWords(startIndex: number, value: string) {
    const nextWords = parseRecoveryWords(value);
    if (nextWords.length === 0) {
      return;
    }
    setRestoreWords((current) => {
      const next = [...current];
      nextWords
        .slice(0, RECOVERY_WORD_COUNT - startIndex)
        .forEach((word, offset) => {
          next[startIndex + offset] = word;
        });
      return next;
    });
    setRestoreFocusIndex(
      Math.min(startIndex + nextWords.length, RECOVERY_WORD_COUNT - 1),
    );
  }

  function updateRestoreWord(
    index: number,
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const nextValue = event.currentTarget.value;
    if (/\s/.test(nextValue)) {
      fillRestoreWords(index, nextValue);
      return;
    }
    setRestoreWords((current) => {
      const next = [...current];
      next[index] = nextValue;
      return next;
    });
  }

  function pasteRestoreWordsFromField(
    index: number,
    event: ClipboardEvent<HTMLInputElement>,
  ) {
    const pastedWords = parseRecoveryWords(event.clipboardData.getData('text'));
    if (pastedWords.length <= 1) {
      return;
    }
    event.preventDefault();
    fillRestoreWords(index, pastedWords.join(' '));
  }

  async function pasteRestoreWordsFromClipboard() {
    if (navigator.clipboard === undefined) {
      return;
    }
    try {
      fillRestoreWords(0, await navigator.clipboard.readText());
    } catch {
      // Clipboard availability is browser-controlled; typed entry remains available.
    }
  }

  if (mode === 'create' && mnemonic !== undefined) {
    const columns = [words.slice(0, 6), words.slice(6)];
    return (
      <section className="onb-recovery" aria-labelledby="identity-title">
        <OnboardingProgress step={1} />
        <h1 id="identity-title" className="onb-title">
          Your recovery phrase
        </h1>
        <div className="warn-banner">
          <WarningTriangleIcon />
          <p>
            Write these down in order. Anyone with them can take your money —
            Chascuro can't recover them.
          </p>
        </div>
        <div className="word-grid">
          {columns.map((column, columnIndex) => (
            <ol
              className="word-col"
              key={columnIndex}
              start={columnIndex * 6 + 1}
              aria-label={`Recovery words ${columnIndex * 6 + 1} to ${columnIndex * 6 + column.length}`}
            >
              {column.map((word, wordIndex) => {
                const position = columnIndex * 6 + wordIndex + 1;
                return (
                  <li className="word-row" key={`${position}-${word}`}>
                    <span className="word-num">{position}</span>
                    <span className="word-text">{word}</span>
                  </li>
                );
              })}
            </ol>
          ))}
        </div>
        <div className="onb-footer">
          <ScreenError message={error} />
          {copied ? (
            <p className="copy-status" role="status">
              Copied to clipboard
            </p>
          ) : null}
          <button
            className="btn-ghost"
            type="button"
            disabled={busy}
            onClick={() => void copyWords()}
          >
            <CopyIcon />
            Copy to clipboard
          </button>
          <button
            className="cta-pill"
            type="button"
            disabled={busy}
            onClick={() => void confirmBackup()}
          >
            {busy ? 'Saving…' : "I've written it down"}
          </button>
        </div>
      </section>
    );
  }

  if (mode === 'restore') {
    const columns = [restoreWords.slice(0, 6), restoreWords.slice(6)];

    return (
      <section className="onb-restore" aria-labelledby="identity-title">
        <OnboardingProgress step={1} />
        <h1 id="identity-title" className="onb-title">
          Restore your wallet
        </h1>
        <p className="onb-restore-helper">
          Enter your 12-word recovery phrase in order. Only you ever see these
          words.
        </p>
        <div
          className="restore-word-grid"
          role="group"
          aria-label="Recovery phrase"
        >
          {columns.map((column, columnIndex) => (
            <div className="restore-word-col" key={columnIndex}>
              {column.map((word, wordIndex) => {
                const index = columnIndex * 6 + wordIndex;
                const position = index + 1;
                return (
                  <label
                    className={
                      index === restoreFocusIndex
                        ? 'restore-word-row is-active'
                        : 'restore-word-row'
                    }
                    key={position}
                  >
                    <span className="word-num">{position}</span>
                    <input
                      aria-label={`Recovery word ${position}`}
                      autoCapitalize="none"
                      autoComplete="off"
                      autoCorrect="off"
                      className="restore-word-input"
                      disabled={busy}
                      inputMode="text"
                      spellCheck={false}
                      type="text"
                      value={word}
                      onChange={(event) => updateRestoreWord(index, event)}
                      onFocus={() => setRestoreFocusIndex(index)}
                      onPaste={(event) =>
                        pasteRestoreWordsFromField(index, event)
                      }
                    />
                  </label>
                );
              })}
            </div>
          ))}
        </div>
        <div className="onb-footer onb-restore-footer">
          <ScreenError message={error} />
          <button
            className="btn-ghost onb-paste-action"
            type="button"
            disabled={busy}
            onClick={() => void pasteRestoreWordsFromClipboard()}
          >
            <CopyIcon />
            Paste from clipboard
          </button>
          <button
            className="cta-pill onb-restore-submit"
            type="button"
            disabled={busy || !canRestore}
            onClick={() => void onRestore(restorePhrase)}
          >
            {busy ? 'Restoring…' : 'Restore wallet'}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="onb-welcome" aria-labelledby="identity-title">
      <div className="onb-welcome-hero">
        <div className="onb-brand-mark" aria-hidden="true">
          <BitcoinMark />
        </div>
        <h1 id="identity-title">Chascuro</h1>
        <p>Private chat and Bitcoin payments, held by a community you trust.</p>
      </div>
      <button
        className="onb-restore-action"
        type="button"
        disabled={busy}
        onClick={() => setMode('restore')}
      >
        <RefreshIcon size={16} />
        Restore another wallet
      </button>
      <div className="onb-welcome-footer">
        <ScreenError message={error} />
        <button
          className="cta-pill"
          type="button"
          disabled={busy}
          onClick={() => void createWalletIdentity()}
        >
          {busy ? 'Creating…' : 'Create a wallet'}
        </button>
      </div>
    </section>
  );
}
