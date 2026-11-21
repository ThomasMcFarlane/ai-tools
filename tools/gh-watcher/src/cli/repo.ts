const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Normalise a repository argument to OWNER/NAME. Accepts OWNER/NAME, github.com/OWNER/NAME,
 * https://github.com/OWNER/NAME, git@github.com:OWNER/NAME and a trailing `.git` or `/`.
 * Throws a plain Error (no exit code) when the value is not a repository.
 */
export function normaliseRepo(input: string): string {
  let value = input.trim();
  value = value.replace(/^(?:https?:\/\/|ssh:\/\/git@)/i, '');
  value = value.replace(/^git@github\.com:/i, '');
  value = value.replace(/^(?:www\.)?github\.com\//i, '');
  value = value.replace(/[/]+$/, '');
  value = value.replace(/\.git$/i, '');
  if (!REPO_PATTERN.test(value) || value.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error(`invalid repository "${input}": use OWNER/NAME`);
  }
  return value;
}

/** The repository from `--repo` or GH_REPO, normalised. Sets exit code 2 on failure. */
export function resolveRepoOrExit(repo: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const value = repo ?? env['GH_REPO'];
  try {
    if (value === undefined || value.trim().length === 0) {
      throw new Error('no repository specified (use --repo OWNER/NAME or set GH_REPO)');
    }
    return normaliseRepo(value);
  } catch (error) {
    process.exitCode = 2;
    throw error;
  }
}
