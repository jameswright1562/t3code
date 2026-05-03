# Source Control Providers

T3 Code can connect your local projects to source control hosting providers so you can work with
pull requests and merge requests from inside the app.

This guide covers the providers currently supported by T3 Code:

- GitHub
- GitLab
- Bitbucket

## What Provider Support Enables

When a provider is available and authenticated, T3 Code can use it for source-control actions such
as:

- detecting the provider for the current project
- showing whether the required provider tools are installed
- showing whether you are signed in
- finding pull requests or merge requests for the current branch
- creating pull requests or merge requests
- opening the current pull request or merge request in your browser
- checking out an existing pull request or merge request locally

The exact wording may differ by provider. GitHub and Bitbucket call these pull requests. GitLab
calls them merge requests.

## Check Provider Status

Open Settings, then Source Control.

T3 Code shows each provider with:

- whether the required tool or credentials are available
- whether T3 Code can detect an authenticated account
- the account or host when the provider reports one
- setup hints when something is missing

After changing authentication in your terminal, refresh the Source Control settings page or restart
T3 Code.

## GitHub

GitHub support uses the GitHub CLI.

### Requirements

Install GitHub CLI:

```bash
brew install gh
```

Or use the installer from:

<https://cli.github.com/>

### Sign In

Run:

```bash
gh auth login
```

Follow the prompts and choose the GitHub account you want T3 Code to use.

To verify the login:

```bash
gh auth status
```

T3 Code reads the GitHub CLI login status and shows the signed-in account in Source Control
settings.

### Notes

Use the same GitHub account that has access to the repositories you work with in T3 Code. If you use
SSH remotes, make sure your GitHub SSH key is set up as well.

## GitLab

GitLab support uses the GitLab CLI.

### Requirements

Install GitLab CLI:

```bash
brew install glab
```

Or use the installer from:

<https://gitlab.com/gitlab-org/cli>

### Sign In

Run:

```bash
glab auth login
```

Follow the prompts for your GitLab host and account.

To verify the login:

```bash
glab auth status
```

T3 Code reads the GitLab CLI login status and shows the signed-in account in Source Control
settings.

### Notes

If your team uses a self-managed GitLab instance, authenticate `glab` against that host. T3 Code
uses your repository remote to determine which provider should handle a project.

## Bitbucket

Bitbucket support uses the Bitbucket Cloud REST API.

Bitbucket does not have an official general-purpose CLI like GitHub CLI or GitLab CLI, so T3 Code
uses environment variables for authentication.

### Requirements

Create a Bitbucket API token for your Atlassian account.

The token should include the Bitbucket scopes needed for the actions you want to use:

- read access to your Bitbucket account
- read access to pull requests
- write access to pull requests

If you want to push commits over HTTPS, your Git credentials also need write access to the
repository. Many users prefer SSH for Git push and pull.

### Sign In

Expose these environment variables in the shell that starts T3 Code:

```bash
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-api-token"
```

Use your Atlassian account email for `T3CODE_BITBUCKET_EMAIL`.

If you normally start T3 Code from a terminal, put those exports in your shell profile, such as
`~/.zshrc`.

If you start T3 Code from a desktop launcher, make sure the launcher receives those environment
variables too.

To verify the token manually:

```bash
curl -u "$T3CODE_BITBUCKET_EMAIL:$T3CODE_BITBUCKET_API_TOKEN" \
  -H "Accept: application/json" \
  "https://api.bitbucket.org/2.0/user"
```

T3 Code uses the same credentials to check your Bitbucket sign-in status.

### Notes

Bitbucket workspace billing and repository permissions can affect whether Git pushes are allowed.
If pull request creation works but pushing fails, check the repository permissions, workspace plan,
and whether your Git remote uses HTTPS credentials or SSH.

## Version Control Requirements

Source control providers work with your local version control setup.

Today, Git is the supported local version control system for provider actions. Make sure Git is
installed:

```bash
git --version
```

T3 Code can also detect Jujutsu installations in Source Control settings, but provider workflows for
Jujutsu are still being built.

## Troubleshooting

If a provider shows as unavailable:

1. Install the required CLI or configure the required environment variables.
2. Authenticate in your terminal.
3. Restart T3 Code or refresh Source Control settings.
4. Check that the current project's remote URL points to the provider you expect.
5. Confirm your account has access to the repository.

If provider actions work but Git push or checkout fails, verify your Git remote and credentials
separately with normal Git commands.
