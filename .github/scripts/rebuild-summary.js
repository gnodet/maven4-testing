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

const {
  getMavenIdentifier,
  findSummaryIssue,
  extractSummaryInfo,
  calculateStats,
  buildSummaryBody,
  updateSummaryIssue
} = require('./summary-utils');

module.exports = async function rebuildSummary(github, context) {
  const mavenVersion = process.env.GITHUB_EVENT_INPUTS_MAVEN_VERSION;
  const mavenBranchOrCommit = process.env.GITHUB_EVENT_INPUTS_MAVEN_BRANCH_OR_COMMIT;
  const currentBuildId = process.env.GITHUB_EVENT_INPUTS_BUILD_ID;
  const chunkNumber = process.env.GITHUB_EVENT_INPUTS_CHUNK_NUMBER;

  if (!currentBuildId) {
    console.log('No build ID provided — skipping summary rebuild.');
    return;
  }

  const mavenIdentifier = getMavenIdentifier(mavenVersion, mavenBranchOrCommit);

  console.log(`Rebuilding summary for build ${currentBuildId} (chunk ${chunkNumber})...`);

  // 1. Find and validate the summary issue
  const { issue: summaryIssue, stale } = await findSummaryIssue(
    github, context, mavenIdentifier, currentBuildId
  );

  if (!summaryIssue) {
    console.log('Summary issue not found — nothing to rebuild.');
    return;
  }
  if (stale) {
    console.log(`Build ${currentBuildId} is outdated. Skipping.`);
    return;
  }

  const { totalProjects, startDate } = extractSummaryInfo(summaryIssue.body);

  // 2. Fetch ALL individual project issues from this build
  const issuePrefix = 'Maven 4 Test Results:';
  const titleSuffix = currentBuildId
    ? `(${mavenIdentifier}) [${currentBuildId}]`
    : `(${mavenIdentifier})`;

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

    const matching = batch.data.filter(issue =>
      issue.title.startsWith(issuePrefix) && issue.title.endsWith(titleSuffix)
    );
    allIssues.push(...matching);
    page++;

    if (page > 50) break; // safety valve
  }

  console.log(`Found ${allIssues.length} individual project issues for this build.`);

  // 3. Build deduplicated table rows from individual issues
  const rowsByRepo = new Map();

  for (const issue of allIssues) {
    const repoMatch = issue.title.match(/Maven 4 Test Results:\s+(.+?)\s+\(/);
    if (!repoMatch) continue;
    const repo = repoMatch[1].trim();

    // Keep latest issue per repo (skip if already seen)
    if (rowsByRepo.has(repo)) continue;

    // Determine status from labels
    const labelNames = issue.labels.map(l => l.name);
    let status;
    if (labelNames.includes('known-issue')) {
      status = '🔶 Known Issue';
    } else if (labelNames.includes('maven4-failed')) {
      status = '❌ Maven 4.x Failed';
    } else if (labelNames.includes('maven3-failed')) {
      status = '⚠️ Maven 3.x Failed';
    } else if (labelNames.includes('success')) {
      status = '✅ Success';
    } else {
      // Fallback: parse from issue body
      if (issue.body && issue.body.includes('Maven 3.x build failed')) {
        status = '⚠️ Maven 3.x Failed';
      } else if (issue.body && issue.body.includes('Maven 4.x build failed')) {
        status = '❌ Maven 4.x Failed';
      } else {
        status = '✅ Success';
      }
    }

    // Extract first error line from issue body
    let errorLine = '';
    if (status !== '✅ Success' && issue.body) {
      const knownIssueMatch = issue.body.match(/\*\*Known Issue\*\*:\s*\[([^\]]+)\]\(([^)]+)\)/);
      if (knownIssueMatch) {
        errorLine = `[${knownIssueMatch[1]}](${knownIssueMatch[2]})`;
      } else {
        const errorLines = issue.body.match(/\[ERROR\]\s+\S.{5,80}/g);
        if (errorLines && errorLines.length > 0) {
          errorLine = errorLines[0].substring(0, 80);
        }
      }
    }

    const issueUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/issues/${issue.number}`;
    rowsByRepo.set(repo, { repo, status, issueUrl, errorLine });
  }

  // Sort alphabetically
  const sortedRows = Array.from(rowsByRepo.values())
    .sort((a, b) => a.repo.toLowerCase().localeCompare(b.repo.toLowerCase()));

  // Count statuses
  const counts = { success: 0, maven3Failed: 0, maven4Failed: 0, knownIssue: 0 };
  for (const row of sortedRows) {
    if      (row.status === '✅ Success')           counts.success++;
    else if (row.status === '⚠️ Maven 3.x Failed') counts.maven3Failed++;
    else if (row.status === '❌ Maven 4.x Failed')  counts.maven4Failed++;
    else if (row.status === '🔶 Known Issue')       counts.knownIssue++;
  }

  const stats = calculateStats(counts, totalProjects);

  // 4. Build table and body
  const tableHeader = '|Project|Status|Details|Error|';
  const headerSeparator = '|---|---|---|---|';
  const tableRows = sortedRows.map(row =>
    `|${row.repo}|${row.status}|[Details](${row.issueUrl})|${row.errorLine}|`
  );
  const tableContent = tableHeader + '\n' + headerSeparator + '\n' + tableRows.join('\n');

  const updatedBody = buildSummaryBody({
    mavenVersion, mavenBranchOrCommit, startDate, buildId: currentBuildId,
    stats, tableContent
  });

  // 5. Update the summary issue
  await updateSummaryIssue(
    github, summaryIssue.node_id, updatedBody,
    `rebuild-summary-chunk${chunkNumber}-${Date.now()}`
  );

  console.log(`Summary rebuilt from ${sortedRows.length} individual issues (chunk ${chunkNumber} completed).`);
  console.log(`Stats: ${counts.success} success, ${counts.maven3Failed} M3-failed, ${counts.maven4Failed} M4-failed, ${counts.knownIssue} known-issue`);
};
