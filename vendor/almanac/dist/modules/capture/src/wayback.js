import { canonicalInstant } from "../../work/src/time.js";
/**
 * The Wayback Machine as a capture source: its raw replay route names exactly
 * which historical page a capture shows, and its CDX index lists what it holds.
 */
/** A 14-digit Wayback timestamp as the UTC instant it names. */
export function waybackSnapshotInstant(timestamp) {
    if (!/^\d{14}$/u.test(timestamp)) {
        throw new Error("Wayback replay has no exact snapshot timestamp.");
    }
    const value = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}Z`;
    canonicalInstant(value.replace("Z", ".000Z"), "Wayback replay timestamp");
    return value;
}
/**
 * The raw replay route for one snapshot of one original URL, the only route that
 * proves which historical page a capture shows. Its parse returns the same pair.
 */
export function waybackReplayUrl(input) {
    const timestamp = input.snapshotAt.replace(/\.000Z$/u, "Z").replace(/[-:TZ]/gu, "");
    const replay = `https://web.archive.org/web/${timestamp}id_/${input.originalUrl}`;
    const parsed = parseWaybackReplayUrl(replay);
    if (parsed.originalUrl !== input.originalUrl ||
        parsed.snapshotAt !== input.snapshotAt.replace(/\.000Z$/u, "Z")) {
        throw new Error("Wayback replay does not name exactly this snapshot of this URL.");
    }
    return replay;
}
/** Only the raw archived response route proves which historical URL was requested. */
export function parseWaybackReplayUrl(value) {
    let replay;
    try {
        replay = new URL(value);
    }
    catch {
        throw new Error("Wayback replay URL is invalid.");
    }
    if (replay.origin !== "https://web.archive.org" ||
        replay.username ||
        replay.password ||
        replay.hash) {
        throw new Error("Wayback replay must use the exact HTTPS archive host and raw route.");
    }
    const match = /^\/web\/(\d{14})id_\/(https?:\/\/.+)$/u.exec(replay.pathname);
    if (!match?.[1] || !match[2])
        throw new Error("Wayback replay lacks a raw historical target.");
    // The replay's query belongs to the archived address, an empty `?` included: the archive keys
    // a page by it, and `search` reads the same for no query and an empty one.
    const query = replay.search || (replay.href.endsWith("?") ? "?" : "");
    const originalUrl = `${match[2]}${query}`;
    let original;
    try {
        original = new URL(originalUrl);
    }
    catch {
        throw new Error("Wayback replay contains an invalid historical target.");
    }
    if (!["http:", "https:"].includes(original.protocol) ||
        original.username ||
        original.password ||
        original.hash) {
        throw new Error("Wayback replay historical target is not a plain exact URL.");
    }
    return Object.freeze({ originalUrl, snapshotAt: waybackSnapshotInstant(match[1]) });
}
/**
 * The redirect authority of one replay: the archive may move between raw
 * replays of the same original at the same snapshot, and nowhere else.
 */
export function waybackRedirectAuthority(replayUrl) {
    const historical = parseWaybackReplayUrl(replayUrl);
    return (_from, to) => {
        try {
            const candidate = parseWaybackReplayUrl(to.href);
            return (candidate.originalUrl === historical.originalUrl &&
                candidate.snapshotAt === historical.snapshotAt);
        }
        catch {
            return false;
        }
    };
}
const CDX_FIELDS = ["timestamp", "original", "statuscode", "mimetype", "digest"];
/**
 * A CDX JSON index (`fl=timestamp,original,statuscode,mimetype,digest`), its
 * header exact and its rows bounded. Which rows matter is the caller's rule.
 */
export function parseWaybackIndex(bytes, bounds) {
    if (bytes.byteLength === 0 || bytes.byteLength > bounds.maximumBytes) {
        throw new Error("Wayback index exceeds its bounded byte limit.");
    }
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    catch {
        throw new Error("Wayback index is not UTF-8 JSON.");
    }
    if (!Array.isArray(parsed) ||
        parsed.length < 2 ||
        parsed.length > bounds.maximumRows + 1 ||
        !Array.isArray(parsed[0]) ||
        parsed[0].length !== CDX_FIELDS.length ||
        CDX_FIELDS.some((name, index) => parsed[0][index] !== name)) {
        throw new Error("Wayback index lacks its exact bounded CDX header and rows.");
    }
    return Object.freeze(parsed.slice(1).map((row) => {
        if (!Array.isArray(row) ||
            row.length !== CDX_FIELDS.length ||
            row.some((value) => typeof value !== "string" || value.length === 0)) {
            throw new Error("Wayback index row has another shape.");
        }
        const [timestamp, originalUrl, statusCode, mediaType, providerDigest] = row;
        let original;
        try {
            original = new URL(originalUrl);
        }
        catch {
            throw new Error("Wayback index names an invalid original URL.");
        }
        if (!["http:", "https:"].includes(original.protocol) ||
            original.username ||
            original.password ||
            original.hash ||
            providerDigest.length > 128) {
            throw new Error("Wayback index row is not a plain exact capture lead.");
        }
        return Object.freeze({
            snapshotAt: waybackSnapshotInstant(timestamp),
            originalUrl: originalUrl,
            statusCode: statusCode,
            mediaType: mediaType,
            providerDigest: providerDigest,
        });
    }));
}
//# sourceMappingURL=wayback.js.map