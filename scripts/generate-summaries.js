const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

const GIT_USERNAME = process.env.GIT_USERNAME;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;

// GraphQL Queries
const GITHUB_GRAPHQL_QUERY = `query {
  search(query: "is:pr is:merged author:${GIT_USERNAME} -user:${GIT_USERNAME}", type: ISSUE, first: 100) {
    nodes {
      ... on PullRequest {
        id
        number
        title
        body
        bodyText
        url
        mergedAt
        state
        repository { nameWithOwner }
        labels(first: 10) { nodes { name } }
        closingIssuesReferences(first: 10) { nodes { number url } }
      }
    }
  }
}`;

const GITLAB_GRAPHQL_QUERY = `query {
  user(username: "${GIT_USERNAME}") {
    authoredMergeRequests(state: merged, first: 100) {
      nodes {
        iid
        title
        description
        webUrl
        mergedAt
        state
        project { id fullPath }
        labels { nodes { title } }
      }
    }
  }
}`;

// List of PRs to ignore (add PR IDs here), format: "owner/repo#number"
const ignoredPRs = [
  "open-minds/awesome-openminds-team#106",
  "shrutikapoor08/devjoke#610",
]; // e.g., ["owner/repo#123", "other/repo#456"]

if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required");
if (!GITLAB_TOKEN) throw new Error("GITLAB_TOKEN is required");
if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required");

// GitHub GraphQL fetch helper
async function fetchGraphQLGithub(query) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
    },
    body: JSON.stringify({ query }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      `GitHub GraphQL error: ${res.status} ${JSON.stringify(json)}`
    );
  }
  if (json.errors) {
    // don't fail hard for individual errors, but surface them
    console.warn("GitHub GraphQL returned errors", json.errors);
  }

  return json.data || {};
}

// GitLab GraphQL fetch helper
async function fetchGraphQLGitLab(query) {
  const res = await fetch("https://gitlab.com/api/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GITLAB_TOKEN}`,
    },
    body: JSON.stringify({ query }),
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(
      `GitLab GraphQL error: ${res.status} ${JSON.stringify(json)}`
    );
  }
  if (json.errors) {
    console.warn("GitLab GraphQL returned errors", json.errors);
  }

  return json.data || {};
}

async function fetchGithubPRs() {
  const data = await fetchGraphQLGithub(GITHUB_GRAPHQL_QUERY);
  const nodes = data?.search?.nodes || [];

  const contributions = nodes.map((n) => {
    const repo = n.repository?.nameWithOwner || "";
    const relatedIssues =
      (n.closingIssuesReferences?.nodes || []).map((r) => ({
        number: r.number,
        url: r.url,
      })) || [];

    return {
      id: n.number,
      title: n.title,
      repo,
      html_url: n.url,
      body: n.body || n.bodyText || null,
      merged_at: n.mergedAt || null,
      source: "github",
      relatedIssues,
    };
  });

  return contributions;
}

async function fetchGitLabMRs() {
  const data = await fetchGraphQLGitLab(GITLAB_GRAPHQL_QUERY);
  const nodes = data?.user?.authoredMergeRequests?.nodes || [];

  // Fetch related issues for each MR using REST API
  const contributions = await Promise.all(
    nodes.map(async (n) => {
      const repo = n.project?.fullPath || "";
      const projectId = encodeURIComponent(repo);
      const mrIid = n.iid;

      let relatedIssues = [];
      try {
        const closesIssuesUrl = `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${mrIid}/closes_issues`;
        const res = await fetch(closesIssuesUrl, {
          headers: {
            Authorization: `Bearer ${GITLAB_TOKEN}`,
          },
        });
        if (res.ok) {
          const issues = await res.json();
          relatedIssues = issues.map((issue) => ({
            number: issue.iid,
            url: issue.web_url,
          }));
        } else {
          console.warn(
            `Failed to fetch closes_issues for ${repo}#${mrIid}: ${res.status}`
          );
        }
      } catch (error) {
        console.warn(
          `Error fetching closes_issues for ${repo}#${mrIid}:`,
          error
        );
      }

      return {
        id: n.iid,
        title: n.title,
        repo,
        html_url: n.webUrl,
        body: n.description || null,
        merged_at: n.mergedAt || null,
        source: "gitlab",
        relatedIssues,
      };
    })
  );

  return contributions;
}

