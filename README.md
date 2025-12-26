# Gmail AI Triage — iPad Web App (Groq)

This is the iPad-friendly version of the Gmail AI Triage tool.
It runs as a normal website (or add-to-home-screen PWA) in Safari on iPad.

## What it does
- Connects to Gmail using Google Identity Services “token model”
- Lists emails using a Gmail search query
- Fetches metadata only: From/To/Subject/Date + snippet
- Sends that metadata to Groq to produce:
  - action: keep | trash | review
  - category
  - short summary + reason
- Shows results grouped by sender
- Moves messages to Trash only when you click Trash

## Setup
### 1) Create a Google OAuth client for a Web app
In Google Cloud Console:
- Enable the Gmail API
- Configure OAuth consent screen
- Create credentials: OAuth client ID → Web application
- Add an authorized JavaScript origin for where you host this (or http://localhost if testing)
- Copy the Client ID

Paste that Client ID into the app.

Scopes used:
- https://www.googleapis.com/auth/gmail.modify  (so the app can trash emails)

### 2) Add your Groq API key
Paste your Groq key into the app (saved to localStorage on your device).

## Hosting / running
Because Google OAuth needs an HTTPS origin for most real use, host this on:
- GitHub Pages
- Cloudflare Pages
- Netlify / Vercel
(any static host works)

Local testing:
- You can use a simple static server (e.g. `python -m http.server`) but OAuth may require HTTPS depending on your setup.

## Privacy note
This app sends only headers + snippet to Groq by default (not full body).
You can modify `getMessageMeta` to fetch full message bodies, but that's more sensitive.
