# awesome-selfhosted submission

Status (2026-09-14):

- **Issue [#2285](https://github.com/awesome-selfhosted/awesome-selfhosted-data/issues/2285)** - filed 2026-04-02, still open, now labelled `addition` only (the `needs to mature` label is gone). It is the queue position; that repo's CONTRIBUTING states plainly that they do not close issues, only tag them, so it must not be closed or re-filed. Title and body were corrected from the old "Oikos" wording.
- **Pull request [#2847](https://github.com/awesome-selfhosted/awesome-selfhosted-data/pull/2847)** - adds `software/yuvomi.yml`, still open. A maintainer review on 2026-09-02 requested changes with a single suggestion, `Groupware` as the only tag; it was adopted on 2026-09-10 (commit `c9b7ba83` in the fork branch), `syntax-checks` is green on that commit, and the PR waits for a re-review. This is the path their CONTRIBUTING prefers; the issue is only the fallback for people who would rather not send a PR.
- Maturity: first tagged release v0.1.0 on 2026-03-30, so the four-month threshold was met on 2026-07-30 - the review date a maintainer had set on the issue.

`yuvomi.yml` next to this file is the byte-exact content of the submitted entry. Their linter enforces the rules that matter, so keep both in step:

- `description` at most 250 characters, sentence case, ending in a period; no "self-hosted", "open-source" or "free" (the list implies it), and an alternative named as `(alternative to X)`. The previous draft here was 283 characters and would have failed.
- Every entry in `tags`, `platforms` and `licenses` must exist verbatim in their `tags/`, `platforms/` and `licenses.yml`. The platform is spelled `Nodejs`, not `Node.js`.
- Only the **first** tag decides where the entry appears in single-page mode. The entry carries `Groupware` alone, as the 2026-09-02 review asked; the three tags it was first submitted with were unusual there (of 1341 entries, 1271 carry exactly one).
- No metadata fields (`stargazers_count`, `updated_at`, `commit_history`) - their bot writes those.

Validate a change before pushing it:

```bash
git clone --depth 1 https://github.com/awesome-selfhosted/awesome-selfhosted-data
cp docs/awesome-selfhosted/yuvomi.yml awesome-selfhosted-data/software/
cd awesome-selfhosted-data && make install && make awesome_lint
```
