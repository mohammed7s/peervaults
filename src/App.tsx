import {
  PLATFORM_METADATA,
  Zkp2pClient,
  currencyInfo,
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
import { formatUnits, type Address, type Hex } from 'viem';
import { appConfig } from './lib/config';
import {
  RATE_MANAGER_ABI,
  formatPercentFromWad,
  formatRate,
  groupQueuedRates,
  percentToWad,
  rateInputToPreciseUnits,
} from './lib/rateManager';

type VaultConfig = {
  manager: Address;
  feeRecipient: Address;
  maxFee: bigint;
  fee: bigint;
  minLiquidity: bigint;
  name: string;
  uri: string;
};

type TxResult = {
  hash: Hex;
  label: string;
};

type PaymentMethodKey = keyof typeof PLATFORM_METADATA;
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
  currencyCode: string;
  originalRateInput: string;
  rateInput: string;
  updatedAt?: string;
  isNew: boolean;
};
type ManagedDeposit = {
  id: string;
  depositor: string;
  remainingDeposits: string;
  status: string;
  delegatedAt?: string | null;
  updatedAt?: string | null;
};

const paymentOptions = Object.entries(PLATFORM_METADATA)
  .map(([key, value]) => ({ key: key as PaymentMethodKey, label: value.displayName }))
  .sort((a, b) => a.label.localeCompare(b.label));
