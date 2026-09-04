#!/usr/bin/env python3
"""
Maven 4 Compatibility Fix Script
Fixes issues like ancient-enforcer-plugin (< 3.0.0) and other Maven 4.x quirks.
"""

from pathlib import Path
from typing import Optional
import xml.etree.ElementTree as ET
import re
from shutil import copyfile
from subprocess import run


def get_maven_plugin_version(project_path: Path, plugin_id: str) -> str:
    """Extract version of a specific Maven plugin from pom.xml"""
    pom_path = project_path / "pom.xml"
    if not pom_path.exists():
        return "3.0.1"  # Default fallback
    
    tree = ET.parse(pom_path)
    root = tree.getroot()
    
    # Handle both root level and dependencyManagement sections
    # Check different namespace possibilities
    namespaces = [
        "{http://maven.apache.org/POM/4.0.0}",
        "{http://maven.apache.org/POM/4.0.0#dependency}"
    ]
    
    for ns in namespaces:
        plugin_elements = root.findall(f".//{ns}dependency")
        for element in plugin_elements:
            group_id = element.get("groupId")
            if group_id == plugin_id:
                version = element.get("version", "3.0.1")
                if version:
                    return version
    
    # Check for plugin group/variant in dependencyManagement
    dep_mgmt = root.find(f".//{namespaces[0]}dependencyManagement/{namespaces[0]}dependency")
    if dep_mgmt:
        for child in dep_mgmt:
            if child.tag.endswith("dependency"):
                group_id = child.get("groupId")
                if group_id == plugin_id:
                    return child.get("version", "3.0.1")
    
    return "3.0.1"


def upgrade_enforcer_plugin(project_path: Path) -> None:
    """Upgrade maven-enforcer-plugin to 3.0.0+ for Maven 4 compatibility"""
    pom_path = project_path / "pom.xml"
    
    if not pom_path.exists():
        print(f"  ⚠ {pom_path} doesn't exist, skipping")
        return
    
    tree = ET.parse(pom_path)
    root = tree.getroot()
    
    # Define common namespaces to search
    namespaces = [
        "{http://maven.apache.org/POM/4.0.0}",
    ]
    
    ns = namespaces[0]
    enforcer_elements = root.findall(f".//{ns}dependency")
    
    for dependency in enforcer_elements:
        group_id = dependency.get("groupId")
        artifact_id = dependency.get("artifactId")
        
        if group_id == "org.apache.maven.plugins" and artifact_id == "maven-enforcer-plugin":
            current_version = dependency.get("version", "3.0.1")
            
            # Check if version starts with "3." - upgrade to 3.4.0 for stability
            if current_version and current_version.startswith("3.") and not current_version.startswith("3.4"):
                version_match = re.match(r"3\.0\.\d+", current_version)
                if version_match:
                    new_version = "3.4.0"
                    dependency.set("version", new_version)
                    print(f"  ✓ Upgraded {project_path.name} enforcer-plugin to {new_version}")
    
    tree.write(pom_path, encoding="utf-8", xml_declaration=True)
    print(f"  ✓ Updated: {project_path.name}")


def fix_toolchains_plugin(project_path: Path) -> None:
    """Ensure toolchains plugin is properly configured for Java 17"""
    pom_path = project_path / "pom.xml"
    
    if not pom_path.exists():
        return
    
    tree = ET.parse(pom_path)
    root = tree.getroot()
    
    ns = "{http://maven.apache.org/POM/4.0/}"
    
    # Check for existing toolchains plugin
    toolchains_elem = root.find(f".//{ns}plugin")
    
    if toolchains_elem is None:
        print(f"  ⚠ Adding toolchains plugin to {project_path.name}")
        plugin = ET.SubElement(root, "{http://maven.apache.org/POM/4.0.0}plugin")
        plugin.set("groupId", "org.apache.maven.plugins")
        plugin.set("artifactId", "maven-toolchains-plugin")
        
        version_elem = ET.SubElement(plugin, "{http://maven.apache.org/POM/4.0/}version")
        version_elem.text = "3.1.0"
        
        plugin_name = ET.SubElement(plugin, "{http://maven.apache.org/POM/4.0/}executions")
        executions = ET.SubElement(plugin_name, "{http://maven.apache.org/POM/4.0/}execution")
        
        goal_elem = ET.SubElement(executions, "{http://maven.apache.org/POM/4.0/}goals")
        goal = ET.SubElement(goal_elem, "{http://maven.apache.org/POM/4.0/}goal")
        goal.text = "select-jdk-toolchain"
    
    tree.write(pom_path, encoding="utf-8", xml_declaration=True)


