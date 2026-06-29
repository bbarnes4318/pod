export interface StorageProvider {
  name: string;
  putObject(input: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<{
    url: string;
    key: string;
    raw?: unknown;
  }>;
  getObject(input: {
    key?: string;
    url?: string;
  }): Promise<{
    body: Buffer;
    contentType?: string;
    key?: string;
    raw?: unknown;
  }>;
  headObject(input: {
    key?: string;
    url?: string;
  }): Promise<{
    sizeBytes: number;
    contentType?: string;
    lastModified?: Date;
    key?: string;
    raw?: unknown;
  }>;
}
