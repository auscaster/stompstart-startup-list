// The eligibility ports over the public web: pages and files over HTTPS, the Wayback index,
// RDAP, Stompstart's public API and the startup list's open pull requests on GitHub, each read
// over Almanac's pinned public HTTPS, which checks every hop's address is public. Pictures
// decode with WebAssembly codecs (Squoosh's PNG, JPEG and WebP decoders, resvg for SVG), so this
// runs in the list's CI with no system tools.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode.js";
import decodePng, { init as initPng } from "@jsquash/png/decode.js";
import decodeWebp, { init as initWebp } from "@jsquash/webp/decode.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { readPublicHttps } from "almanac/capture/http";
import { parseWaybackIndex } from "almanac/capture/wayback";
import { pinnedHttpsRequest } from "almanac/http/pinned";
import { readImageHeader } from "../../media/src/index.js";
import { startupClaims, websiteDomain } from "./index.js";
import { MAX_PIXELS } from "./pictures.js";
const require = createRequire(import.meta.url);
const PAGE_BYTES = 2_000_000;
/** A file's bytes, or a JSON answer: a page of a hundred pull requests runs to megabytes. */
const FILE_BYTES = 8_000_000;
const TIMEOUT_MS = 15_000;
/** The most records Stompstart's API answers a page. */
const API_PAGE = 40;
/** The most pages one Stompstart listing is read through; a longer one is not read whole. */
const API_PAGES = 100;
/** GitHub lists at most 3,000 of a pull request's files, 100 a page. */
const PULL_FILE_PAGES = 30;
const USER_AGENT = "StompstartEligibility/1 (+https://stompstart.com/contribute)";
const decoder = new TextDecoder("utf-8");
/** One public read that follows HTTPS redirects anywhere; null when it could not be made. */
async function readPublic(url, maximumBytes, accept) {
    try {
        return await readPublicHttps({
            url,
            limits: { minimumBytes: 0, maximumBytes, timeoutMs: TIMEOUT_MS },
            maxRedirects: 5,
            permitRedirect: (_from, to) => to.protocol === "https:",
            userAgent: USER_AGENT,
            headers: { accept },
        });
    }
    catch {
        return null;
    }
}
/** A 2xx answer's JSON; null for any other status or a body that is not JSON. */
function jsonAnswer(status, bytes) {
    if (status < 200 || status > 299)
        return null;
    try {
        return JSON.parse(decoder.decode(bytes));
    }
    catch {
        return null;
    }
}
/** SVG renders at this size on its long side. */
const SVG_EDGE = 512;
let codecs = null;
/** The codecs, compiled once per process from the installed packages. */
function loadCodecs() {
    const compile = async (specifier) => WebAssembly.compile(await readFile(require.resolve(specifier)));
    // The Emscripten codecs take the compiled module first; their declarations only name options.
    const withModule = (init) => init;
    codecs ??= (async () => {
        await Promise.all([
            initPng(await compile("@jsquash/png/codec/pkg/squoosh_png_bg.wasm")),
            withModule(initJpeg)(await compile("@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm")),
            withModule(initWebp)(await compile("@jsquash/webp/codec/dec/webp_dec.wasm")),
            initWasm(await compile("@resvg/resvg-wasm/index_bg.wasm")),
        ]);
    })();
    return codecs;
}
function isSvg(bytes) {
    const head = Buffer.from(bytes.subarray(0, 512)).toString("utf8").trimStart().toLowerCase();
    return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}
/** A PNG, JPEG, WebP or SVG decoded to RGBA; null for anything else or a picture over 4K. */
export async function decodePicture(bytes) {
    await loadCodecs();
    try {
        if (isSvg(bytes)) {
            const probe = new Resvg(bytes);
            const wide = probe.width >= probe.height;
            probe.free();
            const renderer = new Resvg(bytes, {
                fitTo: wide ? { mode: "width", value: SVG_EDGE } : { mode: "height", value: SVG_EDGE },
            });
            const image = renderer.render();
            const picture = {
                width: image.width,
                height: image.height,
                rgba: image.pixels,
                vector: true,
            };
            image.free();
            renderer.free();
            return picture;
        }
        const header = readImageHeader(bytes);
        if (header.width * header.height > MAX_PIXELS)
            return null;
        // A copy the size of the file: a Node Buffer can be a view on a larger shared pool.
        const buffer = new Uint8Array(bytes).buffer;
        const decoded = header.mediaType === "image/png"
            ? await decodePng(buffer)
            : header.mediaType === "image/jpeg"
                ? await decodeJpeg(buffer)
                : await decodeWebp(buffer);
        return { width: decoded.width, height: decoded.height, rgba: decoded.data, vector: false };
    }
    catch {
        return null;
    }
}
/**
 * Ports over the public web. `stompstart` is the site whose API lists existing records; `github`
 * names the startup list and an optional token for its open pull requests.
 */
