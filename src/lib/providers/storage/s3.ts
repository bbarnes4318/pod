import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
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
}
