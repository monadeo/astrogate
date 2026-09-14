import type { GitHubApp } from "./client.js";
import { ALL_STATUSES, isStatus, type Status } from "../flow/status.js";

const STATUS_COLORS: Record<Status, string> = {
  Inbox: "GRAY",
  Ready: "BLUE",
  "In progress": "YELLOW",
  Review: "ORANGE",
  QA: "PURPLE",
  "Ready for acceptance": "PINK",
  Done: "GREEN",
  "Needs Astro": "RED",
  Blocked: "RED",
};

interface BoardHandle {
  id: string;
  number: number;
  field: { id: string; options: { id: string; name: string }[] } | null;
  views: { nodes: { id: string; name: string; layout: string }[] };
}

const BOARD_FRAGMENT = `id number field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } views(first: 20) { nodes { id name layout } }`;

async function findBoard(github: GitHubApp, org: string, title: string, number?: number): Promise<BoardHandle | undefined> {
  if (number !== undefined) {
    const data = await github.graphql<{ organization: { projectV2: BoardHandle | null } }>(
      `query($org: String!, $number: Int!) { organization(login: $org) { projectV2(number: $number) { ${BOARD_FRAGMENT} } } }`,
      { org, number },
    );
    return data.organization.projectV2 ?? undefined;
  }
  const data = await github.graphql<{ organization: { projectsV2: { nodes: (BoardHandle & { title: string })[] } } }>(
    `query($org: String!, $query: String!) { organization(login: $org) { projectsV2(first: 20, query: $query) { nodes { title ${BOARD_FRAGMENT} } } } }`,
    { org, query: title },
  );
  return data.organization.projectsV2.nodes.find((n) => n.title.toLowerCase() === title.toLowerCase());
}

/**
 * Adopts the board named `title` (or numbered `number`) or creates it, then shapes it for Astrogate:
 * the Status field carries exactly the driven options in lifecycle order (existing ones keep their
 * ids, so items keep their values; GitHub's stock Todo / In Progress go on a fresh board), and a
 * board-layout view named "Board" is the first view.
 */
export async function ensureBoard(github: GitHubApp, org: string, title: string, number?: number): Promise<{ number: number; created: boolean }> {
  let board = await findBoard(github, org, title, number);
  let created = false;
  if (!board) {
    if (number !== undefined) throw new Error(`Project ${number} not found in ${org}`);
    const owner = await github.graphql<{ organization: { id: string } }>(`query($org: String!) { organization(login: $org) { id } }`, { org });
    const data = await github.graphql<{ createProjectV2: { projectV2: BoardHandle } }>(
      `mutation($owner: ID!, $title: String!) { createProjectV2(input: { ownerId: $owner, title: $title }) { projectV2 { ${BOARD_FRAGMENT} } } }`,
      { owner: owner.organization.id, title },
    );
    board = data.createProjectV2.projectV2;
    created = true;
  }
  if (!board.field) throw new Error(`Project ${board.number} has no single-select "Status" field`);

  const byName = new Map(board.field.options.map((o) => [o.name, o.id]));
  const ordered = ALL_STATUSES.map((name) => {
    const id = byName.get(name);
    return { ...(id ? { id } : {}), name, color: STATUS_COLORS[name], description: "" };
  });
  // Foreign options are dropped on a fresh board; on an adopted board they stay so no item loses its value.
  const foreign = created ? [] : board.field.options.filter((o) => !ALL_STATUSES.includes(o.name as Status)).map((o) => ({ id: o.id, name: o.name, color: "GRAY", description: "" }));
  const current = board.field.options.map((o) => o.name).join("|");
  if (current !== [...ordered, ...foreign].map((o) => o.name).join("|")) {
    await github.graphql(
      `mutation($field: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        updateProjectV2Field(input: { fieldId: $field, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
      }`,
      { field: board.field.id, options: [...ordered, ...foreign] },
    );
  }

  const views = board.views.nodes;
  const existingBoard = views.find((v) => v.layout === "BOARD_LAYOUT");
  if (existingBoard) {
    if (existingBoard.name !== "Board") {
      await github.graphql(`mutation($view: ID!) { updateProjectV2View(input: { viewId: $view, name: "Board" }) { projectV2View { id } } }`, { view: existingBoard.id });
    }
  } else {
    await github.graphql(`mutation($project: ID!) { createProjectV2View(input: { projectId: $project, name: "Board", layout: BOARD_LAYOUT }) { projectV2View { id } } }`, { project: board.id });
  }
  if (created) {
    for (const view of views.filter((v) => v.layout === "TABLE_LAYOUT")) {
      await github.graphql(`mutation($view: ID!) { deleteProjectV2View(input: { viewId: $view }) { projectV2View { id } } }`, { view: view.id });
    }
  }
  return { number: board.number, created };
}

