const { execSync } = require('child_process');

async function runMaven3Build() {
  let maven3Success = false;
  let maven3Output = '';
  let maven3Error = '';

  try {
    console.log('Testing with Maven 3.x first...');

    // Check if project has Maven wrapper
    let maven3Command = 'mvn';
    try {
      execSync('test -f project/mvnw');
      console.log('Found Maven wrapper, checking version...');
      const wrapperVersion = execSync('./mvnw -version 2>&1', { encoding: 'utf8', cwd: process.cwd() + '/project' });
      if (wrapperVersion.includes('Apache Maven 3.')) {
        console.log('Maven wrapper is configured for Maven 3.x, using it');
        maven3Command = './mvnw';
      } else {
        console.log('Maven wrapper is not Maven 3.x, downloading Maven 3.9.9');
        // Download Maven 3.9.9
        execSync('wget -q https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz');
        execSync('tar xzf apache-maven-3.9.9-bin.tar.gz');
        maven3Command = `${process.env.GITHUB_WORKSPACE}/apache-maven-3.9.9/bin/mvn`;
      }
    } catch (wrapperError) {
      console.log('No Maven wrapper found, downloading Maven 3.9.9');
      // Download Maven 3.9.9
      execSync('wget -q https://archive.apache.org/dist/maven/maven-3/3.9.9/binaries/apache-maven-3.9.9-bin.tar.gz');
      execSync('tar xzf apache-maven-3.9.9-bin.tar.gz');
      maven3Command = `${process.env.GITHUB_WORKSPACE}/apache-maven-3.9.9/bin/mvn`;
    }

    const maven3VersionInfo = execSync(`${maven3Command} -version 2>&1`, { encoding: 'utf8', cwd: process.cwd() + '/project' });
    console.log('Running Maven 3.x build...');
    // Run Maven build and capture output
    const maven3BuildOutput = execSync(`${maven3Command} -V -B -e package -DskipTests 2>&1`, {
      encoding: 'utf8',
      cwd: process.cwd() + '/project',
      timeout: 1800000 // 30 minutes timeout
    });
    maven3Success = true;
    maven3Output = maven3VersionInfo;
    maven3Error = maven3BuildOutput; // For successful builds, this contains the build log
  } catch (error) {
    maven3Success = false;
    maven3Output = 'Maven 3.x version info not available';
    // Enhanced error capture - collect all available output
    let errorOutput = '';
    let stdoutContent = '';
    let stderrContent = '';

    // Capture stdout if available
    if (error.stdout) {
      stdoutContent = error.stdout.toString();
    }

    // Capture stderr if available
    if (error.stderr) {
      stderrContent = error.stderr.toString();
    }

    // Handle execSync output array format
    if (error.output && error.output.length > 0) {
      const outputs = error.output.filter(o => o);
      if (outputs.length > 1) {
        stdoutContent = outputs[1] ? outputs[1].toString() : '';
        stderrContent = outputs[2] ? outputs[2].toString() : '';
      } else if (outputs.length === 1) {
        stdoutContent = outputs[0].toString();
      }
    }

    // Combine outputs intelligently
    if (stderrContent && stdoutContent) {
      errorOutput = `STDERR:\n${stderrContent}\n\nSTDOUT:\n${stdoutContent}`;
    } else if (stderrContent) {
      errorOutput = stderrContent;
    } else if (stdoutContent) {
      errorOutput = stdoutContent;
    } else {
      errorOutput = error.message || 'Unknown error occurred';
    }

    maven3Error = errorOutput;
    console.log('Maven 3.x build failed. Error details captured:', errorOutput.substring(0, 500) + '...');

    // Analyze the error for better reporting
    try {
      execSync('echo "' + errorOutput.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '" > maven3_build.log');
      const errorAnalysis = execSync('bash scripts/analyze-build-errors.sh maven3_build.log summary 2>&1', {
        encoding: 'utf8',
        timeout: 30000 // 30 seconds timeout
      });
      console.log('Maven 3.x error analysis:', errorAnalysis);
    } catch (analysisError) {
      console.log('Failed to analyze Maven 3.x error:', analysisError.message);
    }
  }

  return { maven3Success, maven3Output, maven3Error };
}

