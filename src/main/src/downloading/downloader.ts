import { once } from "node:events";
import { type FileHandle as NodeFileHandle, access, open } from "node:fs/promises";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from "node:http";

import { getErrorCode } from "@vortex/shared";
import { VortexError, parseError } from "@vortex/shared";
import type {
  ByteRange,
  Chunk,
  Chunker,
  ChunkProgress,
  ResolvedEndpoint,
  Resolver,
  RetryStrategy,
} from "@vortex/shared/download";
import type { Got, Headers, ExtendOptions } from "got";
import got from "got";
import type { RateLimiter } from "limiter";
import PQueue from "p-queue";
import type { CookieJar } from "tough-cookie";

import { isCancellation } from "../transfer/cancellation";
import { withRetry } from "../transfer/retry";
import type { TimeoutOptions } from "../transfer/timeouts";
import { createGotTimeoutOptions } from "../transfer/timeouts";
import { toNetworkError } from "./errors";
import type { ProgressReporter } from "./progress";
import type { NormalizedResource } from "./resolver";
import { normalize } from "./resolver";

export const defaultChunkConcurrency = 4;

/** @internal */
export type Checkpoint = {
  etag: string | undefined;
  completedRanges: ByteRange[];
};

export type { TimeoutOptions };

/** @internal */
export async function download<T>(
  resource: T,
  dest: string,
  strategy: {
    resolver: Resolver<T>;
    chunker: Chunker<T>;
    rateLimiter?: RateLimiter;
    retry?: RetryStrategy;
  },
  options?: {
    cookieJar?: CookieJar;
    progressReporter?: ProgressReporter;
    abortSignal?: AbortSignal;
    chunkConcurrency?: number;
    checkpoint?: Checkpoint;
    timeout?: TimeoutOptions;
    userAgent?: string;
  },
): Promise<void> {
  if (options?.abortSignal?.aborted) {
    throw new VortexError("Download cancelled", { kind: "user-canceled", skipped: false });
  }

  // Resuming opens the partial file with r+, which requires it to exist; drop the checkpoint when
  // that file is missing so the download starts fresh.
  let checkpoint = options?.checkpoint;
  if (checkpoint !== undefined) {
    try {
      await access(dest);
    } catch (err) {
      // Only a missing file (ENOENT) invalidates the checkpoint; any other access error is left for
      // open() below to surface.
      if (getErrorCode(err) === "ENOENT") {
        checkpoint = undefined;
      }
    }
  }

  const sessionGot = got.extend({
    cookieJar: options?.cookieJar,
    signal: options?.abortSignal,
    timeout: createGotTimeoutOptions(options?.timeout),
    retry: { limit: 0 },
    headers: {
      "User-Agent": options?.userAgent,
    },
  } satisfies ExtendOptions);

  let resolved: NormalizedResource;
  try {
    resolved = normalize(await strategy.resolver(resource));
  } catch (err) {
    throw new VortexError("Resolver failed", { kind: "download:resolver-error" }, { cause: err });
  }

  let probe: ProbeResult;
  try {
    probe = await withRetry(
      () => probeUrl(sessionGot, resolved.probeEndpoint, checkpoint?.etag ?? undefined),
      strategy.retry,
      options?.abortSignal,
    );
  } catch (err) {
    if (isCancellation(err)) {
      throw new VortexError(
        "Download cancelled",
        { kind: "user-canceled", skipped: false },
        { cause: err },
      );
    }

    throw toNetworkError(resolved.probeEndpoint, err);
  }

  if (options?.progressReporter) {
    if (probe.etag) options.progressReporter.etag = probe.etag;
    if (probe.fileName) options.progressReporter.fileName = probe.fileName;
  }

  // A full response must replace the partial file when range resumption is unavailable.
  if (!probe.acceptsRanges || !probe.size) checkpoint = undefined;

  const chunks: Chunk[] =
    probe.acceptsRanges && probe.size
      ? await Promise.resolve(strategy.chunker(probe.size, resource))
      : [];
  const isChunked = chunks.length > 1;

  const completedRanges = checkpoint?.completedRanges ?? [];
  const pendingChunks = chunks.filter(
    (chunk) =>
      !completedRanges.some((r) => r.start <= chunk.range.start && r.end >= chunk.range.end),
  );

  let handle: FileHandle;

  try {
    // Preserve checkpoint bytes when resuming and truncate fresh downloads.
    const flag = checkpoint ? "r+" : "w+";
    const fd = await open(dest, flag);
    handle = { fd, path: dest };
  } catch (err) {
    throw parseError(err, { path: dest }, () => `Failed to open ${dest}`);
  }

  try {
    if (checkpoint && probe.size) {
      try {
        await handle.fd.truncate(probe.size);
      } catch (err) {
        throw parseError(err, { path: handle.path }, () => `Failed to truncate ${handle.path}`);
      }
    }
    if (isChunked) {
      const chunkQueue = new PQueue({
        concurrency: options?.chunkConcurrency ?? defaultChunkConcurrency,
      });

      let chunkProgress: Map<number, ChunkProgress> | undefined = undefined;
      if (options?.progressReporter) {
        chunkProgress = options.progressReporter.initChunked(chunks, probe.size!);

        for (const chunk of chunks) {
          const isComplete = completedRanges.some(
            (r) => r.start <= chunk.range.start && r.end >= chunk.range.end,
          );
          if (isComplete) {
            const progress = chunkProgress.get(chunk.index);
            if (!progress) continue;
            const size = chunk.range.end - chunk.range.start + 1;
            progress.bytesReceived = size;
            progress.bytesWritten = size;
          }
        }
      }

      try {
        await chunkQueue.addAll(
          pendingChunks.map(
            (chunk) => async () =>
              withRetry(
                () => {
                  // Exclude failed attempts from progress totals.
                  if (chunkProgress) {
                    const progress = chunkProgress.get(chunk.index);
                    if (progress) {
                      progress.bytesReceived = 0;
                      progress.bytesWritten = 0;
                    }
                  }

                  return downloadChunk(sessionGot, chunk, resolved, probe, handle, {
                    abortSignal: options?.abortSignal,
                    rateLimiter: strategy.rateLimiter,
                    progress: chunkProgress ? chunkProgress.get(chunk.index) : undefined,
                  });
                },
                strategy.retry,
                options?.abortSignal,
              ),
          ),
        );
      } finally {
        // Other chunks must release the file before the owner closes its handle.
        await chunkQueue.onIdle();
      }
    } else {
      // Preserve only the contiguous completed prefix when retrying.
      let checkpointPosition = 0;

      if (checkpoint && completedRanges.length > 0) {
        const sortedRanges = completedRanges.toSorted((a, b) => a.start - b.start);

        let currentEnd = -1;

        for (const range of sortedRanges) {
          if (range.start === currentEnd + 1) {
            currentEnd = range.end;
          } else if (range.start === 0) {
            currentEnd = range.end;
          } else {
            break;
          }
        }

        checkpointPosition = currentEnd + 1;
      }

      const progress = options?.progressReporter?.init(probe.size);

      if (checkpoint !== undefined && checkpointPosition === probe.size) {
        if (progress) {
          progress.bytesReceived = checkpointPosition;
          progress.bytesWritten = checkpointPosition;
        }
        return;
      }

      await withRetry(
        async () => {
          // Discard bytes left by failed attempts while preserving the checkpoint.
          const writePosition = checkpointPosition;
          try {
            await handle.fd.truncate(writePosition);
          } catch (err) {
            throw parseError(err, { path: dest }, () => `Failed to truncate ${dest}`);
          }

          if (progress) {
            progress.bytesReceived = checkpointPosition;
            progress.bytesWritten = checkpointPosition;
          }

          let expectedRemainingBytes = probe.size || undefined;
          let rangeChunk: Chunk | undefined = undefined;

          if (probe.size && writePosition > 0) {
            expectedRemainingBytes = probe.size - writePosition;
          }

          // Single-stream resumes also need a Range header to skip valid bytes.
          if (probe.acceptsRanges && probe.size && writePosition > 0) {
            rangeChunk = {
              index: 0,
              range: { start: writePosition, end: probe.size - 1 },
            };
            expectedRemainingBytes = probe.size - writePosition;
          }

          return downloadStream(sessionGot, resolved.probeEndpoint, handle, writePosition, {
            progress: progress,
            abortSignal: options?.abortSignal,
            rateLimiter: strategy.rateLimiter,
            etag: probe.etag ?? undefined,
            chunk: rangeChunk ?? undefined,
            expectedRemainingBytes,
            expectedTotalBytes: probe.size,
          });
        },
        strategy.retry,
        options?.abortSignal,
      );
    }
  } catch (err) {
    if (isCancellation(err)) {
      throw new VortexError(
        "Download cancelled",
        { kind: "user-canceled", skipped: false },
        { cause: err },
      );
    }

    throw err;
  } finally {
    await handle.fd.close();
  }
}

