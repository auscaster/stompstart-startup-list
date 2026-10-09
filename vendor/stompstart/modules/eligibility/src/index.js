// Whether a new startup's submission is eligible for Stompstart, and why. The rules read the
// submission and what the web shows about it through ports; they import only the image header
// reader and the picture rules beside them, so the compiled files run on their own in the public
// startup list's CI.
import { readImageHeader } from "../../media/src/index.js";
import { differenceHash, galleryImage, logoOrigin, } from "./pictures.js";
/** A new discovery first appeared publicly within this many months before its pull request. */
export const LAUNCH_WINDOW_MONTHS = 6;
/** Captures of the site this long before the window flag it for review. */
const CAPTURE_GRACE_DAYS = 30;
const LOGO_MIN_EDGE = 256;
const IMAGE_MAX_EDGE = 1_600;
const PRODUCT_IMAGE_MIN_WIDTH = 1_200;
const COPIED_SHARE = 0.5;
const TWO_LEVEL_SUFFIXES = new Set([
    "co.uk",
    "org.uk",
    "ac.uk",
    "com.au",
    "net.au",
    "org.au",
    "co.nz",
    "co.jp",
    "com.br",
    "co.in",
    "com.sg",
    "co.za",
    "com.mx",
    "com.tr",
    "co.il",
    "com.cn",
    "com.hk",
    "co.kr",
]);
/**
 * Hosts that give anyone a subdomain, and tunnels that give a temporary one. A site under one is
 * not on its own domain, and two sites under the same one are two different startups.
 */
const SHARED_HOSTS = new Set([
    "bubbleapps.io",
    "carrd.co",
    "firebaseapp.com",
    "fly.dev",
    "framer.app",
    "framer.website",
    "github.io",
    "glitch.me",
    "herokuapp.com",
    "hf.space",
    "loca.lt",
    "lovable.app",
    "netlify.app",
    "ngrok.app",
    "ngrok.io",
    "ngrok-free.app",
    "notion.site",
    "onrender.com",
    "pages.dev",
    "railway.app",
    "replit.app",
    "streamlit.app",
    "surge.sh",
    "trycloudflare.com",
    "vercel.app",
    "web.app",
    "webflow.io",
    "wixsite.com",
    "workers.dev",
]);
/** The shared host a host sits under, or null for a host on its own domain. */
export function sharedHost(host) {
    const suffix = host.toLowerCase().replace(/\.$/u, "").split(".").slice(-2).join(".");
    return SHARED_HOSTS.has(suffix) ? suffix : null;
}
/** The domain a host belongs to, for the common public suffixes and shared hosts. */
export function registrableDomain(host) {
    const labels = host.toLowerCase().replace(/\.$/u, "").split(".");
    const suffix = labels.slice(-2).join(".");
    const size = TWO_LEVEL_SUFFIXES.has(suffix) || SHARED_HOSTS.has(suffix) ? 3 : 2;
    return labels.slice(-size).join(".");
}
/**
 * Whether a record or proposal is the same startup as the one asked about: the same registrable
 * domain, or the same name in letters and digits.
 */
export function sameStartup(query, other) {
    const plain = (value) => value.toLowerCase().replace(/[^a-z0-9]/gu, "");
    let domain = "";
    try {
        domain = other.website ? registrableDomain(new URL(other.website).hostname) : "";
    }
    catch {
        // A record without a usable website matches by name only.
    }
    return ((domain !== "" && domain === query.domain) ||
        (plain(other.name) !== "" && plain(other.name) === plain(query.name)));
}
function hostOf(url) {
    return new URL(url).hostname.toLowerCase();
}
function day(value) {
    return value.toISOString().slice(0, 10);
}
/** The window a first public appearance must fall in: six months up to the pull request. */
export function launchWindow(openedAt) {
    const to = new Date(openedAt);
    // The same day six months back, or that month's last day when it is shorter.
    const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - LAUNCH_WINDOW_MONTHS, 1));
    const monthEnd = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
    from.setUTCDate(Math.min(to.getUTCDate(), monthEnd.getUTCDate()));
    return { from: day(from), to: day(to) };
}
/** A day or month date's first and last day, or null for a coarser one. */
function dateSpan(date) {
    if (date.precision === "day" && date.value)
        return { first: date.value, last: date.value };
    if (date.precision === "month" && date.value) {
        const [year, month] = date.value.split("-").map(Number);
        if (!year || !month)
            return null;
        return { first: `${date.value}-01`, last: day(new Date(Date.UTC(year, month, 0))) };
    }
    return null;
}
const TRACKING = /^(?:utm_[a-z_]+|ref|ref_|referrer|via|aff|affiliate|aff_id|gclid|fbclid|mc_cid|mc_eid)$/u;
/** Query parameters that track or pay for a click, from any of these addresses. */
export function trackingParameters(urls) {
    const found = new Set();
    for (const url of urls) {
        for (const key of new URL(url).searchParams.keys()) {
            if (TRACKING.test(key.toLowerCase()))
                found.add(key);
        }
    }
    return [...found].sort();
}
/** A page answered with content. */
const answered = (page) => page.status >= 200 && page.status <= 299;
/**
 * A definite answer that the page is not there. Anything else that is not content (no answer,
 * a refusal, a rate limit, a server error) may be the network this check runs from, so it goes
 * to a reviewer instead of failing the submission.
 */
