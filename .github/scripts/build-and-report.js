const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  getMavenIdentifier,
  getSummaryTitle,
  findSummaryIssue,
  extractSummaryInfo,
  calculateStats,
  countStatusesFromTable,
  buildSummaryBody,
  updateSummaryIssue
} = require('./summary-utils');

function loadKnownIssues() {
  try {
    const knownIssuesPath = path.join(process.cwd(), '.github', 'known-issues.json');
    return JSON.parse(fs.readFileSync(knownIssuesPath, 'utf8'));
  } catch (error) {
    console.log('No known-issues.json found or failed to parse:', error.message);
    return [];
  }
}

function loadExtraArgs(repo) {
  try {
    const extraArgsPath = path.join(process.cwd(), 'maven4-extra-args.json');
    const extraArgs = JSON.parse(fs.readFileSync(extraArgsPath, 'utf8'));
    return extraArgs[repo] || '';
  } catch (error) {
    return '';
  }
}

function matchKnownIssue(repo, buildError) {
  const knownIssues = loadKnownIssues();
  const safeBuildError = buildError ? String(buildError) : '';

  for (const issue of knownIssues) {
    if (issue.projectPatterns && issue.projectPatterns.length > 0) {
      const projectMatch = issue.projectPatterns.some(pattern => repo.startsWith(pattern));
      if (!projectMatch) continue;
    }

    if (issue.errorPatterns && issue.errorPatterns.length > 0) {
      const allErrorsMatch = issue.errorPatterns.every(pattern => safeBuildError.includes(pattern));
      if (!allErrorsMatch) continue;
    }

    return issue;
  }

  return null;
}

/**
 * Returns true if the build error output indicates a transient network failure
 * (HTTP timeouts, connection resets, transfer failures to Maven Central, etc.)
 * that is likely to succeed on retry.
 */
function isTransientNetworkError(errorOutput) {
  if (!errorOutput) return false;
  const s = String(errorOutput);
  const patterns = [
    'HTTP connect timed out',
    'Read timed out',
    'Connection reset',
    'Connection refused',
    'Could not transfer artifact',
    'Could not transfer metadata',
    'SocketTimeoutException',
    'ConnectTimeoutException',
    'NoRouteToHostException',
    'UnknownHostException'
  ];
  // Only retry if the error is clearly network-related — check that at least
  // one timeout/transfer pattern appears AND points to a well-known repo.
  return patterns.some(p => s.includes(p));
}