async function generateSummary(pr) {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const prompt = `You are generating raw MDX. NEVER wrap output in triple backticks or a code block. Output ONLY the MDX document described.

Context:
Platform: ${pr.source}
Repo: ${pr.repo}
Title: ${pr.title}
URL: ${pr.html_url}
MergedAt: ${pr.merged_at || "(unknown)"}
RelatedIssues: ${pr.relatedIssues.map((i) => i.url).join(", ") || "None"}

MDX structure:
---
id: ${pr.id}
repo: "${pr.repo}"
title: "${pr.title.replace(/"/g, '\\"')}"
url: "${pr.html_url}"
mergedAt: "${pr.merged_at || ""}"
relatedIssues: [${pr.relatedIssues.map((i) => `"${i.url}"`).join(", ")}]
summary: "A brief one-sentence summary of the ${
    pr.source === "gitlab" ? "merge request" : "pull request"
  }."
---

## What was done
- Concrete, technical changes (files, components, features).
- Implementation approach (patterns/algorithms if relevant).

## Impact
- Effects on users, performance, reliability, DX.
- Note breaking changes or migrations (if any).

## Technical details
- Notable files/paths touched; technologies used.
- Design / architectural decisions.
- Testing or validation notes if inferable.

## Related issues
${
  pr.relatedIssues.length > 0
    ? pr.relatedIssues.map((i) => `- [#${i.number}](${i.url})`).join("\n")
    : "- None"
}

## Metadata
- Source: ${pr.source}
- Repo: ${pr.repo}
- URL: ${pr.html_url}
- Merged: ${pr.merged_at || "(unknown)"}

Rules:
- DO NOT include backticks.
- DO NOT guess unavailable details.
- Keep lists brief but informative.
- Output ONLY what is specified above.`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
  });

  return response.text;
}

async function main() {
  const allContributions = [];

  // Fetch GitHub PRs
  try {
    const prs = await fetchGithubPRs();
    allContributions.push(...prs);
  } catch (error) {
    if (error instanceof Error && /GITHUB_TOKEN/.test(error.message)) {
      console.warn("Skipping GitHub contributions: GITHUB_TOKEN not provided");
    } else {
      console.error("Failed to fetch GitHub contributions", error);
    }
  }

  // Fetch GitLab MRs
  try {
    const mrs = await fetchGitLabMRs();
    allContributions.push(...mrs);
  } catch (error) {
    if (error instanceof Error && /GITLAB_TOKEN/.test(error.message)) {
      console.warn("Skipping GitLab contributions: GITLAB_TOKEN not provided");
    } else {
      console.error("Failed to fetch GitLab contributions", error);
    }
  }

  const contributionsDir = "contributions";
  if (!fs.existsSync(contributionsDir)) {
    fs.mkdirSync(contributionsDir);
  }

  for (const pr of allContributions) {
    // Check if PR/MR is in ignored list
    if (ignoredPRs.includes(`${pr.repo}#${pr.id}`)) {
      console.log(`Ignoring ${pr.repo}#${pr.id}`);
      continue;
    }
    const repoSlug = pr.repo.replace("/", "-");
    const dateStr = pr.merged_at
      ? pr.merged_at.slice(0, 10).replace(/-/g, "")
      : "00000000";
    const fileName = `${dateStr}-${repoSlug}-${pr.id}.mdx`;
    const filePath = path.join(contributionsDir, fileName);

    if (fs.existsSync(filePath)) {
      console.log(`Skipping ${fileName}, already exists.`);
      continue;
    }

    console.log(
      `Generating summary for ${pr.source === "gitlab" ? "MR" : "PR"} ${
        pr.id
      } in ${pr.repo}`
    );
    try {
      const summaryMDX = await generateSummary(pr);
      fs.writeFileSync(filePath, summaryMDX);
    } catch (error) {
      console.error(
        `Failed to generate summary for ${
          pr.source === "gitlab" ? "MR" : "PR"
        } ${pr.id}:`,
        error
      );
    }
  }
}

main().catch(console.error);
