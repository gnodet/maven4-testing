# Maven 4 Compatibility Test Failure Analysis — 2026-06-01

Summary issue: https://github.com/gnodet/maven4-testing/issues/14270
Branch: `maven-4.0.x-test-fixes` (built with 4.0.0-rc-5)
Total projects: 966 | Passed: 943 (97.6%) | Failed: 23 (2.4%)

## Failures by Category

| Category | Count | Projects |
|----------|-------|----------|
| ${revision} CI-friendly | 4 | bigtop-manager, guacamole-client, hbase-connectors, logging-log4j-samples |
| Plugin API incompatibility | 4 | oozie (jax-plugin NPE), incubator-kie-optaplanner (jaxb2), camel-kameleon (Quarkus ServiceLocator), xalan-java (getContainer() null) |
| Uninterpolated expressions | 3 | uima-uimaj, opennlp-sandbox, seatunnel-shade |
| Resource targetPath | 2 | tomcat-taglibs-rdc, systemds |
| Compilation errors | 2 | hadoop-api-shim, synapse |
| Missing SNAPSHOT artifact | 2 | incubator-uniffle, servicecomb-java-chassis |
| GitHub body truncated | 2 | camel-k-runtime, maven-surefire |
| Ancient enforcer (1.x) | 1 | ratis-hadoop-projects |
| BannedDependencies | 1 | netbeans-html4j |
| POM validation | 1 | activemq-protobuf |
| SCM / external service | 1 | commons-ognl |

## Detail per Issue

| # | Project | Issue | Error |
|---|---------|-------|-------|
| 1 | bigtop-manager | #16714 | ${revision} not resolved |
| 2 | guacamole-client | #16431 | ${revision} not resolved |
| 3 | hbase-connectors | #16477 | ${revision} not resolved |
| 4 | logging-log4j-samples | #17115 | ${revision} not resolved |
| 5 | oozie | #16542 | jax-maven-plugin:0.1.8:xjc NPE |
| 6 | incubator-kie-optaplanner | #16636 | jaxb2-maven-plugin:3.1.0 missing class |
| 7 | camel-kameleon | #16745 | Quarkus NoClassDefFoundError: ServiceLocator |
| 8 | xalan-java | #17110 | exec-maven-plugin MavenSession.getContainer() null |
| 9 | ratis-hadoop-projects | #16802 | enforcer-plugin 1.4.1 NoSuchMethodError |
| 10 | netbeans-html4j | #16482 | enforcer BannedDependencies |
| 11 | tomcat-taglibs-rdc | #16940 | resources copying to /META-INF/... NoSuchFileException |
| 12 | systemds | #16906 | resources copying to /log4j.properties AccessDeniedException |
| 13 | hadoop-api-shim | #16453 | InterfaceAudience does not exist (27 errors) |
| 14 | synapse | #16905 | ErrorProne plug-in not found |
| 15 | activemq-protobuf | #16505 | dependency.version missing |
| 16 | uima-uimaj | #17057 | ${eclipseP2RepoId} uninterpolated |
| 17 | opennlp-sandbox | #16561 | ${eclipseP2RepoId} uninterpolated |
| 18 | seatunnel-shade | #16946 | pluginRepository.url uninterpolated |
| 19 | commons-ognl | #16949 | commons-release-plugin SCM exception |
| 20 | incubator-uniffle | #16741 | Cannot resolve SNAPSHOT artifact |
| 21 | servicecomb-java-chassis | #16956 | Cannot resolve SNAPSHOT BOM |
| 22 | camel-k-runtime | #16747 | Issue body truncated |
| 23 | maven-surefire | #17358 | Issue body truncated |

## PRs on test branch (milestone 4.0.0-rc-6)

- #12158 — Fix mvnup: use effective model to resolve properties from remote parents
- #12160 — Remove invalid combine.self and combine.children attributes in mvnup
- #12165 — Fix mvnup plugin upgrade for versions locked by parent build/plugins
- #12166 — Fix deadlock in AbstractRequestCache (3 commits)
- #12172 — Fix mvnup PLUGIN_UPGRADES for compiler and exec plugins
- #12173 — Bump scala-maven-plugin upgrade target from 4.9.2 to 4.9.5
- #12174 — Upgrade domtrip from 1.5.1 to 1.5.2
- #12178 — Fix Source targetPath incorrectly aligned to project basedir
- #12179 — Filter dependencies with uninterpolated expressions from CollectRequest
- #12184 — Use request properties for CI-friendly version interpolation

## Investigation Notes

### ${revision} CI-friendly (4 projects)
**Root cause**: `Not fully interpolated artifact ...:pom:${revision}` — the parent POM version
uses `${revision}` (CI-friendly). PR #12184 fixed `${revision}` in dependency versions and
distributionManagement, but NOT in the parent version resolution path. The error occurs at
runtime, not during mvnup. These projects define `<version>${revision}</version>` in their
root POM and pass `-Drevision=X` on the CLI.
**Status**: NOT FIXED — needs additional work in #12184 or a new PR.
**Projects**: bigtop-manager, guacamole-client, hbase-connectors, logging-log4j-samples

