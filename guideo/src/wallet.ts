/**
 * A simulated crypto wallet. We inject an EIP-1193 provider (and announce it
 * via EIP-6963, the modern multi-wallet discovery standard) into the page
 * before its own scripts run. When a dapp asks to connect, this auto-approves
 * and returns a configured demo account, chain and balance — so the app renders
 * its logged-in UI without any real wallet, keys or funds.
 *
 * It fakes reads/signatures/transactions with plausible values. Numbers a dapp
 * derives from on-chain `eth_call`s or its own backend are best-effort: set
 * `defaultCall` for a blanket eth_call return, or use the explorer's response
 * rewriting for a specific app.
 */

export interface WalletConfig {
  /** 0x address shown as the connected account. */
  address: string;
  /** Hex chain id, e.g. '0x1' for Ethereum mainnet, '0x2105' for Base. */
  chainId: string;
  /** Native balance in wei (decimal string), e.g. '12345600000000000000' = 12.3456 ETH. */
  nativeBalanceWei: string;
  /** Wallet name shown in the connect modal. */
  name: string;
  rdns: string;
  uuid: string;
  /** Icon data URI shown next to the name in EIP-6963 modals. */
  icon: string;
  blockNumber: number;
  /** Blanket return value (hex) for eth_call the app makes. */
  defaultCall: string;
}

const ICON =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="22" fill="#6d5efc"/><path d="M24 40h48v28a6 6 0 0 1-6 6H30a6 6 0 0 1-6-6V40Z" fill="#fff"/><rect x="52" y="50" width="16" height="10" rx="3" fill="#6d5efc"/><path d="M24 40 34 24h34l4 16" fill="#33d6a6"/></svg>'
  ).toString('base64');

export const DEFAULT_WALLET: WalletConfig = {
  address: '0xA11CE0000000000000000000000000000000A11C',
  chainId: '0x1',
  nativeBalanceWei: '12345600000000000000', // 12.3456 ETH
  name: 'Guideo Demo Wallet',
  rdns: 'finance.guideo.demowallet',
  uuid: '9f8e7d6c-5b4a-4c3d-2e1f-0a1b2c3d4e5f',
  icon: ICON,
  blockNumber: 21_000_000,
  defaultCall: '0x' + '0'.repeat(64),
};

export function makeWalletConfig(partial: Partial<WalletConfig> = {}): WalletConfig {
  return { ...DEFAULT_WALLET, ...partial };
}

/** ETH (as a decimal string) → wei decimal string, without floating error. */
export function ethToWei(eth: string): string {
  const [whole, frac = ''] = String(eth).split('.');
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  const wei = BigInt(whole || '0') * 10n ** 18n + BigInt(fracPadded || '0');
  return wei.toString();
}

/** Build the init-script that installs the provider. Returned as a string so
 *  it is added verbatim via context.addInitScript({ content }). */
export function buildProviderScript(cfg: WalletConfig): string {
  return `(() => {
  const CFG = ${JSON.stringify(cfg)};
  const toHex = (n) => '0x' + BigInt(n).toString(16);
  const listeners = {};
  const emit = (ev, payload) => { (listeners[ev] || []).forEach((cb) => { try { cb(payload); } catch (e) {} }); };
  let connected = false;

  const provider = {
    isMetaMask: true,
    isGuideoDemoWallet: true,
    _guideo: true,
    chainId: CFG.chainId,
    networkVersion: String(parseInt(CFG.chainId, 16)),
    selectedAddress: null,
    isConnected: () => true,
    on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); return this; },
    addListener(ev, cb) { return this.on(ev, cb); },
    removeListener(ev, cb) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb); return this; },
    removeAllListeners() { for (const k in listeners) delete listeners[k]; return this; },
    async request(args) {
      const method = args && args.method;
      try { if (window.__guideoLog) window.__guideoLog({ kind: 'wallet', method, params: (args && args.params) || [] }); } catch (e) {}
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          if (method === 'eth_accounts' && !connected) return [];
          if (!connected) {
            connected = true;
            this.selectedAddress = CFG.address;
            setTimeout(() => { emit('connect', { chainId: CFG.chainId }); emit('accountsChanged', [CFG.address]); }, 0);
          }
          return [CFG.address];
        case 'eth_chainId': return CFG.chainId;
        case 'net_version': return String(parseInt(CFG.chainId, 16));
        case 'eth_getBalance': return toHex(CFG.nativeBalanceWei);
        case 'eth_blockNumber': return toHex(CFG.blockNumber);
        case 'eth_gasPrice': return toHex('20000000000');
        case 'eth_maxPriorityFeePerGas': return toHex('1500000000');
        case 'eth_estimateGas': return '0x5208';
        case 'eth_call': return CFG.defaultCall;
        case 'personal_sign':
        case 'eth_sign':
        case 'eth_signTypedData':
        case 'eth_signTypedData_v3':
        case 'eth_signTypedData_v4':
          return '0x' + '11'.repeat(65);
        case 'eth_sendTransaction':
        case 'eth_sendRawTransaction':
          return '0x' + '22'.repeat(32);
        case 'wallet_switchEthereumChain':
          if (args.params && args.params[0] && args.params[0].chainId) {
            this.chainId = args.params[0].chainId;
            setTimeout(() => emit('chainChanged', this.chainId), 0);
          }
          return null;
        case 'wallet_addEthereumChain': return null;
        case 'wallet_watchAsset': return true;
        case 'wallet_requestPermissions':
        case 'wallet_getPermissions':
          return [{ parentCapability: 'eth_accounts' }];
        case 'eth_getTransactionReceipt':
          return { status: '0x1', blockNumber: toHex(CFG.blockNumber), transactionHash: (args.params && args.params[0]) || ('0x' + '22'.repeat(32)), gasUsed: '0x5208' };
        case 'eth_getTransactionByHash':
          return { hash: (args.params && args.params[0]) || ('0x' + '22'.repeat(32)), blockNumber: toHex(CFG.blockNumber), from: CFG.address };
        default:
          return null;
      }
    },
    enable() { return this.request({ method: 'eth_requestAccounts' }); },
    send(m, p) { return typeof m === 'string' ? this.request({ method: m, params: p }) : this.request(m); },
    sendAsync(payload, cb) {
      this.request(payload).then((result) => cb(null, { id: payload && payload.id, jsonrpc: '2.0', result }))
        .catch((err) => cb(err, null));
    },
  };

  try { Object.defineProperty(window, 'ethereum', { value: provider, configurable: true, writable: true }); }
  catch (e) { try { window.ethereum = provider; } catch (e2) {} }
  try { window.dispatchEvent(new Event('ethereum#initialized')); } catch (e) {}

  // EIP-6963 multi-wallet discovery.
  const info = Object.freeze({ uuid: CFG.uuid, name: CFG.name, icon: CFG.icon, rdns: CFG.rdns });
  const announce = () => {
    try { window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) })); }
    catch (e) {}
  };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
})();`;
}
