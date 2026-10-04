export class HealthService {
  /** `ping` throws when the database is unusable. */
  constructor(private readonly ping: () => void) {}

  isReady(): boolean {
    try {
      this.ping();
      return true;
    } catch {
      return false;
    }
  }
}
