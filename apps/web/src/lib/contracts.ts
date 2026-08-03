/**
 * The three deployed contracts, in one place.
 *
 * These addresses had drifted into two hardcoded copies — CoreOffline.tsx kept
 * its own list of all three, console/page.tsx kept its own PolicyModule — and a
 * judge who clicks a stale address finds a contract that is not ours. One
 * source, env-overridable, with the verified deployment as the default.
 *
 * All three are deployed AND source-verified on Base Sepolia. The links below
 * are the single most valuable thing on the console for a judge, because they
 * are the only part of this system that does not require trusting our server.
 */

export const POLICY_MODULE_ADDRESS = (process.env['NEXT_PUBLIC_POLICY_MODULE_ADDRESS'] ??
  '0x933bb10252ec2b133f28b7d5edf1d303c3384d87') as `0x${string}`;

export const REKHA_ACCOUNT_ADDRESS = (process.env['NEXT_PUBLIC_REKHA_ACCOUNT_ADDRESS'] ??
  '0xd65122eafeb2e6f384d0095bac7de6f662276f6c') as `0x${string}`;

export const INRX_ADDRESS = (process.env['NEXT_PUBLIC_INRX_ADDRESS'] ??
  '0x9df2d451d682971878d09ba13920ca418697272d') as `0x${string}`;

export type ContractRef = {
  name: string;
  address: `0x${string}`;
  /** What it does, in the owner's language — not the class name. */
  note: string;
};

export const CONTRACTS: readonly ContractRef[] = [
  { name: 'PolicyModule', address: POLICY_MODULE_ADDRESS, note: 'the 14 predicates, on chain' },
  { name: 'RekhaAccount', address: REKHA_ACCOUNT_ADDRESS, note: '2-of-2 enforcement, no admin backdoor' },
  { name: 'INRx', address: INRX_ADDRESS, note: 'ERC-20, the money that moves' },
];

/** Settlements that actually landed. Recorded in FIXLOG2.md. */
export const SETTLED_TX: readonly { hash: string; detail: string }[] = [
  {
    hash: '0x35025de91d5f92d76165358ebab92bf94dc8b05ab7bfd9971eb3b061f12c7e90',
    detail: 'block 44959341 · ₹5,760.00 to ven_meridian',
  },
  {
    hash: '0x1ed0242aee4b863ca20b09999d2d4cd2d6d3b24ac8cceea949c0cd3f64a4df96',
    detail: 'block 44959201 · ₹9,520.00',
  },
];

const EXPLORER = 'https://sepolia.basescan.org';

export const basescanAddress = (address: string) => `${EXPLORER}/address/${address}`;
export const basescanTx = (hash: string) => `${EXPLORER}/tx/${hash}`;

/** 0x1234…abcd. For addresses and hashes in dense rows. */
export const shortHex = (s: string, lead = 6, tail = 4) =>
  s.length <= lead + tail + 1 ? s : `${s.slice(0, lead)}…${s.slice(-tail)}`;