export function publicEligibilityPorts(options) {
    const githubHeaders = {
        accept: "application/vnd.github+json",
        ...(options.github.token ? { authorization: `Bearer ${options.github.token}` } : {}),
    };
    const json = async (url) => {
        const read = await readPublic(url, FILE_BYTES, "application/json");
        return read ? jsonAnswer(read.responseStatusCode, read.bytes) : null;
    };
    // The list's token goes to the API alone, so its answers are read where they are, never followed:
    // a redirect, like any answer that is not a 2xx JSON one, is unread.
    const github = async (path) => {
        try {
            const response = await pinnedHttpsRequest({
                url: `https://api.github.com/repos/${options.github.repository}${path}`,
                method: "GET",
                headers: githubHeaders,
                userAgent: USER_AGENT,
                maximumBytes: FILE_BYTES,
                deadline: Date.now() + TIMEOUT_MS,
            });
            return jsonAnswer(response.status, response.bytes);
        }
        catch {
            return null;
        }
    };
    /** Every record of one Stompstart API listing, page by page; undefined unless all of it was read. */
    const listing = async (path) => {
        const records = [];
        const url = new URL(path, options.stompstart);
        url.searchParams.set("limit", String(API_PAGE));
        for (let page = 0; page < API_PAGES; page += 1) {
            const answer = (await json(url.href));
            if (!Array.isArray(answer?.records))
                return undefined;
            records.push(...answer.records);
            if (typeof answer.nextCursor !== "string")
                return records;
            url.searchParams.set("cursor", answer.nextCursor);
        }
        return undefined;
    };
    /**
     * The startup file a pull request changes, read page by page; null when it changes none, and
     * undefined unless every page that could hold it was read.
     */
    const startupFile = async (pull) => {
        for (let page = 1; page <= PULL_FILE_PAGES; page += 1) {
            const changed = (await github(`/pulls/${pull}/files?per_page=100&page=${page}`));
            if (!Array.isArray(changed))
                return undefined;
            const file = changed.find((entry) => /^startups\/[a-z0-9-]+\.yaml$/u.test(entry.filename));
            if (file)
                return file;
            if (changed.length < 100)
                return null;
        }
        // GitHub lists no more of a pull request's files than this; the rest cannot be read.
        return undefined;
    };
    // Open pull requests' startups; undefined unless every one of them was read.
    let open = null;
    const openPullRequests = async () => {
        const files = [];
        for (let page = 1; page <= 10; page += 1) {
            const pulls = (await github(`/pulls?state=open&per_page=100&page=${page}`));
            if (!Array.isArray(pulls))
                return undefined;
            for (const pull of pulls) {
                const file = await startupFile(pull.number);
                if (file === undefined)
                    return undefined;
                if (!file)
                    continue;
                const text = await readPublic(file.raw_url, PAGE_BYTES, "text/plain");
                if (!text || text.responseStatusCode < 200 || text.responseStatusCode > 299) {
                    return undefined;
                }
                const yaml = decoder.decode(text.bytes);
                const field = (key) => new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, "mu").exec(yaml)?.[1]?.trim() ?? "";
                files.push({
                    number: pull.number,
                    headSha: pull.head.sha,
                    name: field("name"),
                    website: field("website"),
                });
            }
            if (pulls.length < 100)
                return files;
        }
        return undefined;
    };
    return {
        async page(url) {
            const read = await readPublic(url, PAGE_BYTES, "text/html,application/xhtml+xml,*/*;q=0.5");
            return read
                ? { status: read.responseStatusCode, url: read.finalUrl, text: decoder.decode(read.bytes) }
                : null;
        },
        async bytes(url) {
            const read = await readPublic(url, FILE_BYTES, "image/*");
            return read && read.responseStatusCode >= 200 && read.responseStatusCode <= 299
                ? read.bytes
                : null;
        },
        async earliestCapture(host) {
            const index = await readPublic(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(host)}&output=json&limit=1&fl=timestamp,original,statuscode,mimetype,digest&filter=statuscode:200`, PAGE_BYTES, "application/json");
            const rows = index && jsonAnswer(index.responseStatusCode, index.bytes);
            if (!index || !Array.isArray(rows))
                return undefined;
            // The index answers an empty list for a host it never archived.
            if (rows.length === 0)
                return null;
            try {
                const [first] = parseWaybackIndex(index.bytes, {
                    maximumBytes: PAGE_BYTES,
                    maximumRows: 1,
                });
                return first?.snapshotAt.slice(0, 10) ?? null;
            }
            catch {
                return undefined;
            }
        },
        async registered(domain) {
            const answer = (await json(`https://rdap.org/domain/${encodeURIComponent(domain)}`));
            // rdap.org can answer with the registry's own object; only the domain's is its registration.
            if (answer?.ldhName?.toLowerCase() !== domain)
                return null;
            const date = answer.events?.find((event) => event.eventAction === "registration")?.eventDate;
            return date ? date.slice(0, 10) : null;
        },
        // Stompstart's public records: `/api/startups` lists every listed startup, read whole, and
        // `/api/archive` searches every startup with an old-site listing, by name and by its
        // website's domain. A live startup in neither is private: the host's own `existing`, read from
        // its database, finds it. A proposal not yet released is found by `pendingSubmissions`, which
        // only the host can answer.
        async existing(startup) {
            if (options.existing)
                return options.existing(startup);
            const found = [];
            let unread = false;
            for (const path of [
                `/api/archive?q=${encodeURIComponent(startup.name)}`,
                `/api/archive?q=${encodeURIComponent(websiteDomain(startup.website))}`,
                "/api/startups",
            ]) {
                const records = await listing(path);
                if (!records)
                    unread = true;
                for (const record of records ?? []) {
                    found.push(...startupClaims(startup, record, record.slug, { kind: "live" }));
                }
            }
            // A record found is a duplicate whatever else went unread; finding none proves nothing then.
            return unread && found.length === 0 ? undefined : found;
        },
        async openPullRequests(startup) {
            open ??= openPullRequests();
            const files = await open;
            // An unread listing is read again for the next query.
            if (!files)
                open = null;
            return files?.flatMap((file) => startupClaims(startup, file, `#${file.number}`, {
                kind: "open_pull_request",
                repository: options.github.repository,
                pullRequestNumber: file.number,
                headSha: file.headSha,
            }));
        },
        // Private submissions are the host's to read; the public list sees none.
        pendingSubmissions: options.pendingSubmissions ?? (async () => []),
        decode: decodePicture,
    };
}
//# sourceMappingURL=public-ports.js.map