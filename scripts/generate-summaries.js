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

// List of PRs to ignore
const ignoredPRs = [
  "open-minds/awesome-openminds-team#106",
  "shrutikapoor08/devjoke#610",
];

if (!GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required");
if (!GITLAB_TOKEN) throw new Error("GITLAB_TOKEN is required");
if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required");

// --- Helpers ---

// Sleep helper for rate limiting
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Clean MDX output (strip markdown code blocks if the LLM includes them)
function cleanMDX(text) {
  if (!text) return "";
  // Remove wrapping ```mdx, ```markdown, or just ```
  return text.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "");
}

// Generic patch fetcher
async function fetchPatch(url, token, type = "github") {
  try {
    const headers = { Authorization: `Bearer ${token}` };
    if (type === "github") {
      headers["Accept"] = "application/vnd.github.patch";
    }

    const res = await fetch(url, { headers });
    if (res.ok) {
      let patch = await res.text();
      if (patch.length > 15000) {
        patch = patch.slice(0, 15000) + "\n... (truncated)";
      }
      return patch;
    } else {
      console.warn(`Failed to fetch patch from ${url}: ${res.status}`);
      return null;
    }
  } catch (error) {
    console.warn(`Error fetching patch from ${url}:`, error.message);
    return null;
  }
}

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
    console.warn("GitHub GraphQL errors:", json.errors);
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
    console.warn("GitLab GraphQL errors:", json.errors);
  }
  return json.data || {};
}

// --- Data Fetchers ---

async function fetchGithubPRs() {
  const data = await fetchGraphQLGithub(GITHUB_GRAPHQL_QUERY);
  const nodes = data?.search?.nodes || [];

  return Promise.all(
    nodes.map(async (n) => {
      const repo = n.repository?.nameWithOwner || "";
      const relatedIssues = (n.closingIssuesReferences?.nodes || []).map(
        (r) => ({
          number: r.number,
          url: r.url,
        })
      );

      const [owner, name] = repo.split("/");
      const patchUrl = `https://api.github.com/repos/${owner}/${name}/pulls/${n.number}.patch`;
      const patch = await fetchPatch(patchUrl, GITHUB_TOKEN, "github");

      return {
        id: n.number,
        title: n.title,
        repo,
        html_url: n.url,
        body: n.body || n.bodyText || null,
        merged_at: n.mergedAt || null,
        source: "github",
        relatedIssues,
        patch,
      };
    })
  );
}

async function fetchGitLabMRs() {
  const data = await fetchGraphQLGitLab(GITLAB_GRAPHQL_QUERY);
  const nodes = data?.user?.authoredMergeRequests?.nodes || [];

  return Promise.all(
    nodes.map(async (n) => {
      const repo = n.project?.fullPath || "";
      const projectId = encodeURIComponent(repo);
      const mrIid = n.iid;

      // Fetch related issues
      let relatedIssues = [];
      try {
        const closesIssuesUrl = `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${mrIid}/closes_issues`;
        const res = await fetch(closesIssuesUrl, {
          headers: { Authorization: `Bearer ${GITLAB_TOKEN}` },
        });
        if (res.ok) {
          const issues = await res.json();
          relatedIssues = issues.map((issue) => ({
            number: issue.iid,
            url: issue.web_url,
          }));
        }
      } catch (error) {
        console.warn(
          `Error fetching related issues for ${repo}#${mrIid}:`,
          error.message
        );
      }

      const patchUrl = `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${mrIid}.patch`;
      const patch = await fetchPatch(patchUrl, GITLAB_TOKEN, "gitlab");

      return {
        id: n.iid,
        title: n.title,
        repo,
        html_url: n.webUrl,
        body: n.description || null,
        merged_at: n.mergedAt || null,
        source: "gitlab",
        relatedIssues,
        patch,
      };
    })
  );
}

// --- Generator ---

