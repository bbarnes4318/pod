import { StorageProvider } from "./interface";

export class StubStorageProvider implements StorageProvider {
  name = "stub-storage";

  async uploadFile(key: string, body: Buffer, contentType: string): Promise<string> {
    console.log(`[StubStorageProvider] uploadFile: ${key} (${body.length} bytes, type: ${contentType})`);
    return `http://localhost:3000/mock-storage/${key}`;
  }

  async getFileUrl(key: string): Promise<string> {
    console.log(`[StubStorageProvider] getFileUrl: ${key}`);
    return `http://localhost:3000/mock-storage/${key}`;
  }

  async deleteFile(key: string): Promise<void> {
    console.log(`[StubStorageProvider] deleteFile: ${key}`);
  }
}

export default StubStorageProvider;
