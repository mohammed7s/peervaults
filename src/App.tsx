import {
  PLATFORM_METADATA,
  Zkp2pClient,
  currencyInfo,
  getPaymentMethodsCatalog,
  getCurrencyCodeFromHash,
  resolveFiatCurrencyBytes32,
  resolvePaymentMethodHash,
} from '@zkp2p/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { startTransition, useEffect, useMemo, useState } from 'react';
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from 'wagmi';
import { base } from 'wagmi/chains';
import { formatUnits, parseAbi, parseEventLogs, type Address, type Hex } from 'viem';
import peerVaultsLogo from './assets/peervaults-logo.svg';
import { appConfig } from './lib/config';
import {
  RATE_MANAGER_ABI,
  applyMarkupPercentToRate,
  formatPercentFromWad,
  formatRate,
  groupQueuedRates,
  percentToWad,
  rateInputToPreciseUnits,
  usdcInputToBaseUnits,
} from './lib/rateManager';
import { fetchVaultMarkups, saveVaultMarkupsRemote } from './lib/vaultMarkups';

type VaultConfig = {
  manager: Address;
  feeRecipient: Address;
  maxFee: bigint;
  fee: bigint;
  minLiquidity: bigint;
  name: string;
  uri: string;
};
type PublicVaultListItem = {
  manager: DiscoveredVault;
  aggregate: {
    currentDelegatedBalance?: string | null;
    currentDelegatedDeposits?: number | string | null;
  } | null;
};

type TxResult = {
  hash: Hex;
  label: string;
};

type PaymentMethodKey = string;
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

type MarketRatesResponse = {
  data?: {
    rates?: Record<string, string>;
  };
};

type RateEditorRow = {
  id: string;
  paymentMethod: PaymentMethodKey | '';
  originalPaymentMethod: PaymentMethodKey | '';
  currencyCode: string;
  originalCurrencyCode: string;
  originalRateInput: string;
  rateInput: string;
  markupPercentInput: string;
  updatedAt?: string;
  isNew: boolean;
  usesMarketPricing: boolean;
};
type ManagedDeposit = {
  id: string;
  depositor: string;
  remainingDeposits: string;
  status: string;
  delegatedAt?: string | null;
  updatedAt?: string | null;
};
type MarketAdjustedRateResult =
  | { ok: true; rateInput: string }
  | { ok: false; error: string };
type VaultMarkupMap = Record<string, string>;
type CreateVaultForm = {
  manager: string;
  feeRecipient: string;
  name: string;
  uri: string;
  feePercent: string;
  maxFeePercent: string;
  minLiquidityUsdc: string;
};

const RATE_MANAGER_CREATED_ABI = parseAbi([
  'event RateManagerCreated(bytes32 indexed rateManagerId, address indexed manager, address indexed feeRecipient, uint256 maxFee, uint256 fee, string name, string uri)',
]);

const paymentMethodCatalog = getPaymentMethodsCatalog(base.id, appConfig.runtimeEnv);
const zelleVariantLabels: Record<string, string> = {
  bofa: 'Bank of America',
  chase: 'Chase',
  citi: 'Citi',
};

function formatPaymentMethodKey(key: string) {
  return key
    .split('-')
    .filter(Boolean)
    .map((segment) => {
      if (segment.length <= 3) return segment.toUpperCase();
      return `${segment[0].toUpperCase()}${segment.slice(1)}`;
    })
    .join(' ');
}

function getPaymentMethodDisplayName(paymentMethod: PaymentMethodKey | '') {
  if (!paymentMethod) return '';

  const normalizedPaymentMethod = paymentMethod.toLowerCase();
  const metadata = PLATFORM_METADATA[normalizedPaymentMethod as keyof typeof PLATFORM_METADATA];
  if (metadata?.displayName) return metadata.displayName;

  if (normalizedPaymentMethod === 'alipay') return 'Alipay';
  if (normalizedPaymentMethod.startsWith('zelle-')) {
    const variant = normalizedPaymentMethod.slice('zelle-'.length);
    return `Zelle (${zelleVariantLabels[variant] ?? formatPaymentMethodKey(variant)})`;
  }

  return formatPaymentMethodKey(normalizedPaymentMethod);
}

const paymentOptions = Object.keys(paymentMethodCatalog)
  .map((key) => ({ key: key as PaymentMethodKey, label: getPaymentMethodDisplayName(key) }))
  .sort((a, b) => a.label.localeCompare(b.label));
const allowedCurrenciesByPaymentMethod = Object.fromEntries(
  Object.entries(paymentMethodCatalog)
    .map(([key, value]) => [
      key as PaymentMethodKey,
      (value.currencies ?? [])
        .map((currencyHash) => getCurrencyCodeFromHash(currencyHash))
        .filter((currencyCode): currencyCode is string => Boolean(currencyCode && currencyCode in currencyInfo))
        .sort(),
    ]),
) as Record<PaymentMethodKey, string[]>;
const currencyOptions = [...new Set(Object.values(allowedCurrenciesByPaymentMethod).flat())].sort();
const defaultCurrency = currencyOptions.includes('USD') ? 'USD' : (currencyOptions[0] ?? 'USD');
const majorCurrencyCodes = ['USD', 'EUR', 'GBP'].filter((currencyCode) => currencyOptions.includes(currencyCode));
const marketRateSourceUrl = 'https://api.coinbase.com/v2/exchange-rates?currency=USDC';
const paymentMethodLookup = new Map(
  paymentOptions.map((option) => [
    resolvePaymentMethodHash(option.key, { env: appConfig.runtimeEnv }).toLowerCase(),
    option,
  ]),
);
const emptyConfigForm = {
  manager: '',
  feeRecipient: '',
  name: '',
  uri: '',
};

function makeCreateVaultForm(address?: string): CreateVaultForm {
  return {
    manager: address ?? '',
    feeRecipient: address ?? '',
    name: '',
    uri: '',
    feePercent: '0.10',
    maxFeePercent: '2.00',
    minLiquidityUsdc: '0',
  };
}

let rateRowCounter = 0;

