import { config } from "dotenv";
config({ quiet: true });

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    created: string;
    updated: string;
    status: {
      name: string;
      statusCategory: {
        name: string;
      };
    };
    reporter?: {
      displayName: string;
      emailAddress?: string;
    };
    assignee?: {
      displayName: string;
      emailAddress?: string;
    };
    customfield_10010?: {
      requestType?: {
        name: string;
      };
    };
  };
}

interface JqlSearchResponse {
  total: number;
  issues: JiraIssue[];
  nextPageToken?: string;
}

interface JqlParseResult {
  query: string;
  errors?: string[];
  warnings?: string[];
}

interface JqlParseResponse {
  queries: JqlParseResult[];
}

export interface JqlValidationResult {
  query: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function splitOrderBy(jql: string): { conditions: string; orderBy: string } {
  const match = /\border\s+by\b/i.exec(jql);
  if (!match || match.index === undefined) {
    return { conditions: jql.trim(), orderBy: "" };
  }

  const conditions = jql.slice(0, match.index).trim();
  const orderBy = jql.slice(match.index).trim();
  return { conditions, orderBy };
}

export function injectProjectConstraintAtEnd(customJql: string, project: string): string {
  const { conditions, orderBy } = splitOrderBy(customJql);

  const withProject = conditions.length === 0 ? `project = ${project}` : `(${conditions}) AND project = ${project}`;
  return orderBy.length === 0 ? withProject : `${withProject} ${orderBy}`;
}

export class JiraClient {
  private baseUrl: string;
  private auth: string;

  constructor(domain: string) {
    const apiKey = process.env["JIRA_API_KEY"];
    const email = process.env["JIRA_EMAIL"];

    if (!apiKey || !email) {
      throw new Error(
        "Missing required environment variables: JIRA_API_KEY, JIRA_EMAIL"
      );
    }

    this.baseUrl = `https://${domain}/rest/api/3`;
    this.auth = Buffer.from(`${email}:${apiKey}`).toString("base64");
  }

  private async fetch<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Basic ${this.auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jira API error: ${response.status} ${response.statusText} - ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async validateJql(queries: string[]): Promise<JqlValidationResult[]> {
    const response = await this.fetch<JqlParseResponse>("/jql/parse?validation=strict", {
      method: "POST",
      body: JSON.stringify({ queries }),
    });
    
    return response.queries.map((result) => ({
      query: result.query,
      valid: !result.errors || result.errors.length === 0,
      errors: result.errors || [],
      warnings: result.warnings || [],
    }));
  }

  async searchIssues(jql: string): Promise<JiraIssue[]> {
    const allIssues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    const fields = ["summary", "status", "reporter", "assignee", "customfield_10010", "created", "updated"];
    
    do {
      const body: Record<string, unknown> = { jql, maxResults: 100, fields };
      if (nextPageToken) {
        body.nextPageToken = nextPageToken;
      }
      
      const response = await this.fetch<JqlSearchResponse>("/search/jql", {
        method: "POST",
        body: JSON.stringify(body),
      });
      
      allIssues.push(...response.issues);
      nextPageToken = response.nextPageToken;
    } while (nextPageToken);
    
    return allIssues;
  }

  async searchWithProjectConstraint(project: string, customJql: string): Promise<JiraIssue[]> {
    return this.searchIssues(injectProjectConstraintAtEnd(customJql, project));
  }
}

export function getIssueSubject(issue: JiraIssue): string {
  return issue.fields.summary || issue.key;
}

export function getIssueOwner(issue: JiraIssue): string {
  return issue.fields.assignee?.displayName || "Unassigned";
}

export function getIssueStatus(issue: JiraIssue): string {
  return issue.fields.status?.name || "Unknown";
}

export function getIssueCreated(issue: JiraIssue): Date {
  return new Date(issue.fields.created);
}

export function getIssueUpdated(issue: JiraIssue): Date {
  return new Date(issue.fields.updated);
}