const currencyOptions = Object.keys(currencyInfo).sort();
const defaultCurrency = currencyOptions.includes('USD') ? 'USD' : (currencyOptions[0] ?? 'USD');
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
  if (!value) return 'Recent';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return 'Recent';
  return new Date(timestamp).toLocaleDateString();
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
    currencyCode: '',
    originalRateInput: '',
    rateInput: '',
    updatedAt: '',
    isNew: true,
    ...overrides,
  };
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
  const [feeInput, setFeeInput] = useState('0.10');
  const [rateRows, setRateRows] = useState<RateEditorRow[]>([
    createRateRow({ currencyCode: defaultCurrency }),
  ]);
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
    setFeeInput('0.10');
    setRateRows([createRateRow({ currencyCode: defaultCurrency })]);
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
    const rates = vaultDetailQuery.data?.rates ?? [];
    if (!activeVaultId) {
      setRateRows([createRateRow({ currencyCode: defaultCurrency })]);
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
            currencyCode: normalizedCurrencyCode,
            originalRateInput: formatRate(BigInt(rate.managerRate)),
            rateInput: formatRate(BigInt(rate.managerRate)),
            updatedAt: rate.updatedAt,
            isNew: false,
          });
        })
        .filter((row): row is RateEditorRow => Boolean(row))
        .sort((a, b) => {
          const aLabel = a.paymentMethod ? PLATFORM_METADATA[a.paymentMethod].displayName : '';
          const bLabel = b.paymentMethod ? PLATFORM_METADATA[b.paymentMethod].displayName : '';
          const paymentSort = aLabel.localeCompare(bLabel);
          if (paymentSort !== 0) return paymentSort;
          return a.currencyCode.localeCompare(b.currencyCode);
        }),
    );
  }, [activeVaultId, vaultDetailQuery.data?.rates]);

  const connectedIsManager = Boolean(
    address &&
      vaultConfigQuery.data?.manager &&
      address.toLowerCase() === vaultConfigQuery.data.manager.toLowerCase(),
  );

  const pendingRateRows = useMemo(
    () =>
      rateRows.filter(
        (row) => row.rateInput.trim() !== '' && row.rateInput.trim() !== row.originalRateInput.trim(),
      ),
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

      const key = `${row.paymentMethod}:${row.currencyCode}`;
      if (seen.has(key)) {
        return 'Each payment method and currency pair can only appear once.';
      }
      seen.add(key);
    }

    for (const row of pendingRateRows) {
      try {
        rateInputToPreciseUnits(row.rateInput);
      } catch (error) {
        return error instanceof Error ? error.message : 'One of the rates is invalid.';
      }
    }

    return '';
  }, [pendingRateRows, rateRows]);

  async function confirmTx({ hash, label }: TxResult) {
    if (!publicClient) return;

    await publicClient.waitForTransactionReceipt({ hash });
    startTransition(() => {
      void queryClient.invalidateQueries({ queryKey: ['vault-config', activeVaultId] });
      void queryClient.invalidateQueries({ queryKey: ['vault-detail', activeVaultId] });
      void queryClient.invalidateQueries({ queryKey: ['vaults-by-manager', address, appConfig.runtimeEnv] });
      setTxMessage(`${label}: ${hash}`);
    });
  }

  function updateRateRow(id: string, updates: Partial<RateEditorRow>) {
    setRateRows((current) => current.map((row) => (row.id === id ? { ...row, ...updates } : row)));
  }

  function addRateRow() {
    setRateRows((current) => [...current, createRateRow()]);
  }

  function resetRateRow(id: string) {
    setRateRows((current) =>
      current.flatMap((row) => {
        if (row.id !== id) return [row];
        if (row.isNew) return [];

        return [
          {
            ...row,
            rateInput: row.originalRateInput,
          },
        ];
      }),
    );
  }

  function fillRowFromMarket(id: string) {
    const row = rateRows.find((item) => item.id === id);
    if (!row) return;
    if (!row.currencyCode) {
      setTxMessage('Choose a currency first.');
      return;
    }

    const marketRate = marketRatesQuery.data?.rates[row.currencyCode];
    if (!marketRate) {
      setTxMessage(`No Coinbase USDC rate found for ${row.currencyCode}.`);
      return;
    }

    updateRateRow(id, { rateInput: marketRate });
  }

  const saveRatesMutation = useMutation({
    mutationFn: async () => {
      if (!client) throw new Error('Connect the manager wallet first.');
      if (!activeVaultId) throw new Error('No vault selected.');
      if (pendingRateRows.length === 0) throw new Error('No rate changes to save.');
      if (rateValidationError) throw new Error(rateValidationError);

      if (pendingRateRows.length === 1) {
        const row = pendingRateRows[0];
        if (!row.paymentMethod || !row.currencyCode) {
          throw new Error('Method and currency are required.');
        }
        const hash = await client.setVaultMinRate({
          rateManagerId: activeVaultId as Hex,
          paymentMethodHash: resolvePaymentMethodHash(row.paymentMethod, { env: appConfig.runtimeEnv }),
          currencyHash: resolveFiatCurrencyBytes32(row.currencyCode),
          rate: rateInputToPreciseUnits(row.rateInput),
        });

        return {
          hash,
          label: `${PLATFORM_METADATA[row.paymentMethod].displayName} / ${row.currencyCode} saved`,
        };
      }

      const grouped = groupQueuedRates(
        pendingRateRows.map((row) => ({
          ...(row.paymentMethod && row.currencyCode
            ? {}
            : (() => {
                throw new Error('Method and currency are required.');
              })()),
          paymentMethodHash: resolvePaymentMethodHash(row.paymentMethod, { env: appConfig.runtimeEnv }),
          currencyHash: resolveFiatCurrencyBytes32(row.currencyCode),
          rate: rateInputToPreciseUnits(row.rateInput),
        })),
      );

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

  return (
    <main className="shell">
      <header className="header-bar">
        <div className="title-stack">
          <h1>{appConfig.appName}</h1>
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
        <section className="card simple-card">
          <h2>Vault manager dashboard</h2>
          <p className="muted">
            PeerVaults is a management dashboard for Peer.xyz vault managers. Connect the manager wallet to review
            delegated deposits, update rates, and manage vault settings from one place.
          </p>
        </section>
      ) : vaultsQuery.isLoading ? (
        <section className="card simple-card">
          <h2>Loading vaults...</h2>
        </section>
      ) : vaultsQuery.error ? (
        <section className="card simple-card">
          <p className="error-text">{(vaultsQuery.error as Error).message}</p>
        </section>
      ) : !vaultsQuery.data || vaultsQuery.data.length === 0 ? (
        <section className="card simple-card">
          <h2>No vaults found for this wallet</h2>
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
                  {rateRows.map((row) => {
                    const hasPendingChange = row.rateInput.trim() !== row.originalRateInput.trim();
                    const paymentMethodLabel = row.paymentMethod
                      ? PLATFORM_METADATA[row.paymentMethod].displayName
                      : 'Select method';

                    return (
                      <div key={row.id} className={`editor-row${hasPendingChange ? ' editor-row-pending' : ''}`}>
                        {row.isNew ? (
                          <>
                            <label>
                              <span>Method</span>
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
                            </label>
                            <label>
                              <span>Currency</span>
                              <select
                                value={row.currencyCode}
                                onChange={(event) => updateRateRow(row.id, { currencyCode: event.target.value })}
                              >
                                <option value="">Select</option>
                                {currencyOptions.map((currency) => (
                                  <option key={currency} value={currency}>
                                    {currency}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </>
                        ) : (
                          <>
                            <div className="static-cell">
                              <p className="label">Method</p>
                              <strong>{paymentMethodLabel}</strong>
                            </div>
                            <div className="static-cell">
                              <p className="label">Currency</p>
                              <strong>{row.currencyCode}</strong>
                            </div>
                          </>
                        )}
                        <label>
                          <span>Price</span>
                          <input
                            value={row.rateInput}
                            onChange={(event) => updateRateRow(row.id, { rateInput: event.target.value })}
                            placeholder="1.00"
                          />
                        </label>
                        <div>
                          <p className="label">Updated</p>
                          <strong>{formatUpdatedAt(row.updatedAt)}</strong>
                        </div>
                        <div className="editor-row-actions">
                          <button className="text-button" onClick={() => fillRowFromMarket(row.id)}>
                            Use market
                          </button>
                          <button className="text-button" onClick={() => resetRateRow(row.id)}>
                            {row.isNew ? 'Remove' : 'Reset'}
                          </button>
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
                        <strong className="mono-value">{shortHex(deposit.depositor)}</strong>
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
