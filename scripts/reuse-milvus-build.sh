#!/usr/bin/env bash
# Find a package from the same Milvus build recipe on this repository's main.
set -euo pipefail

version=$1
arch=$2
dest=$3
name="engine-milvus-$version-linux-$arch"
archive="$dest/milvus-$version-linux-$arch.tar.gz"
actions="repos/$GITHUB_REPOSITORY/actions"
run_ids=$(gh api --method GET "$actions/artifacts" -f name="$name" -F per_page=20 \
  --jq '.artifacts[] | select(.expired == false) | .workflow_run.id')

for run in $run_ids; do
  sha=$(gh api "$actions/runs/$run" --jq '
    select(.status == "completed" and .head_branch == "main" and .head_repository.id == .repository.id and
      (.path | split("@")[0]) == ".github/workflows/build-engines.yml") | .head_sha')
  [[ "$sha" =~ ^[a-f0-9]{40}$ ]] || continue
  git merge-base --is-ancestor "$sha" "$GITHUB_SHA" || continue
  git diff --quiet "$sha" "$GITHUB_SHA" -- scripts/build-engine.sh scripts/milvus-local.patch scripts/engine-sources.mjs || continue
  mkdir -p "$dest"
  if gh run download "$run" --repo "$GITHUB_REPOSITORY" --name "$name" --dir "$dest" && [[ -f "$archive" ]]; then
    echo "MARINA_MILVUS_REUSE_ARCHIVE=$archive" >> "$GITHUB_ENV"
    echo "Repacking $name from run $run ($sha)"
    exit 0
  fi
done
echo "No compatible $name artifact is available. Building from source."
