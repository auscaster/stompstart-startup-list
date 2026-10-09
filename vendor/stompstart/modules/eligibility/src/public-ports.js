// The eligibility ports over the public web: pages and files over HTTPS, the Wayback index,
// RDAP, Stompstart's public API and the startup list's open pull requests on GitHub. Pictures
// decode with WebAssembly codecs (Squoosh's PNG, JPEG and WebP decoders, resvg for SVG), so this
// runs in the list's CI with no system tools.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import decodeJpeg, { init as initJpeg } from "@jsquash/jpeg/decode.js";
import decodePng, { init as initPng } from "@jsquash/png/decode.js";
import decodeWebp, { init as initWebp } from "@jsquash/webp/decode.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { readImageHeader } from "../../media/src/index.js";
import { sameStartup } from "./index.js";
import { MAX_PIXELS } from "./pictures.js";
const require = createRequire(import.meta.url);
const PAGE_BYTES = 2_000_000;
const FILE_BYTES = 8_000_000;
const TIMEOUT_MS = 15_000;
const USER_AGENT = "StompstartEligibility/1 (+https://stompstart.com/contribute)";
async function fetchBounded(url, limit, accept) {
    if (new URL(url).protocol !== "https:")
        return null;
    try {
        const response = await fetch(url, {
            headers: { "user-agent": USER_AGENT, accept },
            redirect: "follow",
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const reader = response.body?.getReader();
        const chunks = [];
        let size = 0;
        while (reader) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel();
                break;
            }
            chunks.push(value);
        }
        return { response, bytes: Buffer.concat(chunks) };
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
        "user-agent": USER_AGENT,
        ...(options.github.token ? { authorization: `Bearer ${options.github.token}` } : {}),
    };
    const json = async (url, headers = { "user-agent": USER_AGENT }) => {
        try {
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (response.ok)
                return (await response.json());
            // An unread body holds its connection open, and with it the process.
            await response.body?.cancel();
            return null;
        }
        catch {
            return null;
        }
    };
    let open = null;
    const openPullRequests = options.openPullRequests ??
        (async () => {
            const files = [];
            const base = `https://api.github.com/repos/${options.github.repository}`;
            for (let page = 1; page <= 10; page += 1) {
                const pulls = (await json(`${base}/pulls?state=open&per_page=100&page=${page}`, githubHeaders));
                if (!pulls || pulls.length === 0)
                    break;
                for (const pull of pulls) {
                    const changed = (await json(`${base}/pulls/${pull.number}/files?per_page=100`, githubHeaders));
                    const file = changed?.find((entry) => /^startups\/[a-z0-9-]+\.yaml$/u.test(entry.filename));
                    if (!file)
                        continue;
                    const text = await fetchBounded(file.raw_url, PAGE_BYTES, "text/plain");
                    const yaml = text?.bytes.toString("utf8") ?? "";
                    const field = (key) => new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, "mu").exec(yaml)?.[1]?.trim() ??
                        "";
                    files.push({ number: pull.number, name: field("name"), website: field("website") });
                }
                if (pulls.length < 100)
                    break;
            }
            return files;
        });
    return {
        async page(url) {
            const fetched = await fetchBounded(url, PAGE_BYTES, "text/html,application/xhtml+xml,*/*;q=0.5");
            if (!fetched)
                return null;
            return {
                status: fetched.response.status,
                url: fetched.response.url || url,
                text: fetched.bytes.toString("utf8"),
            };
        },
        async bytes(url) {
            const fetched = await fetchBounded(url, FILE_BYTES, "image/*");
            return fetched?.response.ok ? fetched.bytes : null;
        },
        async earliestCapture(host) {
            const rows = (await json(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(host)}&output=json&limit=1&fl=timestamp&filter=statuscode:200`));
            if (!rows)
                return undefined;
            const stamp = rows[1]?.[0];
            return stamp && /^\d{8}/u.test(stamp)
                ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`
                : null;
        },
        async registered(domain) {
            const answer = (await json(`https://rdap.org/domain/${encodeURIComponent(domain)}`));
            // rdap.org can answer with the registry's own object; only the domain's is its registration.
            if (answer?.ldhName?.toLowerCase() !== domain)
                return null;
            const date = answer.events?.find((event) => event.eventAction === "registration")?.eventDate;
            return date ? date.slice(0, 10) : null;
        },
        async existing(query) {
            if (options.existing)
                return options.existing(query);
            const found = new Set();
            const records = [];
            for (const path of [
                `/api/archive?q=${encodeURIComponent(query.name)}&limit=50`,
                `/api/archive?q=${encodeURIComponent(query.domain)}&limit=50`,
                "/api/startups?limit=100",
            ]) {
                const page = (await json(new URL(path, options.stompstart).href));
                for (const record of page?.records ?? []) {
                    records.push(record);
                }
            }
            for (const record of records) {
                if (sameStartup(query, record))
                    found.add(record.slug);
            }
            return [...found].sort();
        },
        async earlierPullRequests(query) {
            open ??= openPullRequests();
            return (await open)
                .filter((file) => file.number < query.before && sameStartup(query, file))
                .map((file) => file.number)
                .sort((left, right) => left - right);
        },
        // Private submissions are the host's to read; the public list sees none.
        pendingSubmissions: options.pendingSubmissions ?? (async () => []),
        decode: decodePicture,
    };
}
//# sourceMappingURL=public-ports.js.map