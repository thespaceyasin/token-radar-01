// Token Radar — main.ts (Node 22, standard library only).
//
// Reads the sealed DefiLlama snapshot, ranks every genuine pre-token launch
// candidate by an implied value, and writes the board, the dashboard data and
// the dossier. No network, no clock, no randomness: two runs write the same
// bytes.
//
// The model, in one line: a protocol's token would be worth the slice of the
// value it already holds that the market pays for its category, stretched by
// how fast that value is growing, how long it has survived without a token,
// and how many chains it spans.
//
//   multiple = the category's market multiple, calibrated on the snapshot
//              itself (see calibrateMultiples below)
//   growth   = 1 + 0.5 * tanh(clamp(change_7d, -100, 500) / 40)
//   age      = 0.70 + 0.30 * (1 - exp(-ageDays / 365))
//   chains   = 1 + 0.04 * min(chains - 1, 5)
//   implied  = round(tvl_usd * multiple * growth * age * chains)
//
// Why these shapes: the multiple is what live tokens in the same category
// actually trade at per dollar of TVL, so a lending protocol and a perp DEX
// no longer share one flat multiple; the growth factor saturates, so a
// protocol that printed +4,000% in a week cannot outrank everything on one
// noisy print, while a -70% week still costs it nearly half; the age factor
// saturates too, so surviving three tokenless years is worth no more than
// surviving two; the chain factor is a small diversification bonus, capped
// at five extra chains. Every factor comes from the snapshot's own figures.
// No protocol name is ever special-cased: the same function scores every row.
//
// The board ranks the eligible pre-token protocols: the watchlist's own rule
// without its TVL floor. A protocol is eligible when it records no token
// (gecko_id and symbol both null), its category is not an exchange, a bridge
// or a wrapped/staked product, its name carries no version marker and no
// whole word wrapped / staked / staking, and it does not begin with an
// exchange's name. Centralised exchanges, bridges and wrapped products are
// set aside, not ranked: they are not token launches waiting to happen.
// Live-token protocols are never ranked; the dashboard shows the largest of
// them apart, at their market values.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The snapshot's date: ages are counted from it, never from today. */
const AS_OF = '2026-11-14';
const AS_OF_MS = Date.parse(`${AS_OF}T00:00:00.000Z`);
const DAY_MS = 86_400_000;

/** The model's constants, stated in the dashboard so a reader can check them. */
const MODEL = {
  growth_weight: 0.5,
  growth_scale: 40,
  growth_floor: -100,
  growth_cap: 500,
  age_floor: 0.7,
  age_tau_days: 365,
  unknown_age_days: 365,
  chain_step: 0.04,
  chain_max_bonus: 5,
  /** The calibration's prior: each category's multiple is pulled toward the global median as if 10 live protocols at the median had been seen. */
  calibration_prior: 10,
  /** A category median outside this band is noise from a tiny sample, not a signal. */
  calibration_median_floor: 0.05,
  calibration_median_cap: 0.6,
  /** The multiple itself never leaves this band, whatever the category says. */
  multiple_floor: 0.08,
  multiple_cap: 0.45,
} as const;

/** One calibrated multiple, as the dashboard's calibration table shows it. */
interface CalibratedMultiple {
  category: string;
  eligible: number;
  live_n: number;
  live_median: number | null;
  multiple: number;
}

/** The calibration: the global median multiple and one row per category. */
interface Calibration {
  global_median: number;
  prior_weight: number;
  multiples: CalibratedMultiple[];
}

/** The scorer's own caps, so the program refuses a board the gate refuses. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** One farm step, as the dashboard shows it: the action, what it costs, how long it takes. */
interface FarmStep {
  action: string;
  cost: string;
  time: string;
}

/** One ranked row of the board. */
interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

