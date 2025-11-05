const fs = require("fs");
const path = require("path");
const { GoogleGenAI } = require("@google/genai");

const GITHUB_REPO_OWNER = process.env.GITHUB_REPO_OWNER;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// List of PRs to ignore (add PR IDs here), format: "owner/repo#number"
const ignoredPRs = [
  "open-minds/awesome-openminds-team#106",
  "shrutikapoor08/devjoke#610",
]; // e.g., ["owner/repo#123", "other/repo#456"]

if (!GITHUB_TOKEN) {
  throw new Error("GITHUB_TOKEN is required");
}
if (!GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is required");
}

// Minimal GraphQL fetch helper
async function fetchGraphQL(query) {
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
    console.warn("GitHub GraphQL returned errors", json.errors);
  }

  return json.data || {};
}

// Fetch merged PRs authored by the user but NOT in user's own repos/orgs using GraphQL
async function fetchExternalMergedPRs() {
  const q = `is:pr is:merged author:${GITHUB_REPO_OWNER} -user:${GITHUB_REPO_OWNER}`;

  const graphQuery = `query {
    search(query: "${q
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')}", type: ISSUE, first: 100) {
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

  const data = await fetchGraphQL(graphQuery);
  const nodes = data?.search?.nodes || [];

  const contributions = nodes.map((n) => {
    const repo = n.repository?.nameWithOwner || "";
    const relatedIssues =
      (n.closingIssuesReferences?.nodes || []).map((r) => ({
        number: r.number,
        url: r.url,
      })) || [];

    return {
      id: n.number, // Use number for file naming
      title: n.title,
      repo,
      html_url: n.url,
      body: n.body || n.bodyText || null,
      merged_at: n.mergedAt || null,
      type: "pr",
      state: n.state || "merged",
      relatedIssues,
    };
  });

  return contributions;
}

async function generateSummary(pr) {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  const relatedIssuesText =
    pr.relatedIssues.length > 0
      ? `Related issues: ${pr.relatedIssues
          .map((i) => `#${i.number}`)
          .join(", ")}`
      : "No related issues.";

  const prompt = `Generate a detailed summary for this GitHub PR in MDX format. Use the exact following template structure, filling in the frontmatter and sections based on the PR details.

---
prNumber: ${pr.id}
repo: "${pr.repo}"
title: "${pr.title.replace(/"/g, '\\"')}"
url: "${pr.html_url}"
mergedAt: "${pr.merged_at || ""}"
summary: "A brief one-sentence summary of the PR."
---

# Contribution Summary

## What was done

- List the key changes made in the PR.

## Impact

- Describe the impact of these changes.

## Technical details

- Provide technical details like modified files, technologies used, etc.

PR Title: ${pr.title}
PR Body: ${pr.body || "No description."}
${relatedIssuesText}

Make the summary concise but informative. Ensure the frontmatter is correctly formatted as YAML. Do not wrap the output in any code blocks, markdown formatting, or backticks. Output the raw MDX content only.`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
  });

  return response.text;
}

async function main() {
  const contributions = await fetchExternalMergedPRs();

  // Sort by merged_at descending
  contributions.sort((a, b) => {
    const da = a.merged_at ? new Date(a.merged_at).getTime() : 0;
    const db = b.merged_at ? new Date(b.merged_at).getTime() : 0;
    return db - da;
  });

  const contributionsDir = "contributions";
  if (!fs.existsSync(contributionsDir)) {
    fs.mkdirSync(contributionsDir);
  }

  for (const pr of contributions) {
    if (ignoredPRs.includes(`${pr.repo}#${pr.id}`)) {
      console.log(`Ignoring PR ${pr.repo}#${pr.id}`);
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

    console.log(`Generating summary for PR ${pr.id} in ${pr.repo}`);
    try {
      const summaryMDX = await generateSummary(pr);
      fs.writeFileSync(filePath, summaryMDX);
    } catch (error) {
      console.error(`Failed to generate summary for PR ${pr.id}:`, error);
    }
  }
}

main().catch(console.error);
