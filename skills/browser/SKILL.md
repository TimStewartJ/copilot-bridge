---
name: browser
description: >
  Browser automation via agent-browser CLI. Use when the user needs to interact
  with websites — navigating pages, filling forms, clicking buttons, taking
  screenshots, extracting data, or automating any browser task. Prefer this over
  web_fetch when sites require JavaScript rendering, block bots, need login state,
  or require interactive flows.
allowed-tools: Bash(agent-browser:*)
---

# Browser Automation

You have access to a headless browser via `agent-browser`. Use it through bash.

## When to Use Browser vs web_fetch

Use `agent-browser` when:
- A website **blocks agentic access** or returns bot-detection pages
- The page requires **JavaScript rendering** (SPAs, dynamic content)
- You need an **interactive flow** (login, form submission, multi-step navigation)
- You need a **screenshot** or **PDF** of a page
- You need to **persist login state** across visits (cookies, sessions)
- You need to interact with page elements (click buttons, fill forms)

Continue using `web_fetch` for simple page reads, API calls, and known-friendly sites where you just need text content.

## Prerequisites

`agent-browser` must be installed globally:

```bash
npm install -g agent-browser
agent-browser install          # Download Chrome (first time only)
agent-browser install --with-deps  # Also install system deps (Linux)
```

## Core Workflow

Every browser automation follows this pattern:

1. **Navigate**: `agent-browser open <url>`
2. **Snapshot**: `agent-browser snapshot -i` (get element refs like `@e1`, `@e2`)
3. **Interact**: Use refs to click, fill, select
4. **Re-snapshot**: After navigation or DOM changes, get fresh refs

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output: @e1 [input] "Email", @e2 [input] "Password", @e3 [button] "Submit"

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i  # Check result
```

## Command Chaining

Chain commands with `&&` when you don't need intermediate output:

```bash
agent-browser open https://example.com && agent-browser wait --load networkidle && agent-browser snapshot -i
agent-browser fill @e1 "user@example.com" && agent-browser fill @e2 "pass" && agent-browser click @e3
```

Run commands separately when you need to parse output first (e.g., snapshot to discover refs, then interact).

## Essential Commands

```bash
# Navigation
agent-browser open <url>              # Navigate to URL
agent-browser close                   # Close browser (always do this when done)

# Snapshot (get page structure + element refs)
agent-browser snapshot -i             # Interactive elements only (recommended)
agent-browser snapshot -i -s "#selector"  # Scope to CSS selector

# Interaction (use @refs from snapshot)
agent-browser click @e1               # Click element
agent-browser fill @e2 "text"         # Clear and type text
agent-browser type @e2 "text"         # Type without clearing (append)
agent-browser select @e1 "option"     # Select dropdown option
agent-browser check @e1               # Check checkbox
agent-browser press Enter             # Press keyboard key
agent-browser scroll down 500         # Scroll page

# Get information
agent-browser get text @e1            # Get element text
agent-browser get url                 # Get current URL
agent-browser get title               # Get page title

# Wait
agent-browser wait @e1                # Wait for element to appear
agent-browser wait --load networkidle # Wait for network to settle
agent-browser wait --url "**/page"    # Wait for URL pattern
agent-browser wait 2000               # Wait milliseconds
agent-browser wait --text "Welcome"   # Wait for text to appear

# Capture
agent-browser screenshot              # Screenshot (returns file path)
agent-browser screenshot --full       # Full page screenshot
agent-browser screenshot --annotate   # Labeled screenshot with numbered elements
agent-browser pdf output.pdf          # Save as PDF
```

## Batch Execution

Execute multiple commands in one invocation for efficiency:

```bash
echo '[
  ["open", "https://example.com"],
  ["wait", "--load", "networkidle"],
  ["snapshot", "-i"],
  ["get", "title"]
]' | agent-browser batch --json
```

Use `batch` for known command sequences. Use separate calls when you need to read output between steps.

## Ref Lifecycle (Important)

Refs (`@e1`, `@e2`) are **invalidated when the page changes**. Always re-snapshot after:
- Clicking links or buttons that navigate
- Form submissions
- Dynamic content loading (dropdowns, modals)

```bash
agent-browser click @e5          # Page navigates
agent-browser snapshot -i        # MUST re-snapshot — old refs are stale
agent-browser click @e1          # Now use new refs
```

## Authentication

### Persistent profile (login once, reuse)

```bash
# First run: login and save state in a profile
agent-browser --profile ~/.browser-profile open https://app.example.com/login
# ... fill credentials, submit ...

# Future runs: already authenticated
agent-browser --profile ~/.browser-profile open https://app.example.com/dashboard
```

### Session name (auto-save/restore cookies)

```bash
agent-browser --session-name myapp open https://app.example.com/login
# ... login flow ...
agent-browser close  # State auto-saved

# Next time: state auto-restored
agent-browser --session-name myapp open https://app.example.com/dashboard
```

### Connect to user's existing browser

```bash
# Auto-discover running Chrome with remote debugging
agent-browser --auto-connect snapshot

# Or connect via explicit CDP port
agent-browser --cdp 9222 snapshot
```

This reuses all the user's existing login sessions without needing credentials.

## Annotated Screenshots

Use `--annotate` for screenshots with numbered labels on interactive elements:

```bash
agent-browser screenshot --annotate
# Output: image with [1], [2], [3] labels + legend mapping to @e1, @e2, @e3
```

The returned file path can be viewed with the `view` tool. Use annotated screenshots when:
- The page has unlabeled icon buttons
- You need to verify visual layout
- Canvas/chart elements are present (invisible to text snapshots)

## JavaScript Evaluation

```bash
# Simple expressions
agent-browser eval 'document.title'
agent-browser eval 'document.querySelectorAll("img").length'

# Complex JS: use --stdin to avoid shell escaping issues
agent-browser eval --stdin <<'EVALEOF'
JSON.stringify(
  Array.from(document.querySelectorAll("a"))
    .map(a => ({ text: a.textContent.trim(), href: a.href }))
    .filter(a => a.text)
)
EVALEOF
```

## Tabs

```bash
agent-browser tab list               # List all tabs
agent-browser tab new https://...    # Open new tab
agent-browser tab 2                  # Switch to tab index 2
agent-browser tab close              # Close current tab
```

## Session Management

Use named sessions to avoid conflicts:

```bash
agent-browser --session mysession open https://example.com
agent-browser --session mysession snapshot -i
agent-browser --session mysession close
```

**Always close your browser session when done** to avoid leaked Chrome processes:

```bash
agent-browser close                          # Close default session
agent-browser --session mysession close      # Close named session
```

## Security

### Content boundaries (recommended)

Wrap page output in markers to distinguish tool output from untrusted page content:

```bash
AGENT_BROWSER_CONTENT_BOUNDARIES=1 agent-browser snapshot
```

### Domain allowlist

Restrict navigation to trusted domains:

```bash
AGENT_BROWSER_ALLOWED_DOMAINS="example.com,*.example.com" agent-browser open https://example.com
```

## Configuration

Create `~/.agent-browser/config.json` for persistent settings:

```json
{
  "args": "--no-sandbox",
  "session": "default"
}
```

Priority: `~/.agent-browser/config.json` < `./agent-browser.json` < env vars < CLI flags.

## Timeouts

Default timeout is 25 seconds. For slow pages, use explicit waits:

```bash
agent-browser wait --load networkidle         # Wait for network to settle
agent-browser wait "#content"                 # Wait for specific element
agent-browser wait --fn "document.readyState === 'complete'"  # Wait for JS condition
```
