import { getStore } from '@netlify/blobs';

const store = getStore('vault-markups');

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

function normalizeVaultId(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sanitizeMarkups(markups) {
  if (!markups || typeof markups !== 'object') return {};

  return Object.fromEntries(
    Object.entries(markups).flatMap(([key, value]) => {
      if (typeof key !== 'string' || typeof value !== 'string') return [];

      const normalizedKey = key.trim();
      const normalizedValue = value.trim();
      if (!normalizedKey) return [];

      return [[normalizedKey, normalizedValue || '0']];
    }),
  );
}

export default async (request) => {
  const url = new URL(request.url);

  if (request.method === 'GET') {
    const vaultId = normalizeVaultId(url.searchParams.get('vaultId'));
    if (!vaultId) {
      return json({ error: 'vaultId is required.' }, { status: 400 });
    }

    const entry = await store.get(vaultId, { type: 'json' });
    const markups = sanitizeMarkups(entry?.markups);

    return json({ vaultId, markups, updatedAt: entry?.updatedAt ?? null });
  }

  if (request.method === 'PUT') {
    let payload;

    try {
      payload = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body.' }, { status: 400 });
    }

    const vaultId = normalizeVaultId(payload?.vaultId);
    if (!vaultId) {
      return json({ error: 'vaultId is required.' }, { status: 400 });
    }

    const markups = sanitizeMarkups(payload?.markups);
    const nextValue = {
      vaultId,
      markups,
      updatedAt: new Date().toISOString(),
    };

    await store.setJSON(vaultId, nextValue);

    return json(nextValue);
  }

  return new Response('Method not allowed', {
    status: 405,
    headers: {
      allow: 'GET, PUT',
    },
  });
};
