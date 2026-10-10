import { sealCaptureAttempt, } from "provenry/capture/attempts";
import { sha256Bytes } from "provenry/primitives";
import { boundedRequestHeaders, mediaType, PublicHttpsError, pinnedHttpsRequest, pinnedHttpsUrl, publicHttpsFailure, REDIRECT_STATUSES, } from "../../http/src/pinned.js";
/**
 * Public HTTPS reads for capture: the shared pinned transport under capture's
 * policy (capture sends no credential of its own; a page's own request headers
 * for its subresource are forwarded as the page sent them; cookies only from the
 * capture's own jar), a redirect loop under an authority the product supplies,
 * and the sealed attempt either one becomes. Every failure is named in the
 * attempt's own vocabulary, so a read and its record cannot disagree.
 */
/** A redirect left the read's authority; the chain ends at the refused target. */
export class CaptureRedirectAuthorityError extends Error {
    redirectChain;
    constructor(redirectChain) {
        const target = redirectChain.at(-1)?.to;
        if (!target)
            throw new Error("A refused redirect names its target.");
        super(`Capture redirect to '${new URL(target).hostname}' is outside its authority.`);
        this.redirectChain = redirectChain;
        this.name = "CaptureRedirectAuthorityError";
    }
    get toUrl() {
        return this.redirectChain.at(-1)?.to;
    }
}
/** The source answered with an error status, for a product that treats one as a failed read. */
export class CaptureHttpStatusError extends Error {
    status;
    redirectChain;
    constructor(status, redirectChain = []) {
        if (!Number.isInteger(status) || status < 400 || status > 599) {
            throw new RangeError("An error status is a 4xx or 5xx response.");
        }
        super(`The source answered HTTP ${status}.`);
        this.status = status;
        this.redirectChain = redirectChain;
        this.name = "CaptureHttpStatusError";
    }
}
/**
 * This host's capture runtime failed, such as a browser that cannot start. It
 * is never the source's answer, so it is never sealed as an attempt.
 */
export class CaptureRuntimeError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "CaptureRuntimeError";
    }
}
/** Request headers a product never supplies; the cookie comes only from the capture's own jar. */
const CAPTURE_FORBIDDEN_HEADERS = new Set([
    "authorization",
    "cookie",
    "proxy-authorization",
]);
/** Request headers a page's own request never forwards; its authorization may ride. */
const PAGE_FORBIDDEN_HEADERS = new Set(["cookie", "proxy-authorization"]);
/**
 * One capture request to a public HTTPS address over the shared pinned
 * transport: GET, or POST with a bounded body, under capture's header policy.
 * Capture sends no credential of its own; a page's own headers for its
 * subresource GET are forwarded as the page sent them.
 */
export async function publicHttpsRequest(input) {
    const headers = boundedRequestHeaders(input.headers ?? {}, CAPTURE_FORBIDDEN_HEADERS);
    const pageHeaders = boundedRequestHeaders(input.pageHeaders ?? {}, PAGE_FORBIDDEN_HEADERS);
    const pageNames = Object.keys(pageHeaders);
    if ((pageNames.length > 0 && input.method === "POST") ||
        pageNames.some((name) => Object.hasOwn(headers, name))) {
        throw new PublicHttpsError("policy_blocked", {
            message: "A page's headers ride only its own GET, and never under a name the product sets.",
        });
    }
    return pinnedHttpsRequest({
        url: input.url,
        method: input.method ?? "GET",
        headers: { ...headers, ...pageHeaders, ...(input.cookie ? { cookie: input.cookie } : {}) },
        ...(input.body ? { body: input.body } : {}),
        userAgent: input.userAgent,
        maximumBytes: input.maximumBytes,
        deadline: input.deadline,
    });
}
/**
 * Read one public page, following redirects the product's authority permits,
 * up to `maxRedirects`, within one deadline. A 4xx or 5xx is returned, not
 * thrown; a redirect outside the authority throws with the chain that reached it.
 * Its headers, the page's own included, travel only until a redirect changes origin.
 */
