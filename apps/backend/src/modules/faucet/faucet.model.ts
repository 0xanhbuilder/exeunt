/** Row of `faucet_grants`: one kit handed out (or reserved while it runs). */
export interface FaucetGrantRow {
  id: number;
  network: string;
  address: string;
  kit: string;
  at: number;
}