/** The dashboard's data: the board with its working, plus the two side lists. */
interface RadarData {
  meta: {
    as_of: string;
    source: string;
    floor_usd: number;
    protocols_total: number;
    pretoken_total: number;
    eligible_total: number;
    watchlist_total: number;
    live_total: number;
    set_aside_total: number;
    board_rows: number;
  };
  model: typeof MODEL;
  calibration: Calibration;
  rows: Array<{
    slug: string;
    name: string;
    category: string | null;
    chains: string[];
    tvl_usd: number;
    change_7d: number | null;
    age_days: number;
    watchlist: boolean;
    rank: number;
    implied_value_usd: number;
    factors: { multiple: number; growth: number; age: number; chains: number };
    farm_steps: FarmStep[];
  }>;
  live: Array<{ slug: string; name: string; category: string | null; mcap_usd: number; symbol: string | null }>;
  set_aside: Array<{ slug: string; name: string; category: string | null; reason: string }>;
}

// ---------------------------------------------------------------- eligibility

/** Categories that are not token launches: exchanges, bridges, wrapped/staked products. */
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Exchange names a launch candidate's name never begins with. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** A name ending in a version marker: a space followed by V2, v2, 2.0 or the like. */
const VERSION_MARKER = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word wrapped, staked or staking, in any case. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Why a pre-token protocol is set aside instead of ranked. */
function setAsideReason(p: SnapshotProtocol): string | null {
  if (p.gecko_id !== null || p.symbol !== null) return 'records a token';
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return `category ${p.category}`;
  if (VERSION_MARKER.test(p.name)) return 'versioned name';
  if (WRAPPED_WORD.test(p.name)) return 'wrapped or staked product';
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return 'exchange product';
  return null;
}

/** The watchlist's rule without its TVL floor: a genuine launch candidate. */
function isEligible(p: SnapshotProtocol): boolean {
  return setAsideReason(p) === null;
}

// ---------------------------------------------------------------- the model

/** Days between the snapshot's date and the day DefiLlama began tracking the protocol. */
function ageDays(p: SnapshotProtocol): number {
  if (p.listed_at === null) return MODEL.unknown_age_days;
  const listed = Date.parse(`${p.listed_at}T00:00:00.000Z`);
  if (Number.isNaN(listed)) return MODEL.unknown_age_days;
  return Math.max(0, Math.round((AS_OF_MS - listed) / DAY_MS));
}

/** The growth factor: 0.5 at a -100% week, 1.0 flat, 1.5 at a +500% week, saturating. */
function growthFactor(change7d: number | null): number {
  const g = change7d === null ? 0 : Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, change7d));
  return 1 + MODEL.growth_weight * Math.tanh(g / MODEL.growth_scale);
}

/** The age factor: 0.70 at birth, rising toward 1.00 with a one-year half-life of trust. */
function ageFactor(days: number): number {
  return MODEL.age_floor + (1 - MODEL.age_floor) * (1 - Math.exp(-days / MODEL.age_tau_days));
}

/** The chain factor: +4% per extra chain, at most five extra chains. */
function chainFactor(chains: string[]): number {
  return 1 + MODEL.chain_step * Math.min(Math.max(chains.length - 1, 0), MODEL.chain_max_bonus);
}

/** The median of a sorted list of numbers. */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * The category multiples, calibrated on the snapshot itself. For every live
 * protocol — one whose token already trades — the market already priced a
 * token per dollar of TVL, as mcap_usd / tvl_usd. A category's multiple is
 * the median of that ratio over its live protocols, clamped to a sane band
 * (one wild protocol must not set a whole category), then shrunk toward the
 * global median with a prior of ten protocols: a category with one live
 * protocol barely moves from the global figure, a category with fifteen
 * mostly speaks for itself. A category with no live protocol at all takes
 * the global median. Nothing here names a protocol: the multiples come from
 * the snapshot's own live market, recomputed on every run.
 */
