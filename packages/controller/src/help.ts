export function helpText(version: string): string {
  return `astrogate ${version}

Usage: astrogate <command> [options]

Commands:
  init app --org ORG --webhook-url URL   Write the GitHub App registration form to ~/.astrogate/register.html
  init app --code CODE                   Exchange the manifest code; writes config and secrets
  serve                                  Run the controller
  status                                 List running sessions
  version                                Print the version
  help                                   Print this help
`;
}