export async function readPublicHttps(input) {
    if (input.limits.minimumBytes < 0 || input.limits.minimumBytes > input.limits.maximumBytes) {
        throw new Error("A read's minimum body exceeds its maximum.");
    }
    const deadline = Date.now() + input.limits.timeoutMs;
    const source = pinnedHttpsUrl(input.url);
    const chain = [];
    const visited = new Set([source.href]);
    let current = source;
    let headers = input.headers ?? {};
    let pageHeaders = input.pageHeaders ?? {};
    try {
        for (;;) {
            const cookie = input.cookies?.requestHeader(current);
            const response = await publicHttpsRequest({
                url: current.href,
                headers,
                pageHeaders,
                ...(cookie ? { cookie } : {}),
                userAgent: input.userAgent,
                maximumBytes: input.limits.maximumBytes,
                deadline,
            });
            input.cookies?.absorb(current, response.headers.getSetCookie());
            if (!REDIRECT_STATUSES.has(response.status)) {
                if (response.status >= 200 &&
                    response.status <= 299 &&
                    response.bytes.byteLength < input.limits.minimumBytes) {
                    throw new PublicHttpsError("byte_limit", { message: "The body is below its bound." });
                }
                return Object.freeze({
                    requestedUrl: source.href,
                    finalUrl: current.href,
                    redirectChain: Object.freeze([...chain]),
                    responseStatusCode: response.status,
                    mediaType: mediaType(response.headers.get("content-type")),
                    bytes: response.bytes,
                });
            }
            const location = response.headers.get("location");
            let next;
            try {
                if (!location)
                    throw new Error("A redirect names no location.");
                next = new URL(location, current);
                if (next.username || next.password || !["http:", "https:"].includes(next.protocol)) {
                    throw new Error("A redirect names no plain web target.");
                }
            }
            catch (cause) {
                throw new PublicHttpsError("policy_blocked", { cause });
            }
            next.hash = "";
            chain.push({ status: response.status, from: current.href, to: next.href });
            if (!input.permitRedirect(current, next))
                throw new CaptureRedirectAuthorityError([...chain]);
            if (chain.length > input.maxRedirects || visited.has(next.href)) {
                throw new PublicHttpsError("policy_blocked", {
                    message: "The redirects exceed their bound or return to a visited page.",
                });
            }
            // Request metadata is the requested origin's; a new origin receives none, the page's too.
            if (next.origin !== current.origin) {
                headers = {};
                pageHeaders = {};
            }
            visited.add(next.href);
            current = next;
        }
    }
    catch (error) {
        if (error instanceof PublicHttpsError && error.redirectChain.length === 0 && chain.length > 0) {
            throw new PublicHttpsError(error.reason, {
                message: error.message,
                redirectChain: [...chain],
                cause: error.cause,
            });
        }
        throw error;
    }
}
/**
 * The attempt one read seals, or the attempt its failure seals; only a 2xx
 * keeps its bytes. Facts that cannot form their attempt settle as a bare
 * transport error, and `sealingFailure` says why.
 */
export function sealHttpCaptureAttempt(input) {
    const common = {
        source_url: input.start.source_url,
        requested_url: input.start.requested_url,
        checked_at: input.checkedAt,
        method: input.start.method,
        method_registry_digest: input.start.method_registry_digest,
    };
    const unsealed = [];
    const seal = (core) => {
        try {
            return sealCaptureAttempt(input.methods, core);
        }
        catch (cause) {
            // Facts that cannot form an attempt, such as a final URL no redirect
            // reached, settle as a bare transport error so every start settles.
            unsealed.push(cause);
            return sealCaptureAttempt(input.methods, {
                ...common,
                outcome: "transport_error",
                reason: "other",
                redirect_chain: [],
            });
        }
    };
    const sealed = (attempt, sourceBytes) => unsealed.length === 0
        ? { attempt, sourceBytes }
        : { attempt, sourceBytes, sealingFailure: unsealed[0] };
    if ("failure" in input.read) {
        return sealed(seal(failureCore(input.read.failure, common)), null);
    }
    const { capture } = input.read;
    const redirect_chain = [...capture.redirectChain];
    const status = capture.responseStatusCode;
    if (status >= 200 && status <= 299) {
        const attempt = seal({
            ...common,
            outcome: "captured",
            final_url: capture.finalUrl,
            redirect_chain,
            response_status_code: status,
            media_type: capture.mediaType,
            content_digest: sha256Bytes(capture.bytes),
            content_bytes: capture.bytes.byteLength,
            ...(input.archiveSnapshotAt ? { archive_snapshot_at: input.archiveSnapshotAt } : {}),
        });
        return sealed(attempt, attempt.outcome === "captured" ? capture.bytes : null);
    }
    const attempt = status >= 400 && status <= 599
        ? seal({
            ...common,
            outcome: "unreachable",
            reason: "http_status",
            response_status_code: status,
            redirect_chain,
        })
        : seal({ ...common, outcome: "transport_error", reason: "other", redirect_chain });
    return sealed(attempt, null);
}
/**
 * The physical capture `captureThroughJournal` runs: read the start's
 * requested URL and seal what came back. A runtime failure propagates unsealed.
 */
export function httpPhysicalCapture(input) {
    return async (start) => {
        let read;
        try {
            read = { capture: await input.read(start.requested_url) };
        }
        catch (failure) {
            if (failure instanceof CaptureRuntimeError)
                throw failure;
            read = { failure };
        }
        return sealHttpCaptureAttempt({
            methods: input.methods,
            start,
            read,
            checkedAt: input.now(),
            ...(input.archiveSnapshotAt ? { archiveSnapshotAt: input.archiveSnapshotAt } : {}),
        });
    };
}
function failureCore(failure, common) {
    if (failure instanceof CaptureRuntimeError)
        throw failure;
    if (failure instanceof CaptureHttpStatusError) {
        return {
            ...common,
            outcome: "unreachable",
            reason: "http_status",
            response_status_code: failure.status,
            redirect_chain: [...failure.redirectChain],
        };
    }
    if (failure instanceof CaptureRedirectAuthorityError) {
        return {
            ...common,
            outcome: "redirected_outside_authority",
            final_url: failure.toUrl,
            redirect_chain: [...failure.redirectChain],
        };
    }
    const error = publicHttpsFailure(failure);
    const redirect_chain = [...error.redirectChain];
    return error.reason === "dns_failure"
        ? { ...common, outcome: "unreachable", reason: "dns_failure", redirect_chain }
        : { ...common, outcome: "transport_error", reason: error.reason, redirect_chain };
}
//# sourceMappingURL=http.js.map