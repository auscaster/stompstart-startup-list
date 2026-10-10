/** Parse a caller-supplied instant; every work module takes time from its caller. */
export function instant(value, label) {
    const time = Date.parse(value);
    if (!Number.isFinite(time))
        throw new Error(`Invalid ${label}.`);
    return time;
}
/** An instant that must already be canonical UTC, such as `2026-09-30T10:00:00.000Z`. */
export function canonicalInstant(value, label) {
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
        throw new Error(`The ${label} must be a canonical UTC instant.`);
    }
    return value;
}
//# sourceMappingURL=time.js.map