async function probeUrl(
  got: Got,
  endpoint: ResolvedEndpoint,
  previousETag: string | undefined,
): Promise<ProbeResult> {
  const response = await got.head(endpoint.url, {
    headers: createHeaders(previousETag, undefined, endpoint.headers),
  });

  const contentType = response.headers["content-type"] ?? "";
  if (contentType.startsWith("text/html")) {
    throw new VortexError("Server returned an HTML page instead of a file", {
      kind: "download:is-html",
      url: endpoint.url.toString(),
    });
  }

  const encoded = response.headers["content-encoding"];
  const size =
    encoded && encoded !== "identity" ? undefined : getSize(response.headers, "content-length");

  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Accept-Ranges
  // NOTE(erri120): only valid range units are "bytes" and "none"
  // https://www.iana.org/assignments/http-parameters/http-parameters.xhtml#range-units
  const acceptsRanges = response.headers["accept-ranges"] === "bytes";

  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/ETag
  const etag = response.headers.etag;

  // NOTE(erri120): Server has to do the precondition check of the ETag.
  if (etag && previousETag && etag !== previousETag) {
    throw new VortexError("ETag has changed, server didn't validate precondition", {
      kind: "http:protocol-violation",
      url: endpoint.url.toString(),
    });
  }

  const fileName =
    getContentDispositionFileName(response.headers) ?? getFileNameFromUrl(endpoint.url.toString());

  return { size, acceptsRanges, etag, fileName };
}