### Uninterpolated expressions in repositories (3 projects)
**Root cause**: `${eclipseP2RepoId}` is defined in the **project's own parent POM** (not transitive).
The property comes from a parent POM on Maven Central but is used in the project's own
`<repositories>` section. #12086 (filter transitive repos) doesn't help because these are
the project's OWN repos. Raw model validation catches them at Severity.ERROR.
The error is a runtime `InternalErrorException: Invalid RemoteRepositories` — the repo with
the uninterpolated expression gets into the actual repository list.
For seatunnel-shade, the issue is in `pluginRepositories.pluginRepository.url`.
**Key finding**: `${eclipseP2RepoId}` is **never defined** — not in the project, not in any
parent. In Maven 3 the literal `${eclipseP2RepoId}` was used as the repo ID (harmless).
Maven 4 rejects it. #12175 (defer to effective) wouldn't help since it's still unresolvable.
#12086 (filter transitive) doesn't help since these are the project's own repos.
**Status**: NOT FIXED — needs a new fix to filter/skip project repos with unresolvable
expressions at runtime instead of throwing `InternalErrorException`.
**Projects**: uima-uimaj, opennlp-sandbox, seatunnel-shade

### Resource targetPath (2 projects)
**Root cause**: `maven-resources-plugin:3.3.1` copies resources to absolute paths like
`/META-INF/tags/...` and `/log4j.properties` instead of under `target/classes/`.
PR #12178 fixed `Source` targetPath in `DefaultModelPathTranslator` but these failures use
the old Maven 3 API `Resource` targetPath. The compat layer that maps between new Source API
and old Resource API doesn't preserve the relative-ness of targetPath.
**Status**: PARTIALLY FIXED — #12178 fixed Source but not Resource compat path.
**Projects**: tomcat-taglibs-rdc, systemds

### Plugin API incompatibility (4 projects)
- **oozie**: jax-maven-plugin:0.1.8:xjc NPE — old plugin, project-side issue
- **incubator-kie-optaplanner**: jaxb2-maven-plugin:3.1.0 missing class — plugin compat issue
- **camel-kameleon**: Quarkus 2.16 `NoClassDefFoundError: ServiceLocator` — old Quarkus, known
- **xalan-java**: exec-maven-plugin:3.1.0 `MavenSession.getContainer()` returns null — Plexus removed
**Status**: Project-side issues. Can be added as known-issues.

### Compilation errors (2 projects)
- **hadoop-api-shim**: `InterfaceAudience does not exist` — missing hadoop annotation dependency
- **synapse**: `ErrorProne plug-in not found` — ErrorProne javac plugin not available
**Status**: Project-side issues. Not Maven 4 bugs.

### Missing SNAPSHOT artifacts (2 projects)
- **incubator-uniffle**: `apache-incubator-disclaimer-resource-bundle:1.2-SNAPSHOT` not available
- **servicecomb-java-chassis**: `java-chassis-bom:3.4.0-SNAPSHOT` not available
**Status**: SNAPSHOTs disabled in test settings.xml. Project-side issue.

### GitHub body truncated (2 projects)
- **camel-k-runtime**: Issue body was truncated before error was visible
- **maven-surefire**: Issue body cut off during clean phase
**Status**: Need to increase truncation tolerance or re-run with shorter logs.

### Ancient enforcer (1 project)
- **ratis-hadoop-projects**: enforcer-plugin:1.4.1 `NoSuchMethodError: PluginParameterExpressionEvaluator`
**Status**: Known issue (ancient enforcer), in known-issues.json.

### BannedDependencies (1 project)
- **netbeans-html4j**: enforcer BannedDependencies rule failure — bans asm:5.0
**Status**: Project-side enforcer rule issue.

### POM validation (1 project)
- **activemq-protobuf**: `dependencies.dependency.version` is missing
**Status**: Project uses a parent that provides dependencyManagement. Maven 4 compat issue.

### SCM / external service (1 project)
- **commons-ognl**: commons-release-plugin SVN checkout fails
**Status**: External service issue, not Maven 4 related.

## Action Items

### Maven 4 core fixes needed (7 projects affected)
1. **${revision} parent version** (4 projects) — extend #12184 to handle parent version interpolation
2. **Uninterpolated project repos** (3 projects) — new fix needed: filter project repos with uninterpolated expressions at runtime instead of failing

### Partial fix to complete (2 projects)
3. **Resource targetPath compat** (2 projects) — extend #12178 to fix Resource (old API) targetPath, not just Source

### Known issues to add (6 projects)
4. Add known-issue entries for: oozie (jax-plugin), incubator-kie-optaplanner (jaxb2), camel-kameleon (Quarkus ServiceLocator), xalan-java (getContainer null), ratis-hadoop-projects (enforcer 1.4.1), netbeans-html4j (BannedDependencies)

### No action needed (8 projects)
5. Compilation errors (2), missing SNAPSHOTs (2), truncated body (2), POM validation (1), SCM (1) — project-side or environment issues

### New PRs created
- #12200 — Bump exec-maven-plugin target to 3.5.0 (fixes xalan-java getContainer NPE)

### Superset workspaces launched
- `fix/revision-parent-version` — Fix ${revision} in parent version (4 projects)
- `fix/filter-unresolvable-project-repos` — Filter project repos with unresolvable expressions (3 projects)
- `fix/resource-targetpath-compat` — Fix Resource targetPath in compat layer (2 projects)

### Known issues added
- ancient-enforcer-plugin (ratis-hadoop-projects)
- old-quarkus-servicelocator (camel-kameleon)
- exec-plugin-getcontainer (xalan-java, until mvnup upgrades to 3.5.0)

### PRs with new commits not yet cherry-picked
- #12178 has 2 new commits (spotless + Windows test fix) — no functional changes, skip
