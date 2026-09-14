export const STATUS = {
  inbox: "Inbox",
  ready: "Ready",
  inProgress: "In progress",
  review: "Review",
  qa: "QA",
  readyForAcceptance: "Ready for acceptance",
  done: "Done",
  needsInfo: "Needs Info",
  blocked: "Blocked",
} as const;

export type Status = (typeof STATUS)[keyof typeof STATUS];

export const ALL_STATUSES: Status[] = Object.values(STATUS);

/** Former option names, renamed in place so items keep their values. */
export const LEGACY_STATUS_NAMES: Record<string, Status> = { "Needs Astro": STATUS.needsInfo };

export function isStatus(value: string): value is Status {
  return (ALL_STATUSES as string[]).includes(value);
}