const gone = (page) => page !== null && (page.status === 404 || page.status === 410);
const unread = (url, page) => `${url} could not be read from here (${page?.status ?? "no response"}); a reviewer checks it`;
/** What a reader sees on a page: no scripts, styles or markup, common entities decoded. */
export function visibleText(html) {
    return html
        .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/giu, " ")
        .replace(/<!--[\s\S]*?-->/gu, " ")
        .replace(/<[^>]+>/gu, " ")
        .replace(/&nbsp;/giu, " ")
        .replace(/&amp;/giu, "&")
        .replace(/&#39;|&apos;/giu, "'")
        .replace(/&quot;/giu, '"')
        .replace(/\s+/gu, " ")
        .trim();
}
const SUPERLATIVES = /\b(?:revolutionary|revolutionizing|world'?s first|best[- ]in[- ]class|cutting[- ]edge|game[- ]chang(?:er|ing)|seamless(?:ly)?|unparalleled|next[- ]generation|leverag(?:e|es|ing)|innovative|groundbreaking)\b/iu;
/** Five-word shingles of a text, for copy comparison. */
function shingles(text) {
    const words = text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/gu, " ")
        .split(/\s+/u)
        .filter(Boolean);
    const out = new Set();
    for (let index = 0; index + 5 <= words.length; index += 1) {
        out.add(words.slice(index, index + 5).join(" "));
    }
    return out;
}
/** The share of a text's five-word runs that also appear in the other text. */
export function copiedShare(text, from) {
    const mine = shingles(text);
    if (mine.size === 0)
        return 0;
    const theirs = shingles(from);
    let shared = 0;
    for (const shingle of mine)
        if (theirs.has(shingle))
            shared += 1;
    return shared / mine.size;
}
function httpsUrl(href, base) {
    try {
        const url = new URL(href, base);
        return url.protocol === "https:" ? url.href : null;
    }
    catch {
        return null;
    }
}
/**
 * The icons, share images and web manifest a page names, as absolute HTTPS addresses, with the
 * two icon paths sites serve without naming them. ICO files are left out: nothing here reads them.
 */
