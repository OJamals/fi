#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSettingsPath = path.join(root, "src", "provider-settings.json");
const defaultSettingsPath = existsSync(sourceSettingsPath)
  ? sourceSettingsPath
  : path.join(root, "dist", "provider-settings.json");

const RELEASE_PROVIDERS = [
  {
    provider: "grokCode",
    displayName: "grok-code",
    versionField: "version",
    responseFormat: "text",
    releaseUrl: "https://x.ai/cli/stable",
  },
  {
    provider: "claudeCode",
    displayName: "Claude Code",
    versionField: "latestReleaseVersion",
    responseFormat: "json",
    releaseUrl: "https://registry.npmjs.org/@anthropic-ai/claude-code/latest",
  },
  {
    provider: "codexCli",
    displayName: "codex-cli",
    versionField: "version",
    responseFormat: "json",
    releaseUrl: "https://registry.npmjs.org/@openai/codex/latest",
  },
  {
    provider: "antigravityCli",
    displayName: "Antigravity CLI",
    versionField: "latestReleaseVersion",
    responseFormat: "antigravity-manifest",
    verifiedArtifactName: "agy_cli_mac_arm64.tar.gz",
    releaseUrl:
      "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json",
    corroborationUrl:
      "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest",
  },
];

const MAX_VERIFIED_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_RELEASE_METADATA_BYTES = 1024 * 1024;
const RELEASE_EVIDENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVIDENCE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const RETRY_DELAYS_MS = [250, 1_000];
const MAX_RETRY_AFTER_MS = 10_000;

const CAPTURE_GATED_FIELDS = {
  claudeCode: [
    "version",
    "fingerprintCapturedVersion",
    "fingerprintEvidence",
    "entrypoint",
    "oauth",
    "stainless",
    "messageBetas",
    "haikuMessageBetas",
    "countTokensBetas",
    "haikuCountTokensBetas",
  ],
  antigravityCli: [
    "version",
    "fingerprintCapturedVersion",
    "client",
    "build",
    "authMethod",
    "apiBaseUrl",
    "projectDiscoveryUrl",
    "oauth",
  ],
};

export function assertVersion(provider, value) {
  if (
    typeof value !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  ) {
    const rendered = JSON.stringify(value);
    const boundedValue =
      typeof rendered === "string" && rendered.length > 160
        ? `${rendered.slice(0, 157)}...`
        : rendered;
    throw new Error(`${provider} returned invalid version: ${boundedValue}`);
  }
  return value;
}

function comparePrerelease(left, right) {
  if (left === right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const count = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index++) {
    const a = leftParts[index];
    const b = rightParts[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function compareVersions(left, right) {
  assertVersion("candidate", left);
  assertVersion("current", right);
  const parse = (value) => {
    const [withoutBuild] = value.split("+");
    const separator = withoutBuild.indexOf("-");
    const core =
      separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
    const prerelease =
      separator === -1 ? "" : withoutBuild.slice(separator + 1);
    return { core: core.split(".").map(BigInt), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] < b.core[index] ? -1 : 1;
    }
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

class RetryableFetchError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.retryAfterMs = retryAfterMs;
  }
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function retryAfterMs(response) {
  const value = response.headers.get("retry-after");
  if (value === null) return null;
  if (/^\d+$/.test(value.trim())) {
    return Math.min(Number(value.trim()) * 1_000, MAX_RETRY_AFTER_MS);
  }
  const retryAt = Date.parse(value);
  const responseDate = Date.parse(response.headers.get("date") || "");
  if (!Number.isFinite(retryAt) || !Number.isFinite(responseDate)) return null;
  return Math.min(Math.max(retryAt - responseDate, 0), MAX_RETRY_AFTER_MS);
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableNetworkError(error) {
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "TimeoutError") ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

async function withRetries(operation, sleep) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const retryable =
        error instanceof RetryableFetchError || isRetryableNetworkError(error);
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
      const requestedDelay =
        error instanceof RetryableFetchError ? error.retryAfterMs : null;
      await sleep(requestedDelay ?? RETRY_DELAYS_MS[attempt]);
    }
  }
}

function assertTrustedReleaseSource(definition, url, field = "releaseUrl") {
  if (url !== definition[field]) {
    throw new Error(
      `${definition.displayName} ${field} is not the trusted public source`,
    );
  }
}

function assertTrustedAntigravityArtifactUrl(provider, rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${provider} returned untrusted artifact URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname !== "storage.googleapis.com" ||
    !url.pathname.startsWith("/antigravity-public/antigravity-cli/")
  ) {
    throw new Error(`${provider} returned untrusted artifact URL`);
  }
}

