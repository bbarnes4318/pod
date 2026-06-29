import { StorageProvider } from "./types";

export class StubStorageProvider implements StorageProvider {
  name = "stub";

  async putObject(input: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<{
    url: string;
    key: string;
    raw?: unknown;
  }> {
    throw new Error("Storage provider is stub. Real file upload is disabled. Please configure 'local' or 's3' storage provider.");
  }

  async getObject(input: {
    key?: string;
    url?: string;
  }): Promise<{
    body: Buffer;
    contentType?: string;
    key?: string;
    raw?: unknown;
  }> {
    throw new Error("Storage provider is stub. Real file retrieval is disabled. Please configure 'local' or 's3' storage provider.");
  }

  async headObject(input: {
    key?: string;
    url?: string;
  }): Promise<{
    sizeBytes: number;
    contentType?: string;
    lastModified?: Date;
    key?: string;
    raw?: unknown;
  }> {
    throw new Error("Storage provider is stub. Real file head check is disabled. Please configure 'local' or 's3' storage provider.");
  }
}

export default StubStorageProvider;