function calibrateMultiples(snapshot: Snapshot, eligible: SnapshotProtocol[]): Calibration {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.tvl_usd > 0);
  const globalMedian = medianOf(live.map((p) => (p.mcap_usd ?? 0) / p.tvl_usd));
  const byCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? '(uncategorised)';
    const list = byCategory.get(key) ?? [];
    list.push((p.mcap_usd ?? 0) / p.tvl_usd);
    byCategory.set(key, list);
  }
  const eligibleCount = new Map<string, number>();
  for (const p of eligible) {
    const key = p.category ?? '(uncategorised)';
    eligibleCount.set(key, (eligibleCount.get(key) ?? 0) + 1);
  }
  const multiples: CalibratedMultiple[] = [...eligibleCount.entries()]
    .map(([category, eligibleN]) => {
      const sample = byCategory.get(category);
      const liveMedian = sample === undefined ? null : medianOf(sample);
      const clamped = liveMedian === null
        ? globalMedian
        : Math.min(MODEL.calibration_median_cap, Math.max(MODEL.calibration_median_floor, liveMedian));
      const n = sample === undefined ? 0 : sample.length;
      const shrunk = (n * clamped + MODEL.calibration_prior * globalMedian) / (n + MODEL.calibration_prior);
      const multiple = Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, shrunk));
      return { category, eligible: eligibleN, live_n: n, live_median: liveMedian, multiple };
    })
    .sort((a, b) => b.eligible - a.eligible || (a.category < b.category ? -1 : 1));
  return { global_median: globalMedian, prior_weight: MODEL.calibration_prior, multiples };
}

/** A category's multiple from the calibration; the global median when it has no row. */
function multipleFor(category: string | null, calibration: Calibration): number {
  const key = category ?? '(uncategorised)';
  const row = calibration.multiples.find((m) => m.category === key);
  return row === undefined ? calibration.global_median : row.multiple;
}

/** The implied value, and the four factors that made it, for one protocol. */
function score(p: SnapshotProtocol, calibration: Calibration): { implied: number; multiple: number; growth: number; age: number; chains: number; ageDays: number } {
  const age = ageDays(p);
  const multiple = multipleFor(p.category, calibration);
  const growth = growthFactor(p.change_7d);
  const ageF = ageFactor(age);
  const chainF = chainFactor(p.chains);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growth * ageF * chainF));
  return { implied, multiple, growth, age: ageF, chains: chainF, ageDays: age };
}

