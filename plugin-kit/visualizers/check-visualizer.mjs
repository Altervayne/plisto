// Checks a visualizer plugin folder the way Plisto will meet it.
//   node check-visualizer.mjs <plugin-folder> [--kind K] [--seconds S] [--json] [--out DIR]
//     [--soft] [--edge PATH]
// For each declared kind it reports the manifest (the same rules and wording as the installer), whether the
// kind compiles in the runtime and how long its first frame took, a scripted run of S seconds (default 10)
// judged by Plisto's flash, slow-frame and hang limits, a still saved as a PNG in DIR (default: a new
// temporary folder the report names), and where the plugin will be listed.
// Exit code: 0 passed, 1 a rule or limit failed, 2 the command could not run, 3 only flashing was found
// (a warning to read: Plisto stops a flashing visualizer only when the user asks it to).
// Needs Windows with Microsoft Edge. The run uses the real GPU; --soft forces software GL. The check opens
// a server on 127.0.0.1 only, and Edge is closed and its profile removed however the run ends.

// -- Library Imports --
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// -- Local Imports --
import { runKinds } from "./lib/check/browser.mjs";
import { listingOf } from "./lib/check/listing.mjs";
import { checkManifest } from "./lib/check/manifest.mjs";
import { buildReport, formatReport, refusedReport, verdictFor } from "./lib/check/report.mjs";

const SWITCHES = ["json", "soft", "help"];
const VALUED = ["kind", "seconds", "out", "edge"];
const DEFAULT_SECONDS = 10;
const EXIT_USAGE = 2;

/** The folder, the flags, or a usage problem. */
export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) positional.push(arg);
    else if (SWITCHES.includes(arg.slice(2))) flags[arg.slice(2)] = true;
    else if (VALUED.includes(arg.slice(2)) && i + 1 < argv.length) flags[arg.slice(2)] = argv[++i];
    else throw new Error(`unknown or incomplete option ${arg}`);
  }
  if (flags.help) return { help: true };
  if (positional.length !== 1) throw new Error("give exactly one plugin folder");
  const seconds = flags.seconds === undefined ? DEFAULT_SECONDS : Number(flags.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error("--seconds must be 1 to 600");
  }
  return {
    dir: resolve(positional[0]),
    kind: flags.kind,
    seconds,
    json: !!flags.json,
    soft: !!flags.soft,
    out: flags.out,
    edge: flags.edge,
  };
}

const USAGE =
  "usage: node check-visualizer.mjs <plugin-folder> [--kind K] [--seconds S] [--json] [--out DIR] " +
  "[--soft] [--edge PATH]";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const facts = checkManifest(args.dir);
  const print = (report) => {
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatReport(report, args.seconds).join("\n"));
    return report.exitCode;
  };
  if (!facts.ok) return print(refusedReport(facts.refusal));

  const decls = args.kind ? facts.decls.filter((d) => d.id === args.kind) : facts.decls;
  if (decls.length === 0) throw new Error(`the plugin declares no visualizer '${args.kind}'`);
  const { results, stills } = await runKinds({
    dir: args.dir,
    decls,
    seconds: args.seconds,
    edge: args.edge,
    soft: args.soft,
    outDir: args.out && resolve(args.out),
  });
  const verdicts = decls.map((decl) => verdictFor(decl, results.find((r) => r.id === decl.id)));
  return print(buildReport(facts, listingOf(facts), verdicts, { stills, seconds: args.seconds }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`check-visualizer: ${e instanceof Error ? e.message : e}`);
      if (/^(give|unknown|--seconds)/.test(String(e?.message))) console.error(USAGE);
      process.exit(EXIT_USAGE);
    },
  );
}
