import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { StorageProvider } from "./types";

export class S3StorageProvider implements StorageProvider {
  name = "s3";

  private client: S3Client;
  private bucket: string;

  constructor() {
    const region = process.env.AWS_REGION || "us-east-1";
    this.bucket = process.env.TTS_AUDIO_BUCKET || "";
    const endpoint = process.env.AWS_ENDPOINT;

    this.client = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
      },
    });
  }

  async putObject(input: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<{
    url: string;
    key: string;
    raw?: unknown;
  }> {
    if (!this.bucket) {
      throw new Error("TTS_AUDIO_BUCKET is not configured.");
    }

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    });

    const result = await this.client.send(command);

    const endpoint = process.env.AWS_ENDPOINT;
    let url = "";
    if (endpoint) {
      url = `${endpoint}/${this.bucket}/${input.key}`;
    } else {
      url = `https://${this.bucket}.s3.amazonaws.com/${input.key}`;
    }

    return {
      url,
      key: input.key,
      raw: result,
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
    if (!this.bucket) {
      throw new Error("TTS_AUDIO_BUCKET is not configured.");
    }

    let keyToUse = input.key;
    if (!keyToUse && input.url) {
      try {
        const parsed = new URL(input.url);
        const pathname = decodeURIComponent(parsed.pathname);
        if (process.env.AWS_ENDPOINT && pathname.startsWith(`/${this.bucket}/`)) {
          keyToUse = pathname.substring(this.bucket.length + 2);
        } else {
          keyToUse = pathname.startsWith("/") ? pathname.substring(1) : pathname;
        }
      } catch {
        // Fallback to simple matching if URL is relative or parse fails
        const match = input.url.match(/\/storage\/(.+)$/);
        if (match) {
          keyToUse = decodeURIComponent(match[1]);
        }
      }
    }

    if (!keyToUse) {
      throw new Error("Could not resolve S3 storage key from input.");
    }

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: keyToUse,
    });

    const response = await this.client.send(command);
    if (!response.Body) {
      throw new Error(`S3 object not found or body is empty for key: ${keyToUse}`);
    }

    const body = Buffer.from(await response.Body.transformToByteArray());
    return {
      body,
      contentType: response.ContentType,
      key: keyToUse,
      raw: response,
    };
  }
}
