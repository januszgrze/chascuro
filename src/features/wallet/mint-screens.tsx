import { useState } from 'react';

import {
  addMsats,
  formatMsatsAsSats,
  msats,
  type BitcoinNetwork,
  type Msats,
} from '../../domain';
import type { FederationAccount, WalletSnapshot } from '../../services/wallet';
import { BitcoinMark } from '../shared/BitcoinMark';
import { CheckIcon, PlusIcon } from '../shared/icons';
import { ScreenError } from '../shared/ScreenFrame';
import { ChevronRightGlyph, CloseGlyph } from './wallet-screen-components';

export function totalJoinedBalance(snapshot: WalletSnapshot): Msats {
  if (snapshot.federations.length === 0) {
    return snapshot.balanceMsats;
  }
  return snapshot.federations.reduce(
    (sum, account) => addMsats(sum, account.balanceMsats),
    msats(0n),
  );
}

export function selectedMintAccount(
  snapshot: WalletSnapshot,
): FederationAccount | undefined {
  const selectedId = snapshot.activeFederation?.federationId;
  if (selectedId === undefined) {
    return snapshot.federations[0];
  }
  return snapshot.federations.find(
    (account) => account.federation.federationId === selectedId,
  );
}

export function mintDisplayName(
  snapshot: WalletSnapshot,
  federationId: string,
): string {
  return (
    snapshot.federations.find(
      (account) => account.federation.federationId === federationId,
    )?.federation.displayName ?? 'Mint'
  );
}

function mintNetworkLabel(network: BitcoinNetwork): string | undefined {
  switch (network) {
    case 'testnet':
      return 'Testnet';
    case 'signet':
      return 'Signet';
    case 'regtest':
      return 'Regtest';
    default:
      return undefined;
  }
}

function BtcAmount({ amount }: { amount: Msats | string }) {
  const label = typeof amount === 'string' ? amount : formatMsatsAsSats(amount);
  return (
    <span className="btc-amount">
      <BitcoinMark className="btc-symbol" /> {label}
    </span>
  );
}

export function PayFromCard({
  account,
  direction = 'send',
  onPick,
}: {
  account?: FederationAccount;
  direction?: 'send' | 'receive';
  onPick?(): void;
}) {
  if (account === undefined) {
    return null;
  }

  const subtitle = mintNetworkLabel(account.federation.network);
  const label = direction === 'send' ? 'Pay from' : 'Receive to';
  const interactive = onPick !== undefined;

  return (
    <div className="pay-from">
      {interactive ? (
        <button className="pay-from-trigger" type="button" onClick={onPick}>
          <PayFromCardBody
            label={label}
            name={account.federation.displayName}
            subtitle={subtitle}
            balanceMsats={account.balanceMsats}
          />
        </button>
      ) : (
        <PayFromCardBody
          label={label}
          name={account.federation.displayName}
          subtitle={subtitle}
          balanceMsats={account.balanceMsats}
        />
      )}
    </div>
  );
}

function PayFromCardBody({
  label,
  name,
  subtitle,
  balanceMsats,
}: {
  label: string;
  name: string;
  subtitle?: string;
  balanceMsats: FederationAccount['balanceMsats'];
}) {
  return (
    <>
      <span className="pay-from-heading">{label}</span>
      <span className="pay-from-card">
        <span className="pay-from-copy">
          <span className="pay-from-name">{name}</span>
          {subtitle !== undefined && (
            <span className="pay-from-sub">{subtitle}</span>
          )}
        </span>
        <span className="pay-from-meta">
          <BtcAmount amount={balanceMsats} />
          <span className="pay-from-chevron">
            <ChevronRightGlyph />
          </span>
        </span>
      </span>
    </>
  );
}