function shortHex(value?: string) {
  if (!value) return 'Not connected';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function normalizeCurrencyCode(value?: string) {
  if (!value) return '';
  if (value.startsWith('0x')) {
    return getCurrencyCodeFromHash(value) || value;
  }

  return value;
}

function formatUpdatedAt(value?: string) {
  if (!value) return '--';
  const trimmedValue = value.trim();
  const numericValue = Number(trimmedValue);
  const timestamp = Number.isFinite(numericValue) && trimmedValue !== ''
    ? (trimmedValue.length <= 10 ? numericValue * 1000 : numericValue)
    : Date.parse(trimmedValue);
  if (Number.isNaN(timestamp)) return '--';

  const updatedDate = new Date(timestamp);
  const now = new Date();
  const includeYear = updatedDate.getFullYear() !== now.getFullYear();

  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
    ...(includeYear ? { year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(updatedDate);
}

function formatLiquidity(value?: string) {
  if (!value) return '0 USDC';

  try {
    return `${formatUnits(BigInt(value), 6)} USDC`;
  } catch {
    return value;
  }
}

function createRateRow(overrides: Partial<RateEditorRow> = {}): RateEditorRow {
  return {
    id: `rate-row-${rateRowCounter++}`,
    paymentMethod: '',
    originalPaymentMethod: '',
    currencyCode: '',
    originalCurrencyCode: '',
    originalRateInput: '',
    rateInput: '',
    markupPercentInput: '0',
    updatedAt: '',
    isNew: true,
    usesMarketPricing: false,
    ...overrides,
  };
}

function isRowBlank(row: RateEditorRow) {
  return !row.paymentMethod && !row.currencyCode && !row.rateInput.trim() && !row.originalRateInput.trim();
}

function getRateRouteKey(paymentMethod: PaymentMethodKey | '', currencyCode: string) {
  return paymentMethod && currencyCode ? `${paymentMethod}:${currencyCode}` : '';
}

function isAllowedRoute(paymentMethod: PaymentMethodKey | '', currencyCode: string) {
  if (!paymentMethod || !currencyCode) return false;
  return allowedCurrenciesByPaymentMethod[paymentMethod]?.includes(currencyCode) ?? false;
}

function getVaultMarkupStorageKey(vaultId: string) {
  return `peervaults:markups:${vaultId}`;
}

function loadVaultMarkups(vaultId: string): VaultMarkupMap {
  if (!vaultId || typeof window === 'undefined') return {};

  try {
    const rawValue = window.localStorage.getItem(getVaultMarkupStorageKey(vaultId));
    if (!rawValue) return {};
    const parsed = JSON.parse(rawValue) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as VaultMarkupMap) : {};
  } catch {
    return {};
  }
}

function saveVaultMarkups(vaultId: string, markups: VaultMarkupMap) {
  if (!vaultId || typeof window === 'undefined') return;
  window.localStorage.setItem(getVaultMarkupStorageKey(vaultId), JSON.stringify(markups));
}

function sortMarkupEntries(markups: VaultMarkupMap) {
  return Object.fromEntries(Object.entries(markups).sort(([left], [right]) => left.localeCompare(right)));
}

function mergeVaultMarkups(primary: VaultMarkupMap, fallback: VaultMarkupMap) {
  return sortMarkupEntries({
    ...fallback,
    ...primary,
  });
}

function collectPersistedMarkups(rows: RateEditorRow[]) {
  return sortMarkupEntries(
    rows.reduce<VaultMarkupMap>((accumulator, row) => {
      if (!row.paymentMethod || !row.currencyCode) return accumulator;

      accumulator[getRateRouteKey(row.paymentMethod, row.currencyCode)] = row.markupPercentInput || '0';
      return accumulator;
    }, {}),
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const publicClient = usePublicClient({ chainId: base.id });
  const { data: walletClient } = useWalletClient();
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending: isConnectPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const primaryConnector = connectors[0];

  const [selectedVaultId, setSelectedVaultId] = useState<Hex | ''>(appConfig.vaultId);
  const [configForm, setConfigForm] = useState(emptyConfigForm);
  const [createVaultForm, setCreateVaultForm] = useState<CreateVaultForm>(makeCreateVaultForm());
  const [feeInput, setFeeInput] = useState('0.10');
  const [rateRows, setRateRows] = useState<RateEditorRow[]>([
    createRateRow({ currencyCode: defaultCurrency }),
  ]);
  const [showCreateVault, setShowCreateVault] = useState(false);
  const [showVaultSettings, setShowVaultSettings] = useState(false);
  const [txMessage, setTxMessage] = useState('');

  const client = useMemo(() => {
    if (!walletClient) return null;

    return new Zkp2pClient({
      walletClient,
      chainId: base.id,
      runtimeEnv: appConfig.runtimeEnv,
    });
  }, [walletClient]);

  const readOnlyClient = useMemo(
    () =>
      new Zkp2pClient({
        chainId: base.id,
        runtimeEnv: appConfig.runtimeEnv,
        rpcUrl: appConfig.rpcUrl,
      } as ConstructorParameters<typeof Zkp2pClient>[0]),
    [],
  );

  const vaultsQuery = useQuery({
    queryKey: ['vaults-by-manager', address, appConfig.runtimeEnv],
    enabled: Boolean(client && address),
    queryFn: async () => {
      const result = await client!.indexer.getRateManagers(
        { limit: 20, orderBy: 'createdAt', orderDirection: 'desc' },
        { manager: address! },
      );

      return result.map((item) => item.manager as DiscoveredVault);
    },
  });

  const publicVaultsQuery = useQuery({
    queryKey: ['public-vaults', appConfig.runtimeEnv],
    enabled: !isConnected,
    queryFn: async () => {
      const result = await readOnlyClient.indexer.getRateManagers({
        limit: 6,
        orderBy: 'currentDelegatedBalance',
        orderDirection: 'desc',
      });

      return result as PublicVaultListItem[];
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const selectedVault = useMemo(
    () => vaultsQuery.data?.find((vault) => vault.rateManagerId === selectedVaultId) ?? null,
    [selectedVaultId, vaultsQuery.data],
  );

  const activeVaultId = selectedVault?.rateManagerId ?? selectedVaultId;
  const activeRateManagerAddress = selectedVault?.rateManagerAddress ?? appConfig.rateManagerAddress;

  const vaultConfigQuery = useQuery({
    queryKey: ['vault-config', activeVaultId, activeRateManagerAddress],
    enabled: Boolean(publicClient && activeVaultId),
    queryFn: async () => {
      const result = await publicClient!.readContract({
        address: activeRateManagerAddress,
        abi: RATE_MANAGER_ABI,
        functionName: 'getRateManager',
        args: [activeVaultId as Hex],
      });

      return result as VaultConfig;
    },
  });

  const vaultDetailQuery = useQuery({
    queryKey: ['vault-detail', activeVaultId, activeRateManagerAddress],
    enabled: Boolean(client && activeVaultId),
    queryFn: async () =>
      client!.indexer.getRateManagerDetail(activeVaultId as Hex, {
        rateManagerAddress: activeRateManagerAddress,
      }),
  });

  const vaultMarkupsQuery = useQuery({
    queryKey: ['vault-markups', activeVaultId],
    enabled: Boolean(activeVaultId),
    queryFn: async () => fetchVaultMarkups(activeVaultId as Hex),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const marketRatesQuery = useQuery({
    queryKey: ['coinbase-market-rates'],
    queryFn: async () => {
      const response = await fetch(marketRateSourceUrl);
      if (!response.ok) {
        throw new Error(`Coinbase market feed failed with ${response.status}.`);
      }

      const payload = (await response.json()) as MarketRatesResponse;
      if (!payload.data?.rates) {
        throw new Error('Coinbase market feed did not return rates.');
      }

      return {
        rates: payload.data.rates,
        fetchedAt: Date.now(),
      };
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const managedDepositsQuery = useQuery({
    queryKey: ['managed-deposits', activeVaultId],
    enabled: Boolean(client && activeVaultId),
    queryFn: async () => {
      const delegations = await client!.indexer.getRateManagerDelegations(activeVaultId as Hex, {
        limit: 100,
      });
      if (delegations.length === 0) {
        return [] as ManagedDeposit[];
      }

      const depositIds = delegations.map((delegation) => delegation.depositId);
      const deposits = await client!.indexer.getDepositsByIdsWithRelations(depositIds, {
        includeIntents: false,
      });
      const depositMap = new Map(deposits.map((deposit) => [deposit.id, deposit]));

      return delegations.flatMap((delegation) => {
        const deposit = depositMap.get(delegation.depositId);
        if (!deposit) return [];

        return [
          {
            id: delegation.depositId,
            depositor: deposit.depositor,
            remainingDeposits: deposit.remainingDeposits,
            status: deposit.status,
            delegatedAt: delegation.delegatedAt,
            updatedAt: deposit.updatedAt,
          } satisfies ManagedDeposit,
        ];
      });
    },
  });

  useEffect(() => {
    if (isConnected) return;

    setSelectedVaultId('');
    setConfigForm(emptyConfigForm);
    setCreateVaultForm(makeCreateVaultForm());
    setFeeInput('0.10');
    setRateRows([createRateRow({ currencyCode: defaultCurrency })]);
    setShowCreateVault(false);
    setShowVaultSettings(false);
    setTxMessage('');
    queryClient.removeQueries({ queryKey: ['vault-config'] });
    queryClient.removeQueries({ queryKey: ['vault-detail'] });
    queryClient.removeQueries({ queryKey: ['vaults-by-manager'] });
  }, [isConnected, queryClient]);

  useEffect(() => {
    if (!vaultsQuery.data) return;

    if (selectedVaultId && vaultsQuery.data.some((vault) => vault.rateManagerId === selectedVaultId)) {
      return;
    }

    if (vaultsQuery.data.length === 0) {
      setSelectedVaultId(appConfig.vaultId);
      return;
    }

    const fallbackVault = vaultsQuery.data.find((vault) => vault.rateManagerId === appConfig.vaultId);
    setSelectedVaultId((fallbackVault ?? vaultsQuery.data[0]).rateManagerId);
  }, [selectedVaultId, vaultsQuery.data]);

  useEffect(() => {
    setCreateVaultForm((current) => {
      if (!address) return current;
      return {
        ...current,
        manager: current.manager || address,
        feeRecipient: current.feeRecipient || address,
      };
    });
  }, [address]);

  useEffect(() => {
    if (!vaultConfigQuery.data) return;

    setFeeInput(formatUnits(vaultConfigQuery.data.fee * 100n, 18));
    setConfigForm({
      manager: vaultConfigQuery.data.manager,
      feeRecipient: vaultConfigQuery.data.feeRecipient,
      name: vaultConfigQuery.data.name,
      uri: vaultConfigQuery.data.uri,
    });
  }, [vaultConfigQuery.data]);

  useEffect(() => {
    if (!activeVaultId || !vaultMarkupsQuery.data) return;
    saveVaultMarkups(activeVaultId, vaultMarkupsQuery.data.markups);
  }, [activeVaultId, vaultMarkupsQuery.data]);

  useEffect(() => {
    const rates = vaultDetailQuery.data?.rates ?? [];
    const persistedMarkups = activeVaultId
      ? mergeVaultMarkups(vaultMarkupsQuery.data?.markups ?? {}, loadVaultMarkups(activeVaultId))
      : {};
    if (!activeVaultId) {
      setRateRows([createRateRow({ currencyCode: defaultCurrency })]);
      return;
    }

    if (vaultMarkupsQuery.isPending) {
      return;
    }

    if (rates.length === 0) {
      setRateRows([createRateRow({ currencyCode: defaultCurrency })]);
      return;
    }

    setRateRows(
      rates
        .map((rate) => {
          const option = paymentMethodLookup.get(rate.paymentMethodHash.toLowerCase());
          if (!option) return null;
          const candidate = rate as { currencyCode?: string; currency?: string };
          const normalizedCurrencyCode =
            normalizeCurrencyCode(candidate.currencyCode) || normalizeCurrencyCode(candidate.currency);

          return createRateRow({
            paymentMethod: option.key,
            originalPaymentMethod: option.key,
            currencyCode: normalizedCurrencyCode,
            originalCurrencyCode: normalizedCurrencyCode,
            originalRateInput: formatRate(BigInt(rate.managerRate)),
            rateInput: formatRate(BigInt(rate.managerRate)),
            markupPercentInput: persistedMarkups[getRateRouteKey(option.key, normalizedCurrencyCode)] ?? '0',
            updatedAt: rate.updatedAt,
            isNew: false,
            usesMarketPricing: false,
          });
        })
        .filter((row): row is RateEditorRow => Boolean(row))
        .sort((a, b) => {
          const aLabel = getPaymentMethodDisplayName(a.paymentMethod);
          const bLabel = getPaymentMethodDisplayName(b.paymentMethod);
          const paymentSort = aLabel.localeCompare(bLabel);
          if (paymentSort !== 0) return paymentSort;
          return a.currencyCode.localeCompare(b.currencyCode);
        }),
    );
  }, [activeVaultId, vaultDetailQuery.data?.rates, vaultMarkupsQuery.data, vaultMarkupsQuery.isPending]);

  const connectedIsManager = Boolean(
    address &&
      vaultConfigQuery.data?.manager &&
      address.toLowerCase() === vaultConfigQuery.data.manager.toLowerCase(),
  );

  const pendingRateRows = useMemo(
    () =>
      rateRows.filter((row) => {
        const routeChanged =
          row.paymentMethod !== row.originalPaymentMethod || row.currencyCode !== row.originalCurrencyCode;
        const priceChanged = row.rateInput.trim() !== '' && row.rateInput.trim() !== row.originalRateInput.trim();
        return routeChanged || priceChanged;
      }),
    [rateRows],
  );

  const rateValidationError = useMemo(() => {
    const seen = new Set<string>();

    for (const row of rateRows) {
      const hasAnyValue = Boolean(row.paymentMethod || row.currencyCode || row.rateInput.trim());
      if (!hasAnyValue) {
        continue;
      }

      if (!row.paymentMethod || !row.currencyCode || !row.rateInput.trim()) {
        return 'Every added row needs a method, currency, and price.';
      }

      if (!isAllowedRoute(row.paymentMethod, row.currencyCode)) {
        return `${getPaymentMethodDisplayName(row.paymentMethod)} does not support ${row.currencyCode} on Peer.xyz.`;
      }

      const key = `${row.paymentMethod}:${row.currencyCode}`;
      if (seen.has(key)) {
        return 'Each payment method and currency pair can only appear once.';
      }
      seen.add(key);
    }

    for (const row of pendingRateRows) {
      try {
        rateInputToPreciseUnits(row.rateInput);
        percentToWad(row.markupPercentInput || '0');
      } catch (error) {
        return error instanceof Error ? error.message : 'One of the rates is invalid.';
      }
    }

    return '';
  }, [pendingRateRows, rateRows]);

  async function confirmTx({ hash, label }: TxResult) {
    if (!publicClient) return;

    await publicClient.waitForTransactionReceipt({ hash });

    let remotePersistenceWarning = '';

    if (activeVaultId) {
      const nextMarkups = collectPersistedMarkups(rateRows);

      saveVaultMarkups(activeVaultId, nextMarkups);

      try {
        await saveVaultMarkupsRemote(activeVaultId, nextMarkups);
      } catch (error) {
        remotePersistenceWarning =
          error instanceof Error
            ? ` Saved onchain, but could not persist markups remotely: ${error.message}`
            : ' Saved onchain, but could not persist markups remotely.';
      }
    }

    startTransition(() => {
      void queryClient.invalidateQueries({ queryKey: ['vault-config', activeVaultId] });
      void queryClient.invalidateQueries({ queryKey: ['vault-detail', activeVaultId] });
      void queryClient.invalidateQueries({ queryKey: ['vault-markups', activeVaultId] });
      void queryClient.invalidateQueries({ queryKey: ['vaults-by-manager', address, appConfig.runtimeEnv] });
      setTxMessage(`${label}: ${hash}.${remotePersistenceWarning}`);
    });
  }

  function updateRateRow(id: string, updates: Partial<RateEditorRow>) {
    setRateRows((current) => current.map((row) => (row.id === id ? { ...row, ...updates } : row)));
  }

  function getMarketAdjustedRate(
    row: Pick<RateEditorRow, 'currencyCode' | 'markupPercentInput'>,
    rates?: Record<string, string>,
  ): MarketAdjustedRateResult {
    if (!row.currencyCode) {
      return { ok: false, error: 'Choose a currency first.' };
    }

    const marketRate = rates?.[row.currencyCode];
    if (!marketRate) {
      return { ok: false, error: `No Coinbase USDC rate found for ${row.currencyCode}.` };
    }

    try {
      return {
        ok: true,
        rateInput: applyMarkupPercentToRate(marketRate, row.markupPercentInput || '0'),
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Could not calculate market rate.',
      };
    }
  }

  function updateMarkupForRow(id: string, markupPercentInput: string) {
    setRateRows((current) =>
      current.map((row) => {
        if (row.id !== id) return row;

        const nextRow = { ...row, markupPercentInput };
        if (!row.usesMarketPricing) {
          return nextRow;
        }

        const adjusted = getMarketAdjustedRate(nextRow, marketRatesQuery.data?.rates);
        if (!adjusted.ok) {
          return nextRow;
        }

        return {
          ...nextRow,
          rateInput: adjusted.rateInput,
        };
      }),
    );
  }

  function discardRateChanges() {
    const rates = vaultDetailQuery.data?.rates ?? [];
    const persistedMarkups = activeVaultId
      ? mergeVaultMarkups(vaultMarkupsQuery.data?.markups ?? {}, loadVaultMarkups(activeVaultId))
      : {};

    if (!activeVaultId || rates.length === 0) {
      setRateRows([createRateRow({ currencyCode: defaultCurrency })]);
      setTxMessage('Discarded unsaved changes.');
      return;
    }

    setRateRows(
      rates
        .map((rate) => {
          const option = paymentMethodLookup.get(rate.paymentMethodHash.toLowerCase());
          if (!option) return null;
          const candidate = rate as { currencyCode?: string; currency?: string };
          const normalizedCurrencyCode =
            normalizeCurrencyCode(candidate.currencyCode) || normalizeCurrencyCode(candidate.currency);

          return createRateRow({
            paymentMethod: option.key,
            originalPaymentMethod: option.key,
            currencyCode: normalizedCurrencyCode,
            originalCurrencyCode: normalizedCurrencyCode,
            originalRateInput: formatRate(BigInt(rate.managerRate)),
            rateInput: formatRate(BigInt(rate.managerRate)),
            markupPercentInput: persistedMarkups[getRateRouteKey(option.key, normalizedCurrencyCode)] ?? '0',
            updatedAt: rate.updatedAt,
            isNew: false,
            usesMarketPricing: false,
          });
        })
        .filter((row): row is RateEditorRow => Boolean(row))
        .sort((a, b) => {
          const aLabel = getPaymentMethodDisplayName(a.paymentMethod);
          const bLabel = getPaymentMethodDisplayName(b.paymentMethod);
          const paymentSort = aLabel.localeCompare(bLabel);
          if (paymentSort !== 0) return paymentSort;
          return a.currencyCode.localeCompare(b.currencyCode);
        }),
    );

    setTxMessage('Discarded unsaved changes.');
  }

  function addRateRow() {
    setRateRows((current) => [...current, createRateRow()]);
  }

  function addAllRouteRows() {
    const allPairs = paymentOptions.flatMap((paymentOption) =>
      (allowedCurrenciesByPaymentMethod[paymentOption.key] ?? []).map((currencyCode) => ({
        paymentMethod: paymentOption.key,
        currencyCode,
      })),
    );

    appendRouteRows(allPairs, 'Added {count} missing {label} to the price book.', 'All available routes are already in the price book.');
  }

  function addMajorRouteRows() {
    const majorPairs = paymentOptions.flatMap((paymentOption) =>
      (allowedCurrenciesByPaymentMethod[paymentOption.key] ?? [])
        .filter((currencyCode) => majorCurrencyCodes.includes(currencyCode))
        .map((currencyCode) => ({
          paymentMethod: paymentOption.key,
          currencyCode,
        })),
    );

    appendRouteRows(
      majorPairs,
      'Added {count} missing major {label} to the price book.',
      'All major routes are already in the price book.',
    );
  }

  function appendRouteRows(
    pairs: Array<{ paymentMethod: PaymentMethodKey; currencyCode: string }>,
    successTemplate: string,
    emptyMessage: string,
  ) {
    const existingKeys = new Set(
      rateRows
        .filter((row) => row.paymentMethod && row.currencyCode)
        .map((row) => `${row.paymentMethod}:${row.currencyCode}`),
    );
    const addedCount = pairs.filter(
      ({ paymentMethod, currencyCode }) => !existingKeys.has(`${paymentMethod}:${currencyCode}`),
    ).length;

    setRateRows((current) => {
      const existingKeys = new Set(
        current
          .filter((row) => row.paymentMethod && row.currencyCode)
          .map((row) => `${row.paymentMethod}:${row.currencyCode}`),
      );

      const rowsToAdd = pairs
        .filter(({ paymentMethod, currencyCode }) => !existingKeys.has(`${paymentMethod}:${currencyCode}`))
        .map(({ paymentMethod, currencyCode }) =>
          createRateRow({
            paymentMethod,
            currencyCode,
          }),
        );

      const baseRows = current.filter((row) => !isRowBlank(row));
      return rowsToAdd.length > 0 ? [...baseRows, ...rowsToAdd] : baseRows.length > 0 ? baseRows : current;
    });

    setTxMessage(
      addedCount > 0
        ? successTemplate
            .replace('{count}', String(addedCount))
            .replace('{label}', addedCount === 1 ? 'route' : 'routes')
        : emptyMessage,
    );
  }

  async function copyToClipboard(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setTxMessage(`${label} copied.`);
    } catch {
      setTxMessage(`Could not copy ${label.toLowerCase()}.`);
    }
  }

  function resetRateRow(id: string) {
    setRateRows((current) =>
      current.flatMap((row) => {
        if (row.id !== id) return [row];
        if (row.isNew) return [];

        return [
          {
            ...row,
            paymentMethod: row.originalPaymentMethod,
            currencyCode: row.originalCurrencyCode,
            markupPercentInput: '0',
            rateInput: row.originalRateInput,
            usesMarketPricing: false,
          },
        ];
      }),
    );
  }

  function deleteRateRow(id: string) {
    setRateRows((current) =>
      current.flatMap((row) => {
        if (row.id !== id) return [row];
        if (row.isNew) return [];

        return [
          {
            ...row,
            rateInput: '0',
            markupPercentInput: '0',
            usesMarketPricing: false,
          },
        ];
      }),
    );
  }

  function deleteAllPrices() {
    setRateRows((current) => {
      const existingRows = current
        .filter((row) => !row.isNew)
        .map((row) => ({
          ...row,
          rateInput: '0',
          markupPercentInput: '0',
          usesMarketPricing: false,
        }));

      return existingRows.length > 0 ? existingRows : [createRateRow({ currencyCode: defaultCurrency })];
    });

    setTxMessage('All existing prices staged for deletion. Click Update prices to send zero rates onchain.');
  }

  function fillRowFromMarket(id: string) {
    const row = rateRows.find((item) => item.id === id);
    if (!row) return;
    const adjusted = getMarketAdjustedRate(row, marketRatesQuery.data?.rates);
    if (!adjusted.ok) {
      setTxMessage(adjusted.error);
      return;
    }

    updateRateRow(id, {
      rateInput: adjusted.rateInput,
      usesMarketPricing: true,
    });
  }

  async function fillAllRowsFromMarket() {
    const result = await marketRatesQuery.refetch();
    const rates = result.data?.rates ?? marketRatesQuery.data?.rates;
    if (!rates) {
      setTxMessage('Could not load market prices.');
      return;
    }

    let updatedCount = 0;
    let skippedCount = 0;

    setRateRows((current) =>
      current.map((row) => {
        if (row.isNew && !row.paymentMethod && !row.currencyCode) {
          return row;
        }

        const adjusted = getMarketAdjustedRate(row, rates);
        if (!adjusted.ok) {
          skippedCount += 1;
          return row;
        }

        updatedCount += 1;
        return {
          ...row,
          rateInput: adjusted.rateInput,
          usesMarketPricing: true,
        };
      }),
    );

    if (updatedCount === 0) {
      setTxMessage('No rows could be updated from market.');
      return;
    }

    setTxMessage(
      skippedCount > 0
        ? `Updated ${updatedCount} ${updatedCount === 1 ? 'price' : 'prices'} from market. Skipped ${skippedCount}.`
        : `Updated ${updatedCount} ${updatedCount === 1 ? 'price' : 'prices'} from market.`,
    );
  }

  const saveRatesMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error('Connect the manager wallet first.');
      if (!activeVaultId) throw new Error('No vault selected.');
      if (pendingRateRows.length === 0) throw new Error('No rate changes to save.');
      if (rateValidationError) throw new Error(rateValidationError);

      const queuedRateMap = new Map<string, { paymentMethodHash: Hex; currencyHash: Hex; rate: bigint }>();

      for (const row of pendingRateRows) {
        if (!row.paymentMethod || !row.currencyCode) {
          throw new Error('Method and currency are required.');
        }

        const routeChanged =
          row.paymentMethod !== row.originalPaymentMethod || row.currencyCode !== row.originalCurrencyCode;

        if (!row.isNew && routeChanged && row.originalPaymentMethod && row.originalCurrencyCode) {
          const originalPaymentMethodHash = resolvePaymentMethodHash(row.originalPaymentMethod, {
            env: appConfig.runtimeEnv,
          });
          const originalCurrencyHash = resolveFiatCurrencyBytes32(row.originalCurrencyCode);
          queuedRateMap.set(`${originalPaymentMethodHash}:${originalCurrencyHash}`, {
            paymentMethodHash: originalPaymentMethodHash,
            currencyHash: originalCurrencyHash,
            rate: 0n,
          });
        }

        const paymentMethodHash = resolvePaymentMethodHash(row.paymentMethod, { env: appConfig.runtimeEnv });
        const currencyHash = resolveFiatCurrencyBytes32(row.currencyCode);
        queuedRateMap.set(`${paymentMethodHash}:${currencyHash}`, {
          paymentMethodHash,
          currencyHash,
          rate: rateInputToPreciseUnits(row.rateInput),
        });
      }

      const queuedRates = [...queuedRateMap.values()];

      if (queuedRates.length === 1) {
        const row = pendingRateRows[0];
        const item = queuedRates[0];
        const hash = await client.setVaultMinRate({
          rateManagerId: activeVaultId as Hex,
          paymentMethodHash: item.paymentMethodHash,
          currencyHash: item.currencyHash,
          rate: item.rate,
        });

        return {
          hash,
          label: row.paymentMethod ? `${getPaymentMethodDisplayName(row.paymentMethod)} / ${row.currencyCode} saved` : 'Rate saved',
        };
      }

      const grouped = groupQueuedRates(queuedRates);

      const hash = await client.setVaultMinRatesBatch({
        rateManagerId: activeVaultId as Hex,
        paymentMethods: grouped.paymentMethods,
        currencies: grouped.currencies,
        rates: grouped.rates,
      });

      return { hash, label: `${pendingRateRows.length} rates saved` };
    },
    onSuccess: confirmTx,
    onError: (error: unknown) => setTxMessage(error instanceof Error ? error.message : 'Saving rates failed'),
  });

  const feeMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error('Connect the manager wallet first.');
      if (!activeVaultId) throw new Error('No vault selected.');

      const hash = await client.setVaultFee({
        rateManagerId: activeVaultId as Hex,
        newFee: percentToWad(feeInput),
      });

      return { hash, label: 'Fee saved' };
    },
    onSuccess: confirmTx,
    onError: (error: unknown) => setTxMessage(error instanceof Error ? error.message : 'Fee update failed'),
  });

  const configMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error('Connect the manager wallet first.');
      if (!activeVaultId) throw new Error('No vault selected.');

      const hash = await client.setVaultConfig({
        rateManagerId: activeVaultId as Hex,
        newManager: configForm.manager as Address,
        newFeeRecipient: configForm.feeRecipient as Address,
        newName: configForm.name,
        newUri: configForm.uri,
      });

      return { hash, label: 'Vault settings saved' };
    },
    onSuccess: confirmTx,
    onError: (error: unknown) => setTxMessage(error instanceof Error ? error.message : 'Settings update failed'),
  });

  const createVaultMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error('Connect the manager wallet first.');
      if (!publicClient) throw new Error('Public client unavailable.');
      if (!createVaultForm.name.trim()) throw new Error('Vault name is required.');
      if (!createVaultForm.uri.trim()) throw new Error('Vault URI is required.');
      if (!createVaultForm.manager.trim()) throw new Error('Manager address is required.');
      if (!createVaultForm.feeRecipient.trim()) throw new Error('Fee recipient is required.');

      const fee = percentToWad(createVaultForm.feePercent);
      const maxFee = percentToWad(createVaultForm.maxFeePercent);
      if (fee > maxFee) {
        throw new Error('Fee cannot be greater than max fee.');
      }

      const hash = await client.createRateManager({
        config: {
          manager: createVaultForm.manager as Address,
          feeRecipient: createVaultForm.feeRecipient as Address,
          fee,
          maxFee,
          minLiquidity: usdcInputToBaseUnits(createVaultForm.minLiquidityUsdc),
          name: createVaultForm.name.trim(),
          uri: createVaultForm.uri.trim(),
        },
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const events = parseEventLogs({
        abi: RATE_MANAGER_CREATED_ABI,
        eventName: 'RateManagerCreated',
        logs: receipt.logs,
        strict: false,
      });
      const createdId = events[0]?.args.rateManagerId as Hex | undefined;

      return { hash, createdId };
    },
    onSuccess: async ({ hash, createdId }) => {
      await queryClient.invalidateQueries({ queryKey: ['vaults-by-manager', address, appConfig.runtimeEnv] });
      setTxMessage(createdId ? `Vault created: ${createdId}` : `Vault created: ${hash}`);
      setShowCreateVault(false);
      setCreateVaultForm(makeCreateVaultForm(address));
      if (createdId) {
        setSelectedVaultId(createdId);
      }
    },
    onError: (error: unknown) =>
      setTxMessage(error instanceof Error ? error.message : 'Vault creation failed'),
  });

  return (
    <main className="shell">
      <header className="header-bar">
        <div className="title-stack">
          <img src={peerVaultsLogo} alt="Peer Vaults" className="brand-logo" />
        </div>
        <div className="header-actions">
          {isConnected ? (
            <>
              <span className="wallet-chip">{shortHex(address)}</span>
              {chainId !== base.id ? (
                <button className="button button-primary" onClick={() => switchChain({ chainId: base.id })}>
                  Switch to Base
                </button>
              ) : null}
              <button className="button button-secondary" onClick={() => disconnect()}>
                Disconnect
              </button>
            </>
          ) : (
            <button
              className="button button-primary"
              onClick={() => primaryConnector && connect({ connector: primaryConnector, chainId: base.id })}
              disabled={isConnectPending || !primaryConnector}
            >
              Connect Wallet
            </button>
          )}
        </div>
      </header>

      {!isConnected ? (
        <>
          <section className="card simple-card">
            <h2>Vault manager dashboard</h2>
            <p className="muted">
              Peer Vaults is a management dashboard for Peer.xyz vault managers. Connect the manager wallet to review
              delegated deposits, update rates, and manage vault settings from one place.
            </p>
          </section>

          <section className="card docs-card">
            <div className="section-head">
              <div>
                <p className="eyebrow">Docs</p>
                <h2>How to use</h2>
              </div>
            </div>
            <div className="docs-list">
              <p className="muted">
                To use this dashboard, you need the actual manager wallet in a standard browser wallet. If the vault is
                managed by a Privy wallet inside Peer.xyz, export that wallet&apos;s private key and import it into a wallet
                like MetaMask first.
              </p>
              <p className="muted">
                Once connected on Base, the app will find vaults managed by that wallet, let you update prices, and
                edit vault settings.
              </p>
              <p className="muted">You also need a small amount of Base ETH in the connected manager wallet for gas.</p>
              <a
                className="link-chip docs-link"
                href="https://github.com/mohammed7s/peervaults"
                target="_blank"
                rel="noreferrer"
              >
                View GitHub
              </a>
            </div>
          </section>

          <section className="card">
            <div className="section-head">
              <div>
                <p className="eyebrow">Network</p>
                <h2>Active vaults</h2>
              </div>
            </div>
            {publicVaultsQuery.isLoading ? (
              <p className="muted">Loading public vaults...</p>
            ) : publicVaultsQuery.error ? (
              <p className="error-text">{(publicVaultsQuery.error as Error).message}</p>
            ) : publicVaultsQuery.data && publicVaultsQuery.data.length > 0 ? (
              <div className="deposit-table">
                {publicVaultsQuery.data.map((vault) => (
                  <div key={vault.manager.rateManagerId} className="deposit-row">
                    <div>
                      <p className="label">Vault</p>
                      <strong>{vault.manager.name || 'Untitled vault'}</strong>
                    </div>
                    <div>
                      <p className="label">Manager</p>
                      <strong className="mono-value">{shortHex(vault.manager.manager)}</strong>
                    </div>
                    <div>
                      <p className="label">Liquidity</p>
                      <strong>{formatLiquidity(vault.aggregate?.currentDelegatedBalance ?? '0')}</strong>
                    </div>
                    <div>
                      <p className="label">Deposits</p>
                      <strong>{String(vault.aggregate?.currentDelegatedDeposits ?? 0)}</strong>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">No public vaults found.</p>
            )}
          </section>
        </>
      ) : vaultsQuery.isLoading ? (
        <section className="card simple-card">
          <h2>Loading vaults...</h2>
        </section>
      ) : vaultsQuery.error ? (
        <section className="card simple-card">
          <p className="error-text">{(vaultsQuery.error as Error).message}</p>
        </section>
      ) : !vaultsQuery.data || vaultsQuery.data.length === 0 ? (
        <section className="card">
          <div className="summary-head">
            <div>
              <p className="eyebrow">Create</p>
              <h2>Create your first vault</h2>
            </div>
          </div>
          <p className="muted">This wallet does not manage any vaults yet. Deploy one from here.</p>
          <div className="vault-settings-grid create-vault-grid">
            <section className="subcard">
              <div className="subcard-head">
                <h3>Vault</h3>
              </div>
              <label>
                <span>Name</span>
                <input
                  value={createVaultForm.name}
                  onChange={(event) => setCreateVaultForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="Peer Vaults Alpha"
                />
              </label>
              <label>
                <span>URI</span>
                <input
                  value={createVaultForm.uri}
                  onChange={(event) => setCreateVaultForm((current) => ({ ...current, uri: event.target.value }))}
                  placeholder="https://..."
                />
              </label>
              <label>
                <span>Manager</span>
                <input
                  value={createVaultForm.manager}
                  onChange={(event) => setCreateVaultForm((current) => ({ ...current, manager: event.target.value }))}
                />
              </label>
              <label>
                <span>Fee recipient</span>
                <input
                  value={createVaultForm.feeRecipient}
                  onChange={(event) =>
                    setCreateVaultForm((current) => ({ ...current, feeRecipient: event.target.value }))
                  }
                />
              </label>
            </section>
            <section className="subcard">
              <div className="subcard-head">
                <h3>Pricing</h3>
              </div>
              <label>
                <span>Fee %</span>
                <input
                  value={createVaultForm.feePercent}
                  onChange={(event) =>
                    setCreateVaultForm((current) => ({ ...current, feePercent: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>Max fee %</span>
                <input
                  value={createVaultForm.maxFeePercent}
                  onChange={(event) =>
                    setCreateVaultForm((current) => ({ ...current, maxFeePercent: event.target.value }))
                  }
                />
              </label>
              <label>
                <span>Min liquidity USDC</span>
                <input
                  value={createVaultForm.minLiquidityUsdc}
                  onChange={(event) =>
                    setCreateVaultForm((current) => ({ ...current, minLiquidityUsdc: event.target.value }))
                  }
                />
              </label>
              <button
                className="button button-primary"
                disabled={createVaultMutation.isPending}
                onClick={() => createVaultMutation.mutate()}
              >
                {createVaultMutation.isPending ? 'Deploying...' : 'Create vault'}
              </button>
            </section>
          </div>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="summary-head">
              <div>
                <p className="eyebrow">Vault</p>
                <h2>{vaultConfigQuery.data?.name || selectedVault?.name || 'Vault'}</h2>
              </div>
              <div className="summary-actions">
                {!showCreateVault ? (
                  <button className="button button-secondary button-compact" onClick={() => setShowCreateVault(true)}>
                    Create vault
                  </button>
                ) : null}
                {vaultsQuery.data.length > 1 ? (
                  <label className="vault-selector">
                    <span>Vault</span>
                    <select value={activeVaultId} onChange={(event) => setSelectedVaultId(event.target.value as Hex)}>
                      {vaultsQuery.data.map((vault) => (
                        <option key={vault.rateManagerId} value={vault.rateManagerId}>
                          {vault.name || vault.rateManagerId}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {!showVaultSettings ? (
                  <button
                    className="button button-secondary button-compact"
                    onClick={() => setShowVaultSettings(true)}
                  >
                    Manage vault
                  </button>
                ) : null}
              </div>
            </div>

            <div className="summary-grid">
              <div>
                <p className="label">Vault ID</p>
                <strong className="mono-value">{activeVaultId}</strong>
              </div>
              <div>
                <p className="label">Fee</p>
                <strong>{vaultConfigQuery.data ? formatPercentFromWad(vaultConfigQuery.data.fee) : '...'}</strong>
              </div>
              <div>
                <p className="label">Manager</p>
                <strong className="mono-value">
                  {vaultConfigQuery.data ? shortHex(vaultConfigQuery.data.manager) : '...'}
                </strong>
              </div>
              <div>
                <p className="label">Fee recipient</p>
                <strong className="mono-value">
                  {vaultConfigQuery.data ? shortHex(vaultConfigQuery.data.feeRecipient) : '...'}
                </strong>
              </div>
              <div>
                <p className="label">Min liquidity</p>
                <strong>
                  {vaultConfigQuery.data ? `${formatUnits(vaultConfigQuery.data.minLiquidity, 6)} USDC` : '...'}
                </strong>
              </div>
              <div>
                <p className="label">Max fee</p>
                <strong>{vaultConfigQuery.data ? formatPercentFromWad(vaultConfigQuery.data.maxFee) : '...'}</strong>
              </div>
            </div>

            {showCreateVault ? (
              <div className="vault-settings-panel">
                <div className="vault-settings-head">
                  <h3>Create vault</h3>
                  <button className="button button-secondary button-compact" onClick={() => setShowCreateVault(false)}>
                    Close create vault
                  </button>
                </div>
                <div className="vault-settings-grid create-vault-grid">
                  <section className="subcard">
                    <div className="subcard-head">
                      <h3>Vault</h3>
                    </div>
                    <label>
                      <span>Name</span>
                      <input
                        value={createVaultForm.name}
                        onChange={(event) =>
                          setCreateVaultForm((current) => ({ ...current, name: event.target.value }))
                        }
                        placeholder="Peer Vaults Alpha"
                      />
                    </label>
                    <label>
                      <span>URI</span>
                      <input
                        value={createVaultForm.uri}
                        onChange={(event) =>
                          setCreateVaultForm((current) => ({ ...current, uri: event.target.value }))
                        }
                        placeholder="https://..."
                      />
                    </label>
                    <label>
                      <span>Manager</span>
                      <input
                        value={createVaultForm.manager}
                        onChange={(event) =>
                          setCreateVaultForm((current) => ({ ...current, manager: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      <span>Fee recipient</span>
                      <input
                        value={createVaultForm.feeRecipient}
                        onChange={(event) =>
                          setCreateVaultForm((current) => ({ ...current, feeRecipient: event.target.value }))
                        }
                      />
                    </label>
                  </section>

                  <section className="subcard">
                    <div className="subcard-head">
                      <h3>Pricing</h3>
                    </div>
                    <label>
                      <span>Fee %</span>
                      <input
                        value={createVaultForm.feePercent}
                        onChange={(event) =>
                          setCreateVaultForm((current) => ({ ...current, feePercent: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      <span>Max fee %</span>
                      <input
                        value={createVaultForm.maxFeePercent}
                        onChange={(event) =>
                          setCreateVaultForm((current) => ({ ...current, maxFeePercent: event.target.value }))
                        }
                      />
                    </label>
                    <label>
                      <span>Min liquidity USDC</span>
                      <input
                        value={createVaultForm.minLiquidityUsdc}
                        onChange={(event) =>
                          setCreateVaultForm((current) => ({ ...current, minLiquidityUsdc: event.target.value }))
                        }
                      />
                    </label>
                    <button
                      className="button button-primary"
                      disabled={createVaultMutation.isPending}
                      onClick={() => createVaultMutation.mutate()}
                    >
                      {createVaultMutation.isPending ? 'Deploying...' : 'Create vault'}
                    </button>
                  </section>
                </div>
              </div>
            ) : null}

            {showVaultSettings ? (
              <div className="vault-settings-panel">
                <div className="vault-settings-head">
                  <h3>Vault settings</h3>
                  <button
                    className="button button-secondary button-compact"
                    onClick={() => setShowVaultSettings(false)}
                  >
                    Close vault settings
                  </button>
                </div>
                <div className="vault-settings-grid">
                  <section className="subcard">
                    <div className="subcard-head">
                      <h3>Fee</h3>
                      <span>{vaultConfigQuery.data ? `Max ${formatPercentFromWad(vaultConfigQuery.data.maxFee)}` : ''}</span>
                    </div>
                    <label>
                      <span>Fee percent</span>
                      <input value={feeInput} onChange={(event) => setFeeInput(event.target.value)} />
                    </label>
                    <button
                      className="button button-primary"
                      disabled={!connectedIsManager || !activeVaultId || feeMutation.isPending}
                      onClick={() => feeMutation.mutate()}
                    >
                      {feeMutation.isPending ? 'Saving...' : 'Save fee'}
                    </button>
                  </section>

                  <section className="subcard">
                    <div className="subcard-head">
                      <h3>Profile</h3>
                    </div>
                    <label>
                      <span>Name</span>
                      <input
                        value={configForm.name}
                        onChange={(event) => setConfigForm((current) => ({ ...current, name: event.target.value }))}
                      />
                    </label>
                    <label>
                      <span>URI</span>
                      <input
                        value={configForm.uri}
                        onChange={(event) => setConfigForm((current) => ({ ...current, uri: event.target.value }))}
                      />
                    </label>
                    <label>
                      <span>Manager</span>
                      <input
                        value={configForm.manager}
                        onChange={(event) => setConfigForm((current) => ({ ...current, manager: event.target.value }))}
                      />
                    </label>
                    <label>
                      <span>Fee recipient</span>
                      <input
                        value={configForm.feeRecipient}
                        onChange={(event) =>
                          setConfigForm((current) => ({ ...current, feeRecipient: event.target.value }))
                        }
                      />
                    </label>
                    <button
                      className="button button-primary"
                      disabled={!connectedIsManager || !activeVaultId || configMutation.isPending}
                      onClick={() => configMutation.mutate()}
                    >
                      {configMutation.isPending ? 'Saving...' : 'Save settings'}
                    </button>
                  </section>

                  <section className="subcard status-panel">
                    <div className="subcard-head">
                      <h3>Status</h3>
                      <a
                        className="text-button"
                        href={`${appConfig.basescanUrl}/address/${activeRateManagerAddress}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        RateManagerV1
                      </a>
                    </div>
                    <p className={txMessage ? 'muted' : 'muted muted-faint'}>
                      {txMessage || 'No recent transaction'}
                    </p>
                  </section>
                </div>
              </div>
            ) : null}
          </section>

          <section className="page-grid">
            <article className="card tall">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Rate Desk</p>
                  <h2>Prices</h2>
                </div>
                <div className="section-actions">
                  <button className="button button-secondary button-compact" onClick={deleteAllPrices}>
                    Delete all prices
                  </button>
                  <button className="button button-secondary button-compact" onClick={addMajorRouteRows}>
                    Add major pairs
                  </button>
                  <button className="button button-secondary button-compact" onClick={addAllRouteRows}>
                    Add all routes
                  </button>
                  <button
                    className="button button-secondary button-compact"
                    onClick={() => void fillAllRowsFromMarket()}
                    disabled={marketRatesQuery.isFetching || !rateRows.length}
                  >
                    Update with market all
                  </button>
                  <button
                    className="button button-secondary button-compact"
                    onClick={() => void marketRatesQuery.refetch()}
                    disabled={marketRatesQuery.isFetching}
                  >
                    Refresh feed
                  </button>
                </div>
              </div>

              {vaultDetailQuery.isLoading ? (
                <p className="muted">Loading rates...</p>
              ) : vaultDetailQuery.error ? (
                <p className="error-text">{(vaultDetailQuery.error as Error).message}</p>
              ) : (
                <div className="editor-table">
                  <div className="editor-table-head">
                    <span className="editor-head-cell">#</span>
                    <span className="editor-head-cell">Method</span>
                    <span className="editor-head-cell">Currency</span>
                    <span className="editor-head-cell">Markup %</span>
                    <span className="editor-head-cell">Price</span>
                    <span className="editor-head-cell editor-head-cell-updated">Updated</span>
                    <span className="editor-head-cell">Actions</span>
                  </div>
                  {rateRows.map((row, index) => {
                    const hasPendingChange =
                      row.rateInput.trim() !== row.originalRateInput.trim() ||
                      row.paymentMethod !== row.originalPaymentMethod ||
                      row.currencyCode !== row.originalCurrencyCode;
                    const availableCurrencies = row.paymentMethod
                      ? (allowedCurrenciesByPaymentMethod[row.paymentMethod] ?? [])
                      : currencyOptions;

                    return (
                      <div key={row.id} className={`editor-row${hasPendingChange ? ' editor-row-pending' : ''}`}>
                        <div className="line-number-cell">
                          <strong>{index + 1}</strong>
                        </div>
                        <div className="editor-field">
                          <select
                            value={row.paymentMethod}
                            onChange={(event) =>
                              updateRateRow(row.id, {
                                paymentMethod: event.target.value as PaymentMethodKey | '',
                              })
                            }
                          >
                            <option value="">Select</option>
                            {paymentOptions.map((option) => (
                              <option key={option.key} value={option.key}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="editor-field">
                          <select
                            value={row.currencyCode}
                            onChange={(event) => updateRateRow(row.id, { currencyCode: event.target.value })}
                          >
                            <option value="">Select</option>
                            {availableCurrencies.map((currency) => (
                              <option key={currency} value={currency}>
                                {currency}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="editor-field">
                          <input
                            value={row.markupPercentInput}
                            onChange={(event) => updateMarkupForRow(row.id, event.target.value)}
                            placeholder="0"
                          />
                        </div>
                        <div className="editor-field">
                          <input
                            value={row.rateInput}
                            onChange={(event) =>
                              updateRateRow(row.id, {
                                rateInput: event.target.value,
                                usesMarketPricing: false,
                              })
                            }
                            placeholder="1.00"
                          />
                        </div>
                        <div className="static-cell static-cell-tight updated-cell">
                          <strong>{formatUpdatedAt(row.updatedAt)}</strong>
                        </div>
                        <div className="editor-row-actions">
                          <button className="text-button" onClick={() => fillRowFromMarket(row.id)}>
                            Use market
                          </button>
                          {row.isNew ? (
                            <button className="text-button" onClick={() => deleteRateRow(row.id)}>
                              Remove
                            </button>
                          ) : (
                            <>
                              <button className="text-button" onClick={() => resetRateRow(row.id)}>
                                Reset
                              </button>
                              <button className="text-button" onClick={() => deleteRateRow(row.id)}>
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="save-bar">
                <div className="save-actions">
                  <button className="button button-secondary" onClick={addRateRow}>
                    + Add rate
                  </button>
                </div>
                <div className="save-actions">
                  <p className="muted">
                    {pendingRateRows.length === 0
                      ? 'No pending price changes'
                      : `${pendingRateRows.length} pending ${pendingRateRows.length === 1 ? 'change' : 'changes'}`}
                  </p>
                  <button
                    className="button button-secondary"
                    disabled={!pendingRateRows.length || saveRatesMutation.isPending}
                    onClick={discardRateChanges}
                  >
                    Discard changes
                  </button>
                  <button
                    className="button button-primary"
                    disabled={!connectedIsManager || !activeVaultId || !pendingRateRows.length || Boolean(rateValidationError) || saveRatesMutation.isPending}
                    onClick={() => saveRatesMutation.mutate()}
                  >
                    {saveRatesMutation.isPending ? 'Updating...' : 'Update prices'}
                  </button>
                </div>
              </div>
            </article>

            <article className="card">
              <div className="section-head">
                <div>
                  <p className="eyebrow">Managed Deposits</p>
                  <h2>Delegated liquidity</h2>
                </div>
              </div>

              {managedDepositsQuery.isLoading ? (
                <p className="muted">Loading deposits...</p>
              ) : managedDepositsQuery.error ? (
                <p className="error-text">{(managedDepositsQuery.error as Error).message}</p>
              ) : managedDepositsQuery.data && managedDepositsQuery.data.length > 0 ? (
                <div className="deposit-table">
                  {managedDepositsQuery.data.map((deposit) => (
                    <div key={deposit.id} className="deposit-row">
                      <div>
                        <p className="label">Depositor</p>
                        <button
                          type="button"
                          className="copy-chip mono-value"
                          onClick={() => void copyToClipboard(deposit.depositor, 'Depositor address')}
                          title={deposit.depositor}
                        >
                          {shortHex(deposit.depositor)}
                        </button>
                      </div>
                      <div>
                        <p className="label">Liquidity</p>
                        <strong>{formatLiquidity(deposit.remainingDeposits)}</strong>
                      </div>
                      <div>
                        <p className="label">Status</p>
                        <strong>{deposit.status}</strong>
                      </div>
                      <div>
                        <p className="label">Delegated</p>
                        <strong>{formatUpdatedAt(deposit.delegatedAt ?? deposit.updatedAt ?? '')}</strong>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No deposits are delegated to this vault yet.</p>
              )}
            </article>
          </section>
        </>
      )}
    </main>
  );
}
