import { randomUUID } from "node:crypto";
import { NETWORKS, type NetworkKey } from "@exeunt/sdk";
import type { Transactional } from "../../shared/db/database.js";
import { AppError, ErrorCode } from "../../shared/errors/AppError.js";
import type { Logger } from "../../shared/middlewares/logger.js";
import type { FaucetRepository } from "./faucet.repository.js";
import type { RequestKitInput } from "./faucet.schema.js";
import {
  FAUCET_LOCK_TTL_MS,
  FAUCET_LOCK_WAIT_MS,
  FAUCET_WINDOW_MS,
  type FaucetResult,
  type KitRunner,
} from "./faucet.types.js";

export type FaucetRepositoryPort = Pick<FaucetRepository, "lastGrantAt" | "insertGrant" | "deleteGrant" | "tryAcquireLock" | "releaseLock">;

export interface FaucetServiceOptions {
  isFork: (network: NetworkKey) => boolean;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  newHolderId: () => string;
  windowMs: number;
  lockTtlMs: number;
  lockWaitMs: number;
  lockPollMs: number;
}

const DEFAULTS: FaucetServiceOptions = {
  isFork: (network) => NETWORKS[network].isFork,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  newHolderId: randomUUID,
  windowMs: FAUCET_WINDOW_MS,
  lockTtlMs: FAUCET_LOCK_TTL_MS,
  lockWaitMs: FAUCET_LOCK_WAIT_MS,
  lockPollMs: 250,
};

export class FaucetService {
  private readonly opts: FaucetServiceOptions;

  constructor(
    private readonly repo: FaucetRepositoryPort,
    private readonly kits: KitRunner,
    private readonly inTransaction: Transactional,
    private readonly logger: Logger,
    options: Partial<FaucetServiceOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Hands a demo kit to a wallet on a fork network, at most one kit of each type per window. */
  async requestKit(input: RequestKitInput): Promise<FaucetResult> {
    const { network, address, kit } = input;
    if (!this.opts.isFork(network)) {
      throw new AppError(403, ErrorCode.FAUCET_FORK_ONLY, `The faucet only works on fork networks; ${network} is a live network`);
    }
    // Reserve the slot first so concurrent requests cannot both pass the rate limit.
    const grantId = this.inTransaction((tx) => {
      const now = this.opts.now();
      const last = this.repo.lastGrantAt(network, address, kit, tx);
      if (last !== null && now - last < this.opts.windowMs) {
        const retryAfterSeconds = Math.ceil((last + this.opts.windowMs - now) / 1_000);
        throw new AppError(
          429,
          ErrorCode.FAUCET_RATE_LIMITED,
          `A ${kit} kit was already sent to this address on ${network}; try again in ${retryAfterSeconds}s`,
          { retryAfterSeconds },
        );
      }
      return this.repo.insertGrant({ network, address, kit, at: now }, tx);
    });

    const holder = this.opts.newHolderId();
    try {
      await this.acquireLock(network, holder);
    } catch (err) {
      this.repo.deleteGrant(grantId);
      throw err;
    }
    try {
      const actions = await this.kits.runKit(network, kit, address);
      this.logger.info({ network, kit }, "faucet kit delivered");
      return { ok: true, actions };
    } catch (err) {
      // A failed kit does not count against the rate limit.
      this.repo.deleteGrant(grantId);
      throw err;
    } finally {
      this.repo.releaseLock(network, holder);
    }
  }

  private async acquireLock(network: NetworkKey, holder: string): Promise<void> {
    const deadline = this.opts.now() + this.opts.lockWaitMs;
    while (!this.repo.tryAcquireLock(network, holder, this.opts.now(), this.opts.lockTtlMs)) {
      if (this.opts.now() >= deadline) {
        throw new AppError(503, ErrorCode.FAUCET_BUSY, "Another kit is being prepared on this fork; try again shortly");
      }
      await this.opts.sleep(this.opts.lockPollMs);
    }
  }
}