export function siteImages(page) {
    const attribute = (tag, name) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, "iu").exec(tag)?.[1];
    const icon = (href) => {
        const url = httpsUrl(href, page.url);
        return url && !/\.ico$/iu.test(new URL(url).pathname) ? url : null;
    };
    const icons = new Set();
    const share = new Set();
    let manifest = null;
    for (const tag of page.text.match(/<link\b[^>]*>/giu) ?? []) {
        const rel = attribute(tag, "rel")?.toLowerCase() ?? "";
        const href = attribute(tag, "href");
        if (!href)
            continue;
        if (/(?:^|\s)(?:icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)(?:\s|$)/u.test(rel)) {
            const url = icon(href);
            if (url)
                icons.add(url);
        }
        else if (/(?:^|\s)manifest(?:\s|$)/u.test(rel)) {
            manifest = httpsUrl(href, page.url);
        }
    }
    for (const tag of page.text.match(/<meta\b[^>]*>/giu) ?? []) {
        const property = (attribute(tag, "property") ?? attribute(tag, "name") ?? "").toLowerCase();
        const content = attribute(tag, "content");
        if (content && (property === "og:image" || property === "twitter:image")) {
            const url = httpsUrl(content, page.url);
            if (url)
                share.add(url);
        }
    }
    for (const guess of ["/apple-touch-icon.png", "/favicon.svg"]) {
        const url = icon(guess);
        if (url)
            icons.add(url);
    }
    return { icons: [...icons], share: [...share], manifest };
}
/** The icons a web manifest lists, as absolute HTTPS addresses. */
export function manifestIcons(text, base) {
    let icons;
    try {
        icons = JSON.parse(text).icons;
    }
    catch {
        return [];
    }
    if (!Array.isArray(icons))
        return [];
    return icons.flatMap((entry) => {
        const url = typeof entry?.src === "string" ? httpsUrl(entry.src, base) : null;
        return url ? [url] : [];
    });
}
/** A code host's repository page (its root or files), rather than a release or announcement. */
function codeRepository(url) {
    const { hostname, pathname } = new URL(url);
    if (!["github.com", "gitlab.com", "codeberg.org", "bitbucket.org"].includes(hostname)) {
        return false;
    }
    const [, , , section] = pathname.split("/");
    return !section || ["tree", "blob", "src"].includes(section);
}
/** Every web address a submission names, wherever in the file it sits. */
function webAddresses(value) {
    if (typeof value === "string")
        return /^https?:\/\//iu.test(value) ? [value] : [];
    if (Array.isArray(value))
        return value.flatMap(webAddresses);
    if (value && typeof value === "object")
        return Object.values(value).flatMap(webAddresses);
    return [];
}
/**
 * Check a submission. Every rule reports: a fail makes it ineligible; a flag passes to review
 * with the reason; a pass records what was confirmed.
 */
