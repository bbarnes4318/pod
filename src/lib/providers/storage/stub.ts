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
}

export default StubStorageProvider;
