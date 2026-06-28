import { StorageProvider } from "./types";
import { StubStorageProvider } from "./stub";
import { LocalStorageProvider } from "./local";
import { S3StorageProvider } from "./s3";

export function getStorageProvider(): StorageProvider {
  const providerType = process.env.STORAGE_PROVIDER?.toLowerCase() || "local";

  switch (providerType) {
    case "s3":
      return new S3StorageProvider();
    case "local":
      return new LocalStorageProvider();
    case "stub":
    default:
      return new StubStorageProvider();
  }
}

export default getStorageProvider;
