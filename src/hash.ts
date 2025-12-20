// Hash validation utilities

/**
 * Compute SHA-256 hash of data
 */
export async function computeSha256(data: Blob | ArrayBuffer): Promise<string> {
  const buffer = data instanceof ArrayBuffer ? new Uint8Array(data) : await data.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validate that data matches the expected SHA-256 hash
 */
export async function validateHash(data: Blob | ArrayBuffer, expectedHash: string): Promise<boolean> {
  const computedHash = await computeSha256(data);
  return computedHash.toLowerCase() === expectedHash.toLowerCase();
}

