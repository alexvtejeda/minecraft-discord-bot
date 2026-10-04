#!/usr/bin/env bash
# Run Gradle for paper/lobby-bridge in the official image, so nobody needs Gradle or a JDK installed.
# :z relabels the folder for SELinux (Fedora). Gradle's cache stays inside the project (git-ignored).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec docker run --rm -u "$(id -u):$(id -g)" \
  -v "$REPO/paper/lobby-bridge:/project:z" -w /project \
  -e GRADLE_USER_HOME=/project/.gradle-home \
  gradle:9.8.0-jdk25 gradle --no-daemon -q "$@"
