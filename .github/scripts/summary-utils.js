/**
 * Shared utilities for summary issue management.
 *
 * Used by both build-and-report.js (incremental per-project updates)
 * and rebuild-summary.js (full rebuild after all matrix jobs complete).
 */

function getMavenIdentifier(mavenVersion, mavenBranchOrCommit) {
  return mavenBranchOrCommit
    ? `${mavenBranchOrCommit} (built with ${mavenVersion})`
    : mavenVersion;
}

function getSummaryTitle(mavenIdentifier) {
  return `Maven Compatibility Summary (${mavenIdentifier})`;
}

/**
 * Find the summary issue by label and title, and verify the build ID matches.
 * Returns { issue, stale } where stale=true means this build is outdated.
 */
async function findSummaryIssue(github, context, mavenIdentifier, currentBuildId) {
  const summaryTitle = getSummaryTitle(mavenIdentifier);
  const summaryIssues = await github.rest.issues.listForRepo({
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: 'all',
    labels: 'maven4-summary'
  });

  const issue = summaryIssues.data.find(i => i.title === summaryTitle);
  if (!issue) return { issue: null, stale: false };

  // Check build ID
  if (currentBuildId && issue.body) {
    const match = issue.body.match(/Build ID:\s*([^\n]+)/);
    const summaryBuildId = match ? match[1].trim() : null;
    if (summaryBuildId && summaryBuildId !== currentBuildId) {
      return { issue, stale: true };
    }
  }

  return { issue, stale: false };
}

/**
 * Extract metadata from an existing summary body.
 */
function extractSummaryInfo(body) {
  if (!body) return { totalProjects: 966, startDate: null };

  const totalMatch = body.match(/\*\*Total Projects\*\*:\s*(\d+)/);
  const startMatch = body.match(/Started:\s*([^\n]+)/);

  return {
    totalProjects: totalMatch ? parseInt(totalMatch[1]) : 966,
    startDate: startMatch ? startMatch[1].trim() : null
  };
}

/**
 * Compute display ratios from raw counts.
 */
function calculateStats(counts, totalProjects) {
  const { success, maven3Failed, maven4Failed, knownIssue } = counts;
  const tested = success + maven3Failed + maven4Failed + knownIssue;

  return {
    total: totalProjects,
    tested,
    success,
    maven3Failed,
    maven4Failed,
    knownIssue,
    testedRatio:       (tested / totalProjects * 100).toFixed(1),
    successRatio:      tested > 0 ? (success      / tested * 100).toFixed(1) : '0.0',
    maven3FailedRatio: tested > 0 ? (maven3Failed / tested * 100).toFixed(1) : '0.0',
    maven4FailedRatio: tested > 0 ? (maven4Failed / tested * 100).toFixed(1) : '0.0',
    knownIssueRatio:   tested > 0 ? (knownIssue   / tested * 100).toFixed(1) : '0.0'
  };
}

/**
 * Count statuses from table rows (pipe-delimited markdown).
 * Each row is: |project|status|details|error|
 */
function countStatusesFromTable(tableBody) {
  const lines = tableBody.split('\n');
  const tableStartIndex = lines.findIndex(line => line.startsWith('|Project|'));
  if (tableStartIndex === -1) return { success: 0, maven3Failed: 0, maven4Failed: 0, knownIssue: 0 };

  const counts = { success: 0, maven3Failed: 0, maven4Failed: 0, knownIssue: 0 };
  lines
    .slice(tableStartIndex + 2)
    .filter(line => line.trim() && line.startsWith('|') && !line.includes('*Testing in progress*'))
    .forEach(row => {
      const cols = row.split('|');
      if (cols.length < 3) return;
      const s = cols[2].trim();
      if      (s === '✅ Success')           counts.success++;
      else if (s === '⚠️ Maven 3.x Failed') counts.maven3Failed++;
      else if (s === '❌ Maven 4.x Failed')  counts.maven4Failed++;
      else if (s === '🔶 Known Issue')       counts.knownIssue++;
    });
  return counts;
}

/**
 * Render the full summary issue body from stats + table content.
 */
function buildSummaryBody({ mavenVersion, mavenBranchOrCommit, startDate, buildId, stats, tableContent }) {
  return (
    "# Maven Compatibility Testing Summary\n\n" +
    "Testing with Maven 3.x first, then Maven 4.x if 3.x succeeds\n" +
    "Maven 4.x version: " + mavenVersion + "\n" +
    (mavenBranchOrCommit
      ? "Building from branch/commit: " + mavenBranchOrCommit + "\n" : '') +
    (startDate ? "Started: " + startDate + "\n" : '') +
    "Last updated: " + new Date().toISOString() + "\n" +
    "Build ID: " + buildId + "\n\n" +
    "## Summary Statistics\n\n" +
    `- **Total Projects**: ${stats.total}\n` +
    `- **Tested Projects**: ${stats.tested} (${stats.testedRatio}%)\n` +
    `- **✅ Successful**: ${stats.success} (${stats.successRatio}%)\n` +
    `- **⚠️ Maven 3.x Failed**: ${stats.maven3Failed} (${stats.maven3FailedRatio}%)\n` +
    `- **❌ Maven 4.x Failed**: ${stats.maven4Failed} (${stats.maven4FailedRatio}%)\n` +
    (stats.knownIssue > 0
      ? `- **🔶 Known Issue**: ${stats.knownIssue} (${stats.knownIssueRatio}%)\n` : '') +
    '\n' +
    "## Detailed Results\n\n" +
    tableContent
  );
}

/**
 * Update the summary issue body via GraphQL (avoids REST update race).
 */
async function updateSummaryIssue(github, nodeId, body, mutationId) {
  await github.graphql(`
    mutation UpdateIssue($input: UpdateIssueInput!) {
      updateIssue(input: $input) {
        issue { id }
        clientMutationId
      }
    }
  `, {
    input: {
      id: nodeId,
      body,
      clientMutationId: mutationId
    }
  });
}

module.exports = {
  getMavenIdentifier,
  getSummaryTitle,
  findSummaryIssue,
  extractSummaryInfo,
  calculateStats,
  countStatusesFromTable,
  buildSummaryBody,
  updateSummaryIssue
};
