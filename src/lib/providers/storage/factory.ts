import { StorageProvider } from "./interface";
import { StubStorageProvider } from "./stub";

export function getStorageProvider(): StorageProvider {
  const providerType = process.env.STORAGE_PROVIDER?.toLowerCase() || "stub";

  switch (providerType) {
    case "s3":
      console.log("[StorageFactory] S3 requested (not fully implemented in architectural stub phase). Falling back to Stub.");
      return new StubStorageProvider();
    case "stub":
    default:
      return new StubStorageProvider();
  }
}

export default getStorageProvider;
