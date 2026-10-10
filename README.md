# Chat

A real-time, web-based chat app built for the KamandPrompt "First Commit" hackathon (IIT Mandi).

## Features

- **Auth:** register, login, logout, persistent sessions (bcrypt-hashed passwords, 7-day cookie)
- **One-to-one chat** and **group chats**, delivered in real time over WebSockets (Socket.IO)
- **Message requests:** messages from non-friends arrive as requests you can accept, delete, or block
- **Group invites:** you join a group only after accepting the invite
- **Friends:** send/accept friend requests; friends chat freely
- **Profiles:** display name, profile photo, bio, and a 24-hour note (friends only, shown as a cloud over the photo)
- **Group info:** view/edit group name, photo, and about; leave a group
- **Privacy settings:** read receipts on/off, profile photo and bio visible to everyone or friends only
- **Blocking** and unblocking users
- Online status, typing indicator, read receipts ("Seen"), edit/delete messages, IST timestamps, unread badges
- Persistent storage in SQLite

## Tech stack

| Part | Technology |
|---|---|
| Backend | Node.js + Express |
| Real-time | Socket.IO (WebSockets) |
| Database | SQLite (`better-sqlite3`) |
| Auth | `express-session` (sessions stored in SQLite) + `bcryptjs` |
| Frontend | Plain HTML, CSS, and JavaScript |

## Architecture

```
chat-app/
├── server.js          # Express routes, Socket.IO events, privacy/permission logic
├── db.js              # SQLite schema + automatic migrations
├── public/
│   ├── index.html     # Main app (single page)
│   └── login.html     # Login / register
├── .env               # Secrets (not committed)
└── chat.db            # Database file (not committed, created on first run)
```

- The browser talks to the server over **REST** (profiles, friends, groups, history) and **Socket.IO** (live messages, typing, presence, read receipts).
- Each conversation is a Socket.IO room (`conv:<id>`), and each user has a personal room (`user:<id>`) for notifications.
- The sender of every action comes from the **server-side session**, never from the browser.
- Profile photos are resized to 256px JPEGs in the browser and served through an authenticated route, so privacy settings are enforced.

## Setup

Requires **Node.js 18+**.

```bash
git clone https://github.com/adityajhardr2008-cell/chat-app.git
cd chat-app
npm install
```

Create a `.env` file in the project root:

```
SESSION_SECRET=your_long_random_string
```

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Run

```bash
node server.js
```

Open `http://localhost:3000`.

For development with auto-restart: `node --watch server.js`

## Environment variables

| Name | Purpose |
|---|---|
| `SESSION_SECRET` | Signs session cookies. Required. |

No external API keys or services are needed. Fonts load from Google Fonts (internet needed for the intended look; the app still works without it).

## Testing it in a clean environment

1. Fresh clone, `npm install`, add `.env`, `node server.js`.
2. Register `alice` in a normal window and `bob` in an **incognito** window (separate cookies). Passwords need 6+ characters with a letter and a number.
3. As alice, search `bob` and send a message. In bob's window it appears under **Requests**. Accept it, and reply.
4. Check typing dots, "Seen", edit/delete (hover your own message), and online status (close bob's window).
5. Open bob's profile, send a friend request, and accept it on bob's side. Set a note in alice's profile and see it float over her photo in bob's list.
6. Create a group from alice's **+** button. Bob gets an invite under Requests, and joins after accepting.
7. Try Block/Unblock, Leave group, and the privacy toggles in **Your profile**.

## Notes

- A stranger can send up to 3 messages before the recipient accepts (`PENDING_LIMIT` in `server.js`).
- The database migrates itself on startup, so existing `chat.db` files keep working.
- Never commit `.env` or `chat.db` (both are in `.gitignore`).