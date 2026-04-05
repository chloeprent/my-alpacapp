/**
 * Cloudflare R2 upload helper using S3-compatible API with AWS Signature V4.
 *
 * Usage:
 *   import { uploadToR2, deleteFromR2, getR2PublicUrl } from "../_shared/r2-upload.ts";
 *   const url = await uploadToR2("documents/manual.pdf", pdfBytes, "application/pdf");
 */

// ── AWS Signature V4 helpers ──────────────────────────────────────────────────

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key instanceof ArrayBuffer ? key : key.buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
}

async function sha256(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return toHex(hash);
}

async function getSigningKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(new TextEncoder().encode("AWS4" + secretKey), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

// ── R2 config from env ────────────────────────────────────────────────────────

interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl: string;
}

function getR2Config(): R2Config {
  const accountId = Deno.env.get("R2_ACCOUNT_ID");
  const accessKeyId = Deno.env.get("R2_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("R2_SECRET_ACCESS_KEY");
  const bucketName = Deno.env.get("R2_BUCKET_NAME") || "yourorg";
  const publicUrl = Deno.env.get("R2_PUBLIC_URL") || "";

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 credentials not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY)");
  }

  return { accountId, accessKeyId, secretAccessKey, bucketName, publicUrl };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upload a file to R2.
 * @param key - Object key (path), e.g. "documents/manual.pdf"
 * @param body - File content as Uint8Array
 * @param contentType - MIME type
 * @returns Public URL of the uploaded object
 */
export async function uploadToR2(
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<string> {
  const cfg = getR2Config();
  const endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com`;
  const region = "auto";
  const service = "s3";

  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, ""); // YYYYMMDD
  const amzDate = dateStamp + "T" + now.toISOString().slice(11, 19).replace(/:/g, "") + "Z"; // YYYYMMDDTHHMMSSZ

  const method = "PUT";
  const canonicalUri = `/${cfg.bucketName}/${key}`;
  const canonicalQuerystring = "";
  const payloadHash = await sha256(body);

  const headers: Record<string, string> = {
    "content-type": contentType,
    host: `${cfg.accountId}.r2.cloudflarestorage.com`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  // Build canonical headers (sorted by key)
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}`).join("\n") + "\n";
  const signedHeaders = sortedKeys.join(";");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");

  const signingKey = await getSigningKey(cfg.secretAccessKey, dateStamp, region, service);
  const signatureBuffer = await hmacSha256(signingKey, stringToSign);
  const signature = toHex(signatureBuffer);

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`${endpoint}${canonicalUri}`, {
    method,
    headers: {
      ...headers,
      Authorization: authorization,
    },
    body,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`R2 upload failed (${response.status}): ${errText}`);
  }

  // Return the public URL
  return cfg.publicUrl
    ? `${cfg.publicUrl.replace(/\/$/, "")}/${key}`
    : `${endpoint}/${cfg.bucketName}/${key}`;
}

/**
 * Delete an object from R2.
 * @param key - Object key (path) to delete
 */
export async function deleteFromR2(key: string): Promise<void> {
  const cfg = getR2Config();
  const endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com`;
  const region = "auto";
  const service = "s3";

  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const amzDate = dateStamp + "T" + now.toISOString().slice(11, 19).replace(/:/g, "") + "Z";

  const method = "DELETE";
  const canonicalUri = `/${cfg.bucketName}/${key}`;
  const emptyHash = await sha256(new Uint8Array(0));

  const headers: Record<string, string> = {
    host: `${cfg.accountId}.r2.cloudflarestorage.com`,
    "x-amz-content-sha256": emptyHash,
    "x-amz-date": amzDate,
  };

  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}`).join("\n") + "\n";
  const signedHeaders = sortedKeys.join(";");

  const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, emptyHash].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256(new TextEncoder().encode(canonicalRequest)),
  ].join("\n");

  const signingKey = await getSigningKey(cfg.secretAccessKey, dateStamp, region, service);
  const signature = toHex(await hmacSha256(signingKey, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(`${endpoint}${canonicalUri}`, {
    method,
    headers: { ...headers, Authorization: authorization },
  });

  if (!response.ok && response.status !== 404) {
    const errText = await response.text();
    throw new Error(`R2 delete failed (${response.status}): ${errText}`);
  }
}

/**
 * Get the public URL for an R2 object.
 * @param key - Object key (path)
 */
export function getR2PublicUrl(key: string): string {
  const publicUrl = Deno.env.get("R2_PUBLIC_URL") || "";
  if (publicUrl) {
    return `${publicUrl.replace(/\/$/, "")}/${key}`;
  }
  const accountId = Deno.env.get("R2_ACCOUNT_ID") || "";
  const bucketName = Deno.env.get("R2_BUCKET_NAME") || "yourorg";
  return `https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${key}`;
}
