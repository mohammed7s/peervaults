export type VaultMarkupMap = Record<string, string>;

type VaultMarkupsResponse = {
  vaultId: string;
  markups: VaultMarkupMap;
  updatedAt?: string | null;
};

const endpoint = '/.netlify/functions/vault-markups';

function normalizeVaultId(vaultId: string) {
  return vaultId.trim().toLowerCase();
}

function normalizeMarkups(markups: VaultMarkupMap) {
  return Object.fromEntries(
    Object.entries(markups)
      .map(([key, value]) => [key.trim(), value.trim()] as const)
      .filter(([key]) => key.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export async function fetchVaultMarkups(vaultId: string): Promise<VaultMarkupsResponse> {
  const normalizedVaultId = normalizeVaultId(vaultId);
  const response = await fetch(`${endpoint}?vaultId=${encodeURIComponent(normalizedVaultId)}`);

  if (!response.ok) {
    throw new Error(`Could not load persisted markups (${response.status}).`);
  }

  const payload = (await response.json()) as VaultMarkupsResponse;

  return {
    vaultId: normalizedVaultId,
    markups: normalizeMarkups(payload.markups ?? {}),
    updatedAt: payload.updatedAt ?? null,
  };
}

export async function saveVaultMarkupsRemote(vaultId: string, markups: VaultMarkupMap): Promise<VaultMarkupsResponse> {
  const normalizedVaultId = normalizeVaultId(vaultId);
  const response = await fetch(endpoint, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      vaultId: normalizedVaultId,
      markups: normalizeMarkups(markups),
    }),
  });

  if (!response.ok) {
    throw new Error(`Could not save persisted markups (${response.status}).`);
  }

  const payload = (await response.json()) as VaultMarkupsResponse;

  return {
    vaultId: normalizedVaultId,
    markups: normalizeMarkups(payload.markups ?? {}),
    updatedAt: payload.updatedAt ?? null,
  };
}
