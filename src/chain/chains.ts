// Names and block explorers of common EVM chains, Anvil's public dev accounts, and hiding the secret parts of RPC URLs.

export interface ChainInfo {
  name: string;
  /** Block explorer base URL, without a trailing slash. */
  explorer?: string;
  local?: boolean;
}

const chains: Record<number, ChainInfo> = {
  1: { name: "Ethereum", explorer: "https://etherscan.io" },
  11155111: { name: "Sepolia", explorer: "https://sepolia.etherscan.io" },
  17000: { name: "Holesky", explorer: "https://holesky.etherscan.io" },
  560048: { name: "Hoodi", explorer: "https://hoodi.etherscan.io" },
  10: { name: "OP Mainnet", explorer: "https://optimistic.etherscan.io" },
  11155420: { name: "OP Sepolia", explorer: "https://sepolia-optimism.etherscan.io" },
  8453: { name: "Base", explorer: "https://basescan.org" },
  84532: { name: "Base Sepolia", explorer: "https://sepolia.basescan.org" },
  42161: { name: "Arbitrum One", explorer: "https://arbiscan.io" },
  42170: { name: "Arbitrum Nova", explorer: "https://nova.arbiscan.io" },
  421614: { name: "Arbitrum Sepolia", explorer: "https://sepolia.arbiscan.io" },
  137: { name: "Polygon", explorer: "https://polygonscan.com" },
  80002: { name: "Polygon Amoy", explorer: "https://amoy.polygonscan.com" },
  1101: { name: "Polygon zkEVM", explorer: "https://zkevm.polygonscan.com" },
  56: { name: "BNB Smart Chain", explorer: "https://bscscan.com" },
  97: { name: "BNB Smart Chain Testnet", explorer: "https://testnet.bscscan.com" },
  43114: { name: "Avalanche C-Chain", explorer: "https://snowtrace.io" },
  43113: { name: "Avalanche Fuji", explorer: "https://testnet.snowtrace.io" },
  100: { name: "Gnosis", explorer: "https://gnosisscan.io" },
  59144: { name: "Linea", explorer: "https://lineascan.build" },
  59141: { name: "Linea Sepolia", explorer: "https://sepolia.lineascan.build" },
  534352: { name: "Scroll", explorer: "https://scrollscan.com" },
  534351: { name: "Scroll Sepolia", explorer: "https://sepolia.scrollscan.com" },
  324: { name: "zkSync Era", explorer: "https://explorer.zksync.io" },
  81457: { name: "Blast", explorer: "https://blastscan.io" },
  5000: { name: "Mantle", explorer: "https://mantlescan.xyz" },
  42220: { name: "Celo", explorer: "https://celoscan.io" },
  250: { name: "Fantom", explorer: "https://ftmscan.com" },
  1284: { name: "Moonbeam", explorer: "https://moonscan.io" },
  130: { name: "Unichain", explorer: "https://uniscan.xyz" },
  146: { name: "Sonic", explorer: "https://sonicscan.org" },
  31337: { name: "Anvil (local)", local: true },
  1337: { name: "Local chain", local: true },
};

export function chainInfo(id: number): ChainInfo {
  return chains[id] ?? { name: `Chain ${id}` };
}

export function addressUrl(chainId: number, address: string): string | undefined {
  const e = chainInfo(chainId).explorer;
  return e && `${e}/address/${address}`;
}

export function txUrl(chainId: number, hash: string): string | undefined {
  const e = chainInfo(chainId).explorer;
  return e && `${e}/tx/${hash}`;
}

/**
 * Anvil's default accounts, from its published test mnemonic ("test test ... junk"). Public dev accounts: anyone can
 * sign for them, so they are only ever for a local chain. Addresses only; the extension never handles their keys.
 */
export const anvilAccounts = [
  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
  "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
  "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
  "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
  "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
];

/**
 * A URL safe to show or log: scheme, host and port only. RPC providers put the API key in the path
 * (/v2/KEY, /v3/KEY) or the query, so both go.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const rest = u.pathname !== "/" || u.search ? "/…" : "";
    return `${u.protocol}//${u.host}${rest}`;
  } catch {
    return "(a URL)";
  }
}

/** Replaces `${VAR}` in a foundry.toml value from the environment; reports the names it could not fill. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv): { value: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined || v === "") {
      missing.push(name);
      return "";
    }
    return v;
  });
  return { value: out, missing };
}
