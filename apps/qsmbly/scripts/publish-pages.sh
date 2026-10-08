#!/bin/bash
# Publish a built site into one subtree of the GitHub Pages branch.
#
# The Pages branch holds the deployed site as independent subtrees: the released site at the root
# and a staging build under staging/. Each deploy replaces its own subtree and leaves the others
# exactly as they were, so a push to the staging branch cannot disturb what is in production and a
# release cannot roll back staging.
#
# The branch carries a single commit, rebuilt and force-pushed on every deploy. The site is ~25 MB
# of wasm per subtree, and an append-only history would grow by that much every time. Git is
# content-addressed, so a rebuild only stores files that actually changed: a deploy that touches
# only JavaScript adds kilobytes, not megabytes.
#
# Because each deploy rewrites the whole branch from a clone, two deploys running at once would
# both be correct in isolation and wrong together: the second to push would carry the first's
# subtree as it was *before* that deploy, quietly reverting it. The push therefore takes a lease on
# the commit it cloned, and a deploy that loses the race rebuilds from the new tip instead of
# overwriting it. Keeping the workflows from overlapping is then a matter of saving CI time, rather
# than the only thing standing between a release and a silently rolled-back site.
#
# Usage:
#   publish-pages.sh --source <dir> --remote <url> [options]
#
#   --source DIR        built site to publish (required)
#   --remote URL        push target, e.g. https://x-access-token:$TOKEN@github.com/owner/repo.git
#   --subtree PATH      subtree to replace; empty or omitted means the root of the site
#   --keep NAME         when publishing the root, a top-level entry to preserve (repeatable)
#   --prune-unknown     allow a root deploy to delete top-level entries it neither builds nor keeps
#   --branch NAME       Pages branch (default: gh-pages)
#   --domain HOST       written to CNAME at the branch root; Pages reads the custom domain there
#   --noindex PATH      written to robots.txt at the branch root as a Disallow rule (repeatable)
#   --message TEXT      commit message
#   --attempts N        tries before giving up when another deploy keeps winning (default: 3)
#   --dry-run           do everything except the push, and print the resulting tree

set -euo pipefail

SOURCE=""
REMOTE=""
SUBTREE=""
BRANCH="gh-pages"
DOMAIN=""
MESSAGE="Deploy"
ATTEMPTS=3
DRY_RUN=0
# Written into every subtree so a root deploy can recognise one. See the root branch below.
OWNER_MARKER=".pages-subtree"
PRUNE_UNKNOWN=0
KEEP=()
NOINDEX=()

while [ $# -gt 0 ]; do
    case "$1" in
        --source)   SOURCE="$2"; shift 2 ;;
        --remote)   REMOTE="$2"; shift 2 ;;
        --subtree)  SUBTREE="${2#/}"; SUBTREE="${SUBTREE%/}"; shift 2 ;;
        --keep)     KEEP+=("$2"); shift 2 ;;
        --branch)   BRANCH="$2"; shift 2 ;;
        --domain)   DOMAIN="$2"; shift 2 ;;
        --noindex)  NOINDEX+=("${2#/}"); shift 2 ;;
        --message)  MESSAGE="$2"; shift 2 ;;
        --attempts) ATTEMPTS="$2"; shift 2 ;;
        --prune-unknown) PRUNE_UNKNOWN=1; shift ;;
        --dry-run)  DRY_RUN=1; shift ;;
        *) echo "publish-pages.sh: unknown argument '$1'" >&2; exit 2 ;;
    esac
done

[ -n "$SOURCE" ] || { echo "publish-pages.sh: --source is required" >&2; exit 2; }
[ -d "$SOURCE" ] || { echo "publish-pages.sh: --source '$SOURCE' is not a directory" >&2; exit 2; }
[ -n "$REMOTE" ] || { echo "publish-pages.sh: --remote is required" >&2; exit 2; }

SOURCE="$(cd "$SOURCE" && pwd)"

WORK="$(mktemp -d)"
trap 'cd /; rm -rf "${WORK}"' EXIT