function assertTrustedGithubReleaseUrls(provider, metadata, version) {
  const tagName = metadata.tagName;
  if (tagName !== version && tagName !== `v${version}`) {
    throw new Error(`${provider} returned invalid release tag`);
  }
  const releaseUrl = `https://github.com/google-antigravity/antigravity-cli/releases/tag/${tagName}`;
  if (metadata.releasePageUrl !== releaseUrl) {
    throw new Error(`${provider} returned untrusted release page URL`);
  }
  const assetPrefix = `https://github.com/google-antigravity/antigravity-cli/releases/download/${tagName}/`;
  if (
    metadata.artifacts.some((artifact) => !artifact.url.startsWith(assetPrefix))
  ) {
    throw new Error(`${provider} returned untrusted artifact URL`);
  }
}

async function fetchWithTimeout(url, fetchImpl, { accept, timeoutMs, sleep }) {
  return withRetries(async () => {
    const response = await fetchImpl(url, {
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: accept,
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "User-Agent": "auth2api-provider-settings-updater",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return response;
    await response.body?.cancel();
    const message = `${url} returned ${response.status}`;
    if (isRetryableStatus(response.status)) {
      throw new RetryableFetchError(message, retryAfterMs(response));
    }
    throw new Error(message);
  }, sleep);
}

async function readBoundedResponse(response, maxBytes, label) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    await response.body?.cancel();
    throw new Error(`${label} exceeds size limit`);
  }
  if (!response.body) throw new Error(`${label} omitted body`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      throw new Error(`${label} exceeds size limit`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function parseReleaseArtifacts(provider, assets) {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error(`${provider} returned invalid release metadata`);
  }

  return assets.map((asset) => {
    if (
      !asset ||
      typeof asset !== "object" ||
      typeof asset.name !== "string" ||
      typeof asset.browser_download_url !== "string"
    ) {
      throw new Error(`${provider} returned invalid release metadata`);
    }

    const match = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || "");
    if (!match) {
      throw new Error(
        `${provider} returned invalid artifact digest for ${asset.name}`,
      );
    }

    return {
      name: asset.name,
      url: asset.browser_download_url,
      sha256: match[1].toLowerCase(),
    };
  });
}

async function verifyArtifact(provider, artifact, fetchImpl, sleep) {
  const response = await fetchWithTimeout(artifact.url, fetchImpl, {
    accept: "application/octet-stream",
    timeoutMs: 60_000,
    sleep,
  });
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_VERIFIED_ARTIFACT_BYTES
  ) {
    await response.body?.cancel();
    throw new Error(`${provider} artifact exceeds verification size limit`);
  }
  if (!response.body) {
    throw new Error(`${provider} artifact response omitted body`);
  }
  const sha256Digest = createHash("sha256");
  const sha512Digest = artifact.sha512 ? createHash("sha512") : null;
  let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_VERIFIED_ARTIFACT_BYTES) {
      throw new Error(`${provider} artifact exceeds verification size limit`);
    }
    sha256Digest.update(bytes);
    sha512Digest?.update(bytes);
  }
  if (size === 0) {
    throw new Error(`${provider} artifact is empty`);
  }
  const sha256 = sha256Digest.digest("hex");
  const sha512 = sha512Digest?.digest("hex");
  if (artifact.sha256 && sha256 !== artifact.sha256) {
    throw new Error(`${provider} artifact digest verification failed`);
  }
  if (artifact.sha512 && sha512 !== artifact.sha512) {
    throw new Error(`${provider} artifact digest verification failed`);
  }
  return { ...artifact, sha256, ...(sha512 ? { sha512 } : {}), size };
}

