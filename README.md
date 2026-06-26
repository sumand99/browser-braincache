# BrainCache

Your browser's external memory — auto-saves tab sessions, clusters by topic, tracks focus time, and restores your context instantly.

## Features

- **Auto Snapshot** — automatically saves all open tabs and windows to local storage at regular intervals. Never lose your session to a crash or accidental close.
- **AI Tab Summary** — reads your open tab titles and URLs, infers topic clusters, and generates a one-line description of what you're working on ("Researching React performance, working on a Jira auth ticket, 6 restaurant tabs open").
- **Tab Clustering** — groups open tabs into topic buckets (Coding & Dev, Work & Productivity, News, Shopping, etc.) using domain heuristics. See your browsing at a glance.
- **Park Mode** — "git stash for the browser." Save a named snapshot of your current session, close everything, and restore exactly where you left off whenever you're ready.
- **Focus Time Tracking** — tracks how long you spend on each domain per day, entirely local. Useful for freelancers and deep-work practitioners.
- **Monday Morning Context Restore** — detects when you're starting a new week and surfaces your last Friday session with a summary so you can pick up right where you left off.

## Enabling / Disabling

The **ON / OFF toggle** in the top-right corner of the popup is a master power switch. Flip it off to pause all auto-snapshots and tab-change saves without losing your existing backups. Flip it back on to resume. The same toggle is mirrored in **Settings → Auto-Backup Enabled**.

## Privacy

Zero cloud. Zero accounts. All data lives in `chrome.storage.local` — nothing leaves your browser.

## Installation

1. Clone this repo or download the zip.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (top right toggle).
4. Click **Load unpacked** and select this folder.
5. Pin the BrainCache icon to your toolbar.

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+T` | Open BrainCache popup |
| `Alt+Shift+S` | Save snapshot now |
| `Alt+Shift+D` | Toggle duplicate tab prevention |

## Removing from Chrome

1. Open `chrome://extensions`.
2. Find **BrainCache** in the list.
3. Click **Remove** → confirm.

All locally stored snapshots are wiped automatically when the extension is removed. If you want to keep them first, use **Export** in the popup before uninstalling.

## Tech

Manifest V3 · Vanilla JS · No build tools · No external dependencies