function createGotStream(
  got: Got,
  endpoint: ResolvedEndpoint,
  options: {
    etag?: string;
    chunk?: Chunk;
  },
) {
  const stream = got.stream(endpoint.url, {
    headers: createHeaders(options?.etag, options?.chunk, endpoint.headers),
  });

  // Prevent uncaught abort errors before consumers attach their own listeners.
  stream.on("error", () => {});
  // Keep got's timing listeners from draining bytes while it awaits the cookie jar.
  stream.on("request", (request: ClientRequest) => {
    request.prependOnceListener("response", (response: IncomingMessage) => response.pause());
  });

  return stream;
}

async function consumeTokens(
  limiter: RateLimiter,
  bytes: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  let remaining = bytes;
  while (remaining > 0) {
    abortSignal?.throwIfAborted();
    const toRemove = Math.min(remaining, limiter.tokenBucket.bucketSize);
    const delay = limiter.removeTokens(toRemove);
    await delay;
    remaining -= toRemove;
  }
}

async function downloadStream(
  got: Got,
  endpoint: ResolvedEndpoint,
  handle: FileHandle,
  writePosition: number,
  options: {
    progress?: { bytesReceived: number; bytesWritten: number };
    abortSignal?: AbortSignal;
    rateLimiter?: RateLimiter;
    etag?: string;
    chunk?: Chunk;
    expectedRemainingBytes?: number;
    expectedTotalBytes?: number;
  },
): Promise<void> {
  const { progress } = options;
  const stream = createGotStream(got, endpoint, {
    etag: options.etag,
    chunk: options.chunk,
  });

  let remaining = options.expectedRemainingBytes;
  try {
    // Wait for got to finish cookie processing before pulling bytes or validating headers.
    const [response] = (await once(stream, "response")) as [IncomingMessage];
    if (options.chunk) {
      const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers["content-range"] ?? "");
      if (
        response.statusCode !== 206 ||
        range === null ||
        Number(range[1]) !== options.chunk.range.start ||
        Number(range[2]) !== options.chunk.range.end ||
        (range[3] !== "*" &&
          options.expectedTotalBytes !== undefined &&
          Number(range[3]) !== options.expectedTotalBytes)
      ) {
        throw new VortexError("Server returned a different byte range", {
          kind: "http:protocol-violation",
          url: endpoint.url.toString(),
        });
      }
    }
    for await (const data of stream) {
      const buffer = data as Buffer;
      if (progress) progress.bytesReceived += buffer.length;

      if (remaining !== undefined) {
        if (buffer.length > remaining) {
          throw new VortexError(
            `Server sent ${buffer.length} bytes but only ${remaining} were expected; response exceeds requested range`,
            { kind: "http:protocol-violation", url: endpoint.url.toString() },
          );
        }
        remaining -= buffer.length;
      }

      if (options.rateLimiter) {
        await consumeTokens(options.rateLimiter, buffer.length, options.abortSignal);
      }

      let offset = 0;
      while (offset < buffer.length) {
        options.abortSignal?.throwIfAborted();
        try {
          const result = await handle.fd.write(
            buffer,
            offset,
            buffer.length - offset,
            writePosition,
          );
          if (result.bytesWritten === 0) {
            throw new VortexError("Disk write made no progress", {
              kind: "os:generic",
              originalCode: "EIO",
            });
          }
          offset += result.bytesWritten;
          if (progress) progress.bytesWritten += result.bytesWritten;
          writePosition += result.bytesWritten;
        } catch (err) {
          throw parseError(err, { path: handle.path }, () => `Failed to write to ${handle.path}`);
        }
      }
    }
    if (remaining !== undefined && remaining !== 0) {
      throw new VortexError(`Server omitted ${remaining} requested bytes`, {
        kind: "http:protocol-violation",
        url: endpoint.url.toString(),
      });
    }
  } catch (err) {
    if (err instanceof VortexError || isCancellation(err)) throw err;
    throw toNetworkError(stream.requestUrl!, err);
  } finally {
    stream.destroy();
  }
}