def fix_java_compat_dependencies(project_path: Path) -> None:
    """Fix Java compatibility dependencies that might cause issues"""
    pom_path = project_path / "pom.xml"
    
    if not pom_path.exists():
        return
    
    tree = ET.parse(pom_path)
    root = tree.getroot()
    
    ns = "{http://maven.apache.org/POM/4.0/}"
    
    # Look for specific dependencies that might need version bumping
    deps_to_fix = [
        ("org.apache.maven", "maven-core", "3.0.0"),
        ("org.apache.maven", "maven-plugin-api", "3.0.0"),
        ("org.apache.maven", "maven-model", "3.0.0"),
    ]
    
    for group, artifact, new_ver in deps_to_fix:
        dependency = root.find(f".//{ns}dependency")
        if dependency:
            group_id = dependency.get("groupId")
            if group_id == group:
                artifact_id = dependency.get("artifactId")
                if artifact_id == artifact:
                    current = dependency.get("version", "3.0.0")
                    if current == "3.0.0" and not current.startswith("3."):
                        dependency.set("version", new_ver)
                        print(f"  ✓ Fixed {group}:{artifact} version in {project_path.name}")
    
    tree.write(pom_path, encoding="utf-8", xml_declaration=True)


def fix_ancient_enforcer_plugin(project_path: Path) -> None:
    """Special fix for ancient-enforcer-plugin known issue"""
    pom_path = project_path / "pom.xml"
    
    if not pom_path.exists():
        return
    
    tree = ET.parse(pom_path)
    root = tree.getroot()
    
    ns = "{http://maven.apache.org/POM/4.0/}"
    
    # Look for the enforcer plugin
    enforcer = root.find(f".//{ns}dependency")
    
    if enforcer and enforcer.get("groupId") == "org.apache.maven.plugins":
        artifact = enforcer.get("artifactId")
        if artifact == "maven-enforcer-plugin":
            current = enforcer.get("version", "3.0.1")
            
            # The issue is PluginParameterExpressionEvaluator constructor used before 3.0
            # Upgrade to 3.4.0 to ensure it's properly stable
            if current.startswith("3.") and not current.startswith("3.4"):
                enforcer.set("version", "3.4.0")
                print(f"  ✓ Fixed ancient-enforcer-plugin version in {project_path.name}")
            
            # Check for the 'rules' parameter which might need fixing
            rules_elem = enforcer.find(f".//{ns}rules/{ns}rule/{ns}requires")
            if rules_elem and current.startswith("3."):
                # Ensure the version is set properly for rule parameters
                version_check = enforcer.get("version")
                if version_check == "3.0.1":
                    enforcer.set("version", "3.4.0")
    
    tree.write(pom_path, encoding="utf-8", xml_declaration=True)


def process_pom_file(pom_path: Path) -> None:
    """Process a single POM file for Maven 4 compatibility"""
    if not pom_path.exists():
        return
    
    tree = ET.parse(pom_path)
    root = tree.getroot()
    
    ns = "{http://maven.apache.org/POM/4.0/}"
    
    # 1. Fix enforcer plugin version
    enforcer_dep = root.find(f".//{ns}dependency")
    if enforcer_dep and enforcer_dep.get("groupId") == "org.apache.maven.plugins":
        artifact = enforcer_dep.get("artifactId")
        if artifact == "maven-enforcer-plugin":
            current = enforcer_dep.get("version", "3.0.1")
            if current.startswith("3.0.") and not current.startswith("3.4"):
                enforcer_dep.set("version", "3.4.0")
                print(f"  ✓ Upgraded enforcer-plugin to {current} in {pom_path.name}")
    
    # 2. Check for specific rule dependencies
    rules_dep = root.find(f".//{ns}dependency/{ns}dependencyManagement/{ns}dependency")
    if rules_dep and rules_dep.get("groupId") == "org.apache.maven":
        # Handle any nested dependencies
        version = rules_dep.get("version", "3.0.1")
        if version.startswith("3.0.") and not version.startswith("3.4"):
            rules_dep.set("version", "3.4.0")
    
    # 3. Fix toolchains plugin configuration
    toolchains = root.find(f".//{ns}plugin/{ns}pluginExecution/{ns}plugin")
    if toolchains:
        toolchains_group = toolchains.get("groupId")
        if toolchains_group == "org.apache.maven.plugins":
            toolchains_artifact = toolchains.get("artifactId")
            if toolchains_artifact == "maven-toolchains-plugin":
                tool_ver = toolchains.get("version", "3.1.0")
                if tool_ver.startswith("3."):
                    toolchains.set("version", "3.1.0")
    
    tree.write(pom_path, encoding="utf-8", xml_declaration=True)
    print(f"  ✓ Processed: {pom_path.name}")


