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
}
