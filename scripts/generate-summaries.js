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

  const prompt = `Generate a comprehensive summary for this ${
    pr.source === "gitlab" ? "GitLab Merge Request" : "GitHub Pull Request"
  } in MDX format. This contribution was made to the repository "${
    pr.repo
  }" and ${
    pr.relatedIssues.length > 0
      ? `addresses ${pr.relatedIssues.length} related issue${
          pr.relatedIssues.length > 1 ? "s" : ""
        }`
      : "has no explicitly linked issues"
  }.

Use the exact following template structure, filling in the frontmatter and sections with detailed, specific information based on the contribution details.

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

# Contribution Summary

## What was done

- Provide specific details about the code changes, features added, bugs fixed, or improvements made
- Mention the main files or components that were modified
- Describe the implementation approach or solution

## Impact

- Explain how these changes affect users, performance, or the system
- Describe any breaking changes, new capabilities, or improved functionality
- Mention the scope of impact (e.g., affects all users, specific feature, internal improvement)

## Technical details

- Provide technical details like modified files, technologies used, algorithms implemented, etc.
- Include code patterns, frameworks, or libraries involved
- Mention any architectural changes or design decisions

**Related issues**: ${
    pr.relatedIssues.length > 0
      ? pr.relatedIssues.map((i) => `[#${i.number}](${i.url})`).join(", ")
      : "None"
  }

${pr.source === "gitlab" ? "MR" : "PR"} Title: ${pr.title}
${pr.source === "gitlab" ? "MR" : "PR"} Body: ${pr.body || "No description."}
**Related issues**: ${pr.relatedIssues
    .map((i) => `[#${i.number}](${i.url})`)
    .join(", ")}

INSTRUCTIONS:
- Be specific and technical in your descriptions
- Focus on the actual changes made, not just high-level descriptions
- Include concrete examples where relevant
- Explain the "why" and "how" of the changes
- Make the summary informative for developers who want to understand the contribution
- Ensure the frontmatter is correctly formatted as YAML
- Do not wrap the output in any code blocks, markdown formatting, or backticks
- Output the raw MDX content only`;

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