async function generateSummary(pr) {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const prompt = `You are an expert technical writer. Generate a concise, informative MDX summary for the following ${
    pr.source === "gitlab" ? "Merge Request" : "Pull Request"
  }.

Context:
- Platform: ${pr.source}
- Repo: ${pr.repo}
- Title: ${pr.title}
- URL: ${pr.html_url}
- MergedAt: ${pr.merged_at || "(unknown)"}
- RelatedIssues: ${pr.relatedIssues.map((i) => i.url).join(", ") || "None"}
- Patch:
${pr.patch ? `\`\`\`diff\n${pr.patch}\n\`\`\`` : "No patch available"}

MDX Format Requirements:
1. Start with the YAML frontmatter exactly as shown.
2. Follow with the content sections.
3. Use simple, clear language. 
4. Do NOT output markdown code fences (like \`\`\`mdx) around the entire output.

Desired Output Structure:
---
id: ${pr.id}
repo: "${pr.repo}"
title: "${pr.title.replace(/"/g, '\\"')}"
url: "${pr.html_url}"
mergedAt: "${pr.merged_at || ""}"
relatedIssues: [${pr.relatedIssues.map((i) => `"${i.url}"`).join(", ")}]
summary: "A brief one-sentence summary of the PR."
---

## What was done
- Bullet points of technical changes (files, logic, features).

## Impact
- User-facing or developer-facing impact.
- Breaking changes (if any).

## Technical details
- Specific libraries, patterns, or architecture decisions.

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
`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });

    // Sanitize the output just in case
    return cleanMDX(response.text);
  } catch (error) {
    console.error(`Gemini API Error for ${pr.repo}#${pr.id}:`, error.message);
    throw error;
  }
}

// --- Main ---

async function main() {
  const allContributions = [];

  // Parallel fetching of PR/MR metadata
  console.log("Fetching collection data...");
  const [githubResults, gitlabResults] = await Promise.allSettled([
    fetchGithubPRs().catch((e) => {
      console.warn("GitHub fetch failed:", e.message);
      return [];
    }),
    fetchGitLabMRs().catch((e) => {
      console.warn("GitLab fetch failed:", e.message);
      return [];
    }),
  ]);

  if (githubResults.status === "fulfilled")
    allContributions.push(...githubResults.value);
  if (gitlabResults.status === "fulfilled")
    allContributions.push(...gitlabResults.value);

  console.log(`Found ${allContributions.length} total contributions.`);

  const contributionsDir = "contributions";
  if (!fs.existsSync(contributionsDir)) {
    fs.mkdirSync(contributionsDir);
  }

  // Process sequentially to be gentle on Gemini Rate Limits
  // (Gemini Flash has high limits, but safest to process one by one or small batches)
  let count = 0;
  for (const pr of allContributions) {
    if (ignoredPRs.includes(`${pr.repo}#${pr.id}`)) {
      console.log(`Ignoring ${pr.repo}#${pr.id}`);
      continue;
    }

    // Generate slug-friendly filename: owner-repo-id.mdx
    // e.g. "google-gemini-cli-123.mdx"
    const safeRepo = pr.repo.replace(/[\/\.]/g, "-").toLowerCase(); // replace / and . with -
    const fileName = `${safeRepo}-${pr.id}.mdx`;
    const filePath = path.join(contributionsDir, fileName);

    if (fs.existsSync(filePath)) {
      // console.log(`Skipping ${fileName}, already exists.`);
      continue;
    }

    console.log(
      `Generating summary for ${pr.repo}#${pr.id} (${count + 1}/${
        allContributions.length
      })...`
    );

    try {
      const summaryMDX = await generateSummary(pr);
      if (summaryMDX) {
        fs.writeFileSync(filePath, summaryMDX);
        console.log(`✔ Saved ${fileName}`);
      }

      // Small delay to avoid rate limits
      await sleep(1000);
    } catch (error) {
      console.error(`✘ Failed to generate ${fileName}`);
    }
    count++;
  }
}

main().catch(console.error);
