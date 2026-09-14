import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { exchangeManifestCode, manifestFormHtml, writeAppSecrets, writeInitialConfig } from "./commands/init.js";
import { serve } from "./commands/serve.js";
import { initBoard } from "./commands/board.js";
import { status } from "./commands/status.js";
import { ConfigError } from "./config.js";
import { helpText } from "./help.js";
import { resolvePaths } from "./paths.js";

declare const __ASTROGATE_VERSION__: string;

async function initApp(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      org: { type: "string" },
      "webhook-url": { type: "string" },
      code: { type: "string" },
      port: { type: "string", default: "8787" },
    },
  });
  const paths = resolvePaths();
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port <= 0) throw new ConfigError("--port must be a positive integer");

  if (values.code) {
    const conversion = await exchangeManifestCode(values.code);
    writeAppSecrets(paths, conversion);
    if (!values.org) throw new ConfigError("--org is required together with --code");
    writeInitialConfig(paths, values.org, conversion.id, conversion.slug, port, "/webhook");
    console.log(`App ${conversion.slug} (id ${conversion.id}) registered. Secrets in ${paths.secrets}.`);
    console.log(`Install the app on ${values.org}, then set github.owner, github.installationId, github.projectNumber, repos, and worker paths in ${paths.config}.`);
    return;
  }
  if (!values.org || !values["webhook-url"]) throw new ConfigError("init app needs --org and --webhook-url, or --code");
  const file = join(paths.home, "register.html");
  writeFileSync(file, manifestFormHtml(values.org, values["webhook-url"]));
  console.log(`Open ${file} in a browser and click the button.`);
  console.log(`GitHub redirects to a 127.0.0.1 URL that will not load; copy its code= value and run:`);
  console.log(`  astrogate init app --org ${values.org} --code <CODE>`);
}

async function main(argv: string[]): Promise<void> {
  const [command = "help", ...rest] = argv;
  switch (command) {
    case "version":
    case "--version":
    case "-v":
      console.log(__ASTROGATE_VERSION__);
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(helpText(__ASTROGATE_VERSION__));
      return;
    case "init":
      if (rest[0] === "app") await initApp(rest.slice(1));
      else if (rest[0] === "board") await initBoard(resolvePaths(), rest.slice(1));
      else throw new ConfigError("usage: astrogate init app|board ...");
      return;
    case "serve":
      await serve(resolvePaths());
      return;
    case "status":
      status(resolvePaths());
      return;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.error(helpText(__ASTROGATE_VERSION__));
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
