// Settings that change between test sessions. Edit, then redeploy.
window.CONFIG = {
  COIN: 'BTC',

  // Reference lines on the chart. A 1m close through one is written to the log.
  // These are the levels from the 22 Oct 2026 session; replace them before a new session.
  LEVELS: [
    { price: 84875, label: 'the overnight double top', short: '84,875 top' },
    { price: 83350, label: 'the breakdown candle close', short: '83,350' },
    { price: 83000, label: 'the consolidation ceiling', short: '83,000' },
    { price: 82600, label: 'the rally origin', short: '82,600' },
    { price: 81538, label: 'the 50-day MA', short: '81,538 50DMA' },
    { price: 80000, label: 'round-number support', short: '80,000' },
  ],

  // Scheduled releases, in UTC. The page reminds 10 minutes before and judges the first candle after.
  EVENTS: [
    { id: 'claims', utc: '2026-10-22T12:30:00Z', name: 'US jobless claims', note: 'Consensus 200K, prior 199K' },
    { id: 'lei', utc: '2026-10-22T14:00:00Z', name: 'Conference Board LEI', note: 'September' },
    { id: 'kcfed', utc: '2026-10-22T15:00:00Z', name: 'Kansas City Fed manufacturing', note: 'October survey' },
    { id: 'amc', utc: '2026-10-22T20:05:00Z', name: 'After-close earnings', note: 'Western Digital, MaxLinear, Newmont, Bloom Energy. Time approximate' },
    { id: 'pmi', utc: '2026-10-23T13:45:00Z', name: 'S&P Global flash PMIs', note: 'Services 58.0 vs 58.8, manufacturing 55.5 vs 55.9' },
    { id: 'umich', utc: '2026-10-23T14:00:00Z', name: 'UMich inflation expectations', note: '1-year, consensus 4.7%' },
    { id: 'fomc', utc: '2026-10-28T18:00:00Z', name: 'FOMC decision', note: 'Hold about 86% to 88% priced' },
    { id: 'pce', utc: '2026-10-29T12:30:00Z', name: 'Q3 GDP and September PCE', note: 'Advance GDP estimate' },
    { id: 'ecb', utc: '2026-10-29T13:15:00Z', name: 'ECB decision', note: 'Usual 14:15 CET slot' },
    { id: 'expiry', utc: '2026-10-30T08:00:00Z', name: 'Deribit monthly expiry', note: 'About $12.2B notional, max pain $79,000' },
  ],

  // Coinversa liquidation map. range is a whole-number percent around price (the API rejects decimals).
  HEATMAP: { range: 5, buckets: 80, everyMs: 120000 },
  // Coinversa liquidation events.
  LIQUIDATIONS: { since: '3m', limit: 200, everyMs: 30000 },
  // Single taker orders on Hyperliquid, summed per transaction. watch = heads-up, prepare = get ready (toward bust only).
  PRINTS: { watch: 2e6, prepare: 5e6 },
  // A cluster is a run of adjacent map buckets of at least bucketMin each, totalling at least min.
  CLUSTER: { min: 5e6, bucketMin: 1e6 },
  // Coinversa calls per UTC day. Polls slow at slowAt and the liquidation feeds stop at stopAt.
  BUDGET: { perDay: 20000, slowAt: 17000, stopAt: 19000 },
  // Minutes of 1m candles loaded when monitoring starts with no position open.
  HISTORY_MINUTES: 180,
};
