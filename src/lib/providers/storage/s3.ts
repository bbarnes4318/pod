import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { StorageProvider } from "./types";

export class S3StorageProvider implements StorageProvider {
  name = "s3";

  private client: S3Client;
  private bucket: string;

  constructor() {
    const region = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1";
    this.bucket = process.env.S3_BUCKET || process.env.TTS_AUDIO_BUCKET || "";
    const endpoint = process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT;

    this.client = new S3Client({
      region,
      ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || "",
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || "",
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
      throw new Error("S3_BUCKET / TTS_AUDIO_BUCKET is not configured.");
    }

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
    });

    const result = await this.client.send(command);

    const endpoint = process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT;
    let url = "";
    if (process.env.S3_PUBLIC_BASE_URL) {
      url = `${process.env.S3_PUBLIC_BASE_URL}/${input.key}`;
    } else if (endpoint) {
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
      throw new Error("S3_BUCKET / TTS_AUDIO_BUCKET is not configured.");
    }

    let keyToUse = input.key;
    if (!keyToUse && input.url) {
      try {
        const parsed = new URL(input.url);
        const pathname = decodeURIComponent(parsed.pathname);
        const endpoint = process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT;
        if (endpoint && pathname.startsWith(`/${this.bucket}/`)) {
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
    if (!this.bucket) {
      throw new Error("S3_BUCKET / TTS_AUDIO_BUCKET is not configured.");
    }

    let keyToUse = input.key;
    if (!keyToUse && input.url) {
      try {
        const parsed = new URL(input.url);
        const endpoint = process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT;
        const endpointHost = endpoint ? new URL(endpoint).host : null;
        const publicBaseUrl = process.env.S3_PUBLIC_BASE_URL;
        const publicBaseUrlHost = publicBaseUrl ? new URL(publicBaseUrl).host : null;

        const isS3Host = parsed.host === `${this.bucket}.s3.amazonaws.com` || 
                         parsed.host === `s3.amazonaws.com` || 
                         (endpointHost && parsed.host === endpointHost) ||
                         (publicBaseUrlHost && parsed.host === publicBaseUrlHost);

        if (!isS3Host) {
          throw new Error(`Security Exception: S3 storage provider rejected external or arbitrary URL: ${input.url}`);
        }

        const pathname = decodeURIComponent(parsed.pathname);
        if (endpoint && pathname.startsWith(`/${this.bucket}/`)) {
          keyToUse = pathname.substring(this.bucket.length + 2);
        } else {
          keyToUse = pathname.startsWith("/") ? pathname.substring(1) : pathname;
        }
      } catch (e: any) {
        if (e.message.startsWith("Security Exception")) {
          throw e;
        }
        const match = input.url.match(/\/storage\/(.+)$/);
        if (match) {
          keyToUse = decodeURIComponent(match[1]);
        } else {
          throw new Error(`Security Exception: Invalid URL pattern: ${input.url}`);
        }
      }
    }

    if (!keyToUse) {
      throw new Error("Could not resolve S3 storage key from input.");
    }

    const command = new HeadObjectCommand({
      Bucket: this.bucket,
      Key: keyToUse,
    });

    const response = await this.client.send(command);
    return {
      sizeBytes: response.ContentLength || 0,
      contentType: response.ContentType,
      lastModified: response.LastModified,
      key: keyToUse,
      raw: response,
    };
  }
}
