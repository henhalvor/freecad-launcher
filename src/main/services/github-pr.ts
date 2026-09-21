import type {
  MilestoneInfo,
  PullRequestComment,
  PullRequestDetails,
  PullRequestSearchResult,
  PullRequestSummary,
} from "../../shared/types.js";
import { FREECAD_REPO, type GitHubClient } from "./github.js";
import { encodeMediaUrl, renderMarkdown } from "./markdown.js";

interface GitHubUser {
  login?: string;
  avatar_url?: string;
}

interface GitHubLabel {
  name?: string;
}

interface GitHubPull {
  number: number;
  title?: string;
  state?: string;
  draft?: boolean;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  comments?: number;
  user?: GitHubUser;
  labels?: GitHubLabel[];
  head?: { ref?: string; sha?: string };
  base?: { ref?: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
  mergeable_state?: string | null;
  milestone?: GitHubMilestone | null;
}

interface GitHubMilestone {
  title?: string;
  open_issues?: number;
  closed_issues?: number;
  due_on?: string | null;
  html_url?: string;
  number?: number;
}

interface GitHubComment {
  id: number;
  body?: string | null;
  created_at?: string;
  user?: GitHubUser;
}

interface GitHubSearchResponse {
  total_count: number;
  incomplete_results: boolean;
  items: GitHubPull[];
}

export interface PullRequestOptions {
  client: GitHubClient;
  favorites?: number[];
  markdownOptions?: { rewriteImage?: (url: string) => string };
}

function summarize(pull: GitHubPull, favorites: Set<number>): PullRequestSummary {
  return {
    number: pull.number,
    title: pull.title ?? `PR #${pull.number}`,
    state: pull.state ?? "open",
    draft: Boolean(pull.draft),
    author: pull.user?.login ?? "unknown",
    authorAvatarUrl: pull.user?.avatar_url ?? "",
    createdAt: pull.created_at ?? new Date(0).toISOString(),
    updatedAt: pull.updated_at ?? new Date(0).toISOString(),
    htmlUrl: pull.html_url ?? `https://github.com/${FREECAD_REPO}/pull/${pull.number}`,
    labels: (pull.labels ?? []).map((label) => label.name ?? "").filter(Boolean),
    comments: pull.comments ?? 0,
    isFavorite: favorites.has(pull.number),
  };
}

export async function listRecentPullRequests(
  options: PullRequestOptions,
  limit = 25,
): Promise<PullRequestSummary[]> {
  const favorites = new Set(options.favorites ?? []);
  const response = await options.client.get<GitHubPull[]>(
    `/repos/${FREECAD_REPO}/pulls?state=open&sort=updated&direction=desc&per_page=${limit}`,
  );
  return (response.data ?? []).map((pull) => summarize(pull, favorites));
}

export async function searchPullRequests(
  options: PullRequestOptions,
  query: string,
  limit = 25,
): Promise<PullRequestSearchResult> {
  const favorites = new Set(options.favorites ?? []);
  const trimmed = query.trim();
  const qualifiers = `repo:${FREECAD_REPO} is:pr${trimmed ? ` ${trimmed}` : ""}`;
  const response = await options.client.get<GitHubSearchResponse>(
    `/search/issues?q=${encodeURIComponent(qualifiers)}&sort=updated&order=desc&per_page=${limit}`,
  );
  const data = response.data;
  return {
    total: data.total_count ?? 0,
    incomplete: Boolean(data.incomplete_results),
    items: (data.items ?? []).map((pull) => summarize(pull, favorites)),
  };
}

function mapMilestone(milestone: GitHubMilestone | null | undefined): MilestoneInfo | null {
  if (!milestone?.title) return null;
  const open = milestone.open_issues ?? 0;
  const closed = milestone.closed_issues ?? 0;
  const total = open + closed;
  return {
    title: milestone.title,
    open,
    closed,
    total,
    percent: total > 0 ? Math.round((closed * 100) / total) : 0,
    dueOn: milestone.due_on ? milestone.due_on.slice(0, 10) : null,
    url: milestone.html_url ?? `https://github.com/${FREECAD_REPO}/milestones`,
  };
}

export async function getPullRequestDetails(
  options: PullRequestOptions,
  number: number,
): Promise<PullRequestDetails> {
  const favorites = new Set(options.favorites ?? []);
  const [pullResponse, issueResponse, commentsResponse] = await Promise.all([
    options.client.get<GitHubPull>(`/repos/${FREECAD_REPO}/pulls/${number}`),
    options.client.get<GitHubPull>(`/repos/${FREECAD_REPO}/issues/${number}`),
    options.client.get<GitHubComment[]>(
      `/repos/${FREECAD_REPO}/issues/${number}/comments?per_page=50`,
    ),
  ]);

  const pull = pullResponse.data;
  const issue = issueResponse.data;
  const summary = summarize({ ...pull, milestone: issue.milestone ?? pull.milestone }, favorites);
  const markdownOptions = options.markdownOptions ?? {};
  const body = pull.body ?? "";

  const commentsList: PullRequestComment[] = (commentsResponse.data ?? []).map((comment) => ({
    id: comment.id,
    author: comment.user?.login ?? "unknown",
    authorAvatarUrl: comment.user?.avatar_url ?? "",
    createdAt: comment.created_at ?? new Date(0).toISOString(),
    body: comment.body ?? "",
    bodyHtml: renderMarkdown(comment.body ?? "", markdownOptions),
  }));

  return {
    ...summary,
    body,
    bodyHtml: renderMarkdown(body, markdownOptions),
    mergeableState: pull.mergeable_state ?? null,
    additions: pull.additions ?? 0,
    deletions: pull.deletions ?? 0,
    changedFiles: pull.changed_files ?? 0,
    baseRef: pull.base?.ref ?? "main",
    headRef: pull.head?.ref ?? "",
    headSha: pull.head?.sha ?? "",
    milestone: mapMilestone(issue.milestone ?? pull.milestone),
    commentsList,
  };
}

export async function getNextMilestone(client: GitHubClient): Promise<MilestoneInfo | null> {
  const response = await client.get<GitHubMilestone[]>(
    `/repos/${FREECAD_REPO}/milestones?state=open&sort=due_on&direction=asc&per_page=20`,
  );
  const candidates = (response.data ?? []).filter((milestone) => {
    const title = (milestone.title ?? "").trim();
    if (!title || ["tbd", "to be decided", "backlog"].includes(title.toLowerCase())) return false;
    return (milestone.open_issues ?? 0) + (milestone.closed_issues ?? 0) > 0;
  });
  candidates.sort((a, b) => (a.due_on ?? "9999-12-31").localeCompare(b.due_on ?? "9999-12-31"));
  return mapMilestone(candidates[0] ?? null);
}

export { encodeMediaUrl, renderMarkdown };
