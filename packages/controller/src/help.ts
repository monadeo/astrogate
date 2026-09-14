export function helpText(version: string): string {
  return `astrogate ${version}

Usage: astrogate <command> [options]

Commands:
  init app --org ORG --webhook-url URL   Register the GitHub App in the browser; writes config and secrets
  init app --code CODE                   Exchange the manifest code; writes config and secrets
  init board [--title TITLE] [--number N]  Adopt or create the org board and its Status options; sets github.projectNumber
  serve                                  Run the controller
  status                                 List running sessions
  version                                Print the version
  help                                   Print this help
`;
}
