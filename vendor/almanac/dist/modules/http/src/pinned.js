import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { HEADER_NAME_PATTERN } from "provenry/exchange/records";
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** A request to a public address that failed, with any redirects followed before it. */
export class PublicHttpsError extends Error {
    reason;
    redirectChain;
    constructor(reason, options = {}) {
        super(options.message ?? `Public HTTPS request failed: ${reason}.`, { cause: options.cause });
        this.reason = reason;
        this.name = "PublicHttpsError";
        this.redirectChain = options.redirectChain ?? [];
    }
}
const PINNED_HTTPS_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
/** The encodings every request asks for; the transport decodes each within its bound. */
const ACCEPTED_CONTENT_ENCODINGS = "br, gzip, deflate";
/** Headers the transport itself sends on every request, for records that list what was sent. */
export const TRANSPORT_HEADER_NAMES = ["accept-encoding", "user-agent"];
/** Headers no caller supplies: the transport frames the request and negotiates its encoding. */
const FRAMING_HEADERS = new Set([
    "accept-encoding",
    "connection",
    "content-length",
    "host",
    "transfer-encoding",
]);
/**
 * One request to a public HTTPS address. `headers` must already have passed the
 * caller's policy (`boundedRequestHeaders`). A redirect's body is drained within
 * the bound and dropped; it is returned, never followed.
 */
export async function pinnedHttpsRequest(input) {
    bound(input.maximumBytes);
    const url = pinnedHttpsUrl(input.url);
    if (!PINNED_HTTPS_METHODS.includes(input.method)) {
        throw new PublicHttpsError("policy_blocked", {
            message: `Method '${input.method}' is unsupported.`,
        });
    }
    if (input.body && (input.method === "GET" || input.method === "HEAD")) {
        throw new PublicHttpsError("policy_blocked", { message: "A GET or HEAD request has no body." });
    }
    if (input.body && input.body.byteLength > input.maximumBytes) {
        throw new PublicHttpsError("byte_limit", { message: "The request body exceeds its bound." });
    }
    for (const name of Object.keys(input.headers)) {
        if (FRAMING_HEADERS.has(name.toLowerCase())) {
            throw new PublicHttpsError("policy_blocked", {
                message: "Framing headers are the transport's.",
            });
        }
    }
    let addresses;
    try {
        addresses = await withinDeadline(lookup(url.hostname, { all: true, verbatim: true }), input.deadline);
    }
    catch (error) {
        throw publicHttpsFailure(error);
    }
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new PublicHttpsError("non_public_address");
    }
    const address = [...addresses].sort((left, right) => `${left.family}:${left.address}`.localeCompare(`${right.family}:${right.address}`))[0];
    const remaining = remainingTime(input.deadline);
    return new Promise((resolve, reject) => {
        const request = httpsRequest(url, {
            method: input.method,
            agent: false,
            lookup: pinnedLookup(address),
            maxHeaderSize: 256 * 1024,
            signal: AbortSignal.timeout(remaining),
            headers: {
                ...input.headers,
                "accept-encoding": ACCEPTED_CONTENT_ENCODINGS,
                "user-agent": input.userAgent,
            },
        }, async (response) => {
            try {
                const length = Number(response.headers["content-length"] ?? 0);
                if (Number.isFinite(length) && length > input.maximumBytes) {
                    throw new PublicHttpsError("byte_limit");
                }
                const status = response.statusCode ?? 502;
                const redirect = REDIRECT_STATUSES.has(status);
                const bytes = input.method === "HEAD"
                    ? new Uint8Array()
                    : await decodeBoundedBody({
                        body: response,
                        contentEncoding: redirect ? undefined : response.headers["content-encoding"],
                        maximumBytes: input.maximumBytes,
                    });
                const received = responseHeaders(response.headers);
                received.delete("content-encoding");
                received.delete("content-length");
                resolve({ status, headers: received, bytes: redirect ? new Uint8Array() : bytes });
            }
            catch (error) {
                response.destroy();
                reject(publicHttpsFailure(error));
            }
        });
        request.once("error", (error) => reject(publicHttpsFailure(error)));
        request.end(input.body);
    });
}
/**
 * Request headers as bounded metadata under a caller's policy: lower-cased field names,
 * values of 1 to 512 characters without line breaks, none of `forbidden` and no
 * framing header.
 */