async function runMaven3Build() {
  let maven3Success = false;
  let maven3Output = '';
  let maven3Error = '';

  // Use project JDK for Maven 3 if available (may be lower than JDK 17 required by Maven 4)
  const projectJdkHome = process.env.PROJECT_JDK_HOME;
  const maven3Env = projectJdkHome
    ? { ...process.env, JAVA_HOME: projectJdkHome, PATH: `${projectJdkHome}/bin:${process.env.PATH}` }
    : process.env;
  if (projectJdkHome) {
    console.log(`Using project JDK for Maven 3 build: ${projectJdkHome}`);
  }

  // Early exit: skip projects with no pom.xml at root — these are sub-repos,
  // retired projects, or repos that use a different build system entirely.
  const projectPomPath = path.join(process.cwd(), 'project', 'pom.xml');
  if (!fs.existsSync(projectPomPath)) {
    console.log('No pom.xml found in project root — skipping (not a Maven project)');
    return {
      maven3Success: false,
      maven3Output: 'No pom.xml found',
      maven3Error: 'No pom.xml found at project root. This repository may be a sub-module, retired, or use a different build system.'
    };
  }

  try {
    console.log('Testing with Maven 3.x first...');

    // Check if project has Maven wrapper
    let maven3Command = 'mvn';
    try {
      execSync('test -f project/mvnw');
      console.log('Found Maven wrapper, checking version...');
      const wrapperVersion = execSync('./mvnw -version 2>&1', { encoding: 'utf8', cwd: process.cwd() + '/project', env: maven3Env });
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

    const maven3VersionInfo = execSync(`${maven3Command} -version 2>&1`, { encoding: 'utf8', cwd: process.cwd() + '/project', env: maven3Env });

    // Fix HTTP repository URLs that are blocked by Maven 3.8.1+.
    // Since Maven 3.8.1, http:// repositories are blocked by default (CVE-2021-26291).
    // Many older Apache projects still declare http:// repo URLs in their POMs.
    // We rewrite these to https:// before the build to avoid false-positive failures.
    try {
      const httpFixCount = execSync(
        `find project -name pom.xml -exec grep -l 'http://repo\\|http://repository\\|http://snapshots\\|http://people.apache\\|http://oss\\.sonatype\\|http://maven\\.restlet\\|http://dl\\.bintray\\|http://repository\\.springsource\\|http://repo\\.spring\\|http://svn\\.apache\\|http://www\\.mvnsearch' {} \\; 2>/dev/null | head -50`,
        { encoding: 'utf8', cwd: process.cwd() }
      ).trim();
      if (httpFixCount) {
        console.log('Fixing HTTP repository URLs blocked by Maven 3.8.1+...');
        execSync(
          `find project -name pom.xml -exec sed -i ` +
          `-e 's|http://repo\\.maven\\.apache\\.org|https://repo.maven.apache.org|g' ` +
          `-e 's|http://repository\\.apache\\.org|https://repository.apache.org|g' ` +
          `-e 's|http://repo1\\.maven\\.org|https://repo1.maven.org|g' ` +
          `-e 's|http://snapshots\\.repository\\.codehaus\\.org|https://repository.codehaus.org|g' ` +
          `-e 's|http://people\\.apache\\.org|https://people.apache.org|g' ` +
          `-e 's|http://www\\.ibiblio\\.org/maven2|https://repo.maven.apache.org/maven2|g' ` +
          `-e 's|http://oss\\.sonatype\\.org|https://oss.sonatype.org|g' ` +
          `-e 's|http://svn\\.apache\\.org|https://svn.apache.org|g' ` +
          `-e 's|http://repo\\.spring\\.io|https://repo.spring.io|g' ` +
          `-e 's|http://repository\\.springsource\\.com|https://repo.spring.io|g' ` +
          `-e 's|http://maven\\.restlet\\.org|https://maven.restlet.talend.com|g' ` +
          `-e 's|http://dl\\.bintray\\.com|https://dl.bintray.com|g' ` +
          `-e 's|http://www\\.mvnsearch\\.org|https://repo.maven.apache.org|g' ` +
          `{} \\;`,
          { encoding: 'utf8', cwd: process.cwd(), timeout: 60000 }
        );
        console.log('HTTP→HTTPS repository URL rewrite completed');
      }
    } catch (httpFixError) {
      console.log('HTTP URL fix failed (non-fatal):', httpFixError.message);
    }

    console.log('Running Maven 3.x build...');
    // Run Maven build and capture output
    // Skip lint/doc/policy checks that are irrelevant to Maven compatibility testing:
    //   -Drat.skip          — Apache RAT license header checks
    //   -Dmaven.javadoc.skip — Javadoc generation (locale/encoding errors)
    //   -Dcheckstyle.skip    — Checkstyle (style-only, not build correctness)
    //   -Denforcer.skip      — Enforcer rules (JDK/Maven version gates, banned deps)
    //   -Dspotless.check.skip — Spotless code formatter checks
    const maven3Cmd = `${maven3Command} -V -B -e package -DskipTests -Drat.skip=true -Dmaven.javadoc.skip=true -Dcheckstyle.skip=true -Denforcer.skip=true -Dspotless.check.skip=true -Dmaven.repo.local=\${HOME}/.m2/repository-m3 2>&1`;
    let maven3BuildOutput;
    try {
      maven3BuildOutput = execSync(maven3Cmd, {
        encoding: 'utf8',
        cwd: process.cwd() + '/project',
        timeout: 3600000,
        maxBuffer: 50 * 1024 * 1024,
        env: maven3Env
      });
    } catch (firstAttemptError) {
      const firstOutput = firstAttemptError.stdout || firstAttemptError.stderr
        || (firstAttemptError.output && firstAttemptError.output.filter(o => o).join('\n'))
        || firstAttemptError.message || '';
      if (isTransientNetworkError(String(firstOutput))) {
        console.log('Maven 3.x build failed with transient network error, retrying in 30s...');
        await new Promise(resolve => setTimeout(resolve, 30000));
        maven3BuildOutput = execSync(maven3Cmd, {
          encoding: 'utf8',
          cwd: process.cwd() + '/project',
          timeout: 3600000,
          maxBuffer: 50 * 1024 * 1024,
          env: maven3Env
        });
      } else {
        throw firstAttemptError;
      }
    }
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

async function runMaven4Build(extraArgs) {
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
      // Unset MAVEN_ARGS to prevent project/CI env vars from leaking into mvnup.
      // mvnup is a thin wrapper around `mvn --up`, so it inherits MAVEN_ARGS
      // and .mvn/maven.config — options like --ntp can cause unexpected failures.
      const mvnupEnv = { ...process.env };
      delete mvnupEnv.MAVEN_ARGS;
      mvnupOutput = execSync(`"${mvnupPath}" apply 2>&1`, {
        encoding: 'utf8',
        cwd: process.cwd() + '/project',
        timeout: 300000, // 5 minutes timeout for mvnup
        maxBuffer: 50 * 1024 * 1024, // 50 MB
        env: mvnupEnv
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

    // After mvnup modifies POMs, reformat them to avoid false-positive format-check
    // failures caused by mvnup's POM edits.  The formatter config may live in a parent
    // POM (e.g. Sling parent) so we can't detect it by grepping the local pom.xml.
    // Instead, just attempt each formatter — if the plugin isn't configured, Maven
    // exits quickly with "No plugin found for prefix" which we harmlessly ignore.
    if (mvnupOutput && mvnupOutput.includes('Modified')) {
      for (const fmt of [
        { name: 'spotless', goal: 'spotless:apply' },
        { name: 'sortpom',  goal: 'sortpom:sort'   },
        { name: 'tidy',     goal: 'tidy:pom'        }
      ]) {
        try {
          console.log(`Trying ${fmt.name} to reformat POMs after mvnup...`);
          execSync(`mvn -B ${fmt.goal} -Dmaven.repo.local=\${HOME}/.m2/repository-m4 2>&1`, {
            encoding: 'utf8',
            cwd: process.cwd() + '/project',
            timeout: 120000,
            maxBuffer: 10 * 1024 * 1024
          });
          console.log(`${fmt.name} completed successfully`);
        } catch (formatError) {
          const msg = (formatError.stdout || formatError.message || '').toString();
          if (msg.includes('No plugin found for prefix')) {
            console.log(`${fmt.name} not configured in this project, skipping`);
          } else {
            console.log(`${fmt.name} failed (non-fatal): ${formatError.message}`);
          }
        }
      }
    }

    console.log('Running Maven 4.x build...');
    const extraArgsStr = extraArgs ? ` ${extraArgs}` : '';
    if (extraArgsStr) {
      console.log(`Using extra args: ${extraArgsStr}`);
    }
    const maven4Cmd = `mvn -V -B -e clean package -DskipTests -Drat.skip=true -Dmaven.javadoc.skip=true -Dcheckstyle.skip=true -Denforcer.skip=true -Dspotless.check.skip=true -Dsort.skip=true -Dmaven.repo.local=\${HOME}/.m2/repository-m4${extraArgsStr} 2>&1`;
    let buildOutput;
    try {
      buildOutput = execSync(maven4Cmd, {
        encoding: 'utf8',
        cwd: process.cwd() + '/project',
        timeout: 3600000,
        maxBuffer: 50 * 1024 * 1024
      });
    } catch (firstAttemptError) {
      const firstOutput = firstAttemptError.stdout || firstAttemptError.stderr
        || (firstAttemptError.output && firstAttemptError.output.filter(o => o).join('\n'))
        || firstAttemptError.message || '';
      if (isTransientNetworkError(String(firstOutput))) {
        console.log('Maven 4.x build failed with transient network error, retrying in 30s...');
        await new Promise(resolve => setTimeout(resolve, 30000));
        buildOutput = execSync(maven4Cmd, {
          encoding: 'utf8',
          cwd: process.cwd() + '/project',
          timeout: 3600000,
          maxBuffer: 50 * 1024 * 1024
        });
      } else {
        throw firstAttemptError;
      }
    }
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

async function createOrUpdateIndividualProjectIssue(github, context, repo, maven3Success, maven3Output, maven3Error, buildSuccess, mavenOutput, buildError, mvnupOutput, mavenVersion, mavenBranchOrCommit, chunkNumber, timingInfo, buildId) {
  // Skip issue creation for repos without pom.xml — these aren't Maven projects
  if (!maven3Success && maven3Output === 'No pom.xml found') {
    console.log(`Skipping issue creation for ${repo} — no pom.xml at project root`);
    return { issueNumber: null, status: '⏭️ Skipped (no pom.xml)', knownIssue: null };
  }

  // Determine overall status
  let overallStatus;
  let knownIssue = null;
  if (!maven3Success) {
    overallStatus = '⚠️ Maven 3.x Failed';
  } else if (buildSuccess) {
    overallStatus = '✅ Success';
  } else {
    knownIssue = matchKnownIssue(repo, buildError);
    if (knownIssue) {
      overallStatus = '🔶 Known Issue';
      console.log(`Matched known issue ${knownIssue.id} for ${repo}`);
    } else {
      overallStatus = '❌ Maven 4.x Failed';
    }
  }

  const mavenIdentifier = mavenBranchOrCommit ? `${mavenBranchOrCommit} (built with ${mavenVersion})` : mavenVersion;
  const issueTitle = buildId
    ? `Maven 4 Test Results: ${repo} (${mavenIdentifier}) [${buildId}]`
    : `Maven 4 Test Results: ${repo} (${mavenIdentifier})`;

  const issues = await github.rest.issues.listForRepo({
    owner: context.repo.owner,
    repo: context.repo.repo,
    state: 'all',
    labels: 'maven4-testing'
  });

  const maxLength = 8000; // Keep each log under 8k to stay within GitHub's 65536 char issue body limit
  const safeMaven3Error = maven3Error ? String(maven3Error) : '';
  const safeBuildError = buildError ? String(buildError) : '';
  // Extract ERROR/WARNING lines for a compact error summary
  const extractErrors = (log) => {
    const lines = log.split('\n');
    const errorLines = lines.filter(l => /^\[ERROR\]|^\[WARNING\].*[Ff]ailed|Exception|Caused by/.test(l));
    return errorLines.length > 0 ? 'Key errors:\n' + errorLines.slice(-30).join('\n') + '\n\n' : '';
  };
  const maven3Errors = extractErrors(safeMaven3Error);
  const maven4Errors = extractErrors(safeBuildError);
  const truncatedMaven3Log = safeMaven3Error.length > maxLength ? maven3Errors + '...(truncated)...\n' + safeMaven3Error.slice(-maxLength) : safeMaven3Error;
  const truncatedMaven4Log = safeBuildError.length > maxLength ? maven4Errors + '...(truncated)...\n' + safeBuildError.slice(-maxLength) : safeBuildError;

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
    (knownIssue ? `- **Known Issue**: [${knownIssue.id}](${knownIssue.url}) — ${knownIssue.description}\n` : '') +
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
      const truncatedMvnupOutput = mvnupOutput.length > maxLength ? '...' + mvnupOutput.slice(-maxLength) : mvnupOutput;
      body +=
        "<details>\n" +
        "<summary>Maven Upgrade Output</summary>\n\n" +
        "```\n" +
        truncatedMvnupOutput + "\n" +
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
  } else if (knownIssue) {
    labels.push('known-issue');
  } else {
    labels.push('maven4-failed');
  }

  // GitHub has a 65536 character limit for issue bodies
  if (body.length > 65000) {
    body = body.substring(0, 64900) + '\n\n---\n*Issue body truncated due to GitHub size limit*\n';
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

  return { issueNumber, status: overallStatus, knownIssue };
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

async function updateSummaryTable(github, context, repo, status, issueNumber, buildError, buildSuccess, maven3Error, maven3Success, mavenVersion, mavenBranchOrCommit, currentBuildId, knownIssue) {
  const mavenIdentifier = getMavenIdentifier(mavenVersion, mavenBranchOrCommit);

  const { issue: existingSummary, stale } = await findSummaryIssue(
    github, context, mavenIdentifier, currentBuildId
  );

  if (stale) {
    console.log(`Build ID mismatch — this build (${currentBuildId}) is outdated. Skipping summary update.`);
    return;
  }

  const issueUrl = `https://github.com/${context.repo.owner}/${context.repo.repo}/issues/${issueNumber}`;

  // Merge this project's row into the existing table
  function processTableUpdate(currentBody, firstErrorLine) {
    const tableHeader = '|Project|Status|Details|Error|';
    const headerSeparator = '|---|---|---|---|';
    const newEntry = `|${repo}|${status}|[Details](${issueUrl})|${firstErrorLine}|`;

    if (!currentBody) {
      return `${tableHeader}\n${headerSeparator}\n${newEntry}`;
    }

    const lines = currentBody.split('\n');
    const tableStartIndex = lines.findIndex(line => line.startsWith('|Project|'));
    if (tableStartIndex === -1) {
      return `${tableHeader}\n${headerSeparator}\n${newEntry}`;
    }

    const tableRows = lines
      .slice(tableStartIndex + 2)
      .filter(line => line.trim() && line.startsWith('|'))
      .map(line => line.endsWith('|') ? line : line + '|');

    const filteredRows = tableRows.filter(row => {
      const projectName = row.split('|')[1].trim();
      return projectName !== repo;
    });

    const allRows = [...filteredRows, newEntry];
    allRows.sort((a, b) => {
      const aProject = a.split('|')[1].trim();
      const bProject = b.split('|')[1].trim();
      return aProject.localeCompare(bProject);
    });

    return `${tableHeader}\n${headerSeparator}\n${allRows.join('\n')}`;
  }

  const firstErrorLine = knownIssue
    ? `[${knownIssue.id}](${knownIssue.url})`
    : extractFirstErrorLine(buildError, buildSuccess, maven3Error, maven3Success);

  const MAX_RETRIES = 5;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Re-read the summary issue on retries to get the latest body
      let currentSummary = existingSummary;
      if (attempt > 1) {
        console.log(`Retry attempt ${attempt}: re-reading summary issue...`);
        const { issue: freshSummary, stale: freshStale } = await findSummaryIssue(
          github, context, mavenIdentifier, currentBuildId
        );
        if (freshStale) {
          console.log('Build ID mismatch on retry — skipping.');
          return;
        }
        currentSummary = freshSummary;
      }

      // Recompute table and stats from latest body
      const latestTable = currentSummary
        ? processTableUpdate(currentSummary.body, firstErrorLine)
        : '|Project|Status|Details|Error|\n|---|---|---|---|' + `\n|${repo}|${status}|[Details](${issueUrl})|${firstErrorLine}|`;

      const { totalProjects, startDate } = extractSummaryInfo(currentSummary ? currentSummary.body : null);
      const counts = countStatusesFromTable(latestTable);
      const stats = calculateStats(counts, totalProjects);

      const latestBody = buildSummaryBody({
        mavenVersion, mavenBranchOrCommit, startDate, buildId: currentBuildId,
        stats, tableContent: latestTable
      });

      if (currentSummary) {
        await updateSummaryIssue(
          github, currentSummary.node_id, latestBody,
          `maven4-summary-${Date.now()}`
        );
      } else {
        await github.rest.issues.create({
          owner: context.repo.owner,
          repo: context.repo.repo,
          title: getSummaryTitle(mavenIdentifier),
          body: latestBody,
          labels: ['maven4-summary']
        });
        return;
      }

      // Verify the project row survived (detect concurrent overwrite)
      await new Promise(resolve => setTimeout(resolve, 1000));
      const verifyIssue = await github.rest.issues.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        issue_number: currentSummary.number
      });

      if (verifyIssue.data.body && verifyIssue.data.body.includes(`|${repo}|`)) {
        console.log(`Summary update verified for ${repo} (attempt ${attempt})`);
        return;
      }

      console.log(`Summary update for ${repo} was overwritten by concurrent update (attempt ${attempt}/${MAX_RETRIES})`);
      const backoffMs = Math.floor(Math.random() * 3000) + 1000;
      await new Promise(resolve => setTimeout(resolve, backoffMs));

    } catch (error) {
      console.error(`Error updating summary table (attempt ${attempt}/${MAX_RETRIES}):`, error);
      if (attempt === MAX_RETRIES) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.warn(`Failed to persist summary update for ${repo} after ${MAX_RETRIES} attempts`);
}

// Main execution function
module.exports = async function(github, context) {
  const overallStartTime = Date.now();

  // Log available disk space
  try {
    const diskSpace = execSync('df -h . | tail -1', { encoding: 'utf8' }).trim();
    console.log('Disk space:', diskSpace);
  } catch (e) {
    // ignore
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

  const repo = process.env.GITHUB_REPOSITORY_MATRIX || '';
  const mavenVersion = process.env.GITHUB_EVENT_INPUTS_MAVEN_VERSION || '';
  const mavenBranchOrCommit = process.env.GITHUB_EVENT_INPUTS_MAVEN_BRANCH_OR_COMMIT || '';
  const chunkNumber = process.env.GITHUB_EVENT_INPUTS_CHUNK_NUMBER || '';
  const buildId = process.env.GITHUB_EVENT_INPUTS_BUILD_ID || '';

  // Only run Maven 4.x if Maven 3.x succeeded
  if (maven3Success) {
    console.log('Maven 3.x build succeeded, proceeding with Maven 4.x...');
    const extraArgs = loadExtraArgs(repo);
    const maven4StartTime = Date.now();
    const maven4Results = await runMaven4Build(extraArgs);
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

  // Create/update individual project issue with timing information
  const timingInfo = {
    maven3Duration: maven3Duration,
    maven4Duration: maven4Duration,
    overallDuration: overallDuration
  };

  const { issueNumber, status, knownIssue } = await createOrUpdateIndividualProjectIssue(
    github, context, repo, maven3Success, maven3Output, maven3Error, buildSuccess, mavenOutput, buildError, mvnupOutput, mavenVersion, mavenBranchOrCommit, chunkNumber, timingInfo, buildId
  );

  // Skip summary update and issue tracking for non-Maven projects (no pom.xml)
  if (issueNumber === null) {
    console.log(`Skipping summary update for ${repo} — not a Maven project`);
    return;
  }

  // Add delay to prevent GitHub rate limiting (2.5 seconds)
  console.log('Adding delay to prevent rate limiting...');
  await new Promise(resolve => setTimeout(resolve, 2500));

  // Update summary table
  await updateSummaryTable(github, context, repo, status, issueNumber, buildError, buildSuccess, maven3Error, maven3Success, mavenVersion, mavenBranchOrCommit, buildId, knownIssue);
};
