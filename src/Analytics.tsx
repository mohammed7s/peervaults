import {
  PLATFORM_METADATA,
  Zkp2pClient,
  getPaymentMethodsCatalog,
  getCurrencyCodeFromHash,
  resolvePaymentMethodHash,
} from '@zkp2p/sdk';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { formatUnits, type Hex, type Address } from 'viem';
import { base } from 'wagmi/chains';
import peerVaultsLogo from './assets/peervaults-logo.svg';
import { appConfig } from './lib/config';

/* ── types ─────────────────────────────────────────────────────────── */

type DiscoveredVault = {
  rateManagerId: Hex;
  rateManagerAddress?: Address | null;
  manager: Address;
  feeRecipient: Address;
  maxFee: string;
  fee: string;
  minLiquidity?: string;
  name: string;
  uri: string;
};

type VaultListItem = {
  manager: DiscoveredVault;
  aggregate: {
    currentDelegatedBalance?: string | null;
    currentDelegatedDeposits?: number | string | null;
    totalFilledVolume?: string | null;
    totalFeeAmount?: string | null;
    totalPnlUsdCents?: string | null;
    fulfilledIntents?: number | null;
    firstSeenAt?: string | null;
  } | null;
};

type VaultRate = {
  paymentMethodHash: string;
  currencyCode: string;
  managerRate: string;
  updatedAt: string;
};

type DailySnapshot = {
  dayTimestamp: string;
  tvl: string;
  dailyVolume: string;
  dailyFees: string;
  dailyPnlUsdCents: string;
  dailyFulfilledIntents: number;
  cumulativeVolume: string;
  cumulativeFees: string;
  cumulativePnlUsdCents: string;
  cumulativeFulfilledIntents: number;
  delegatedDeposits: number;
};

type DelegationRecord = {
  depositId: string;
  delegatedAt?: string | null;
};

type DepositRecord = {
  id: string;
  depositor: string;
  remainingDeposits: string;
  outstandingIntentAmount?: string;
  totalAmountTaken: string;
  totalWithdrawn?: string;
  status: string;
  timestamp: string;
  updatedAt: string;
  fulfilledIntents?: number;
  signaledIntents?: number;
};

type IntentRecord = {
  intentHash: string;
  depositId: string;
  owner: string;
  amount: string;
  status: string;
  signalTimestamp: string;
  fulfillTimestamp?: string;
  paymentMethodHash?: string;
  rateManagerId?: string;
  fiatCurrency: string;
};

type VaultDetail = {
  vault: VaultListItem;
  rates: VaultRate[];
  snapshots: DailySnapshot[];
  delegations: DelegationRecord[];
  deposits: DepositRecord[];
  intents: IntentRecord[];
};

type MarketRatesResponse = {
  data?: { rates?: Record<string, string> };
};

/* ── helpers ───────────────────────────────────────────────────────── */

const paymentMethodCatalog = getPaymentMethodsCatalog(base.id, appConfig.runtimeEnv);

const paymentMethodLabels = new Map<string, string>();
for (const key of Object.keys(paymentMethodCatalog)) {
  const hash = resolvePaymentMethodHash(key, { env: appConfig.runtimeEnv }).toLowerCase();
  const meta = PLATFORM_METADATA[key.toLowerCase() as keyof typeof PLATFORM_METADATA];
  paymentMethodLabels.set(hash, meta?.displayName ?? formatMethodKey(key));
}

function formatMethodKey(key: string) {
  return key
    .split('-')
    .filter(Boolean)
    .map((s) => (s.length <= 3 ? s.toUpperCase() : s[0].toUpperCase() + s.slice(1)))
    .join(' ');
}

function resolvePaymentMethod(hash: string) {
  if (!hash) return '';
  const found = paymentMethodLabels.get(hash.toLowerCase());
  if (found) return found;
  // if it's not a hash, try looking up as a key directly
  const meta = PLATFORM_METADATA[hash.toLowerCase() as keyof typeof PLATFORM_METADATA];
  if (meta?.displayName) return meta.displayName;
  return hash.startsWith('0x') ? hash.slice(0, 10) : formatMethodKey(hash);
}

function resolveCurrency(hash: string) {
  if (!hash) return '';
  // if it's already a readable code (e.g. "USD"), return as-is
  if (!hash.startsWith('0x')) return hash;
  return getCurrencyCodeFromHash(hash) ?? hash.slice(0, 10);
}