export async function checkEligibility(submission, ports) {
    const { input } = submission;
    const checks = [];
    const add = (id, outcome, detail) => {
        checks.push({ id, outcome, detail });
    };
    const window = launchWindow(submission.openedAt);
    const host = hostOf(input.website);
    const domain = registrableDomain(host);
    // One record per startup: already published, archived or first proposed elsewhere.
    const existing = await ports.existing({ domain, name: input.name });
    const earlier = await ports.earlierPullRequests({
        domain,
        name: input.name,
        before: submission.pullNumber ?? Number.POSITIVE_INFINITY,
    });
    const pending = await ports.pendingSubmissions({
        domain,
        name: input.name,
        pullNumber: submission.pullNumber,
        submissionId: submission.submissionId,
    });
    if (existing.length > 0) {
        add("duplicate", "fail", `Already on Stompstart: ${existing.join(", ")}.`);
    }
    else if (earlier.length > 0) {
        add("duplicate", "fail", `An earlier open pull request proposes it: #${earlier.join(", #")}.`);
    }
    else if (pending.length > 0) {
        add("duplicate", "fail", `Another submission already proposes it: ${pending.join(", ")}.`);
    }
    else {
        add("duplicate", "pass", `No record or earlier proposal for ${domain}.`);
    }
    // A real product: its site answers on its own domain, and the way in works. Whether the site
    // presents the product, not a parked or error page, is read from its capture at review.
    const site = await ports.page(input.website);
    const shared = sharedHost(host);
    if (shared) {
        add("website", "fail", `${input.website} is on ${shared}, a shared host; a listed startup has its own domain.`);
    }
    else if (site && registrableDomain(hostOf(site.url)) !== domain) {
        add("website", "fail", `${input.website} redirects to another domain, ${hostOf(site.url)}.`);
    }
    else if (!site || !answered(site)) {
        if (gone(site))
            add("website", "fail", `${input.website} is not there (${site?.status}).`);
        else
            add("website", "flag", `${unread(input.website, site)}.`);
    }
    else {
        add("website", "pass", `${input.website} answers on ${domain}.`);
    }
    const deadAccess = [];
    const unreadAccess = [];
    for (const route of input.access) {
        const page = await ports.page(route.url);
        if (gone(page))
            deadAccess.push(route.url);
        else if (!page || page.status >= 400)
            unreadAccess.push(route.url);
    }
    if (deadAccess.length > 0) {
        add("access", "fail", `These routes are not there: ${deadAccess.join(", ")}.`);
    }
    else if (unreadAccess.length > 0) {
        add("access", "flag", `These routes could not be read from here; a reviewer checks them: ${unreadAccess.join(", ")}.`);
    }
    else {
        add("access", "pass", "Every access route answers.");
    }
    // New: the first public appearance falls in the window, and the source that dates it says so.
    const captured = await ports.earliestCapture(host);
    const registeredOn = await ports.registered(domain);
    const graceStart = new Date(`${window.from}T00:00:00Z`);
    graceStart.setUTCDate(graceStart.getUTCDate() - CAPTURE_GRACE_DAYS);
    const capturedEarly = typeof captured === "string" && captured < day(graceStart);
    const history = [
        captured === undefined
            ? "the web archive could not be read"
            : captured
                ? `first archived ${captured}`
                : "never archived",
        registeredOn ? `registered ${registeredOn}` : "registration unknown",
    ].join(", ");
    if (input.launch) {
        const span = dateSpan(input.launch.occurred_on);
        const source = await ports.page(input.launch.source.url);
        if (!span) {
            add("launch-window", "fail", "The launch needs a day or month date.");
        }
        else if (span.last < window.from || span.first > window.to) {
            add("launch-window", "fail", `The launch (${span.first.slice(0, span.first === span.last ? 10 : 7)}) is outside ${window.from} to ${window.to}.`);
        }
        else if (codeRepository(input.launch.source.url)) {
            add("launch-window", "fail", `The launch source ${input.launch.source.url} is a code repository, which shows the code, not a launch; cite the announcement, release post or listing that dates it.`);
        }
        else if (gone(source)) {
            add("launch-window", "fail", `The launch source ${input.launch.source.url} is not there.`);
        }
        else if (!source || !answered(source)) {
            add("launch-window", "flag", `The launch date is in the window; ${unread(input.launch.source.url, source)}; ${history}.`);
        }
        else if (capturedEarly) {
            add("launch-window", "flag", `The launch date is in the window, but the site was ${history}.`);
        }
        else {
            add("launch-window", "pass", `The launch date is in the window and its source answers; ${history}.`);
        }
    }
    else if (input.stage !== "prelaunch") {
        add("launch-window", "fail", "A released product states its launch, with a source.");
    }
    else if (capturedEarly) {
        add("launch-window", "flag", `A prelaunch product whose site was ${history}.`);
    }
    else {
        add("launch-window", "pass", `Prelaunch, and new to the web: ${history}.`);
    }
    // The site's own pictures, decoded: its icons (with its manifest's) and its share images.
    const assets = site && answered(site) ? siteImages(site) : { icons: [], share: [], manifest: null };
    let iconUrls = [...assets.icons];
    if (assets.manifest) {
        const manifest = await ports.page(assets.manifest);
        if (manifest && answered(manifest))
            iconUrls = [...iconUrls, ...manifestIcons(manifest.text, manifest.url)];
    }
    const load = async (url) => {
        const bytes = await ports.bytes(url);
        const picture = bytes ? await ports.decode(bytes) : null;
        return picture ? { url, picture } : null;
    };
    const [icons, shares] = await Promise.all([
        Promise.all([...new Set(iconUrls)].map(load)),
        Promise.all(assets.share.map(load)),
    ]);
    const siteIcons = icons.filter((icon) => icon !== null);
    const shareHashes = shares.flatMap((found) => (found ? [differenceHash(found.picture)] : []));
    // Its own logo: an original of at least 256 pixels, never a smaller site icon enlarged.
    const image = (path) => path ? submission.images.find((candidate) => candidate.path === path) : undefined;
    const logo = image(input.logo?.path);
    const original = `Use an original of at least ${LOGO_MIN_EDGE} pixels: the site's SVG logo rendered to PNG, its press kit, or its app icon.`;
    if (!logo) {
        add("logo", "fail", "A new discovery includes its logo beside its file.");
    }
    else {
        const header = readImageHeader(logo.bytes);
        const ratio = header.width / header.height;
        if (header.mediaType === "image/jpeg") {
            add("logo", "fail", "The logo is a PNG or WebP, not a JPEG.");
        }
        else if (Math.min(header.width, header.height) < LOGO_MIN_EDGE) {
            add("logo", "fail", `The logo is at least ${LOGO_MIN_EDGE} pixels on each side.`);
        }
        else if (Math.max(header.width, header.height) > IMAGE_MAX_EDGE) {
            add("logo", "fail", `The logo is at most ${IMAGE_MAX_EDGE} pixels on its long side.`);
        }
        else if (ratio < 0.8 || ratio > 1.25) {
            add("logo", "fail", "The logo is square or close to it.");
        }
        else {
            const picture = await ports.decode(logo.bytes);
            const found = picture ? logoOrigin(picture, siteIcons) : null;
            if (!found) {
                add("logo", "fail", "The logo could not be read as a picture.");
            }
            else if (found.kind === "enlarged") {
                add("logo", "fail", `The logo is the site's ${found.size}-pixel ${found.url} enlarged. ${original}`);
            }
            else if (found.kind === "original") {
                add("logo", "pass", `The logo matches the site's own ${found.url}.`);
            }
            else if (found.kind === "redrawn") {
                add("logo", "flag", `The logo has the shape of the site's smaller ${found.url} but not its detail; check it is an original, not a redraw.`);
            }
            else {
                add("logo", "flag", found.compared > 0
                    ? "The logo does not match any icon the site serves; check it is the startup's own original."
                    : "The site serves no icon to compare the logo with; check it is the startup's own original.");
            }
        }
    }
    // Product images: real pictures of the product, first in the gallery. The site's share image
    // may follow as an extra but never counts; an empty or error page never passes. With no
    // product image, Stompstart takes a screenshot of the homepage at review.
    const gallery = (input.gallery ?? [])
        .map((named) => image(named.path))
        .filter((found) => found !== undefined);
    const problems = [];
    let products = 0;
    let shareFirst = false;
    for (const [index, found] of gallery.entries()) {
        const picture = await ports.decode(found.bytes);
        const kind = picture ? galleryImage(picture, shareHashes, PRODUCT_IMAGE_MIN_WIDTH) : null;
        if (!picture || !kind) {
            problems.push(`${found.path} could not be read as a picture`);
        }
        else if (kind === "blank") {
            problems.push(`${found.path} is an empty or error page`);
        }
        else if (kind === "share") {
            if (index === 0)
                shareFirst = true;
        }
        else if (kind === "narrow") {
            problems.push(`${found.path} is ${picture.width} pixels wide, under ${PRODUCT_IMAGE_MIN_WIDTH}`);
        }
        else {
            products += 1;
        }
    }
    if (problems.length > 0) {
        add("product-image", "fail", `${problems.join("; ")}.`);
    }
    else if (products > 0 && shareFirst) {
        add("product-image", "fail", "List the product image first; the site's share image can follow it.");
    }
    else if (products > 0) {
        add("product-image", "pass", `${products} product image${products === 1 ? "" : "s"}.`);
    }
    else {
        add("product-image", "pass", gallery.length > 0
            ? "Only the site's share image: it is an extra, so Stompstart takes a screenshot of the homepage at review."
            : "No product image: Stompstart takes a screenshot of the homepage at review.");
    }
    // Its own words: not copied from the site, no em dashes, no hype.
    const prose = [input.tagline, input.description, input.problem ?? ""].join("\n");
    const copied = site && answered(site) ? copiedShare(input.description, visibleText(site.text)) : 0;
    if (copied >= COPIED_SHARE) {
        add("copy", "fail", `${Math.round(copied * 100)}% of the description repeats the site; write it in your own words.`);
    }
    else if (/\u2014/u.test(prose) || /\u2014/u.test(input.launch?.summary ?? "")) {
        add("copy", "fail", "The text uses an em dash; use a comma, a colon or a new sentence.");
    }
    else if (SUPERLATIVES.test(prose)) {
        add("copy", "flag", `The text sells rather than describes: "${SUPERLATIVES.exec(prose)?.[0]}".`);
    }
    else {
        add("copy", "pass", "The text is its own and plain.");
    }
    // Clean addresses, each written in full (the form the product records and captures), and no
    // private contact details.
    const urls = webAddresses(input);
    const tracking = trackingParameters(urls);
    const unwritten = urls.flatMap((url) => {
        try {
            const parsed = new URL(url);
            if (parsed.username || parsed.password || parsed.hash)
                return [`${url} has a fragment or login`];
            return parsed.href === url ? [] : [`write ${parsed.href} for ${url}`];
        }
        catch {
            return [`${url} is not an address`];
        }
    });
    const email = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/iu.test(`${prose}\n${input.launch?.summary ?? ""}`);
    add("links", tracking.length > 0 || unwritten.length > 0 || email ? "fail" : "pass", tracking.length > 0
        ? `Remove tracking or referral parameters: ${tracking.join(", ")}.`
        : unwritten.length > 0
            ? `Write each address in full: ${unwritten.join("; ")}.`
            : email
                ? "Remove the email address; contacts stay private."
                : "Addresses are clean and no contact details are published.");
    return Object.freeze({
        eligible: checks.every((check) => check.outcome !== "fail"),
        productImages: products,
        window,
        checks: Object.freeze(checks),
    });
}
//# sourceMappingURL=index.js.map