async function runMaven4Build() {
  let buildSuccess = false;
  let mavenOutput = '';
  let buildError = '';
  let mvnupOutput = '';

  try {
    // Get Maven version info with better error handling
    let versionInfo = '';
    try {
      versionInfo = execSync('mvn -version 2>&1', { encoding: 'utf8' });
      execSync('echo "' + versionInfo.replace(/"/g, '\\"') + '" > maven_version.txt');
    } catch (versionError) {
      versionInfo = 'Maven version info not available';
      console.log('Failed to get Maven version:', versionError.message);
    }

    // Check for and run mvnup apply if it exists
    const mavenDistDir = process.env.MAVEN_DIST_DIR || '';
    const mvnupPath = `${process.env.GITHUB_WORKSPACE}/${mavenDistDir}/bin/mvnup`;

    try {
      execSync(`test -f "${mvnupPath}"`);
      console.log('Found mvnup script, running mvnup apply...');
      mvnupOutput = execSync(`"${mvnupPath}" apply 2>&1`, {
        encoding: 'utf8',
        cwd: process.cwd() + '/project',
        timeout: 300000 // 5 minutes timeout for mvnup
      });
      console.log('mvnup apply completed successfully');
    } catch (mvnupError) {
      if (mvnupError.code === 1) {
        // mvnup script doesn't exist
        console.log('mvnup script not found, skipping...');
        mvnupOutput = '';
      } else {
        // mvnup script exists but failed
        console.log('mvnup apply failed:', mvnupError.message);
        let mvnupErrorOutput = '';
        if (mvnupError.stdout) {
          mvnupErrorOutput = mvnupError.stdout;
        } else if (mvnupError.stderr) {
          mvnupErrorOutput = mvnupError.stderr;
        } else if (mvnupError.output && mvnupError.output.length > 0) {
          mvnupErrorOutput = mvnupError.output.filter(o => o).join('\n');
        } else {
          mvnupErrorOutput = mvnupError.message || 'Unknown mvnup error';
        }
        mvnupOutput = `mvnup apply failed:\n${mvnupErrorOutput}`;
      }
    }

    console.log('Running Maven 4.x build...');
    const buildOutput = execSync('mvn -V -B -e package -DskipTests 2>&1', {
      encoding: 'utf8',
      cwd: process.cwd() + '/project',
      timeout: 1800000 // 30 minutes timeout
    });
    buildSuccess = true;
    mavenOutput = versionInfo;
    buildError = buildOutput;
  } catch (error) {
    buildSuccess = false;
    // Try to get version info from file, fallback to error message
    try {
      mavenOutput = execSync('cat maven_version.txt 2>/dev/null || echo "Maven version info not available"').toString();
    } catch (fileError) {
      mavenOutput = 'Maven version info not available';
    }

    // Enhanced error capture - collect all available output
    let errorOutput = '';
    let stdoutContent = '';
    let stderrContent = '';

    // Capture stdout if available
    if (error.stdout) {
      stdoutContent = error.stdout.toString();
    }

    // Capture stderr if available
    if (error.stderr) {
      stderrContent = error.stderr.toString();
    }

    // Handle execSync output array format
    if (error.output && error.output.length > 0) {
      const outputs = error.output.filter(o => o);
      if (outputs.length > 1) {
        stdoutContent = outputs[1] ? outputs[1].toString() : '';
        stderrContent = outputs[2] ? outputs[2].toString() : '';
      } else if (outputs.length === 1) {
        stdoutContent = outputs[0].toString();
      }
    }

    // Combine outputs intelligently
    if (stderrContent && stdoutContent) {
      errorOutput = `STDERR:\n${stderrContent}\n\nSTDOUT:\n${stdoutContent}`;
    } else if (stderrContent) {
      errorOutput = stderrContent;
    } else if (stdoutContent) {
      errorOutput = stdoutContent;
    } else {
      errorOutput = error.message || 'Unknown error occurred';
    }

    buildError = errorOutput;
    console.log('Maven 4.x build failed. Error details captured:', errorOutput.substring(0, 500) + '...');

    // Analyze the error for better reporting
    try {
      execSync('echo "' + errorOutput.replace(/"/g, '\\"').replace(/\n/g, '\\n') + '" > maven4_build.log');
      const errorAnalysis = execSync('bash scripts/analyze-build-errors.sh maven4_build.log summary 2>&1', {
        encoding: 'utf8',
        timeout: 30000 // 30 seconds timeout
      });
      console.log('Maven 4.x error analysis:', errorAnalysis);
    } catch (analysisError) {
      console.log('Failed to analyze Maven 4.x error:', analysisError.message);
    }
  }

  return { buildSuccess, mavenOutput, buildError, mvnupOutput };
}

async function createOrUpdateIndividualProjectIssue(github, context, repo, maven3Success, maven3Output, maven3Error, buildSuccess, mavenOutput, buildError, mvnupOutput, mavenVersion, mavenBranchOrCommit, chunkNumber, timingInfo) {
  // Determine overall status
  let overallStatus;
  if (!maven3Success) {
    overallStatus = '⚠️ Maven 3.x Failed';
  } else if (buildSuccess) {
    overallStatus = '✅ Success';
  } else {
    overallStatus = '❌ Maven 4.x Failed';
  }

  const mavenIdentifier = mavenBranchOrCommit ? `${mavenBranchOrCommit} (built with ${mavenVersion})` : mavenVersion;
  const issueTitle = `Maven 4 Test Results: ${repo} (${mavenIdentifier})`;

  const issues = await github.rest.issues.listForRepo({
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: 'all',
    labels: 'maven4-testing'
  });

  const maxLength = 30000; // Reduced to accommodate both Maven 3.x and 4.x logs
  const safeMaven3Error = maven3Error ? String(maven3Error) : '';
  const safeBuildError = buildError ? String(buildError) : '';
  const truncatedMaven3Log = safeMaven3Error.length > maxLength ? '...' + safeMaven3Error.slice(-maxLength) : safeMaven3Error;
  const truncatedMaven4Log = safeBuildError.length > maxLength ? '...' + safeBuildError.slice(-maxLength) : safeBuildError;

  // Get last commit info
  let lastCommitInfo = '';
  try {
    const commitSha = execSync('git rev-parse HEAD', { encoding: 'utf8', cwd: process.cwd() + '/project' }).trim();
    const commitDate = execSync('git log -1 --format=%ci', { encoding: 'utf8', cwd: process.cwd() + '/project' }).trim();
    const shortSha = commitSha.substring(0, 8);
    lastCommitInfo = `- **Last Commit**: ${shortSha} (${commitDate})\n`;
  } catch (error) {
    console.log('Could not retrieve commit info:', error.message);
    lastCommitInfo = '- **Last Commit**: Not available\n';
  }

  // Add build timing and diagnostic information
  let diagnosticInfo = '';
  try {
    const javaVersion = execSync('java -version 2>&1 | head -1', { encoding: 'utf8' }).trim();
    const osInfo = execSync('uname -a 2>/dev/null || echo "OS info not available"', { encoding: 'utf8' }).trim();
    diagnosticInfo = `- **Java Version**: ${javaVersion}\n- **OS**: ${osInfo}\n`;
  } catch (diagError) {
    diagnosticInfo = '- **Diagnostic Info**: Not available\n';
  }

  // Add timing information if available
  if (timingInfo) {
    diagnosticInfo += `- **Maven 3.x Duration**: ${(timingInfo.maven3Duration / 1000).toFixed(1)}s\n`;
    if (timingInfo.maven4Duration > 0) {
      diagnosticInfo += `- **Maven 4.x Duration**: ${(timingInfo.maven4Duration / 1000).toFixed(1)}s\n`;
    }
    diagnosticInfo += `- **Total Duration**: ${(timingInfo.overallDuration / 1000).toFixed(1)}s\n`;
  }

  let body =
    "# Maven Compatibility Test Report\n\n" +
    `- **Repository**: [${repo}](https://github.com/apache/${repo})\n` +
    `- **Overall Status**: ${overallStatus}\n` +
    `- **Maven 3.x Status**: ${maven3Success ? '✅ Success' : '⚠️ Failed'}\n` +
    `- **Maven 4.x Status**: ${maven3Success ? (buildSuccess ? '✅ Success' : '❌ Failed') : '⏭️ Skipped (Maven 3.x failed)'}\n` +
    `- **Maven 4.x Version**: ${mavenVersion}\n` +
    (mavenBranchOrCommit ?
      `- **Maven Branch/Commit**: ${mavenBranchOrCommit} (built with Maven ${mavenVersion})\n` : '') +
    lastCommitInfo +
    diagnosticInfo +
    `- **Test Date**: ${new Date().toISOString()}\n` +
    `- **Chunk**: ${chunkNumber}\n\n`;

  // Add Maven 3.x results
  body +=
    "<details>\n" +
    "<summary>Maven 3.x Version Info</summary>\n\n" +
    "```\n" +
    maven3Output + "\n" +
    "```\n" +
    "</details>\n\n";

  if (!maven3Success) {
    // Check if we have separated stdout/stderr
    if (safeMaven3Error.includes('STDERR:') && safeMaven3Error.includes('STDOUT:')) {
      const parts = safeMaven3Error.split('\n\nSTDOUT:\n');
      const stderrPart = parts[0].replace('STDERR:\n', '');
      const stdoutPart = parts[1] || '';

      body +=
        "<details>\n" +
        "<summary>Maven 3.x Error Output (STDERR)</summary>\n\n" +
        "```\n" +
        (stderrPart.length > maxLength ? '...' + stderrPart.slice(-maxLength) : stderrPart) + "\n" +
        "```\n" +
        "</details>\n\n";

      if (stdoutPart.trim()) {
        body +=
          "<details>\n" +
          "<summary>Maven 3.x Build Output (STDOUT)</summary>\n\n" +
          "```\n" +
          (stdoutPart.length > maxLength ? '...' + stdoutPart.slice(-maxLength) : stdoutPart) + "\n" +
          "```\n" +
          "</details>\n\n";
      }
    } else {
      body +=
        "<details>\n" +
        "<summary>Maven 3.x Build Error Details</summary>\n\n" +
        "```\n" +
        truncatedMaven3Log + "\n" +
        "```\n" +
        "</details>\n\n";
    }
  }

  // Add Maven 4.x results only if Maven 3.x succeeded
  if (maven3Success) {
    body +=
      "<details>\n" +
      "<summary>Maven 4.x Version Info</summary>\n\n" +
      "```\n" +
      mavenOutput + "\n" +
      "```\n" +
      "</details>\n\n";

    // Add mvnup output section if available
    if (mvnupOutput && mvnupOutput.trim()) {
      body +=
        "<details>\n" +
        "<summary>Maven Upgrade Output</summary>\n\n" +
        "```\n" +
        mvnupOutput + "\n" +
        "```\n" +
        "</details>\n\n";
    }

    // Add build error details if Maven 4.x build failed
    if (!buildSuccess) {
      // Check if we have separated stdout/stderr
      if (safeBuildError.includes('STDERR:') && safeBuildError.includes('STDOUT:')) {
        const parts = safeBuildError.split('\n\nSTDOUT:\n');
        const stderrPart = parts[0].replace('STDERR:\n', '');
        const stdoutPart = parts[1] || '';

        body +=
          "<details>\n" +
          "<summary>Maven 4.x Error Output (STDERR)</summary>\n\n" +
          "```\n" +
          (stderrPart.length > maxLength ? '...' + stderrPart.slice(-maxLength) : stderrPart) + "\n" +
          "```\n" +
          "</details>\n\n";

        if (stdoutPart.trim()) {
          body +=
            "<details>\n" +
            "<summary>Maven 4.x Build Output (STDOUT)</summary>\n\n" +
            "```\n" +
            (stdoutPart.length > maxLength ? '...' + stdoutPart.slice(-maxLength) : stdoutPart) + "\n" +
            "```\n" +
            "</details>\n";
        }
      } else {
        body +=
          "<details>\n" +
          "<summary>Maven 4.x Build Error Details</summary>\n\n" +
          "```\n" +
          truncatedMaven4Log + "\n" +
          "```\n" +
          "</details>\n";
      }
    }
  }

  const existingIssue = issues.data.find(issue => issue.title === issueTitle);
  let issueNumber;

  // Determine labels based on results
  let labels = ['maven4-testing'];
  if (!maven3Success) {
    labels.push('maven3-failed');
  } else if (buildSuccess) {
    labels.push('success');
  } else {
    labels.push('maven4-failed');
  }

  if (existingIssue) {
    await github.rest.issues.update({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: existingIssue.number,
      body: body,
      state: 'open',
      labels: labels
    });
    issueNumber = existingIssue.number;
  } else {
    const newIssue = await github.rest.issues.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      title: issueTitle,
      body: body,
      labels: labels
    });
    issueNumber = newIssue.data.number;
  }

  return { issueNumber, status: overallStatus };
}

function extractFirstErrorLine(buildError, buildSuccess, maven3Error, maven3Success) {
  // Ensure error variables are strings
  const safeMaven3Error = maven3Error ? String(maven3Error) : '';
  const safeBuildError = buildError ? String(buildError) : '';

  // If Maven 3.x failed, extract error from Maven 3.x
  if (!maven3Success) {
    if (!safeMaven3Error) {
      return 'Maven 3.x: Build failed (no error details)';
    }
    const lines = safeMaven3Error.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.startsWith('[ERROR]')) {
        // Check the next line to ensure it's not another [ERROR]
        if (i > 0 && !lines[i - 1].startsWith('[ERROR]')) {
          return `Maven 3.x: ${line}`;
        } else if (i === 0) { // Handle the case where the last error line has no subsequent non-error line
          return `Maven 3.x: ${line}`;
        }
      }
    }
    return 'Maven 3.x: Build failed';
  }

  // If Maven 3.x succeeded but Maven 4.x failed
  if (maven3Success && !buildSuccess) {
    if (!safeBuildError) {
      return 'Maven 4.x: Build failed (no error details)';
    }
    const lines = safeBuildError.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.startsWith('[ERROR]')) {
        // Check the next line to ensure it's not another [ERROR]
        if (i > 0 && !lines[i - 1].startsWith('[ERROR]')) {
          return `Maven 4.x: ${line}`;
        } else if (i === 0) { // Handle the case where the last error line has no subsequent non-error line
          return `Maven 4.x: ${line}`;
        }
      }
    }
    return 'Maven 4.x: Build failed';
  }

  // Both succeeded
  return '';
}

