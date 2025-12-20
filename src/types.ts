// Type definitions for the Blossom proxy server

export interface ParsedRequest {
  sha256: string;
  extension?: string;
  authorPubkeys: string[];
  serverHints: string[];
}

