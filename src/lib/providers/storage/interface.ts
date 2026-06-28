export interface StorageProvider {
  name: string;
  uploadFile(key: string, body: Buffer, contentType: string): Promise<string>;
  getFileUrl(key: string): Promise<string>;
  deleteFile(key: string): Promise<void>;
}