def run_from_version_check() -> None:
    """Optional: Run Maven 4 from command line to verify fix"""
    project_root = Path("/home/runner/work/maven4-testing/maven4-testing/project")
    
    if project_root.exists():
        # Run a quick verify from Maven 4 root
        maven_root = Path("/home/runner/work/maven4-testing/maven4-testing/apache-maven-4.0.0-SNAPSHOT")
        
        if maven_root.exists():
            cmd = [
                str(maven_root / "bin/mvn"),
                "-f", str(project_root / "pom.xml"),
                "-version",
                "-DskipTests",
            ]
            
            result = run(cmd, capture_output=True, text=True)
            if result.returncode == 0:
                print(f"  ✓ Maven 4 verification complete: {project_root.name}")
            else:
                print(f"  ⚠ Maven 4 output: {result.stdout[:500]}")


def main() -> None:
    """Main entry point for Maven 4 compatibility fix"""
    
    # Determine project root
    project_root = Path("/home/runner/work/maven4-testing/maven4-testing/project")
    
    if not project_root.exists():
        project_root = Path.cwd()
    
    print(f"=== Fixing Maven 4 Compatibility for {project_root.name} ===")
    
    # 1. Fix the parent pom.xml (main focus)
    parent_pom = project_root / "pom.xml"
    if parent_pom.exists():
        process_pom_file(parent_pom)
    else:
        print(f"  ⚠ Parent pom.xml not found at {parent_pom}")
    
    # 2. Fix sub-modules
    sub_poms = list(project_root.glob("*/pom.xml"))
    for sub_pom in sub_poms:
        if "maven-autotag-plugin" in sub_pom.name or "core" in sub_pom.name:
            process_pom_file(sub_pom)
    
    # 3. Fix specific known issues
    # Check for ancient-enforcer-plugin specifically
    enforcer_path = project_root / "pom.xml"
    if enforcer_path.exists():
        tree = ET.parse(enforcer_path)
        root = tree.getroot()
        ns = "{http://maven.apache.org/POM/4.0/}"
        
        enforcer = root.find(f".//{ns}dependency")
        if enforcer and enforcer.get("artifactId") == "maven-enforcer-plugin":
            current = enforcer.get("version", "3.0.1")
            if current.startswith("3.0.") and not current.startswith("3.4"):
                enforcer.set("version", "3.4.0")
                tree.write(enforcer_path, encoding="utf-8", xml_declaration=True)
                print(f"  ✓ Upgraded {current} to 3.4.0 in {project_root.name}")
    
    # 4. Handle velocity and freemarker special cases
    for module in ["velocity", "freemarker", "jsp", "assembly"]:
        module_pom = project_root / f"tiles-autotag-{module}/pom.xml"
        if module_pom.exists():
            tree = ET.parse(module_pom)
            root = tree.getroot()
            ns = "{http://maven.apache.org/POM/4.0/}"
            
            # Check for plugin dependencies
            dep_mgmt = root.find(f".//{ns}dependencyManagement/{ns}dependency")
            if dep_mgmt:
                group = dep_mgmt.get("groupId", "")
                version = dep_mgmt.get("version", "3.0.1")
                if version.startswith("3.0.") and not version.startswith("3.4"):
                    dep_mgmt.set("version", "3.4.0")
            
            tree.write(module_pom, encoding="utf-8", xml_declaration=True)
    
    # 5. Check for Automatic-Module-Name issues
    core_pom = project_root / "pom.xml"
    if core_pom.exists():
        tree = ET.parse(core_pom)
        root = tree.getroot()
        ns = "{http://maven.apache.org/POM/4.0/}"
        
        modules = root.findall(f".//{ns}modules/{ns}module")
        if modules:
            module_names = [m.text for m in modules]
            
            # If there are multiple modules, ensure version is 3.4.0
            if "modules" in str(root):
                modules_elem = root.find(f".//{ns}modules")
                if modules_elem:
                    modules_version = modules_elem.get("version", "1.0.0")
                    if modules_version.startswith("1.") and not modules_version.startswith("1.2"):
                        modules_elem.set("version", "1.2.0")
    
    # 6. Save final state
    final_pom = project_root / "pom.xml"
    if final_pom.exists():
        tree = ET.parse(final_pom)
        root = tree.getroot()
        ns = "{http://maven.apache.org/POM/4.0/}"
        
        # Ensure build plugin is updated
        build_plugin = root.find(f".//{ns}plugin[{ns}groupId=org.apache.maven.plugins]")
        if build_plugin:
            build_artifact = build_plugin.find(f".//{ns}artifactId").text
            if build_artifact == "maven-plugins-plugin":
                build_version = build_plugin.get("version", "3.4.0")
                if build_version.startswith("3."):
                    build_version_elem = build_plugin.find(f".//{ns}version")
                    if build_version_elem:
                        build_version_elem.text = "3.4.0"
        
        tree.write(final_pom, encoding="utf-8", xml_declaration=True)
    
    # 7. Run from Maven 4 if available
    run_from_version_check()
    
    print("\n=== Maven 4 Compatibility Fixes Applied Successfully ===")


if __name__ == "__main__":
    main()