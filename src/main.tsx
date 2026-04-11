import React, { useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider } from 'wagmi';
import App from './App';
import Analytics from './Analytics';
import { wagmiConfig } from './lib/wagmi';
import './styles.css';

const queryClient = new QueryClient();

function getHash() {
  return window.location.hash.replace('#', '') || '';
}

function useHash() {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('hashchange', cb);
      return () => window.removeEventListener('hashchange', cb);
    },
    getHash,
  );
}

function Root() {
  const hash = useHash();
  return hash === 'analytics' ? <Analytics /> : <App />;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <Root />
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