export interface BoardItem {
  itemId: string;
  issueNodeId: string;
  repo: string;
  number: number;
  status: Status | undefined;
}

interface FieldOption {
  id: string;
  name: string;
}

/** The organization Project (v2) that is the authoritative ticket board. */
export class ProjectBoard {
  readonly #github: GitHubApp;
  readonly #org: string;
  readonly #number: number;
  #projectId = "";
  #statusFieldId = "";
  #options = new Map<string, string>();

  constructor(github: GitHubApp, org: string, number: number) {
    this.#github = github;
    this.#org = org;
    this.#number = number;
  }

  get url(): string {
    return `https://github.com/orgs/${this.#org}/projects/${this.#number}`;
  }

  async load(): Promise<void> {
    const data = await this.#github.graphql<{
      organization: { projectV2: { id: string; field: { id: string; options: FieldOption[] } | null } | null };
    }>(
      `query($org: String!, $number: Int!) {
        organization(login: $org) {
          projectV2(number: $number) {
            id
            field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } }
          }
        }
      }`,
      { org: this.#org, number: this.#number },
    );
    const project = data.organization.projectV2;
    if (!project) throw new Error(`Project ${this.#number} not found in ${this.#org}`);
    if (!project.field) throw new Error(`Project ${this.#number} has no single-select "Status" field`);
    this.#projectId = project.id;
    this.#statusFieldId = project.field.id;
    this.#options = new Map(project.field.options.map((o) => [o.name, o.id]));
    const missing = ["Inbox", "Ready", "In progress", "Review", "QA", "Ready for acceptance", "Done", "Needs Astro", "Blocked"].filter(
      (name) => !this.#options.has(name),
    );
    if (missing.length > 0) throw new Error(`Status field lacks options: ${missing.join(", ")}`);
  }

  async itemForIssue(issueNodeId: string): Promise<BoardItem | undefined> {
    const data = await this.#github.graphql<{
      node: {
        number: number;
        repository: { nameWithOwner: string };
        projectItems: { nodes: { id: string; project: { id: string }; fieldValueByName: { name?: string } | null }[] };
      } | null;
    }>(
      `query($id: ID!) {
        node(id: $id) {
          ... on Issue {
            number
            repository { nameWithOwner }
            projectItems(first: 20) {
              nodes { id project { id } fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } } }
            }
          }
        }
      }`,
      { id: issueNodeId },
    );
    const issue = data.node;
    if (!issue) return undefined;
    const item = issue.projectItems.nodes.find((n) => n.project.id === this.#projectId);
    if (!item) return undefined;
    const name = item.fieldValueByName?.name;
    return {
      itemId: item.id,
      issueNodeId,
      repo: issue.repository.nameWithOwner,
      number: issue.number,
      status: name && isStatus(name) ? name : undefined,
    };
  }

  async addIssue(issueNodeId: string): Promise<string> {
    const data = await this.#github.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
      `mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } } }`,
      { project: this.#projectId, content: issueNodeId },
    );
    return data.addProjectV2ItemById.item.id;
  }

  async setStatus(itemId: string, status: Status): Promise<void> {
    const optionId = this.#options.get(status);
    if (!optionId) throw new Error(`unknown status option ${status}`);
    await this.#github.graphql(
      `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
        updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
      }`,
      { project: this.#projectId, item: itemId, field: this.#statusFieldId, option: optionId },
    );
  }

  /** Issues on the board with the given status, oldest first. */
  async itemsWithStatus(status: Status): Promise<BoardItem[]> {
    const items: BoardItem[] = [];
    let cursor: string | null = null;
    do {
      const data: {
        node: {
          items: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: {
              id: string;
              fieldValueByName: { name?: string } | null;
              content: { __typename: string; id: string; number: number; repository: { nameWithOwner: string } } | null;
            }[];
          };
        };
      } = await this.#github.graphql(
        `query($project: ID!, $after: String) {
          node(id: $project) {
            ... on ProjectV2 {
              items(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
                  content { __typename ... on Issue { id number repository { nameWithOwner } } }
                }
              }
            }
          }
        }`,
        { project: this.#projectId, after: cursor },
      );
      for (const node of data.node.items.nodes) {
        if (node.content?.__typename !== "Issue" || node.fieldValueByName?.name !== status) continue;
        items.push({ itemId: node.id, issueNodeId: node.content.id, repo: node.content.repository.nameWithOwner, number: node.content.number, status });
      }
      cursor = data.node.items.pageInfo.hasNextPage ? data.node.items.pageInfo.endCursor : null;
    } while (cursor);
    return items;
  }
}