function formatUsdcShort(value?: string | null) {
  if (!value) return '$0';
  try {
    const num = Number(formatUnits(BigInt(value), 6));
    if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}k`;
    return `$${num.toFixed(0)}`;
  } catch {
    return '$0';
  }
}

function formatUsdcFull(value?: string | null) {
  if (!value) return '0 USDC';
  try {
    return `${Number(formatUnits(BigInt(value), 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC`;
  } catch {
    return '0 USDC';
  }
}

function formatCentsUsd(cents: string | null | undefined) {
  if (!cents) return '$0';
  const n = Number(cents) / 100;
  if (Math.abs(n) >= 1000) return `$${(n / 1000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

function shortHex(value?: string) {
  if (!value) return '';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function parseTimestamp(value?: string | null): number | null {
  if (!value) return null;
  const t = value.trim();
  const n = Number(t);
  if (Number.isFinite(n) && t !== '') {
    return t.length <= 10 ? n * 1000 : n;
  }
  const parsed = Date.parse(t);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatMinutes(ms: number) {
  const mins = ms / (1000 * 60);
  if (mins < 1) return `${Math.round(ms / 1000)}s`;
  if (mins < 60) return `${mins.toFixed(1)}m`;
  if (mins < 1440) return `${(mins / 60).toFixed(1)}h`;
  return `${(mins / 1440).toFixed(1)}d`;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

function spreadColor(spread: number | null) {
  if (spread === null) return 'var(--muted)';
  if (spread <= 0.5) return '#4ade80';
  if (spread <= 1.5) return '#facc15';
  if (spread <= 3) return '#fb923c';
  return '#f87171';
}

/* stable palette for vault dots — each vault gets a consistent color */
const VAULT_COLORS = [
  '#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa',
  '#fb923c', '#22d3ee', '#e879f9', '#4ade80', '#f87171',
  '#818cf8', '#2dd4bf', '#facc15', '#c084fc', '#38bdf8',
  '#fb7185', '#a3e635', '#e2e8f0', '#f97316', '#14b8a6',
];

type RouteKey = string;
function buildRouteKey(pmHash: string, ccyHash: string) {
  return `${pmHash.toLowerCase()}:${ccyHash.toLowerCase()}`;
}

/* ── component ─────────────────────────────────────────────────────── */

export default function Analytics() {
  const [selectedRoute, setSelectedRoute] = useState<string>('all');
  const [aprWindow, setAprWindow] = useState<'7d' | '30d' | 'all'>('30d');
  const [showAllRoutes, setShowAllRoutes] = useState(false);
  const [turnoverSortKey, setTurnoverSortKey] = useState<string>('median');
  const [turnoverSortDir, setTurnoverSortDir] = useState<'asc' | 'desc'>('asc');

  function toggleTurnoverSort(key: string) {
    if (turnoverSortKey === key) {
      setTurnoverSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setTurnoverSortKey(key);
      setTurnoverSortDir(key === 'vault' ? 'asc' : 'asc');
    }
  }
  const [aprSortKey, setAprSortKey] = useState<string>('apr');
  const [aprSortDir, setAprSortDir] = useState<'asc' | 'desc'>('desc');
  const TOP_ROUTES = 10;

  function toggleAprSort(key: string) {
    if (aprSortKey === key) {
      setAprSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setAprSortKey(key);
      setAprSortDir('desc');
    }
  }

  const readOnlyClient = useMemo(
    () =>
      new Zkp2pClient({
        chainId: base.id,
        runtimeEnv: appConfig.runtimeEnv,
        rpcUrl: appConfig.rpcUrl,
      } as ConstructorParameters<typeof Zkp2pClient>[0]),
    [],
  );

  /* ── queries ─────────────────────────────────────────────────────── */

  const vaultsQuery = useQuery({
    queryKey: ['analytics-vaults', appConfig.runtimeEnv],
    queryFn: async () => {
      const result = await readOnlyClient.indexer.getRateManagers({
        limit: 50,
        orderBy: 'currentDelegatedBalance',
        orderDirection: 'desc',
      });
      return result as VaultListItem[];
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const vaultDetailsQuery = useQuery({
    queryKey: ['analytics-vault-details', vaultsQuery.data?.map((v) => v.manager.rateManagerId)],
    enabled: Boolean(vaultsQuery.data?.length),
    queryFn: async () => {
      const vaults = vaultsQuery.data!;
      const results: VaultDetail[] = [];

      for (const vault of vaults) {
        const id = vault.manager.rateManagerId;
        const addr = vault.manager.rateManagerAddress ?? appConfig.rateManagerAddress;

        // fetch rates first — always try to get these
        let rates: VaultRate[] = [];
        let snapshots: DailySnapshot[] = [];
        let delegations: DelegationRecord[] = [];
        let deposits: DepositRecord[] = [];
        let intents: IntentRecord[] = [];

        try {
          const detail = await readOnlyClient.indexer.getRateManagerDetail(id, {
            rateManagerAddress: addr,
          });

          const rawRates = (detail?.rates ?? []) as unknown as Array<Record<string, unknown>>;
          rates = rawRates.map((r) => ({
            paymentMethodHash: String(r.paymentMethodHash ?? r.paymentMethod ?? ''),
            currencyCode: String(r.currencyCode ?? r.currency ?? ''),
            managerRate: String(r.managerRate ?? r.rate ?? '0'),
            updatedAt: String(r.updatedAt ?? ''),
          }));

          delegations = (detail?.delegations ?? []) as unknown as DelegationRecord[];
        } catch {}

        // secondary queries — each independent, failures don't block others
        try {
          const snapshotResult = await readOnlyClient.indexer.getManagerDailySnapshots(id, {
            limit: 90,
            rateManagerAddress: addr,
          });
          snapshots = (snapshotResult as unknown as DailySnapshot[]) ?? [];
        } catch {}

        if (delegations.length > 0) {
          const depositIds = delegations.map((d) => d.depositId);

          try {
            const depositResult = await readOnlyClient.indexer.getDepositsByIdsWithRelations(
              depositIds,
              { includeIntents: false },
            );
            deposits = (depositResult as unknown as DepositRecord[]) ?? [];
          } catch {}

          try {
            const intentResult = await readOnlyClient.indexer.getIntentsForDeposits(
              depositIds,
              ['FULFILLED'],
            );
            intents = (intentResult as unknown as IntentRecord[]) ?? [];
          } catch {}
        }

        results.push({ vault, rates, snapshots, delegations, deposits, intents });
      }
      return results;
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const marketRatesQuery = useQuery({
    queryKey: ['coinbase-market-rates'],
    queryFn: async () => {
      const response = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=USDC');
      if (!response.ok) throw new Error(`Coinbase failed: ${response.status}`);
      const payload = (await response.json()) as MarketRatesResponse;
      if (!payload.data?.rates) throw new Error('No rates');
      return payload.data.rates;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  /* ── derived ─────────────────────────────────────────────────────── */

  const allVaults = vaultsQuery.data ?? [];
  const allDetails = vaultDetailsQuery.data ?? [];
  const isLoading = vaultsQuery.isLoading || vaultDetailsQuery.isLoading;

  /* vaults with volume > 0 (used for price chart + returns) */
  const activeDetails = useMemo(() => {
    return allDetails.filter((vd) => {
      try {
        return BigInt(vd.vault.aggregate?.totalFilledVolume ?? '0') > 0n;
      } catch {
        return false;
      }
    });
  }, [allDetails]);

  /* vault name + color map (only vaults with volume) */
  const vaultColorMap = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    activeDetails.forEach((vd, i) => {
      map.set(vd.vault.manager.rateManagerId, {
        name: vd.vault.manager.name || shortHex(vd.vault.manager.manager),
        color: VAULT_COLORS[i % VAULT_COLORS.length],
      });
    });
    return map;
  }, [activeDetails]);

  /* summary stats */
  const summaryStats = useMemo(() => {
    let totalAUM = 0n;
    let totalDeposits = 0;
    let totalVolume = 0n;
    let totalFees = 0n;
    let totalIntents = 0;

    for (const v of allVaults) {
      try { totalAUM += BigInt(v.aggregate?.currentDelegatedBalance ?? '0'); } catch {}
      totalDeposits += Number(v.aggregate?.currentDelegatedDeposits ?? 0);
      try { totalVolume += BigInt(v.aggregate?.totalFilledVolume ?? '0'); } catch {}
      try { totalFees += BigInt(v.aggregate?.totalFeeAmount ?? '0'); } catch {}
      totalIntents += Number(v.aggregate?.fulfilledIntents ?? 0);
    }

    const fees = allVaults.map((v) => {
      try { return Number(formatUnits(BigInt(v.manager.fee) * 100n, 18)); } catch { return 0; }
    });
    const avgFee = fees.length ? fees.reduce((a, b) => a + b, 0) / fees.length : 0;

    return { totalAUM, totalDeposits, totalVolume, totalFees, totalIntents, avgFee, totalVaults: allVaults.length };
  }, [allVaults]);

  /* routes across all vaults, ranked by how many vaults offer them */
  const allRoutes = useMemo(() => {
    const routeMap = new Map<RouteKey, { pmHash: string; ccyHash: string; label: string; vaultCount: number }>();
    for (const vd of activeDetails) {
      for (const rate of vd.rates) {
        const key = buildRouteKey(rate.paymentMethodHash, rate.currencyCode);
        const existing = routeMap.get(key);
        if (existing) {
          existing.vaultCount++;
        } else {
          const pm = resolvePaymentMethod(rate.paymentMethodHash);
          const ccy = resolveCurrency(rate.currencyCode);
          routeMap.set(key, { pmHash: rate.paymentMethodHash, ccyHash: rate.currencyCode, label: `${pm} / ${ccy}`, vaultCount: 1 });
        }
      }
    }
    // sort by popularity (most vaults offering it)
    return [...routeMap.entries()].sort((a, b) => b[1].vaultCount - a[1].vaultCount);
  }, [activeDetails]);

  /* ── 1. Price strip chart data ───────────────────────────────────── */

  const priceChartData = useMemo(() => {
    if (!activeDetails.length || !allRoutes.length) return [];
    const marketRates = marketRatesQuery.data ?? {};

    return allRoutes.map(([routeKey, routeInfo]) => {
      const ccy = resolveCurrency(routeInfo.ccyHash);
      const marketRate = marketRates[ccy] ? Number(marketRates[ccy]) : null;

      const dots = activeDetails
        .map((vd) => {
          const match = vd.rates.find(
            (r) => buildRouteKey(r.paymentMethodHash, r.currencyCode) === routeKey,
          );
          if (!match) return null;
          const rate = Number(formatUnits(BigInt(match.managerRate), 18));
          const spread = marketRate ? ((rate - marketRate) / marketRate) * 100 : null;
          const vc = vaultColorMap.get(vd.vault.manager.rateManagerId);
          return {
            vaultName: vc?.name ?? shortHex(vd.vault.manager.manager),
            vaultId: vd.vault.manager.rateManagerId,
            color: vc?.color ?? '#888',
            rate,
            spread,
          };
        })
        .filter(Boolean) as Array<{ vaultName: string; vaultId: string; color: string; rate: number; spread: number | null }>;

      dots.sort((a, b) => a.rate - b.rate);

      return { routeKey, label: routeInfo.label, ccy, marketRate, dots, vaultCount: routeInfo.vaultCount };
    });
  }, [activeDetails, allRoutes, marketRatesQuery.data, vaultColorMap]);

  const visiblePriceChart = useMemo(() => {
    const filtered = selectedRoute === 'all'
      ? priceChartData
      : priceChartData.filter((r) => r.routeKey === selectedRoute);

    if (selectedRoute !== 'all' || showAllRoutes) return filtered;
    return filtered.slice(0, TOP_ROUTES);
  }, [priceChartData, selectedRoute, showAllRoutes]);

  const hiddenRouteCount = selectedRoute === 'all' && !showAllRoutes
    ? Math.max(0, priceChartData.length - TOP_ROUTES)
    : 0;

  // global spread range for positioning
  const globalSpreadRange = useMemo(() => {
    let min = 0;
    let max = 5;
    for (const route of priceChartData) {
      for (const dot of route.dots) {
        if (dot.spread !== null) {
          if (dot.spread < min) min = dot.spread;
          if (dot.spread > max) max = dot.spread;
        }
      }
    }
    const padding = (max - min) * 0.1 || 0.5;
    return { min: min - padding, max: max + padding };
  }, [priceChartData]);

  function spreadToPercent(spread: number) {
    const range = globalSpreadRange.max - globalSpreadRange.min;
    if (range === 0) return 50;
    return ((spread - globalSpreadRange.min) / range) * 100;
  }

  /* ── 2. Deposit turnover (delegation → first fill) ──────────────── */

  const turnoverData = useMemo(() => {
    const perVault: Array<{
      vaultId: string;
      vaultName: string;
      turnovers: number[];
      depositCount: number;
      filledCount: number;
    }> = [];

    for (const vd of allDetails) {
      const vaultName = vaultColorMap.get(vd.vault.manager.rateManagerId)?.name ?? '';
      const turnovers: number[] = [];
      let filledCount = 0;

      for (const delegation of vd.delegations) {
        const delegatedMs = parseTimestamp(delegation.delegatedAt);
        if (!delegatedMs) continue;

        // find first fulfilled intent on this deposit
        const depositsIntents = vd.intents
          .filter((i) => i.depositId === delegation.depositId && i.fulfillTimestamp)
          .map((i) => parseTimestamp(i.fulfillTimestamp))
          .filter((t): t is number => t !== null)
          .sort((a, b) => a - b);

        if (depositsIntents.length > 0) {
          filledCount++;
          const firstFill = depositsIntents[0];
          const turnover = firstFill - delegatedMs;
          if (turnover >= 0) turnovers.push(turnover);
        }
      }

      if (vd.delegations.length > 0) {
        perVault.push({
          vaultId: vd.vault.manager.rateManagerId,
          vaultName,
          turnovers,
          depositCount: vd.delegations.length,
          filledCount,
        });
      }
    }

    const allTurnovers = perVault.flatMap((v) => v.turnovers);
    const totalDeposits = perVault.reduce((s, v) => s + v.depositCount, 0);
    const totalFilled = perVault.reduce((s, v) => s + v.filledCount, 0);

    const vaultStats = perVault
      .filter((v) => v.turnovers.length > 0)
      .map((v) => ({
        ...v,
        median: median(v.turnovers),
        p95: percentile(v.turnovers, 95),
        fastest: Math.min(...v.turnovers),
        fillRate: v.depositCount > 0 ? (v.filledCount / v.depositCount) * 100 : 0,
      }))
      .sort((a, b) => a.median - b.median);

    return {
      total: allTurnovers.length,
      totalDeposits,
      totalFilled,
      fillRate: totalDeposits > 0 ? (totalFilled / totalDeposits) * 100 : 0,
      globalMedian: median(allTurnovers),
      globalP95: percentile(allTurnovers, 95),
      globalFastest: allTurnovers.length ? Math.min(...allTurnovers) : 0,
      vaultStats,
    };
  }, [allDetails, vaultColorMap]);

  /* ── 3. APR calculation ───────────────────────────────────────────── */

  const aprData = useMemo(() => {
    const now = Date.now();
    const windowDays = aprWindow === '7d' ? 7 : aprWindow === '30d' ? 30 : 9999;

    return activeDetails.map((vd) => {
      const vault = vd.vault;
      const name = vaultColorMap.get(vault.manager.rateManagerId)?.name ?? '';
      const aum = vault.aggregate?.currentDelegatedBalance ?? '0';
      const feePercent = (() => {
        try { return Number(formatUnits(BigInt(vault.manager.fee) * 100n, 18)); } catch { return 0; }
      })();

      // gross delegated = remaining + outstanding + taken + withdrawn (per deposit)
      let grossDelegated = 0;
      for (const dep of vd.deposits) {
        try {
          const remaining = Number(formatUnits(BigInt(dep.remainingDeposits ?? '0'), 6));
          const outstanding = Number(formatUnits(BigInt(dep.outstandingIntentAmount ?? '0'), 6));
          const taken = Number(formatUnits(BigInt(dep.totalAmountTaken ?? '0'), 6));
          const withdrawn = Number(formatUnits(BigInt(dep.totalWithdrawn ?? '0'), 6));
          grossDelegated += remaining + outstanding + taken + withdrawn;
        } catch {}
      }

      const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
      const windowSnapshots = vd.snapshots.filter((s) => {
        const ts = parseTimestamp(s.dayTimestamp);
        return ts !== null && ts * 1000 >= cutoff;
      });

      // vault age in days (from first snapshot or aggregate firstSeenAt)
      const firstSeen = parseTimestamp(vault.aggregate?.firstSeenAt);
      const vaultAgeDays = firstSeen ? (now - firstSeen) / (1000 * 60 * 60 * 24) : 0;

      // turnover for this vault
      const vaultTurnover = turnoverData.vaultStats.find(
        (v) => v.vaultId === vault.manager.rateManagerId,
      );

      if (windowSnapshots.length === 0) {
        return {
          vaultId: vault.manager.rateManagerId,
          vaultName: name,
          aum,
          grossDelegated,
          feePercent,
          routeCount: vd.rates.length,
          apr: null,
          totalVolume: vault.aggregate?.totalFilledVolume ?? '0',
          totalFees: vault.aggregate?.totalFeeAmount ?? '0',
          totalPnl: vault.aggregate?.totalPnlUsdCents ?? '0',
          fulfilledIntents: vault.aggregate?.fulfilledIntents ?? 0,
          medianTurnover: vaultTurnover?.median ?? null,
          vaultAgeDays,
          windowDays: 0,
          windowVolume: '0',
          windowFees: '0',
          windowPnlCents: '0',
        };
      }

      const windowPnlCents = windowSnapshots.reduce((sum, s) => {
        try { return sum + Number(s.dailyPnlUsdCents); } catch { return sum; }
      }, 0);
      const windowPnlUsd = windowPnlCents / 100;

      const windowVolume = windowSnapshots.reduce((sum, s) => {
        try { return sum + Number(formatUnits(BigInt(s.dailyVolume), 6)); } catch { return sum; }
      }, 0);

      const windowFees = windowSnapshots.reduce((sum, s) => {
        try { return sum + Number(formatUnits(BigInt(s.dailyFees), 6)); } catch { return sum; }
      }, 0);

      const daysActive = windowSnapshots.length;

      // APR = (PnL / gross delegated) * (365 / days)
      const apr = grossDelegated > 0 && daysActive > 0
        ? (windowPnlUsd / grossDelegated) * (365 / daysActive) * 100
        : null;

      return {
        vaultId: vault.manager.rateManagerId,
        vaultName: name,
        aum,
        grossDelegated,
        feePercent,
        routeCount: vd.rates.length,
        apr,
        totalVolume: vault.aggregate?.totalFilledVolume ?? '0',
        totalFees: vault.aggregate?.totalFeeAmount ?? '0',
        totalPnl: vault.aggregate?.totalPnlUsdCents ?? '0',
        fulfilledIntents: vault.aggregate?.fulfilledIntents ?? 0,
        medianTurnover: vaultTurnover?.median ?? null,
        vaultAgeDays,
        windowDays: daysActive,
        windowVolume: Math.round(windowVolume * 1e6).toString(),
        windowFees: Math.round(windowFees * 1e6).toString(),
        windowPnlCents: windowPnlCents.toFixed(0),
      };
    });
  }, [activeDetails, aprWindow, vaultColorMap, turnoverData]);

  const sortedAprData = useMemo(() => {
    const getValue = (row: (typeof aprData)[0]): number => {
      switch (aprSortKey) {
        case 'vault': return 0;
        case 'aum': try { return Number(BigInt(row.aum)); } catch { return 0; }
        case 'grossDelegated': return row.grossDelegated;
        case 'volume': try { return Number(BigInt(row.windowDays > 0 ? row.windowVolume : row.totalVolume)); } catch { return 0; }
        case 'pnl': return Number(row.windowDays > 0 ? row.windowPnlCents : row.totalPnl);
        case 'orders': return row.fulfilledIntents ?? 0;
        case 'turnover': return row.medianTurnover ?? Infinity;
        case 'apr': return row.apr ?? -Infinity;
        default: return row.apr ?? -Infinity;
      }
    };

    const sorted = [...aprData];
    if (aprSortKey === 'vault') {
      sorted.sort((a, b) => a.vaultName.localeCompare(b.vaultName));
      if (aprSortDir === 'desc') sorted.reverse();
    } else {
      sorted.sort((a, b) => {
        const diff = getValue(a) - getValue(b);
        return aprSortDir === 'desc' ? -diff : diff;
      });
    }
    return sorted;
  }, [aprData, aprSortKey, aprSortDir]);

  /* ── 4. Delegator retention ─────────────────────────────────────── */

  const delegatorRetention = useMemo(() => {
    // track depositor addresses across all vaults
    // a "repeat delegator" = same depositor address appears in multiple deposits or multiple vaults
    const globalDepositorDeposits = new Map<string, { vaults: Set<string>; deposits: number; totalDelegated: bigint }>();
    const perVault = new Map<string, { name: string; depositors: Map<string, number> }>();

    for (const vd of allDetails) {
      const vaultName = vaultColorMap.get(vd.vault.manager.rateManagerId)?.name ?? '';
      const vaultId = vd.vault.manager.rateManagerId;
      const vaultDepositors = new Map<string, number>();

      for (const deposit of vd.deposits) {
        const depositor = deposit.depositor?.toLowerCase();
        if (!depositor) continue;

        // per-vault count
        vaultDepositors.set(depositor, (vaultDepositors.get(depositor) ?? 0) + 1);

        // global count
        const global = globalDepositorDeposits.get(depositor) ?? { vaults: new Set(), deposits: 0, totalDelegated: 0n };
        global.vaults.add(vaultId);
        global.deposits++;
        try { global.totalDelegated += BigInt(deposit.remainingDeposits ?? '0'); } catch {}
        globalDepositorDeposits.set(depositor, global);
      }

      if (vaultDepositors.size > 0) {
        perVault.set(vaultId, { name: vaultName, depositors: vaultDepositors });
      }
    }

    const totalDepositors = globalDepositorDeposits.size;
    // repeat = depositor has >1 deposit across any vault, or delegates to multiple vaults
    const repeatDepositors = [...globalDepositorDeposits.values()].filter(
      (d) => d.deposits >= 2 || d.vaults.size >= 2,
    ).length;
    const multiVaultDepositors = [...globalDepositorDeposits.values()].filter(
      (d) => d.vaults.size >= 2,
    ).length;
    const totalDepositCount = [...globalDepositorDeposits.values()].reduce((s, d) => s + d.deposits, 0);
    const avgDepositsPerDepositor = totalDepositors > 0 ? totalDepositCount / totalDepositors : 0;
    const repeatRate = totalDepositors > 0 ? (repeatDepositors / totalDepositors) * 100 : 0;

    // per-vault
    const vaultRetention = [...perVault.entries()]
      .map(([id, { name, depositors }]) => {
        const unique = depositors.size;
        const repeat = [...depositors.values()].filter((c) => c >= 2).length;
        const totalDeps = [...depositors.values()].reduce((a, b) => a + b, 0);
        return {
          vaultId: id,
          vaultName: name,
          uniqueDepositors: unique,
          repeatDepositors: repeat,
          repeatRate: unique > 0 ? (repeat / unique) * 100 : 0,
          totalDeposits: totalDeps,
          avgDeposits: unique > 0 ? totalDeps / unique : 0,
        };
      })
      .sort((a, b) => b.uniqueDepositors - a.uniqueDepositors);

    // top delegators by number of deposits
    const topDelegators = [...globalDepositorDeposits.entries()]
      .sort((a, b) => b[1].deposits - a[1].deposits)
      .slice(0, 10)
      .map(([addr, data]) => ({
        address: addr,
        deposits: data.deposits,
        vaults: data.vaults.size,
        totalDelegated: data.totalDelegated.toString(),
      }));

    return {
      totalDepositors,
      repeatDepositors,
      multiVaultDepositors,
      repeatRate,
      avgDepositsPerDepositor,
      vaultRetention,
      topDelegators,
    };
  }, [allDetails, vaultColorMap]);

  /* ── render ──────────────────────────────────────────────────────── */

  return (
    <main className="shell analytics-shell">
      <header className="header-bar">
        <div className="title-stack">
          <a href="#" style={{ textDecoration: 'none' }}>
            <img src={peerVaultsLogo} alt="Peer Vaults" className="brand-logo" />
          </a>
        </div>
        <div className="header-actions">
          <a href="#" className="button button-secondary button-compact" style={{ textDecoration: 'none' }}>
            Dashboard
          </a>
          <span className="pill pill-success">Analytics</span>
        </div>
      </header>

      {/* ── Summary ────────────────────────────────────────────────── */}
      <section className="card">
        <p className="eyebrow">Protocol Overview</p>
        <h2>Vault Analytics</h2>
        <div className="summary-grid analytics-summary-grid">
          <div>
            <p className="label">Total AUM</p>
            <strong className="stat-value">{formatUsdcFull(summaryStats.totalAUM.toString())}</strong>
          </div>
          <div>
            <p className="label">Total Volume</p>
            <strong className="stat-value">{formatUsdcShort(summaryStats.totalVolume.toString())}</strong>
          </div>
          <div>
            <p className="label">Total Fees</p>
            <strong className="stat-value">{formatUsdcShort(summaryStats.totalFees.toString())}</strong>
          </div>
          <div>
            <p className="label">Fulfilled Orders</p>
            <strong className="stat-value">{summaryStats.totalIntents.toLocaleString()}</strong>
          </div>
          <div>
            <p className="label">Active Vaults</p>
            <strong className="stat-value">{summaryStats.totalVaults}</strong>
          </div>
        </div>
      </section>

      {/* ── Vault APR (Returns) ────────────────────────────────────── */}
      <section className="card">
        <div className="section-head">
          <div>
            <p className="eyebrow">Returns</p>
            <h2>Vault APR</h2>
            <div className="apr-formula-inline">
              <span className="formula-block" style={{ justifyContent: 'flex-start' }}>
                <span style={{ color: 'var(--muted)', marginRight: 8 }}>APR =</span>
                <span className="formula-frac">
                  <span className="formula-num">Realized PnL</span>
                  <span className="formula-den">Gross Delegated</span>
                </span>
                <span className="formula-op">&times;</span>
                <span className="formula-frac">
                  <span className="formula-num">365</span>
                  <span className="formula-den">Days Active</span>
                </span>
              </span>
              <p className="muted" style={{ fontSize: '0.76rem', marginTop: 4 }}>
                Gross Delegated = total capital ever committed to the vault. Idle time naturally reduces APR.
              </p>
            </div>
          </div>
          <div className="section-actions">
            <div className="apr-toggle">
              {(['7d', '30d', 'all'] as const).map((w) => (
                <button
                  key={w}
                  className={`button button-compact ${aprWindow === w ? 'button-primary' : 'button-secondary'}`}
                  onClick={() => setAprWindow(w)}
                >
                  {w === 'all' ? 'All time' : w.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        {isLoading ? (
          <p className="muted">Loading...</p>
        ) : (
          <div className="apr-table">
            <div className="apr-table-head apr-grid">
              {[
                { key: 'vault', label: 'Vault' },
                { key: 'grossDelegated', label: 'Gross Delegated' },
                { key: 'volume', label: 'Volume' },
                { key: 'pnl', label: 'PnL' },
                { key: 'orders', label: 'Orders' },
                { key: 'turnover', label: 'Turnover', hasInfo: 'turnover' as const },
                { key: 'apr', label: 'APR', align: 'right' as const, hasInfo: 'apr' as const },
              ].map((col) => (
                <span
                  key={col.key}
                  className={`editor-head-cell sortable-head${aprSortKey === col.key ? ' sortable-head-active' : ''}`}
                  style={{ textAlign: col.align ?? 'left', cursor: 'pointer', userSelect: 'none' }}
                  onClick={() => toggleAprSort(col.key)}
                >
                  {col.label}
                  {col.hasInfo && (
                    <span
                      className="formula-hint"
                      onClick={(e) => e.stopPropagation()}
                    >
                      ?
                      <span className="formula-tooltip">
                        {col.hasInfo === 'apr' && (
                          <>
                            <span className="formula-title">APR</span>
                            <span className="formula-block">
                              <span className="formula-frac">
                                <span className="formula-num">Realized PnL</span>
                                <span className="formula-den">Gross Delegated</span>
                              </span>
                              <span className="formula-op">&times;</span>
                              <span className="formula-frac">
                                <span className="formula-num">365</span>
                                <span className="formula-den">Days Active</span>
                              </span>
                            </span>
                            <span className="formula-note">Gross Delegated = total capital ever committed. Accounts for idle time and slow turnover.</span>
                          </>
                        )}
                        {col.hasInfo === 'turnover' && (
                          <>
                            <span className="formula-title">Median Turnover</span>
                            <span className="formula-note" style={{ textAlign: 'left' }}>
                              Average time from when a deposit is delegated to this vault until it receives its first fill.
                              Faster turnover means your capital gets put to work sooner.
                            </span>
                          </>
                        )}
                      </span>
                    </span>
                  )}
                  {aprSortKey === col.key ? (aprSortDir === 'desc' ? ' \u25BC' : ' \u25B2') : ''}
                </span>
              ))}
            </div>
            {sortedAprData.length === 0 ? (
              <p className="muted" style={{ padding: 14 }}>No vault data.</p>
            ) : (
              sortedAprData.map((v) => (
                <div key={v.vaultId} className="apr-row apr-grid">
                  <div>
                    <strong>{v.vaultName}</strong>
                    <span className="muted" style={{ fontSize: '0.72rem', display: 'block' }}>
                      Fee: {v.feePercent.toFixed(2)}% &middot; {v.routeCount} routes
                    </span>
                  </div>
                  <div><strong>{formatUsdcShort(Math.round(v.grossDelegated * 1e6).toString())}</strong></div>
                  <div><strong>{formatUsdcShort(v.windowDays > 0 ? v.windowVolume : v.totalVolume)}</strong></div>
                  <div>
                    <strong style={{ color: Number(v.windowDays > 0 ? v.windowPnlCents : v.totalPnl) >= 0 ? '#4ade80' : '#f87171' }}>
                      {formatCentsUsd(v.windowDays > 0 ? v.windowPnlCents : v.totalPnl)}
                    </strong>
                  </div>
                  <div><strong>{v.fulfilledIntents}</strong></div>
                  <div>
                    <strong>{v.medianTurnover != null ? formatMinutes(v.medianTurnover) : '--'}</strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <strong style={{
                      fontSize: '1.1rem',
                      color: v.apr !== null
                        ? v.apr > 10 ? '#4ade80' : v.apr > 0 ? '#facc15' : '#f87171'
                        : 'var(--muted)',
                    }}>
                      {v.apr !== null ? `${v.apr.toFixed(1)}%` : '--'}
                    </strong>
                    {v.windowDays > 0 && (
                      <span className="muted" style={{ fontSize: '0.68rem', display: 'block' }}>
                        {v.windowDays}d data
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      {/* ── 1. Price Strip Chart ───────────────────────────────────── */}
      <section className="card">
        <div className="section-head">
          <div>
            <p className="eyebrow">Competitiveness</p>
            <h2>Price Comparison</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              Each dot is a vault positioned by spread vs. Coinbase mid-market. Top {TOP_ROUTES} routes by popularity.
            </p>
          </div>
          <div className="section-actions">
            <select
              value={selectedRoute}
              onChange={(e) => { setSelectedRoute(e.target.value); setShowAllRoutes(false); }}
              style={{ minWidth: 180 }}
            >
              <option value="all">All routes</option>
              {allRoutes.map(([key, info]) => (
                <option key={key} value={key}>{info.label} ({info.vaultCount})</option>
              ))}
            </select>
          </div>
        </div>

        {isLoading ? (
          <p className="muted">Loading vault rates...</p>
        ) : visiblePriceChart.length === 0 ? (
          <p className="muted">No rate data available.</p>
        ) : (
          <div className="strip-chart">
            {/* vault legend */}
            <div className="strip-vault-legend">
              {[...vaultColorMap.entries()].map(([id, { name, color }]) => (
                <span key={id} className="strip-vault-chip">
                  <span className="strip-vault-swatch" style={{ background: color }} />
                  {name}
                </span>
              ))}
            </div>

            {/* scale */}
            <div className="strip-scale">
              <span>{globalSpreadRange.min.toFixed(1)}%</span>
              <span className="strip-scale-marker">0% (market)</span>
              <span>{globalSpreadRange.max.toFixed(1)}%</span>
            </div>

            {visiblePriceChart.map((route) => (
              <div key={route.routeKey} className="strip-row">
                <div className="strip-label">
                  <strong>{route.label}</strong>
                  <span className="muted" style={{ fontSize: '0.72rem' }}>
                    {route.dots.length} vault{route.dots.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className="strip-track">
                  <div
                    className="strip-zero-line"
                    style={{ left: `${spreadToPercent(0)}%` }}
                  />
                  {route.dots.map((dot) => (
                    <div
                      key={dot.vaultId}
                      className="strip-dot"
                      style={{
                        left: `${spreadToPercent(dot.spread ?? 0)}%`,
                        background: dot.color,
                      }}
                      data-tooltip={`${dot.vaultName}\n${dot.rate.toFixed(4)}  ${dot.spread !== null ? `(${dot.spread >= 0 ? '+' : ''}${dot.spread.toFixed(2)}%)` : ''}`}
                    />
                  ))}
                </div>
              </div>
            ))}

            {hiddenRouteCount > 0 && (
              <button
                className="button button-secondary button-compact"
                onClick={() => setShowAllRoutes(true)}
                style={{ marginTop: 8 }}
              >
                Show {hiddenRouteCount} more route{hiddenRouteCount !== 1 ? 's' : ''}
              </button>
            )}
            {showAllRoutes && selectedRoute === 'all' && priceChartData.length > TOP_ROUTES && (
              <button
                className="button button-secondary button-compact"
                onClick={() => setShowAllRoutes(false)}
                style={{ marginTop: 8 }}
              >
                Collapse
              </button>
            )}
          </div>
        )}
      </section>

      {/* ── 2. Deposit Turnover ────────────────────────────────────── */}
      <section className="card">
        <div className="section-head">
          <div>
            <p className="eyebrow">Performance</p>
            <h2>Deposit Turnover</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              How quickly delegated deposits get their first fill. Median = the middle value when all turnover times are sorted (half are faster, half are slower).
            </p>
          </div>
        </div>

        {isLoading ? (
          <p className="muted">Loading...</p>
        ) : turnoverData.total === 0 ? (
          <div className="placeholder-panel">
            <p className="muted">No deposit turnover data available yet. Deposits need at least one fulfilled intent.</p>
          </div>
        ) : (
          <>
            {turnoverData.vaultStats.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="lifecycle-table">
                  <div className="lifecycle-head" style={{ gridTemplateColumns: 'minmax(140px, 1.5fr) minmax(60px, 0.6fr) minmax(60px, 0.6fr) minmax(80px, 0.7fr) minmax(80px, 0.7fr)' }}>
                    {[
                      { key: 'vault', label: 'Vault' },
                      { key: 'deposits', label: 'Deposits' },
                      { key: 'filled', label: 'Filled' },
                      { key: 'median', label: 'Median' },
                      { key: 'fillRate', label: 'Fill Rate', align: 'right' as const },
                    ].map((col) => (
                      <span
                        key={col.key}
                        className={`editor-head-cell sortable-head${turnoverSortKey === col.key ? ' sortable-head-active' : ''}`}
                        style={{ textAlign: col.align ?? 'left', cursor: 'pointer', userSelect: 'none' }}
                        onClick={() => toggleTurnoverSort(col.key)}
                      >
                        {col.label}
                        {turnoverSortKey === col.key ? (turnoverSortDir === 'desc' ? ' \u25BC' : ' \u25B2') : ''}
                      </span>
                    ))}
                  </div>
                  {[...turnoverData.vaultStats]
                    .sort((a, b) => {
                      let diff = 0;
                      switch (turnoverSortKey) {
                        case 'vault': diff = a.vaultName.localeCompare(b.vaultName); break;
                        case 'deposits': diff = a.depositCount - b.depositCount; break;
                        case 'filled': diff = a.filledCount - b.filledCount; break;
                        case 'median': diff = a.median - b.median; break;
                        case 'fillRate': diff = a.fillRate - b.fillRate; break;
                        default: diff = a.median - b.median;
                      }
                      return turnoverSortDir === 'desc' ? -diff : diff;
                    })
                    .map((v) => (
                    <div key={v.vaultId} className="lifecycle-row" style={{ gridTemplateColumns: 'minmax(140px, 1.5fr) minmax(60px, 0.6fr) minmax(60px, 0.6fr) minmax(80px, 0.7fr) minmax(80px, 0.7fr)' }}>
                      <div><strong>{v.vaultName}</strong></div>
                      <div><strong>{v.depositCount}</strong></div>
                      <div><strong>{v.filledCount}</strong></div>
                      <div><strong>{formatMinutes(v.median)}</strong></div>
                      <div style={{ textAlign: 'right' }}>
                        <strong style={{ color: v.fillRate > 50 ? '#4ade80' : '#facc15' }}>
                          {v.fillRate.toFixed(0)}%
                        </strong>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>

      {/* ── 4. Delegator Retention ─────────────────────────────────── */}
      <section className="card">
        <div className="section-head">
          <div>
            <p className="eyebrow">Delegators</p>
            <h2>Repeat vs One-Off</h2>
            <p className="muted" style={{ marginTop: 6 }}>
              Do depositors delegate once and leave, or come back with more deposits? Tracks unique depositor addresses.
            </p>
          </div>
        </div>

        {isLoading ? (
          <p className="muted">Loading...</p>
        ) : delegatorRetention.totalDepositors === 0 ? (
          <div className="placeholder-panel">
            <p className="muted">No delegator data available yet.</p>
          </div>
        ) : (
          <>
            <div className="delegator-summary" style={{ marginTop: 12 }}>
              <strong>{delegatorRetention.totalDepositors}</strong> unique depositors
              &middot; <strong>{delegatorRetention.repeatDepositors}</strong> repeat ({delegatorRetention.repeatRate.toFixed(0)}%)
              &middot; <strong>{delegatorRetention.multiVaultDepositors}</strong> multi-vault
              &middot; <strong>{delegatorRetention.avgDepositsPerDepositor.toFixed(1)}</strong> avg deposits each
            </div>

            {/* per-vault */}
            {delegatorRetention.vaultRetention.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <h3 style={{ marginBottom: 8 }}>By Vault</h3>
                <div className="lifecycle-table">
                  <div className="lifecycle-head">
                    <span className="editor-head-cell">Vault</span>
                    <span className="editor-head-cell">Depositors</span>
                    <span className="editor-head-cell">Repeat</span>
                    <span className="editor-head-cell">Repeat Rate</span>
                    <span className="editor-head-cell" style={{ textAlign: 'right' }}>Avg Deposits</span>
                  </div>
                  {delegatorRetention.vaultRetention.map((v) => (
                    <div key={v.vaultId} className="lifecycle-row">
                      <div><strong>{v.vaultName}</strong></div>
                      <div><strong>{v.uniqueDepositors}</strong></div>
                      <div><strong>{v.repeatDepositors}</strong></div>
                      <div>
                        <strong style={{ color: v.repeatRate > 20 ? '#4ade80' : v.repeatRate > 5 ? '#facc15' : '#f87171' }}>
                          {v.repeatRate.toFixed(0)}%
                        </strong>
                      </div>
                      <div style={{ textAlign: 'right' }}><strong>{v.avgDeposits.toFixed(1)}</strong></div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* top delegators */}
            {delegatorRetention.topDelegators.length > 0 && (
              <div style={{ marginTop: 20 }}>
                <h3 style={{ marginBottom: 8 }}>Top Delegators</h3>
                <div className="lifecycle-table">
                  <div className="lifecycle-head" style={{ gridTemplateColumns: '36px 1fr minmax(60px, 0.5fr) minmax(60px, 0.5fr) minmax(80px, 0.7fr)' }}>
                    <span className="editor-head-cell">#</span>
                    <span className="editor-head-cell">Address</span>
                    <span className="editor-head-cell">Deposits</span>
                    <span className="editor-head-cell">Vaults</span>
                    <span className="editor-head-cell" style={{ textAlign: 'right' }}>Delegated</span>
                  </div>
                  {delegatorRetention.topDelegators.map((u, i) => (
                    <div key={u.address} className="lifecycle-row" style={{ gridTemplateColumns: '36px 1fr minmax(60px, 0.5fr) minmax(60px, 0.5fr) minmax(80px, 0.7fr)' }}>
                      <div><strong style={{ color: i < 3 ? 'var(--accent-strong)' : 'var(--text)' }}>{i + 1}</strong></div>
                      <div><strong className="mono-value" style={{ fontSize: '0.82rem' }}>{shortHex(u.address)}</strong></div>
                      <div><strong>{u.deposits}</strong></div>
                      <div><strong>{u.vaults}</strong></div>
                      <div style={{ textAlign: 'right' }}><strong>{formatUsdcShort(u.totalDelegated)}</strong></div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