export function boundedRequestHeaders(input, forbidden) {
    const entries = Object.entries(input).map(([name, value]) => [name.toLowerCase(), value]);
    const names = entries.map(([name]) => name);
    if (new Set(names).size !== names.length ||
        names.some((name) => !HEADER_NAME_PATTERN.test(name) || forbidden.has(name) || FRAMING_HEADERS.has(name)) ||
        entries.some(([, value]) => value.length === 0 || value.length > 512 || /[\r\n]/u.test(value))) {
        throw new PublicHttpsError("policy_blocked", {
            message: "Request headers are not bounded metadata under this policy.",
        });
    }
    return Object.fromEntries(entries);
}
/** A plain HTTPS URL: no credentials and no fragment. */
export function pinnedHttpsUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch (cause) {
        throw new PublicHttpsError("policy_blocked", { message: "The URL is invalid.", cause });
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
        throw new PublicHttpsError("policy_blocked", {
            message: "A public request is plain HTTPS, with no credentials or fragment.",
        });
    }
    return url;
}
/** Any failure of a request, named in the shared vocabulary. */
export function publicHttpsFailure(error) {
    if (error instanceof PublicHttpsError)
        return error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    const name = error instanceof Error ? error.name : "";
    const reason = ["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(code)
        ? "dns_failure"
        : name === "AbortError" || name === "TimeoutError" || code === "ABORT_ERR"
            ? "deadline_exceeded"
            : /TLS|SSL|CERT|VERIFY/u.test(code)
                ? "tls_failure"
                : "other";
    return new PublicHttpsError(reason, { cause: error });
}
/** The lowercased media type of a content-type header, or the opaque default. */
export function mediaType(contentType) {
    return contentType?.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
}
/** Whether an address is publicly routable: no private, shared, reserved or documentation range. */
export function isPublicAddress(address) {
    const version = isIP(address);
    if (version === 4)
        return !blockedIpv4.check(address, "ipv4");
    if (version === 6)
        return !blockedIpv6.check(address, "ipv6");
    return false;
}
/** Milliseconds left before `deadline` (epoch milliseconds), or `deadline_exceeded` once it passed. */
export function remainingTime(deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
        throw new PublicHttpsError("deadline_exceeded");
    return remaining;
}
/** Settle `operation` by `deadline` (epoch milliseconds), or fail as `deadline_exceeded`. */
export async function withinDeadline(operation, deadline, message) {
    const expired = () => new PublicHttpsError("deadline_exceeded", message ? { message } : {});
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
        // The caller started it; once abandoned, its eventual rejection is not this request's failure.
        operation.catch(() => undefined);
        throw expired();
    }
    let timeout;
    try {
        return await Promise.race([
            operation,
            new Promise((_resolve, reject) => {
                timeout = setTimeout(() => reject(expired()), remaining);
            }),
        ]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
/** Bound a body before and after decoding, so a small compressed body cannot expand past the limit. */
async function decodeBoundedBody(input) {
    bound(input.maximumBytes);
    const header = typeof input.contentEncoding === "string"
        ? input.contentEncoding
        : input.contentEncoding?.join(",");
    const encoding = header?.trim().toLowerCase() || "identity";
    const decoder = encoding === "identity"
        ? null
        : encoding === "gzip" || encoding === "x-gzip"
            ? createGunzip()
            : encoding === "deflate"
                ? createInflate()
                : encoding === "br"
                    ? createBrotliDecompress()
                    : undefined;
    if (decoder === undefined) {
        throw new PublicHttpsError("policy_blocked", {
            message: `Content encoding '${encoding}' is unsupported.`,
        });
    }
    let encodedBytes = 0;
    const encodedBound = new Transform({
        transform(chunk, _encoding, callback) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            encodedBytes += bytes.byteLength;
            callback(encodedBytes > input.maximumBytes ? new PublicHttpsError("byte_limit") : null, bytes);
        },
    });
    const chunks = [];
    let decodedBytes = 0;
    const collect = new Writable({
        write(chunk, _encoding, callback) {
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            decodedBytes += bytes.byteLength;
            if (decodedBytes > input.maximumBytes) {
                callback(new PublicHttpsError("byte_limit"));
                return;
            }
            chunks.push(bytes);
            callback();
        },
    });
    // A failed stage settles the read at once. `pipeline` would wait for the response to close,
    // and tears a response down by aborting its request, which does nothing once that request
    // has finished: a body that arrived whole before its bound tripped would never settle.
    let failed = () => undefined;
    const failure = new Promise((_resolve, reject) => {
        failed = reject;
    });
    for (const stage of [encodedBound, decoder, collect]) {
        stage?.once("error", (error) => {
            input.body.destroy();
            failed(error);
        });
    }
    await Promise.race([
        decoder
            ? pipeline(input.body, encodedBound, decoder, collect)
            : pipeline(input.body, encodedBound, collect),
        failure,
    ]);
    return Buffer.concat(chunks, decodedBytes);
}
/** A lookup that answers only the address already resolved and checked. */
function pinnedLookup(address) {
    const pinned = { address: address.address, family: address.family };
    return (_hostname, options, callback) => {
        if (options.all)
            callback(null, [pinned]);
        else
            callback(null, pinned.address, pinned.family);
    };
}
function responseHeaders(input) {
    const headers = new Headers();
    for (const [name, value] of Object.entries(input)) {
        if (typeof value === "string")
            headers.set(name, value);
        else if (Array.isArray(value))
            for (const item of value)
                headers.append(name, item);
    }
    return headers;
}
function bound(maximumBytes) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
        throw new Error("A public request needs a positive byte bound.");
    }
}
const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
]) {
    blockedIpv4.addSubnet(network, prefix, "ipv4");
}
const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
]) {
    blockedIpv6.addSubnet(network, prefix, "ipv6");
}
//# sourceMappingURL=pinned.js.map