// Streaming hash calculation using Bun.CryptoHasher

/**
 * Transform stream that calculates SHA256 hash incrementally
 * while passing data through unchanged
 */
export class HashTransformStream extends TransformStream<
  Uint8Array,
  Uint8Array
> {
  private hasher: ReturnType<typeof Bun.CryptoHasher>;
  private expectedHash: string;
  private hashPromise: Promise<string> | null = null;

  constructor(expectedHash: string) {
    const hasher = new Bun.CryptoHasher("sha256");
    super({
      transform: (chunk, controller) => {
        // Update hash with this chunk
        hasher.update(chunk);
        // Pass chunk through unchanged
        controller.enqueue(chunk);
      },
      flush: () => {
        // Hash will be finalized when getFinalHash() is called
      },
    });
    this.hasher = hasher;
    this.expectedHash = expectedHash.toLowerCase();
  }

  /**
   * Get the final hash and validate it
   * Should be called after the stream completes
   */
  async getFinalHash(): Promise<string> {
    if (!this.hashPromise) {
      this.hashPromise = Promise.resolve(this.hasher.digest("hex"));
    }
    return this.hashPromise;
  }

  /**
   * Validate the computed hash against the expected hash
   */
  async validateHash(): Promise<boolean> {
    const computedHash = await this.getFinalHash();
    return computedHash.toLowerCase() === this.expectedHash;
  }
}

/**
 * Create a transform stream that calculates SHA256 hash incrementally
 * @param expectedHash - The expected SHA256 hash to validate against
 * @returns TransformStream that passes data through while calculating hash
 */
export function createHashStream(expectedHash: string): HashTransformStream {
  return new HashTransformStream(expectedHash);
}
