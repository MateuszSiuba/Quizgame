# QuizGame 🎯

Multiplayer quiz game inspired by PopSauce — hosted on Render.com. Entire UI in Polish.

## Stack

- **Backend**: Node.js + Express + `ws` (native WebSocket library)
- **Frontend**: Vanilla HTML/CSS/JS (zero build step)
- **Protocol**: WebSocket (wss:// in production)
- **Hosting**: Render.com Web Service

## Folder Structure

```
quizgame/
├── server/
│   └── index.js          # Express + WebSocket server, full game logic
├── public/
│   ├── index.html        # Single-page app (3 screens)
│   ├── css/
│   │   └── style.css     # Dark blue theme
│   └── js/
│       └── client.js     # WebSocket client, all game UI logic
├── data/
│   └── questions.json    # 48 questions across 8 categories
├── package.json
├── render.yaml           # Render.com service config
└── .gitignore
```

## Local Development

```bash
npm install
npm start           # production
npm run dev         # with nodemon auto-restart
```

Visit: http://localhost:10000

## Deploy to Render.com

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New Web Service**.
3. Connect your GitHub repository.
4. Render auto-detects `render.yaml` — click **Apply**.
5. It will install dependencies (`npm install`) and run (`npm start`).

The `render.yaml` sets:
- Build: `npm install`
- Start: `npm start`
- Health check: `GET /health`
- Port: `10000`

## Game Features

### Categories (8)
Filmy · Muzyka · Gry · Polska · Nauka · Sport · Seriale · Gotowanie

### Game Flow
1. **Login screen** → Enter a username, click "Dołącz"
2. **Lobby** → First player is Host; sees category selector and "Rozpocznij grę"
3. **Active game** → 25-second rounds, live timer, live leaderboard
4. **Reveal** → Answer shown for 5s, then next round auto-starts
5. **Game over** → Final leaderboard, lobby resets after 8s

### Scoring
- 1st correct: **10 points**
- Subsequent: **2–10 points** (degrades with time elapsed)

### Answer Tolerance
Server normalizes: lowercase + strip Polish diacritics + strip punctuation.
e.g. "Wiedźmin" → "wiedzmin", "The Lion King" → "the lion king"

### Wrong Guesses
Wrong answers appear briefly under the player's name in the leaderboard (disappear after ~2s).

### Host Logic
- First player to connect = Host
- If host disconnects, next player is promoted to Host
- Host sees category dropdown and Start button

## Customising Questions

Edit `data/questions.json`. Each entry:
```json
{
  "id": 1,
  "category": "Filmy",
  "type": "image",           // "image" or "text"
  "image_url": "https://...",
  "question_text": "Jaki to film?",
  "answers": ["titanic"]     // all accepted answers (normalized internally)
}
```
