import { Wallet, getBytes, isHexString, toUtf8Bytes } from 'ethers';

/**
 * A real keypair used only to produce valid signatures. Many dapps gate on a
 * Sign-In-With-Ethereum / Terms signature that their backend verifies by
 * recovering the address from the signature — that check needs a genuine
 * signature, but no funds. So the demo wallet holds a throwaway private key and
 * signs personal_sign / eth_sign / EIP-712 requests for real. Balances are
 * still faked elsewhere.
 */
export interface Signer {
  address: string;
  privateKey: string;
  sign(req: { method: string; params: any[] }): Promise<string>;
}

const isAddr = (x: any) => typeof x === 'string' && /^0x[0-9a-fA-F]{40}$/.test(x);

export function createSigner(privateKey?: string): Signer {
  const w = privateKey ? new Wallet(privateKey) : Wallet.createRandom();
  return {
    address: w.address,
    privateKey: w.privateKey,
    async sign({ method, params }) {
      try {
        params = params || [];
        if (method === 'personal_sign' || method === 'eth_sign') {
          // personal_sign: [message, address]; eth_sign: [address, message].
          const message = isAddr(params[0]) ? params[1] : params[0];
          const bytes =
            typeof message === 'string' && isHexString(message)
              ? getBytes(message)
              : toUtf8Bytes(String(message ?? ''));
          return await w.signMessage(bytes);
        }
        if (method.startsWith('eth_signTypedData')) {
          // [address, typedData] where typedData is JSON string or object.
          const raw = isAddr(params[0]) ? params[1] : params[0];
          const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
          const types = { ...(data.types || {}) };
          delete types.EIP712Domain; // ethers derives this itself
          return await w.signTypedData(data.domain || {}, types, data.message || data.value || {});
        }
      } catch {
        /* fall through to a placeholder */
      }
      return '0x' + '11'.repeat(65);
    },
  };
}