async function updateSummaryTable(github, context, repo, status, issueNumber, buildError, buildSuccess, maven3Error, maven3Success, mavenVersion, mavenBranchOrCommit, currentBuildId) {
  const mavenIdentifier = mavenBranchOrCommit ? `${mavenBranchOrCommit} (built with ${mavenVersion})` : mavenVersion;
  const summaryTitle = `Maven Compatibility Summary (${mavenIdentifier})`;
  const summaryIssues = await github.rest.issues.listForRepo({
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: 'all',
    labels: 'maven4-summary'
  });

  const existingSummary = summaryIssues.data.find(issue => issue.title === summaryTitle);

  // Double-check if this build is still the current one (backup check)
  if (existingSummary && existingSummary.body) {
    const buildIdMatch = existingSummary.body.match(/Build ID:\s*([^\n]+)/);
    const summaryBuildId = buildIdMatch ? buildIdMatch[1].trim() : null;

    if (summaryBuildId && summaryBuildId !== currentBuildId) {
      console.log(`Build ID mismatch detected during summary update - this build (${currentBuildId}) is outdated. Current build: ${summaryBuildId}`);
      console.log('Skipping summary update (this should have been caught earlier).');
      return;
    }
  }

  const issueUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/issues/${issueNumber}`;

  // Process table update with first error line
  function processTableUpdate(currentBody, firstErrorLine) {
    const tableHeader = '|Project|Status|Details|Error|';
    const headerSeparator = '|---|---|---|---|';
    const newEntry = `|${repo}|${status}|[Details](${issueUrl})|${firstErrorLine}|`;

    // Handle null or undefined currentBody, or freshly cleared summary
    if (!currentBody) {
      return `${tableHeader}\n${headerSeparator}\n${newEntry}`;
    }

    // Split the body into lines
    const lines = currentBody.split('\n');

    // Find the table in the content
    const tableStartIndex = lines.findIndex(line => line.startsWith('|Project|'));
    if (tableStartIndex === -1) {
      // If no table exists, create a new one
      return `${tableHeader}\n${headerSeparator}\n${newEntry}`;
    }

    // Get existing table rows (excluding header and separator)
    const tableRows = lines
      .slice(tableStartIndex + 2) // Skip header and separator
      .filter(line => line.trim() && line.startsWith('|')) // Only keep non-empty table rows
      .map(line => {
        // Ensure all rows end with | if they don't already
        return line.endsWith('|') ? line : line + '|';
      });

    // Extract project name from the new entry
    const newProjectName = repo;

    // Filter out any existing entries for the same project
    const filteredRows = tableRows.filter(row => {
      const projectName = row.split('|')[1].trim();
      return projectName !== newProjectName;
    });

    // Add the new entry and sort all rows
    const allRows = [...filteredRows, newEntry];
    const sortedRows = allRows.sort((a, b) => {
      const aProject = a.split('|')[1].trim();
      const bProject = b.split('|')[1].trim();
      return aProject.localeCompare(bProject);
    });

    // Reconstruct the table with header
    return `${tableHeader}\n${headerSeparator}\n${sortedRows.join('\n')}`;
  }

  const firstErrorLine = extractFirstErrorLine(buildError, buildSuccess, maven3Error, maven3Success);

  // Extract total projects and start date from existing summary
  function extractSummaryInfo(existingBody) {
    if (!existingBody) {
      return { totalProjects: 966, startDate: null }; // Default fallback
    }

    const totalMatch = existingBody.match(/\*\*Total Projects\*\*:\s*(\d+)/);
    const startMatch = existingBody.match(/Started:\s*([^\n]+)/);

    return {
      totalProjects: totalMatch ? parseInt(totalMatch[1]) : 966,
      startDate: startMatch ? startMatch[1] : null
    };
  }

  // Calculate statistics from the updated table
  function calculateStatistics(tableBody, totalProjects) {
    const lines = tableBody.split('\n');
    const tableStartIndex = lines.findIndex(line => line.startsWith('|Project|'));

    if (tableStartIndex === -1) {
      // No table exists yet, this is the first entry
      const success = status === '✅ Success' ? 1 : 0;
      const maven3Failed = status === '⚠️ Maven 3.x Failed' ? 1 : 0;
      const maven4Failed = status === '❌ Maven 4.x Failed' ? 1 : 0;
      const tested = 1;

      return {
        total: totalProjects,
        tested: tested,
        success: success,
        maven3Failed: maven3Failed,
        maven4Failed: maven4Failed,
        testedRatio: (tested / totalProjects * 100).toFixed(1),
        successRatio: tested > 0 ? (success / tested * 100).toFixed(1) : '0.0',
        maven3FailedRatio: tested > 0 ? (maven3Failed / tested * 100).toFixed(1) : '0.0',
        maven4FailedRatio: tested > 0 ? (maven4Failed / tested * 100).toFixed(1) : '0.0'
      };
    }

    // Get existing table rows (excluding header and separator)
    const tableRows = lines
      .slice(tableStartIndex + 2) // Skip header and separator
      .filter(line => line.trim() && line.startsWith('|') && !line.includes('*Testing in progress*')) // Only keep non-empty table rows, exclude progress message
      .map(line => line.endsWith('|') ? line : line + '|');

    let success = 0;
    let maven3Failed = 0;
    let maven4Failed = 0;

    tableRows.forEach(row => {
      const columns = row.split('|');
      if (columns.length >= 3) {
        const rowStatus = columns[2].trim();
        if (rowStatus === '✅ Success') {
          success++;
        } else if (rowStatus === '⚠️ Maven 3.x Failed') {
          maven3Failed++;
        } else if (rowStatus === '❌ Maven 4.x Failed') {
          maven4Failed++;
        }
      }
    });

    const tested = success + maven3Failed + maven4Failed;

    return {
      total: totalProjects,
      tested: tested,
      success: success,
      maven3Failed: maven3Failed,
      maven4Failed: maven4Failed,
      testedRatio: (tested / totalProjects * 100).toFixed(1),
      successRatio: tested > 0 ? (success / tested * 100).toFixed(1) : '0.0',
      maven3FailedRatio: tested > 0 ? (maven3Failed / tested * 100).toFixed(1) : '0.0',
      maven4FailedRatio: tested > 0 ? (maven4Failed / tested * 100).toFixed(1) : '0.0'
    };
  }

  const updatedTable = existingSummary ? processTableUpdate(existingSummary.body, firstErrorLine) :
    '|Project|Status|Details|Error|\n|---|---|---|---|' + `\n|${repo}|${status}|[Details](${issueUrl})|${firstErrorLine}|`;

  const summaryInfo = extractSummaryInfo(existingSummary ? existingSummary.body : null);
  const stats = calculateStatistics(updatedTable, summaryInfo.totalProjects);

  const summaryBody =
    "# Maven Compatibility Testing Summary\n\n" +
    "Testing with Maven 3.x first, then Maven 4.x if 3.x succeeds\n" +
    "Maven 4.x version: " + mavenVersion + "\n" +
    (mavenBranchOrCommit ?
      "Building from branch/commit: " + mavenBranchOrCommit + "\n" : '') +
    (summaryInfo.startDate ? "Started: " + summaryInfo.startDate + "\n" : '') +
    "Last updated: " + new Date().toISOString() + "\n" +
    "Build ID: " + currentBuildId + "\n\n" +
    "## Summary Statistics\n\n" +
    `- **Total Projects**: ${stats.total}\n` +
    `- **Tested Projects**: ${stats.tested} (${stats.testedRatio}%)\n` +
    `- **✅ Successful**: ${stats.success} (${stats.successRatio}%)\n` +
    `- **⚠️ Maven 3.x Failed**: ${stats.maven3Failed} (${stats.maven3FailedRatio}%)\n` +
    `- **❌ Maven 4.x Failed**: ${stats.maven4Failed} (${stats.maven4FailedRatio}%)\n\n` +
    "## Detailed Results\n\n" +
    updatedTable;

  const clientMutationId = `maven4-summary-${Date.now()}`;

  try {
    if (existingSummary) {
      await github.graphql(`
        mutation UpdateIssue($input: UpdateIssueInput!) {
          updateIssue(input: $input) {
            issue {
              id
            }
            clientMutationId
          }
        }
      `, {
        input: {
          id: existingSummary.node_id,
          body: summaryBody,
          clientMutationId: clientMutationId
        }
      });
    } else {
      await github.rest.issues.create({
        owner: context.repo.owner,
        repo: context.repo.repo,
        title: summaryTitle,
        body: summaryBody,
        labels: ['maven4-summary']
      });
    }
  } catch (error) {
    console.error('Error updating summary table:', error);
    throw error;
  }
}

// Main execution function
module.exports = async function(github, context) {
  const overallStartTime = Date.now();

  // Validate build environment first
  console.log('Validating build environment...');
  try {
    const validationOutput = execSync('bash scripts/validate-build-environment.sh project mvn 2>&1', {
      encoding: 'utf8',
      timeout: 60000 // 1 minute timeout
    });
    console.log('Build environment validation completed successfully');
    console.log('Validation output:', validationOutput.substring(0, 1000) + '...');
  } catch (validationError) {
    console.log('Build environment validation failed:', validationError.message);
    // Continue anyway, but log the issue
  }

  // First, run Maven 3.x build
  console.log('Starting Maven 3.x build...');
  const maven3StartTime = Date.now();
  const { maven3Success, maven3Output, maven3Error } = await runMaven3Build();
  const maven3Duration = Date.now() - maven3StartTime;
  console.log(`Maven 3.x build completed in ${(maven3Duration / 1000).toFixed(1)}s`);

  let buildSuccess = false;
  let mavenOutput = '';
  let buildError = '';
  let mvnupOutput = '';
  let maven4Duration = 0;

  // Only run Maven 4.x if Maven 3.x succeeded
  if (maven3Success) {
    console.log('Maven 3.x build succeeded, proceeding with Maven 4.x...');
    const maven4StartTime = Date.now();
    const maven4Results = await runMaven4Build();
    maven4Duration = Date.now() - maven4StartTime;
    console.log(`Maven 4.x build completed in ${(maven4Duration / 1000).toFixed(1)}s`);
    buildSuccess = maven4Results.buildSuccess;
    mavenOutput = maven4Results.mavenOutput;
    buildError = maven4Results.buildError;
    mvnupOutput = maven4Results.mvnupOutput;
  } else {
    console.log('Maven 3.x build failed, skipping Maven 4.x build');
  }

  const overallDuration = Date.now() - overallStartTime;
  console.log(`Overall test completed in ${(overallDuration / 1000).toFixed(1)}s`);

  const repo = process.env.GITHUB_REPOSITORY_MATRIX || '';
  const mavenVersion = process.env.GITHUB_EVENT_INPUTS_MAVEN_VERSION || '';
  const mavenBranchOrCommit = process.env.GITHUB_EVENT_INPUTS_MAVEN_BRANCH_OR_COMMIT || '';
  const chunkNumber = process.env.GITHUB_EVENT_INPUTS_CHUNK_NUMBER || '';
  const buildId = process.env.GITHUB_EVENT_INPUTS_BUILD_ID || '';

  // Create/update individual project issue with timing information
  const timingInfo = {
    maven3Duration: maven3Duration,
    maven4Duration: maven4Duration,
    overallDuration: overallDuration
  };

  const { issueNumber, status } = await createOrUpdateIndividualProjectIssue(
    github, context, repo, maven3Success, maven3Output, maven3Error, buildSuccess, mavenOutput, buildError, mvnupOutput, mavenVersion, mavenBranchOrCommit, chunkNumber, timingInfo
  );

  // Add delay to prevent GitHub rate limiting (2.5 seconds)
  console.log('Adding delay to prevent rate limiting...');
  await new Promise(resolve => setTimeout(resolve, 2500));

  // Update summary table
  await updateSummaryTable(github, context, repo, status, issueNumber, buildError, buildSuccess, maven3Error, maven3Success, mavenVersion, mavenBranchOrCommit, buildId);
};
