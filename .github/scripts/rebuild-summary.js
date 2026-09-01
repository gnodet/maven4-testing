/**
 * Rebuild the summary issue from individual project issues.
 *
 * This runs after all matrix jobs in a chunk complete. It reads every individual
 * project issue from this build and reconstructs the summary table from scratch,
 * eliminating race conditions from concurrent updates during the matrix run.
 *
 * Since chunks run as separate workflow dispatches, each chunk's rebuild includes
 * results from ALL chunks (not just its own). The last chunk to finish produces
 * the final, complete summary.
 */

module.exports = async function rebuildSummary(github, context) {
  const mavenVersion = process.env.GITHUB_EVENT_INPUTS_MAVEN_VERSION;
  const mavenBranchOrCommit = process.env.GITHUB_EVENT_INPUTS_MAVEN_BRANCH_OR_COMMIT;
  const currentBuildId = process.env.GITHUB_EVENT_INPUTS_BUILD_ID;
  const chunkNumber = process.env.GITHUB_EVENT_INPUTS_CHUNK_NUMBER;

  if (!currentBuildId) {
    console.log('No build ID provided — skipping summary rebuild.');
    return;
  }

  const mavenIdentifier = mavenBranchOrCommit
    ? `${mavenBranchOrCommit} (built with ${mavenVersion})`
    : mavenVersion;
  const summaryTitle = `Maven Compatibility Summary (${mavenIdentifier})`;
  const issueTitle = `Maven 4 Test Results:`;
  const titleSuffix = `(${mavenIdentifier})`;

  console.log(`Rebuilding summary for build ${currentBuildId} (chunk ${chunkNumber})...`);

  // 1. Find the summary issue
  const summaryIssues = await github.rest.issues.listForRepo({
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: 'all',
    labels: 'maven4-summary'
  });

  const summaryIssue = summaryIssues.data.find(issue => issue.title === summaryTitle);
  if (!summaryIssue) {
    console.log('Summary issue not found — nothing to rebuild.');
    return;
  }

  // Verify build ID matches
  if (summaryIssue.body) {
    const buildIdMatch = summaryIssue.body.match(/Build ID:\s*([^\n]+)/);
    const summaryBuildId = buildIdMatch ? buildIdMatch[1].trim() : null;
    if (summaryBuildId && summaryBuildId !== currentBuildId) {
      console.log(`Build ID mismatch — this build (${currentBuildId}) is outdated. Skipping.`);
      return;
    }
  }

  // Extract start date from existing summary
  const startDateMatch = summaryIssue.body
    ? summaryIssue.body.match(/Started:\s*([^\n]+)/)
    : null;
  const startDate = startDateMatch ? startDateMatch[1].trim() : new Date().toISOString();

  // 2. Fetch ALL individual project issues from this build
  //    They're labeled 'maven4-testing' and titled 'Maven 4 Test Results: <repo> (<identifier>)'
  const allIssues = [];
  let page = 1;
  while (true) {
    const batch = await github.rest.issues.listForRepo({
      owner: context.repo.owner,
      repo: context.repo.repo,
      state: 'all',
      labels: 'maven4-testing',
      per_page: 100,
      page: page
    });

    if (batch.data.length === 0) break;

    // Filter to issues matching this build's maven identifier
    const matching = batch.data.filter(issue =>
      issue.title.startsWith(issueTitle) && issue.title.endsWith(titleSuffix)
    );
    allIssues.push(...matching);
    page++;

    // Safety valve: don't fetch more than 50 pages (5000 issues)
    if (page > 50) break;
  }

  console.log(`Found ${allIssues.length} individual project issues for this build.`);

  // 3. Build the table rows from individual issues
  const rows = [];
  let successCount = 0;
  let maven3FailedCount = 0;
  let maven4FailedCount = 0;
  let knownIssueCount = 0;

  for (const issue of allIssues) {
    // Extract repo name from title: "Maven 4 Test Results: <repo> (<identifier>)"
    const repoMatch = issue.title.match(/Maven 4 Test Results:\s+(.+?)\s+\(/);
    if (!repoMatch) continue;
    const repo = repoMatch[1].trim();

    // Determine status from labels
    const labelNames = issue.labels.map(l => l.name);
    let status;
    if (labelNames.includes('known-issue')) {
      status = '🔶 Known Issue';
      knownIssueCount++;
    } else if (labelNames.includes('maven4-failed')) {
      status = '❌ Maven 4.x Failed';
      maven4FailedCount++;
    } else if (labelNames.includes('maven3-failed')) {
      status = '⚠️ Maven 3.x Failed';
      maven3FailedCount++;
    } else if (labelNames.includes('success')) {
      status = '✅ Success';
      successCount++;
    } else {
      // Fallback: parse from issue body
      if (issue.body && issue.body.includes('Maven 3.x build failed')) {
        status = '⚠️ Maven 3.x Failed';
        maven3FailedCount++;
      } else if (issue.body && issue.body.includes('Maven 4.x build failed')) {
        status = '❌ Maven 4.x Failed';
        maven4FailedCount++;
      } else {
        status = '✅ Success';
        successCount++;
      }
    }

    // Extract first error line from issue body (truncated for table)
    let errorLine = '';
    if (status !== '✅ Success' && issue.body) {
      // Look for the known-issue URL or first [ERROR] line
      // Format: **Known Issue**: [id](url) — description
      const knownIssueMatch = issue.body.match(/\*\*Known Issue\*\*:\s*\[([^\]]+)\]\(([^)]+)\)/);
      if (knownIssueMatch) {
        errorLine = `[${knownIssueMatch[1]}](${knownIssueMatch[2]})`;
      } else {
        // Look for meaningful [ERROR] lines (skip empty ones and generic ones)
        const errorLines = issue.body.match(/\[ERROR\]\s+\S.{5,80}/g);
        if (errorLines && errorLines.length > 0) {
          // Pick the first meaningful error
          errorLine = errorLines[0].substring(0, 80);
        }
      }
    }

    const issueUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/issues/${issue.number}`;
    rows.push({
      repo,
      status,
      issueUrl,
      errorLine,
      sortKey: repo.toLowerCase()
    });
  }

  // Sort alphabetically by repo name
  rows.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // Deduplicate: keep only the latest issue per repo (highest issue number)
  const seen = new Map();
  for (const row of rows) {
    if (!seen.has(row.repo)) {
      seen.set(row.repo, row);
    }
  }
  const uniqueRows = Array.from(seen.values());
  uniqueRows.sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // Recalculate stats from deduplicated rows
  successCount = 0;
  maven3FailedCount = 0;
  maven4FailedCount = 0;
  knownIssueCount = 0;
  for (const row of uniqueRows) {
    if (row.status === '✅ Success') successCount++;
    else if (row.status === '⚠️ Maven 3.x Failed') maven3FailedCount++;
    else if (row.status === '❌ Maven 4.x Failed') maven4FailedCount++;
    else if (row.status === '🔶 Known Issue') knownIssueCount++;
  }

  const tested = uniqueRows.length;

  // Get total projects from existing summary
  const totalMatch = summaryIssue.body
    ? summaryIssue.body.match(/\*\*Total Projects\*\*:\s*(\d+)/)
    : null;
  const totalProjects = totalMatch ? parseInt(totalMatch[1]) : 966;

  const testedRatio = (tested / totalProjects * 100).toFixed(1);
  const successRatio = tested > 0 ? (successCount / tested * 100).toFixed(1) : '0.0';
  const maven3FailedRatio = tested > 0 ? (maven3FailedCount / tested * 100).toFixed(1) : '0.0';
  const maven4FailedRatio = tested > 0 ? (maven4FailedCount / tested * 100).toFixed(1) : '0.0';
  const knownIssueRatio = tested > 0 ? (knownIssueCount / tested * 100).toFixed(1) : '0.0';

  // 4. Build the table
  const tableHeader = '|Project|Status|Details|Error|';
  const headerSeparator = '|---|---|---|---|';
  const tableRows = uniqueRows.map(row =>
    `|${row.repo}|${row.status}|[Details](${row.issueUrl})|${row.errorLine}|`
  );

  const updatedBody =
    "# Maven Compatibility Testing Summary\n\n" +
    "Testing with Maven 3.x first, then Maven 4.x if 3.x succeeds\n" +
    "Maven 4.x version: " + mavenVersion + "\n" +
    (mavenBranchOrCommit ?
      "Building from branch/commit: " + mavenBranchOrCommit + "\n" : '') +
    "Started: " + startDate + "\n" +
    "Last updated: " + new Date().toISOString() + "\n" +
    "Build ID: " + currentBuildId + "\n\n" +
    "## Summary Statistics\n\n" +
    `- **Total Projects**: ${totalProjects}\n` +
    `- **Tested Projects**: ${tested} (${testedRatio}%)\n` +
    `- **✅ Successful**: ${successCount} (${successRatio}%)\n` +
    `- **⚠️ Maven 3.x Failed**: ${maven3FailedCount} (${maven3FailedRatio}%)\n` +
    `- **❌ Maven 4.x Failed**: ${maven4FailedCount} (${maven4FailedRatio}%)\n` +
    (knownIssueCount > 0 ? `- **🔶 Known Issue**: ${knownIssueCount} (${knownIssueRatio}%)\n` : '') +
    '\n' +
    "## Detailed Results\n\n" +
    tableHeader + '\n' + headerSeparator + '\n' + tableRows.join('\n');

  // 5. Update the summary issue
  await github.graphql(`
    mutation UpdateIssue($input: UpdateIssueInput!) {
      updateIssue(input: $input) {
        issue { id }
        clientMutationId
      }
    }
  `, {
    input: {
      id: summaryIssue.node_id,
      body: updatedBody,
      clientMutationId: `rebuild-summary-chunk${chunkNumber}-${Date.now()}`
    }
  });

  console.log(`Summary rebuilt from ${uniqueRows.length} individual issues (chunk ${chunkNumber} completed).`);
  console.log(`Stats: ${successCount} success, ${maven3FailedCount} M3-failed, ${maven4FailedCount} M4-failed, ${knownIssueCount} known-issue`);
};
