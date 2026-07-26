import { msats, type Msats } from '../../domain';

export interface LightningReceiveBalance {
  readonly federationId: string;
  readonly balanceMsats: Msats;
}

export function scoreProjectedEqualAllocation(
  balances: readonly LightningReceiveBalance[],
  selectedFederationId: string,
  receiveAmountMsats: Msats,
): bigint {
  const federationCount = BigInt(balances.length);
  const totalAfter =
    balances.reduce((total, entry) => total + entry.balanceMsats, 0n) +
    receiveAmountMsats;
  return balances.reduce((score, entry) => {
    const projected =
      entry.balanceMsats +
      (entry.federationId === selectedFederationId ? receiveAmountMsats : 0n);
    const deviation = projected * federationCount - totalAfter;
    return score + (deviation < 0n ? -deviation : deviation);
  }, 0n);
}

export function selectLightningReceiveFederationId(
  balances: readonly LightningReceiveBalance[],
  primaryFederationId: string,
  receiveAmountMsats: Msats,
  portfolioBalanceMsats: Msats = msats(
    balances.reduce((total, entry) => total + entry.balanceMsats, 0n),
  ),
): string | undefined {
  if (balances.length === 0) {
    return undefined;
  }

  if (portfolioBalanceMsats === 0n) {
    return balances.some((entry) => entry.federationId === primaryFederationId)
      ? primaryFederationId
      : undefined;
  }

  return [...balances].sort((left, right) => {
    const leftScore = scoreProjectedEqualAllocation(
      balances,
      left.federationId,
      receiveAmountMsats,
    );
    const rightScore = scoreProjectedEqualAllocation(
      balances,
      right.federationId,
      receiveAmountMsats,
    );
    return leftScore < rightScore
      ? -1
      : leftScore > rightScore
        ? 1
        : left.federationId.localeCompare(right.federationId);
  })[0]?.federationId;
}
