import fs from "fs";
import path from "path";
import { StorageProvider } from "./types";

export class LocalStorageProvider implements StorageProvider {
  name = "local";

  async putObject(input: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<{
    url: string;
    key: string;
    raw?: unknown;
  }> {
    const storageDir = path.join(process.cwd(), "public", "storage");
    const targetPath = path.join(storageDir, input.key);

    // Ensure parent directories exist
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });

    // Write file
    fs.writeFileSync(targetPath, input.body);

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const url = `${baseUrl}/storage/${input.key}`;

    return {
      url,
      key: input.key,
    };
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
    let keyToUse = input.key;
    if (!keyToUse && input.url) {
      const match = input.url.match(/\/storage\/(.+)$/);
      if (match) {
        keyToUse = decodeURIComponent(match[1]);
      }
    }

    if (!keyToUse) {
      throw new Error("Could not resolve local storage key from input.");
    }

    const storageDir = path.join(process.cwd(), "public", "storage");
    const targetPath = path.join(storageDir, keyToUse);

    if (!fs.existsSync(targetPath)) {
      throw new Error(`Local file not found at path: ${targetPath}`);
    }

    const body = fs.readFileSync(targetPath);
    return {
      body,
      key: keyToUse,
    };
  }
}