function parseReleaseMetadata(provider, responseFormat, rawText) {
  if (responseFormat === "text") {
    return { version: assertVersion(provider, rawText.trim()) };
  }

  let metadata;
  try {
    metadata = JSON.parse(rawText);
  } catch {
    throw new Error(`${provider} returned invalid release metadata`);
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${provider} returned invalid release metadata`);
  }

  if (responseFormat === "github-release") {
    if (typeof metadata.tag_name !== "string") {
      throw new Error(`${provider} returned invalid release metadata`);
    }
    const tagVersion = metadata.tag_name.replace(/^v(?=\d)/, "");
    return {
      version: assertVersion(provider, tagVersion),
      tagName: metadata.tag_name,
      releasePageUrl:
        typeof metadata.html_url === "string" ? metadata.html_url : null,
      publishedAt:
        typeof metadata.published_at === "string"
          ? metadata.published_at
          : null,
      draft: metadata.draft,
      prerelease: metadata.prerelease,
      artifacts: parseReleaseArtifacts(provider, metadata.assets),
    };
  }

  if (responseFormat === "antigravity-manifest") {
    if (
      typeof metadata.url !== "string" ||
      !/^https:\/\//.test(metadata.url) ||
      typeof metadata.sha512 !== "string" ||
      !/^[0-9a-f]{128}$/i.test(metadata.sha512)
    ) {
      throw new Error(`${provider} returned invalid release metadata`);
    }
    let name;
    try {
      name = path.posix.basename(new URL(metadata.url).pathname);
    } catch {
      throw new Error(`${provider} returned invalid release metadata`);
    }
    return {
      version: assertVersion(provider, metadata.version),
      artifact: {
        name,
        url: metadata.url,
        sha512: metadata.sha512.toLowerCase(),
      },
    };
  }

  return { version: assertVersion(provider, metadata.version) };
}

async function readReleaseMetadata(
  provider,
  url,
  responseFormat,
  fetchImpl,
  sleep,
) {
  const response = await fetchWithTimeout(url, fetchImpl, {
    accept: "application/json, text/plain;q=0.9",
    timeoutMs: 30_000,
    sleep,
  });
  const responseBytes = await readBoundedResponse(
    response,
    MAX_RELEASE_METADATA_BYTES,
    `${provider} release metadata`,
  );
  let rawText;
  try {
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
  } catch {
    throw new Error(`${provider} returned invalid release metadata`);
  }
  return {
    metadata: parseReleaseMetadata(provider, responseFormat, rawText),
    sha256: createHash("sha256").update(responseBytes).digest("hex"),
  };
}

async function collectAntigravityRelease(
  settings,
  definition,
  fetchImpl,
  sleep,
) {
  const providerSettings = settings[definition.provider];
  const sourceUrl = providerSettings?.releaseUrl;
  const corroborationUrl = providerSettings?.corroborationUrl;
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) {
    throw new Error(`${definition.displayName} releaseUrl is not configured`);
  }
  assertTrustedReleaseSource(definition, sourceUrl);
  if (typeof corroborationUrl !== "string" || corroborationUrl.length === 0) {
    throw new Error(
      `${definition.displayName} corroborationUrl is not configured`,
    );
  }
  assertTrustedReleaseSource(definition, corroborationUrl, "corroborationUrl");

  const [primary, corroborating] = await Promise.all([
    readReleaseMetadata(
      definition.displayName,
      sourceUrl,
      "antigravity-manifest",
      fetchImpl,
      sleep,
    ),
    readReleaseMetadata(
      definition.displayName,
      corroborationUrl,
      "github-release",
      fetchImpl,
      sleep,
    ),
  ]);
  if (primary.metadata.version !== corroborating.metadata.version) {
    throw new Error(
      `${definition.displayName} release sources disagree: ` +
        `${primary.metadata.version} != ${corroborating.metadata.version}`,
    );
  }
  if (
    corroborating.metadata.draft !== false ||
    corroborating.metadata.prerelease !== false
  ) {
    throw new Error(`${definition.displayName} corroboration is not stable`);
  }
  assertTrustedAntigravityArtifactUrl(
    definition.displayName,
    primary.metadata.artifact.url,
  );
  assertTrustedGithubReleaseUrls(
    definition.displayName,
    corroborating.metadata,
    primary.metadata.version,
  );
  const currentVersion = providerSettings[definition.versionField];
  if (
    typeof currentVersion === "string" &&
    compareVersions(primary.metadata.version, currentVersion) < 0
  ) {
    throw new Error(
      `${definition.displayName} release would downgrade ${currentVersion} to ${primary.metadata.version}`,
    );
  }

  const githubArtifact = corroborating.metadata.artifacts.find(
    (item) => item.name === definition.verifiedArtifactName,
  );
  if (!githubArtifact) {
    throw new Error(
      `${definition.displayName} release omitted ${definition.verifiedArtifactName}`,
    );
  }
  const artifact = {
    ...primary.metadata.artifact,
    sha256: githubArtifact.sha256,
  };
  const previous = providerSettings.releaseEvidence?.verifiedArtifact;
  const alreadyVerified =
    providerSettings.releaseEvidence?.version === primary.metadata.version &&
    previous?.name === artifact.name &&
    previous?.url === artifact.url &&
    previous?.sha256 === artifact.sha256 &&
    previous?.sha512 === artifact.sha512 &&
    Number.isSafeInteger(previous?.size) &&
    previous.size > 0;
  const verifiedArtifact = alreadyVerified
    ? previous
    : await verifyArtifact(definition.displayName, artifact, fetchImpl, sleep);

  return {
    provider: definition.provider,
    versionField: definition.versionField,
    sourceUrl,
    sha256: primary.sha256,
    candidateValue: primary.metadata.version,
    artifact: primary.metadata.artifact,
    corroboration: {
      sourceUrl: corroborationUrl,
      responseSha256: corroborating.sha256,
      releasePageUrl: corroborating.metadata.releasePageUrl,
      publishedAt: corroborating.metadata.publishedAt,
      artifacts: corroborating.metadata.artifacts,
    },
    verifiedArtifact,
  };
}

function isoTimestamp(now) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Provider settings updater received an invalid timestamp");
  }
  return date.toISOString();
}

async function collectReleaseProvider(settings, definition, fetchImpl, sleep) {
  const providerSettings = settings[definition.provider];
  if (definition.provider === "antigravityCli") {
    return collectAntigravityRelease(settings, definition, fetchImpl, sleep);
  }
  const sourceUrl = providerSettings?.releaseUrl;
  if (typeof sourceUrl !== "string" || sourceUrl.length === 0) {
    throw new Error(`${definition.displayName} releaseUrl is not configured`);
  }
  assertTrustedReleaseSource(definition, sourceUrl);

  const response = await fetchWithTimeout(sourceUrl, fetchImpl, {
    accept: "application/json, text/plain;q=0.9",
    timeoutMs: 30_000,
    sleep,
  });
  const responseBytes = await readBoundedResponse(
    response,
    MAX_RELEASE_METADATA_BYTES,
    `${definition.displayName} release metadata`,
  );
  let rawText;
  try {
    rawText = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
  } catch {
    throw new Error(
      `${definition.displayName} returned invalid release metadata`,
    );
  }
  const metadata = parseReleaseMetadata(
    definition.displayName,
    definition.responseFormat,
    rawText,
  );
  const currentVersion = providerSettings[definition.versionField];
  if (
    typeof currentVersion === "string" &&
    compareVersions(metadata.version, currentVersion) < 0
  ) {
    throw new Error(
      `${definition.displayName} release would downgrade ${currentVersion} to ${metadata.version}`,
    );
  }

  let verifiedArtifact;
  if (definition.verifiedArtifactName) {
    const artifact = metadata.artifacts?.find(
      (item) => item.name === definition.verifiedArtifactName,
    );
    if (!artifact) {
      throw new Error(
        `${definition.displayName} release omitted ${definition.verifiedArtifactName}`,
      );
    }
    const previous = providerSettings.releaseEvidence?.verifiedArtifact;
    const alreadyVerified =
      providerSettings.releaseEvidence?.version === metadata.version &&
      previous?.name === artifact.name &&
      previous?.url === artifact.url &&
      previous?.sha256 === artifact.sha256 &&
      Number.isSafeInteger(previous?.size) &&
      previous.size > 0;
    verifiedArtifact = alreadyVerified
      ? previous
      : await verifyArtifact(
          definition.displayName,
          artifact,
          fetchImpl,
          sleep,
        );
  }

  return {
    provider: definition.provider,
    versionField: definition.versionField,
    sourceUrl,
    sha256: createHash("sha256").update(responseBytes).digest("hex"),
    candidateValue: metadata.version,
    releasePageUrl: metadata.releasePageUrl,
    artifacts: metadata.artifacts,
    verifiedArtifact,
  };
}

function releaseEvidence(candidate, version) {
  return {
    version,
    sourceUrl: candidate.sourceUrl,
    retrievedAt: candidate.retrievedAt,
    responseSha256: candidate.sha256,
    ...(typeof candidate.releasePageUrl === "string"
      ? { releasePageUrl: candidate.releasePageUrl }
      : {}),
    ...(candidate.artifacts !== undefined
      ? { artifacts: candidate.artifacts }
      : {}),
    ...(candidate.artifact !== undefined
      ? { artifact: candidate.artifact }
      : {}),
    ...(candidate.corroboration !== undefined
      ? { corroboration: candidate.corroboration }
      : {}),
    ...(candidate.verifiedArtifact !== undefined
      ? { verifiedArtifact: candidate.verifiedArtifact }
      : {}),
  };
}

function sameArtifact(left, right) {
  if (!left || !right) return false;
  return (
    left.name === right.name &&
    left.url === right.url &&
    left.sha256 === right.sha256 &&
    left.sha512 === right.sha512
  );
}

function sameArtifactSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  const byName = (a, b) => a.name.localeCompare(b.name);
  const a = [...left].sort(byName);
  const b = [...right].sort(byName);
  return a.every((artifact, index) => sameArtifact(artifact, b[index]));
}

function hasCurrentEvidence(settings, provider, candidate, version) {
  const evidence = settings[provider].releaseEvidence;
  const currentTime = Date.parse(candidate.retrievedAt);
  const evidenceTime = Date.parse(evidence?.retrievedAt || "");
  const evidenceAge = currentTime - evidenceTime;
  if (
    evidence?.version !== version ||
    evidence?.sourceUrl !== candidate.sourceUrl ||
    typeof evidence?.retrievedAt !== "string" ||
    evidence?.responseSha256 !== candidate.sha256 ||
    !Number.isFinite(evidenceTime) ||
    evidenceAge < -MAX_EVIDENCE_CLOCK_SKEW_MS ||
    evidenceAge > RELEASE_EVIDENCE_TTL_MS
  ) {
    return false;
  }
  if (
    candidate.artifact &&
    !sameArtifact(evidence.artifact, candidate.artifact)
  ) {
    return false;
  }
  if (candidate.corroboration) {
    const corroboration = evidence.corroboration;
    if (
      corroboration?.sourceUrl !== candidate.corroboration.sourceUrl ||
      !/^[0-9a-f]{64}$/.test(corroboration?.responseSha256 || "") ||
      corroboration?.releasePageUrl !==
        candidate.corroboration.releasePageUrl ||
      corroboration?.publishedAt !== candidate.corroboration.publishedAt ||
      !sameArtifactSet(
        corroboration?.artifacts,
        candidate.corroboration.artifacts,
      )
    ) {
      return false;
    }
  }
  if (candidate.verifiedArtifact) {
    const verified = evidence.verifiedArtifact;
    if (
      verified?.name !== candidate.verifiedArtifact.name ||
      verified?.url !== candidate.verifiedArtifact.url ||
      verified?.sha256 !== candidate.verifiedArtifact.sha256 ||
      verified?.sha512 !== candidate.verifiedArtifact.sha512 ||
      verified?.size !== candidate.verifiedArtifact.size
    ) {
      return false;
    }
  }
  return true;
}

function releaseField(field, currentValue, candidateValue) {
  return {
    field,
    currentValue,
    candidateValue,
    risk: "low",
    decision: "allowlisted",
    reason: "allowlisted release-version update",
  };
}

function captureGatedField(settings, provider, field, candidateVersion) {
  return {
    field,
    currentValue: settings[provider][field],
    candidateValue:
      field === "version" || field === "fingerprintCapturedVersion"
        ? candidateVersion
        : null,
    risk: "high",
    decision: "gated",
    reason: "exact-version capture evidence required",
  };
}

export async function collectProviderCandidates(
  settings,
  { fetchImpl = fetch, now = () => new Date(), sleep = defaultSleep } = {},
) {
  const releases = await Promise.all(
    RELEASE_PROVIDERS.map((definition) =>
      collectReleaseProvider(settings, definition, fetchImpl, sleep),
    ),
  );
  const retrievedAt = isoTimestamp(now);
  const providers = {};

  for (const release of releases) {
    providers[release.provider] = {
      sourceUrl: release.sourceUrl,
      ...(release.releasePageUrl !== undefined
        ? { releasePageUrl: release.releasePageUrl }
        : {}),
      retrievedAt,
      sha256: release.sha256,
      ...(release.artifacts !== undefined
        ? { artifacts: release.artifacts }
        : {}),
      ...(release.artifact !== undefined ? { artifact: release.artifact } : {}),
      ...(release.corroboration !== undefined
        ? { corroboration: release.corroboration }
        : {}),
      ...(release.verifiedArtifact !== undefined
        ? { verifiedArtifact: release.verifiedArtifact }
        : {}),
      fields: [
        releaseField(
          release.versionField,
          settings[release.provider][release.versionField],
          release.candidateValue,
        ),
      ],
    };
  }

  for (const [provider, fields] of Object.entries(CAPTURE_GATED_FIELDS)) {
    const release = releases.find((item) => item.provider === provider);
    providers[provider].fields.push(
      ...fields.map((field) =>
        captureGatedField(settings, provider, field, release.candidateValue),
      ),
    );
  }

  return { retrievedAt, providers };
}

export async function latestVersions(settings, fetchImpl = fetch) {
  const snapshot = await collectProviderCandidates(settings, { fetchImpl });
  return Object.fromEntries(
    RELEASE_PROVIDERS.map(({ provider }) => [
      provider,
      snapshot.providers[provider].fields[0].candidateValue,
    ]),
  );
}

async function writeJsonAtomically(settingsPath, serializedSettings) {
  let mode = 0o644;
  try {
    mode = (await fs.stat(settingsPath)).mode;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = path.join(
    path.dirname(settingsPath),
    `.${path.basename(settingsPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", mode);
    await handle.writeFile(serializedSettings);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, settingsPath);
  } finally {
    await handle?.close();
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function updateProviderSettings({
  settingsPath = defaultSettingsPath,
  outputPath = settingsPath,
  checkOnly = false,
  fetchImpl = fetch,
  now = () => new Date(),
  sleep = defaultSleep,
} = {}) {
  const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
  const candidateSnapshot = await collectProviderCandidates(settings, {
    fetchImpl,
    now,
    sleep,
  });
  const latest = {};
  const changes = [];
  const evidenceChanges = [];

  for (const { provider, versionField } of RELEASE_PROVIDERS) {
    const candidate = candidateSnapshot.providers[provider];
    const field = candidate.fields[0];
    const version = field.candidateValue;
    latest[provider] = version;
    const previous = settings[provider][versionField];
    field.decision = previous === version ? "unchanged" : "would-apply";
    if (previous !== version) {
      if (!checkOnly) {
        settings[provider][versionField] = version;
        field.decision = "applied";
      }
      changes.push({
        provider,
        previous,
        version,
        versionField,
        risk: field.risk,
        decision: field.decision,
        origin: {
          sourceUrl: candidate.sourceUrl,
          retrievedAt: candidate.retrievedAt,
          sha256: candidate.sha256,
        },
      });
    }
    if (!hasCurrentEvidence(settings, provider, candidate, version)) {
      const evidence = releaseEvidence(candidate, version);
      evidenceChanges.push({
        provider,
        decision: checkOnly ? "would-record" : "recorded",
        evidence,
      });
      if (!checkOnly) settings[provider].releaseEvidence = evidence;
    }
  }

  const serializedSettings = `${JSON.stringify(settings, null, 2)}\n`;
  let outputChanged;
  if (path.resolve(outputPath) === path.resolve(settingsPath)) {
    outputChanged = changes.length > 0 || evidenceChanges.length > 0;
  } else {
    let currentOutput = null;
    try {
      currentOutput = await fs.readFile(outputPath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    outputChanged = currentOutput !== serializedSettings;
  }
  if (!checkOnly && outputChanged) {
    await writeJsonAtomically(outputPath, serializedSettings);
  }

  const staleFingerprints = Object.keys(CAPTURE_GATED_FIELDS).filter(
    (provider) =>
      settings[provider].fingerprintCapturedVersion !== latest[provider],
  );
  const fingerprintStale = staleFingerprints.length > 0;

  return {
    candidateSnapshot,
    changes,
    evidenceChanges,
    outputChanged,
    outputPath,
    fingerprintStale,
    staleFingerprints,
    hasDrift:
      changes.length > 0 ||
      evidenceChanges.length > 0 ||
      outputChanged ||
      staleFingerprints.length > 0,
    latest,
    settings,
  };
}

async function main() {
  const checkOnly = process.argv.includes("--check");
  const result = await updateProviderSettings({ checkOnly });

  if (result.changes.length === 0) {
    console.log(
      checkOnly
        ? "Provider release settings are current."
        : "Provider release settings already current.",
    );
  } else {
    for (const change of result.changes) {
      const output = `${change.provider}: ${change.previous} -> ${change.version}`;
      (checkOnly ? console.error : console.log)(output);
    }
  }

  for (const provider of result.staleFingerprints) {
    const captured = result.settings[provider].fingerprintCapturedVersion;
    console.error(
      `${provider} ${result.latest[provider]} needs a fresh protocol capture; ` +
        `current fingerprint is from ${captured}.`,
    );
  }

  for (const change of result.evidenceChanges) {
    const verb = checkOnly ? "needs release evidence" : "recorded evidence";
    console.log(`${change.provider}: ${verb}`);
  }

  if (checkOnly && result.hasDrift) {
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
