// Whether a new startup is eligible: the same checks Stompstart's review runs, over the public web.
//   npm run eligibility -- <slug>        before opening a pull request
// In CI it checks the one startup a pull request adds, from the PR's number, head and opening time.
import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { digest } from "provenry/primitives";
import YAML from "yaml";
import { checkEligibility } from "../vendor/stompstart/modules/eligibility/src/index.js";
import { publicEligibilityPorts } from "../vendor/stompstart/modules/eligibility/src/public-ports.js";
import { validateStartup } from "./schemas.mjs";

const STOMPSTART = "https://stompstart.com";
const root = new URL("../", import.meta.url);
const repository = process.env.GITHUB_REPOSITORY ?? "auscaster/stompstart-startup-list";
const openedAt = process.env.PR_CREATED_AT ?? new Date().toISOString();

function changedSlug() {
  const base = process.env.BASE_SHA;
  if (!base) return process.argv[2];
  // CI checks out GitHub's merge of the pull request into its base as it is now, so the merge's
  // first parent is that base; the event's base SHA can be the base from when the PR was opened.
  const parents = execFileSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], {
    encoding: "utf8",
  })
    .trim()
    .split(" ");
  const range = parents.length === 3 ? ["HEAD^1", "HEAD"] : [`${base}...HEAD`];
  const changed = execFileSync("git", ["diff", "--name-only", ...range], { encoding: "utf8" })
    .split("\n")
    .map((path) => /^startups\/([a-z0-9-]+)(?:\.yaml|\/)/u.exec(path)?.[1])
    .filter(Boolean);
  const slugs = [...new Set(changed)];
  if (slugs.length > 1) throw new Error("A pull request adds or changes one startup.");
  return slugs[0];
}

const slug = changedSlug();
if (!slug) {
  process.stdout.write("No startup file changed; nothing to check.\n");
  process.exit(0);
}
// A startup already on Stompstart is being corrected, not proposed.
const published = await fetch(`${STOMPSTART}/api/startups/${slug}`).then(
  (response) => response.ok,
  () => false,
);
if (published) {
  process.stdout.write(`${slug} is already on Stompstart; a correction needs no eligibility check.\n`);
  process.exit(0);
}
let text;
try {
  text = await readFile(new URL(`startups/${slug}.yaml`, root), "utf8");
} catch {
  process.stderr.write(
    `startups/${slug}.yaml is missing: the startup file goes beside its folder, not inside it. Run npm run validate.\n`,
  );
  process.exit(1);
}
const fields = YAML.parse(text);
if (!validateStartup(fields)) {
  process.stderr.write(`startups/${slug}.yaml does not match the startup schema. Run npm run validate.\n`);
  process.exit(1);
}
const named = [fields.logo, ...(fields.gallery ?? [])].filter(Boolean);
const images = [];
for (const image of named) {
  try {
    images.push({ path: image.path, bytes: await readFile(new URL(`startups/${slug}/${image.path}`, root)) });
  } catch {
    // validate reports a missing image.
  }
}
// A pull request is checked at its head and is held only by earlier ones; a file not yet proposed
// is held by every open one.
const candidate =
  process.env.PR_NUMBER && process.env.PR_HEAD_SHA
    ? {
        kind: "pull_request",
        repository,
        pullRequestNumber: Number(process.env.PR_NUMBER),
        headSha: process.env.PR_HEAD_SHA,
      }
    : { kind: "detached", candidateReference: `startups/${slug}.yaml`, candidateDigest: digest(fields) };
const result = await checkEligibility(
  { input: fields, images, candidate, openedAt },
  publicEligibilityPorts({
    stompstart: STOMPSTART,
    github: { repository, ...(process.env.GITHUB_TOKEN ? { token: process.env.GITHUB_TOKEN } : {}) },
  }),
);
const mark = { pass: "pass", fail: "FAIL", flag: "review" };
const lines = [
  `### ${fields.name}: ${result.eligible ? "eligible" : "not eligible"}`,
  "",
  `Launch window: ${result.window.from} to ${result.window.to}.`,
  "",
  ...result.checks.map((check) => `- **${check.id}** ${mark[check.outcome]}: ${check.detail}`),
  "",
];
process.stdout.write(`${lines.join("\n")}\n`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
if (!result.eligible) process.exitCode = 1;
