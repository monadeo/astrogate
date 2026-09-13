declare const __ASTROGATE_VERSION__: string;

const HELP = `astrogate ${__ASTROGATE_VERSION__}

Usage: astrogate <command>

Commands:
  version   Print the version
  help      Print this help
`;

const command = process.argv[2] ?? "help";

switch (command) {
  case "version":
  case "--version":
  case "-v":
    console.log(__ASTROGATE_VERSION__);
    break;
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`Unknown command: ${command}\n`);
    console.error(HELP);
    process.exitCode = 2;
}