export function ChooseMintScreen({
  snapshot,
  intent,
  amountMsats,
  selectedId,
  onConfirm,
  onClose,
  onConnectMint,
  error,
  confirmBusy = false,
}: {
  snapshot: WalletSnapshot;
  intent: 'lightning-send' | 'ecash-send' | 'lightning-receive' | 'manage';
  amountMsats?: Msats;
  selectedId?: string;
  onConfirm(federationId: string): void | Promise<void>;
  onClose(): void;
  onConnectMint(): void;
  error?: string;
  confirmBusy?: boolean;
}) {
  const [draftId, setDraftId] = useState(
    selectedId ?? snapshot.federations[0]?.federation.federationId,
  );
  const selected = snapshot.federations.find(
    (account) => account.federation.federationId === draftId,
  );
  const needed = amountMsats;
  const sendIntent = intent === 'lightning-send' || intent === 'ecash-send';
  const covered =
    !sendIntent ||
    needed === undefined ||
    (selected !== undefined && selected.balanceMsats >= needed);
  const manage = intent === 'manage';
  const confirmEnabled = draftId !== undefined && covered;

  function subtitle(): string {
    const amountLabel =
      amountMsats === undefined ? undefined : formatMsatsAsSats(amountMsats);
    switch (intent) {
      case 'lightning-send':
        return amountLabel === undefined
          ? 'Choose which mint you’d like to pay from.'
          : `Paying a ₿ ${amountLabel} lightning invoice — choose which mint you’d like to pay from.`;
      case 'ecash-send':
        return amountLabel === undefined
          ? 'Choose which mint you’d like to create the note from.'
          : `Creating a ₿ ${amountLabel} ecash note — choose which mint you’d like to create the note from.`;
      case 'lightning-receive':
        return amountLabel === undefined
          ? 'Choose which mint you’d like the funds to arrive in.'
          : `Receiving ₿ ${amountLabel} over Lightning — choose which mint you’d like the funds to arrive in.`;
      case 'manage':
        return 'Select a mint for Lightning send and receive. Ecash redeem still routes to the matching mint.';
    }
  }

  async function confirm() {
    if (draftId === undefined || !confirmEnabled) {
      return;
    }
    await onConfirm(draftId);
  }

  return (
    <section
      className="choose-mint flow-screen"
      aria-labelledby="choose-mint-title"
    >
      <div className="flow-screen-content">
        <header className="choose-mint-header">
          <div className="choose-mint-topbar">
            <button
              className="choose-mint-close"
              type="button"
              aria-label="Close"
              disabled={confirmBusy}
              onClick={onClose}
            >
              <CloseGlyph />
            </button>
          </div>
          <div className="choose-mint-intro">
            <h1 id="choose-mint-title" className="choose-mint-title">
              {manage ? 'Your mints' : 'Choose a mint'}
            </h1>
            <p className="choose-mint-subtitle">{subtitle()}</p>
          </div>
        </header>
        <div className="choose-mint-body">
          <ul className="choose-mint-list">
            {snapshot.federations.map((account) => {
              const selectedMint = account.federation.federationId === draftId;
              const subtitleLabel = mintNetworkLabel(
                account.federation.network,
              );
              return (
                <li key={account.federation.federationId}>
                  <button
                    className={`choose-mint-row${selectedMint ? ' is-selected' : ''}`}
                    type="button"
                    aria-pressed={selectedMint}
                    onClick={() => {
                      setDraftId(account.federation.federationId);
                    }}
                  >
                    <span className="choose-mint-copy">
                      <span className="choose-mint-name">
                        {account.federation.displayName}
                      </span>
                      {subtitleLabel !== undefined && (
                        <span className="choose-mint-sub">{subtitleLabel}</span>
                      )}
                    </span>
                    <span className="choose-mint-trailing">
                      <span className="choose-mint-balance">
                        <BtcAmount amount={account.balanceMsats} />
                      </span>
                      <span
                        className={`mint-check${selectedMint ? ' is-checked' : ''}`}
                        aria-hidden="true"
                      >
                        {selectedMint ? <CheckIcon size={14} /> : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            className="choose-mint-connect"
            type="button"
            disabled={confirmBusy}
            onClick={onConnectMint}
          >
            <PlusIcon size={16} />
            Connect a mint
          </button>
        </div>
      </div>
      <div className="screen-actions">
        <ScreenError message={error} />
        <button
          className="flow-primary-action"
          type="button"
          disabled={!confirmEnabled || confirmBusy}
          aria-busy={confirmBusy}
          onClick={() => void confirm()}
        >
          {confirmBusy ? 'Creating…' : 'Confirm'}
        </button>
      </div>
    </section>
  );
}
