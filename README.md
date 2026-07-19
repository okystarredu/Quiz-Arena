# Hermit Quiz Arena

A timed Telegram Mini App quiz system with bulk question import, scoring, leaderboards, animations and an admin dashboard.

## Main features

- Telegram Mini App participant interface
- Timed questions and progress display
- Speed or classic scoring
- Instant answer feedback and explanations
- Live and final leaderboards
- CSV, TXT, DOCX and JSON question import
- Admin dashboard and question editor
- Telegram group announcements
- CSV results export

## Deploying on Render

Open `START_HERE.html` for the beginner-friendly guide or read `RENDER_SETUP.txt` for a short checklist.

Render reads the included `render.yaml` file when you create a Blueprint from the GitHub repository.

## Free storage warning

Render Free uses temporary local storage. Imported question banks and results may disappear after a restart, redeployment or shutdown. Use it for testing. Permanent storage requires a paid persistent disk or a hosted database.

## Local use

Requirements: Node.js 20 or later.

```bash
npm install
npm start
```

Open `http://localhost:3000/admin`.

## Security

Never commit `.env`, bot tokens, passwords or application secrets to GitHub. Store secrets only in Render Environment variables.
