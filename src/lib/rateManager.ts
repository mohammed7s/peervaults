import { formatUnits, parseAbi, parseUnits, type Hex } from 'viem';

export const RATE_MANAGER_ABI = parseAbi([
  'function getRateManager(bytes32 rateManagerId) view returns ((address manager,address feeRecipient,uint256 maxFee,uint256 fee,uint256 minLiquidity,string name,string uri) config)',
  'function getManagerRate(bytes32 rateManagerId, bytes32 paymentMethod, bytes32 currencyCode) view returns (uint256 rate)',
]);

export type QueuedRate = {
  paymentMethod: string;
  currencyCode: string;
  rateInput: string;
};

export function percentToWad(percent: string) {
  return parseUnits(percent || '0', 18) / 100n;
}

export function formatPercentFromWad(value: bigint) {
  return `${formatUnits(value * 100n, 18)}%`;
}

export function formatRate(value: bigint) {
  return formatUnits(value, 18);
}

export function rateInputToPreciseUnits(rateInput: string) {
  return parseUnits(rateInput || '0', 18);
}

export function groupQueuedRates<T extends { paymentMethodHash: Hex; currencyHash: Hex; rate: bigint }>(
  items: T[],
) {
  const grouped = new Map<Hex, { currencies: Hex[]; rates: bigint[] }>();

  for (const item of items) {
    const existing = grouped.get(item.paymentMethodHash) || { currencies: [], rates: [] };
    existing.currencies.push(item.currencyHash);
    existing.rates.push(item.rate);
    grouped.set(item.paymentMethodHash, existing);
  }

  return {
    paymentMethods: [...grouped.keys()],
    currencies: [...grouped.values()].map((entry) => entry.currencies),
    rates: [...grouped.values()].map((entry) => entry.rates),
  };
}