async function downloadChunk(
  got: Got,
  chunk: Chunk,
  resource: NormalizedResource,
  probe: ProbeResult,
  handle: FileHandle,
  options: {
    progress?: ChunkProgress;
    rateLimiter?: RateLimiter;
    abortSignal?: AbortSignal;
  },
): Promise<void> {
  options.abortSignal?.throwIfAborted();

  const endpoint = await resource.chunkEndpoint(chunk);
  const expectedRemainingBytes = chunk.range.end - chunk.range.start + 1;

  await downloadStream(got, endpoint, handle, chunk.range.start, {
    chunk,
    expectedRemainingBytes,
    expectedTotalBytes: probe.size,
    etag: probe.etag,
    progress: options.progress,
    rateLimiter: options.rateLimiter,
    abortSignal: options.abortSignal,
  });
}

function createHeaders(
  etag: string | undefined,
  chunk: Chunk | undefined,
  additionalHeaders?: Record<string, string>,
): Headers {
  const range = chunk ? `bytes=${chunk.range.start}-${chunk.range.end}` : undefined;

  // Weak ETags MUST NOT be used with preconditions. The "W/" prefix is case sensitive.
  // https://www.rfc-editor.org/rfc/rfc9110#name-etag
  const isStrongETag = etag && !etag.startsWith("W/");
  const ifMatch = isStrongETag ? etag : undefined;

  return {
    Range: range,
    "If-Match": ifMatch,
    ...(additionalHeaders ?? {}),
  };
}

function getSize(
  headers: IncomingHttpHeaders,
  header: "content-length" | "content-range",
): number | undefined {
  const rawValue = headers[header];
  if (!rawValue) return undefined;

  let parsed: number | undefined;
  if (header === "content-length") {
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Length
    // Content-Length: <length>
    parsed = parseInt(rawValue, 10);
  } else if (header === "content-range") {
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Range
    // Content-Range: <unit> <range>/<size>
    // Content-Range: <unit> <range>/*
    // Content-Range: <unit> */<size>
    const slashIndex = rawValue.lastIndexOf("/");
    if (slashIndex === -1) return undefined;

    const size = rawValue.slice(slashIndex + 1);
    if (size === "*") return undefined;

    parsed = parseInt(size, 10);
  }

  if (parsed === undefined || parsed < 0 || isNaN(parsed)) return undefined;
  return parsed;
}

function getContentDispositionFileName(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers["content-disposition"];
  if (!raw) return undefined;
  // RFC 6266: filename* (encoded) takes priority over filename.
  const starMatch = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(raw);
  if (starMatch && starMatch[1]) {
    try {
      return decodeURIComponent(starMatch[1].trim());
    } catch {
      // fall through to plain filename
    }
  }

  const plainMatch = /filename\s*=\s*"?([^";]+)"?/i.exec(raw);
  return plainMatch && plainMatch[1] ? plainMatch[1].trim() : undefined;
}

function getFileNameFromUrl(url: string): string | undefined {
  try {
    const basename = decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? "");
    return basename.length > 0 ? basename : undefined;
  } catch {
    return undefined;
  }
}

type ProbeResult = {
  size: number | undefined;
  acceptsRanges: boolean;
  etag: string | undefined;
  fileName: string | undefined;
};

type FileHandle = { fd: NodeFileHandle; path: string };