# One clone-build-push cycle. Returns 0 on success, 1 if another deploy moved the branch while this
# one was building, and exits outright on anything that retrying cannot fix.
publish_once() {
    # A directory per attempt, and never stand inside one: a retry that deleted and recreated the
    # tree it was standing in left the shell with no working directory, and every git call after
    # that failed for reasons that had nothing to do with the push.
    local pages="${WORK}/attempt-$1"
    cd "$WORK"

    # A shallow clone is all that is needed: the previous commit is never a parent of the next one.
    # The branch may not exist yet on a first deploy, which is not an error.
    local expected=""
    if git clone --quiet --depth 1 --branch "$BRANCH" "$REMOTE" "$pages" 2>/dev/null; then
        expected="$(git -C "$pages" rev-parse HEAD)"
        echo "Updating ${BRANCH}: $(git -C "$pages" log -1 --format='%h %s')"
    else
        echo "Creating ${BRANCH} (no existing branch on the remote)"
        git init --quiet "$pages"
    fi

    cd "$pages"

    if [ -n "$SUBTREE" ]; then
        rm -rf "./${SUBTREE:?}"
        mkdir -p "./${SUBTREE}"
        cp -a "${SOURCE}/." "./${SUBTREE}/"
        # Marks the directory as belonging to a subtree deploy. A root deploy clears everything it
        # does not build, and without this it cannot tell another environment's site from a
        # leftover of its own.
        touch "./${SUBTREE}/${OWNER_MARKER}"
        echo "Replaced /${SUBTREE}/"
    else
        # A root deploy legitimately deletes whatever it no longer ships - that is how a file
        # dropped from the site stops being served. What it must not do is delete another
        # environment's subtree because a --keep was forgotten, so look only for directories
        # carrying the ownership marker. Checking "not in --source" instead would refuse every
        # release that removes a file.
        local -a orphans=()
        local entry name kept
        while IFS= read -r entry; do
            name="$(basename "$entry")"
            [ -e "${entry}/${OWNER_MARKER}" ] || continue
            for kept in "${KEEP[@]+"${KEEP[@]}"}"; do
                [ "$name" = "$kept" ] && continue 2
            done
            orphans+=("$name")
        done < <(find . -mindepth 1 -maxdepth 1 -type d ! -name .git)

        if [ ${#orphans[@]} -gt 0 ] && [ "$PRUNE_UNKNOWN" != "1" ]; then
            echo "publish-pages.sh: refusing to publish the site root." >&2
            echo "  Another environment is deployed on ${BRANCH} under:" >&2
            printf '    %s/\n' "${orphans[@]}" >&2
            echo "  Add --keep <name> to preserve it, or --prune-unknown to take it down." >&2
            exit 1
        fi

        # Clear the root but keep .git and every subtree this deploy does not own, so the released
        # site and the staging build stay independent of each other.
        local -a prune=(find . -mindepth 1 -maxdepth 1 ! -name .git)
        for name in "${KEEP[@]+"${KEEP[@]}"}"; do
            prune+=(! -name "$name")
        done
        "${prune[@]}" -exec rm -rf {} +
        cp -a "${SOURCE}/." ./
        echo "Replaced the site root, keeping: ${KEEP[*]:-nothing}"
    fi

    # Branch-level files, rewritten on every deploy so they survive a root replacement and exist
    # even if the first deploy to a fresh branch is a staging one.

    # Branch-served Pages runs the site through Jekyll unless told not to, which costs a build step
    # this site has no use for and silently drops any path whose name begins with an underscore. The
    # deployed tree has none today, but nothing guarantees a future dependency won't.
    touch .nojekyll

    if [ -n "$DOMAIN" ]; then
        echo "$DOMAIN" > CNAME
    fi
    if [ ${#NOINDEX[@]} -gt 0 ]; then
        # robots.txt is only honoured at the site root, so it cannot live inside a subtree.
        {
            echo "User-agent: *"
            for name in "${NOINDEX[@]}"; do
                echo "Disallow: /${name}/"
            done
        } > robots.txt
    fi

    # --orphan rather than a normal commit: it keeps the index and working tree but drops the
    # parent, so the branch stays one commit deep. `git switch --orphan` would clear the tree.
    git checkout --quiet --orphan deploy
    git add -A
    git -c user.name="github-actions[bot]" \
        -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
        commit --quiet -m "$MESSAGE"

    if [ "$DRY_RUN" = "1" ]; then
        echo "--- dry run, not pushing. Resulting tree: ---"
        git ls-tree -r --name-only HEAD | sed 's/^/  /'
        return 0
    fi

    # The lease is what turns a concurrent deploy into a retry rather than a silent revert. An
    # empty expected value means the branch must still not exist.
    if git push --quiet "--force-with-lease=${BRANCH}:${expected}" "$REMOTE" "deploy:${BRANCH}"; then
        echo "Pushed $(git rev-parse --short HEAD) to ${BRANCH}"
        return 0
    fi

    echo "Another deploy moved ${BRANCH} while this one was building; rebuilding on its result." >&2
    return 1
}

for attempt in $(seq 1 "$ATTEMPTS"); do
    if publish_once "$attempt"; then
        exit 0
    fi
    [ "$attempt" = "$ATTEMPTS" ] && break
    sleep $((attempt * 5))
done

echo "publish-pages.sh: gave up after ${ATTEMPTS} attempts; ${BRANCH} kept moving underneath." >&2
exit 1