/** Whole dollars, short: 2,757,585,593 -> $2.76B, 48,300,000 -> $48.3M, 950,000 -> $950K. */
function shortUsd(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

/** The 7-day change, as a reader says it: +5.6%, -8.3%, or n/a when unreported. */
function changeText(change7d: number | null): string {
  if (change7d === null) return 'n/a';
  return `${change7d >= 0 ? '+' : ''}${change7d.toFixed(1)}%`;
}

// ---------------------------------------------------------------- farm plans

/** Rough gas per transaction, in whole dollars, by chain; the fallback covers the rest. */
const GAS_USD: Record<string, number> = {
  Ethereum: 4,
  Solana: 0.01,
  Base: 0.05,
  Arbitrum: 0.08,
  Optimism: 0.06,
  BSC: 0.15,
  Polygon: 0.02,
  Avalanche: 0.3,
  Sui: 0.01,
  Aptos: 0.01,
  Berachain: 0.05,
  Hyperliquid: 0.01,
  Tron: 0.5,
  Bitcoin: 1,
  Linea: 0.05,
  zkSync: 0.08,
  Scroll: 0.06,
  Mantle: 0.05,
  Blast: 0.05,
  Mode: 0.05,
};

/** The gas a step costs on the protocol's first chain, for a number of transactions. */
function gasCost(chains: string[], txs: number): string {
  const per = GAS_USD[chains[0] ?? ''] ?? 0.5;
  const total = per * txs;
  if (total < 0.1) return `about $${total.toFixed(2)} in gas`;
  if (total < 1) return `about $${total.toFixed(2)} in gas`;
  return `about $${Math.round(total)} in gas`;
}

/** The first chain, or the generic fallback when the snapshot names none. */
function mainChain(p: SnapshotProtocol): string {
  return p.chains[0] ?? 'its home chain';
}

/** Which family of farm steps a category takes; unknown categories take the generic set. */
function familyOf(category: string | null): string {
  switch (category) {
    case 'Dexs':
      return 'dex';
    case 'Lending':
      return 'lending';
    case 'Yield':
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Yield Aggregator':
      return 'vault';
    case 'Derivatives':
    case 'Options':
    case 'Perpetuals':
      return 'perps';
    case 'CDP':
      return 'cdp';
    case 'RWA':
    case 'RWA Lending':
      return 'rwa';
    case 'Restaking':
      return 'restaking';
    default:
      return 'generic';
  }
}

/** The family-specific middle steps: two or three concrete actions for the protocol. */
function familySteps(family: string, p: SnapshotProtocol): FarmStep[] {
  const chain = mainChain(p);
  const tvl = shortUsd(p.tvl_usd);
  switch (family) {
    case 'dex':
      return [
        {
          action: `Swap $200–$500 of volume on ${p.name} on ${chain} across 2–3 separate days, using limit orders where the router offers them, so the activity reads as real trading rather than one wash trade.`,
          cost: gasCost(p.chains, 3),
          time: '3 days, a few minutes each',
        },
        {
          action: `Add $500–$2,000 to the protocol's deepest pool on ${chain} and leave the position open; collect the trading fees and note the pool's share of the ${tvl} TVL before depositing.`,
          cost: gasCost(p.chains, 2),
          time: '4–8 weeks staked',
        },
      ];
    case 'lending':
      return [
        {
          action: `Supply $500–$2,000 of a major asset (ETH, USDC or wBTC) to ${p.name}'s lending market on ${chain} and keep the supply active; suppliers are usually the first wallets a points program counts.`,
          cost: gasCost(p.chains, 2),
          time: '4–8 weeks supplied',
        },
        {
          action: `Borrow a small amount (under 40% of your collateral) against the supply, repay it within the week, and repeat once: a borrow-and-repay cycle shows use of both sides of the market.`,
          cost: gasCost(p.chains, 4),
          time: '2 weeks, two cycles',
        },
      ];
    case 'vault':
      return [
        {
          action: `Deposit $500–$2,000 into ${p.name}'s flagship vault on ${chain}; vaults in this class hold most of the protocol's ${tvl} TVL, so the deposit is the position that matters.`,
          cost: gasCost(p.chains, 2),
          time: '6–10 weeks deposited',
        },
        {
          action: `Top the vault up once, 2–3 weeks after the first deposit, rather than depositing everything at once; a second deposit is the behaviour points programs usually reward twice.`,
          cost: gasCost(p.chains, 1),
          time: 'one top-up in week 3',
        },
      ];
    case 'perps':
      return [
        {
          action: `Open a small leveraged position on ${p.name} on ${chain} (2–3x, under $500 of margin) and close it within 48 hours; keep the position small enough that a liquidation cannot hurt you.`,
          cost: gasCost(p.chains, 2),
          time: '48 hours per trade',
        },
        {
          action: `Provide $300–$1,000 to the protocol's liquidity pool on ${chain} for at least a month; LP shares in perp venues earn the fees every taker pays.`,
          cost: gasCost(p.chains, 2),
          time: '4–6 weeks as LP',
        },
      ];
    case 'cdp':
      return [
        {
          action: `Lock $1,000–$3,000 of collateral in ${p.name}'s vault on ${chain} and mint stablecoins against at most half of it, keeping the collateral ratio above the protocol's liquidation line with a wide margin.`,
          cost: gasCost(p.chains, 2),
          time: '6–10 weeks open',
        },
        {
          action: `Repay a quarter of the minted debt after a month and mint it back the following week: the repay-and-remint cycle is the activity a launch snapshot most often counts.`,
          cost: gasCost(p.chains, 3),
          time: '2 weeks, one cycle',
        },
      ];
    case 'rwa':
      return [
        {
          action: `Mint or buy $500–$2,000 of ${p.name}'s tokenised asset on ${chain} and hold it in your own wallet (not on an exchange), so the holding is attributable to you on-chain.`,
          cost: gasCost(p.chains, 2),
          time: '6–10 weeks held',
        },
        {
          action: `If the asset pays yield, claim or compound it once a month rather than letting it sit unclaimed; a claim is a second on-chain event tied to the same wallet.`,
          cost: gasCost(p.chains, 1),
          time: 'monthly, 2 claims',
        },
      ];
    case 'restaking':
      return [
        {
          action: `Restake $300–$1,000 of ETH or LST through ${p.name} on ${chain} and delegate it to an operator with a long uptime record, not the largest one.`,
          cost: gasCost(p.chains, 2),
          time: '6–10 weeks staked',
        },
        {
          action: `Add a second, smaller restake 2–3 weeks later from the same wallet; restaking programs tend to weight wallets with repeated deposits over one-offs.`,
          cost: gasCost(p.chains, 1),
          time: 'one top-up in week 3',
        },
      ];
    default:
      return [
        {
          action: `Use ${p.name}'s core feature on ${chain} with a real position of $300–$1,000 — not a dust transaction — and keep it open; the protocol's ${tvl} TVL is the pool your position joins.`,
          cost: gasCost(p.chains, 2),
          time: '4–8 weeks active',
        },
        {
          action: `Come back and use the feature a second time 2–3 weeks later from the same wallet; a repeat visit is the signal most launch snapshots are built to catch.`,
          cost: gasCost(p.chains, 1),
          time: 'one return visit in week 3',
        },
      ];
  }
}

/** The named risk for a family: the one way this kind of position most often loses money. */
function riskStep(family: string, p: SnapshotProtocol): FarmStep {
  const chain = mainChain(p);
  switch (family) {
    case 'dex':
      return {
        action: `Risk to price in: impermanent loss. If the pool's two assets drift apart while your $500–$2,000 sits in it, the position can come back worth less than holding the assets — check the pool's 30-day range before depositing, and pull out if one side moves more than 25%.`,
        cost: 'no cost to watch',
        time: 'check weekly, 5 minutes',
      };
    case 'lending':
      return {
        action: `Risk to price in: liquidation. If your collateral falls while a loan is open, the protocol sells it at a discount — keep the loan under 40% of the collateral, set a price alert 15% above your liquidation price, and repay early if it trips.`,
        cost: gasCost(p.chains, 1),
        time: 'alerts always on',
      };
    case 'vault':
      return {
        action: `Risk to price in: the vault's strategy, not the protocol's name. A vault that chases the highest yield can hold a token that collapses — read what the vault actually holds on ${chain} before depositing, and prefer the plainest strategy over the highest advertised APY.`,
        cost: 'no cost to check',
        time: '30 minutes before depositing',
      };
    case 'perps':
      return {
        action: `Risk to price in: liquidation and funding. A 3x position is wiped out by a 33% move against you, and funding can bleed a position that stays open for weeks — never hold a leveraged position overnight on ${chain} without a stop in place.`,
        cost: 'no cost to watch',
        time: 'check daily while open',
      };
    case 'cdp':
      return {
        action: `Risk to price in: the minted stablecoin losing its peg. If it trades under $0.98 for more than a day, the debt you owe is worth more than the coins you hold — keep the collateral ratio high enough to repay and exit in one transaction on ${chain}.`,
        cost: gasCost(p.chains, 1),
        time: 'check weekly, 5 minutes',
      };
    case 'rwa':
      return {
        action: `Risk to price in: the issuer, not the chain. A tokenised asset is only as good as the company holding the underlying — check who custodies it, whether redemptions have ever been paused, and never put in more than you can wait months to get back.`,
        cost: 'no cost to check',
        time: '1 hour of reading first',
      };
    case 'restaking':
      return {
        action: `Risk to price in: slashing and lock-ups. A misbehaving operator can cost you part of the stake, and unstaking can take days to weeks — split the stake across two operators on ${chain} and confirm the withdrawal delay before you commit.`,
        cost: 'no cost to check',
        time: '30 minutes before staking',
      };
    default:
      return {
        action: `Risk to price in: the token may never come, and the position can still lose money. Only farm with money you can afford to leave locked for months, and treat every point or promise as worthless until a token actually exists and trades.`,
        cost: 'no cost to watch',
        time: 'decide the budget first',
      };
  }
}

/** The full farm plan for one protocol: fund, do the work, stay, track, claim. */
function farmSteps(p: SnapshotProtocol): FarmStep[] {
  const chain = mainChain(p);
  const steps: FarmStep[] = [
    {
      action: `Fund a fresh wallet with $500–$2,000 of stablecoins and bridge it to ${chain}; keep this wallet only for ${p.name} so every action below is attributable to one address.`,
      cost: gasCost(p.chains, 2),
      time: '30 minutes to set up',
    },
    ...familySteps(familyOf(p.category), p),
    {
      action: `Stay active without overdoing it: one meaningful action every 1–2 weeks for 6–10 weeks beats ten transactions in a day, which most anti-Sybil filters discount or ignore.`,
      cost: gasCost(p.chains, 4),
      time: '6–10 weeks, weekly rhythm',
    },
    riskStep(familyOf(p.category), p),
    {
      action: `Watch ${p.name}'s announcements and the snapshot's own figures (TVL ${shortUsd(p.tvl_usd)}, 7-day change ${changeText(p.change_7d)}); if a token or points program is announced, claim inside the window the announcement names.`,
      cost: 'no cost to watch',
      time: 'weekly check, 5 minutes',
    },
  ];
  return steps;
}

// ---------------------------------------------------------------- build

/** The snapshot, parsed and checked: 758 protocols, 40 on the watchlist. */
function parseSnapshot(text: string): Snapshot {
  const doc = JSON.parse(text) as Snapshot;
  if (!Array.isArray(doc.protocols) || !Array.isArray(doc.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must both be arrays');
  }
  return doc;
}

/** The whole radar: the ranked board, the live market apart, and what was set aside. */
function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const watchlist = new Set(snapshot.watchlist);
  const pretoken = snapshot.protocols.filter((p) => p.gecko_id === null && p.symbol === null);
  const live = snapshot.protocols
    .filter((p) => p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0))
    .slice(0, 20)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, mcap_usd: p.mcap_usd ?? 0, symbol: p.symbol }));
  const setAside = pretoken
    .filter((p) => !isEligible(p))
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, reason: setAsideReason(p) ?? 'set aside' }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  const eligible = pretoken.filter((p) => isEligible(p));
  const calibration = calibrateMultiples(snapshot, eligible);
  const scored = eligible
    .map((p) => ({ p, s: score(p, calibration) }))
    .sort((a, b) => (b.s.implied - a.s.implied) || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = scored.map(({ p, s }, i) => ({
    slug: p.slug,
    name: p.name,
    rank: i + 1,
    implied_value_usd: s.implied,
    farm_steps: farmSteps(p).map((st) => `${st.action} Cost: ${st.cost}. Time: ${st.time}.`),
  }));

  const rows = scored.map(({ p, s }, i) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    age_days: s.ageDays,
    watchlist: watchlist.has(p.slug),
    rank: i + 1,
    implied_value_usd: s.implied,
    factors: { multiple: s.multiple, growth: s.growth, age: s.age, chains: s.chains },
    farm_steps: farmSteps(p),
  }));

  const radar: RadarData = {
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      protocols_total: snapshot.protocols.length,
      pretoken_total: pretoken.length,
      eligible_total: scored.length,
      watchlist_total: snapshot.watchlist.length,
      live_total: snapshot.protocols.length - pretoken.length,
      set_aside_total: setAside.length,
      board_rows: board.length,
    },
    model: MODEL,
    calibration,
    rows,
    live,
    set_aside: setAside,
  };
  return { board, radar };
}

