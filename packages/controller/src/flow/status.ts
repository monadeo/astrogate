export const STATUS = {
  inbox: "Inbox",
  ready: "Ready",
  inProgress: "In progress",
  review: "Review",
  qa: "QA",
  readyForAcceptance: "Ready for acceptance",
  done: "Done",
  needsAstro: "Needs Astro",
  blocked: "Blocked",
} as const;

export type Status = (typeof STATUS)[keyof typeof STATUS];

export const ALL_STATUSES: Status[] = Object.values(STATUS);

export function isStatus(value: string): value is Status {
  return (ALL_STATUSES as string[]).includes(value);
}