/** The gate's own shape, checked before anything is written. */
function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4_000) return `board holds ${board.length} rows, the gate wants 100 to 4,000`;
  const seen = new Set<string>();
  for (let i = 0; i < board.length; i++) {
    const row = board[i]!;
    if (row.rank !== i + 1) return `row ${row.slug} carries rank ${row.rank}, expected ${i + 1}`;
    if (i > 0 && row.implied_value_usd > board[i - 1]!.implied_value_usd) return `implied value rises at rank ${row.rank}`;
    if (seen.has(row.slug)) return `slug ${row.slug} appears twice`;
    seen.add(row.slug);
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) return `row ${row.slug} carries ${row.farm_steps.length} farm steps`;
    for (const step of row.farm_steps) {
      const n = step.trim().length;
      if (n < 20 || n > 600) return `a farm step of ${row.slug} is ${n} characters`;
    }
  }
  if (board.every((r) => r.implied_value_usd === board[0]!.implied_value_usd)) return 'every implied value is the same';
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist slug ${slug} is missing from the board`;
  }
  return null;
}

/** The dashboard's data, as a script the page loads: one global, no network. */
function dataScript(radar: RadarData): string {
  const json = JSON.stringify(radar).replace(/</g, '\\u003c');
  return `window.RADAR = ${json};\n`;
}

// ---------------------------------------------------------------- run

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.meta.eligible_total} eligible, ${radar.meta.set_aside_total} set aside, ${radar.meta.live_total} live)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
