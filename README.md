# Atlasphere

**Plan trips together, in real time.**

Atlasphere is a group travel planning web app. Friends create a group trip, get activity recommendations for their destination, vote on what to do, build a shared itinerary, and chat as they go. Every change shows up for everyone at once.

- **Live app:** [atlasphere.up.railway.app](https://atlasphere.up.railway.app)
- **Project:** MSc Interactive Digital Media team project, Trinity College Dublin (Jan – Apr 2026), module Programming for Digital Media

## Features

- **Accounts:** sign up with email verification, log in and out, reset a forgotten password, and update or delete your account.
- **Profile:** add a photo and mark the countries and cities you've already visited.
- **Group trips:** a step-by-step flow to pick a country, city, trip length and activity interests. Invite friends by email or with a join link, then rename, leave or delete groups.
- **Recommendations:** attractions and places for the chosen city, each with a photo on its card.
- **Voting:** group members vote on activities. Saved picks feed into the itinerary.
- **Itinerary builder:** drag-and-drop day planner with resizable time blocks, kept in sync for everyone in the group.
- **Group chat:** live chat per group, with a pop-up chat overlay and notifications.
- **Images:** profile and group photos are resized on the server before storage.

## Tech stack

| Area | Tools |
| --- | --- |
| Server | Node.js, Express, EJS templates |
| Interactive views | React 19, bundled with Vite (group tabs and activities) |
| Real time | Socket.io (chat, notifications, itinerary sync) |
| Database | MySQL, hosted on Aiven, with sessions stored in MySQL |
| Email | Brevo transactional email API |
| Places and photos | Geoapify Places API, Pexels API |
| Images | Sharp |
| Validation and security | express-validator, bcrypt password hashing |
| Hosting | Railway |

## Getting started

### Prerequisites

- Node.js (LTS)
- A MySQL database with the Atlasphere schema. The schema is not included in this repository.
- API keys for Brevo, Geoapify and Pexels. All three have free tiers.

### Setup

```bash
git clone https://github.com/nashwahamido/AtlasphereWebApp-Updated.git
cd AtlasphereWebApp-Updated
npm install
cp .env.example .env   # then fill in the values
npm run build          # bundles the React views into public/dist
npm run dev            # starts the server with nodemon
```

Then open `http://localhost:3000`, or whatever `PORT` is set to.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_DATABASE`, `DB_PASSWORD` | MySQL connection |
| `SESSION_SECRET` | Signs session cookies |
| `BREVO_API_KEY`, `MAIL_FROM`, `MAIL_FROM_NAME` | Verification, password reset and invite emails |
| `GEOAPIFY_API_KEY` | Place recommendations |
| `PEXELS_API_KEY` | Photos for recommendation cards (optional; bundled images are used without it) |
| `UPLOAD_DIR` | Where uploaded photos are stored (defaults to `assets/uploads`) |
| `PORT` | Server port |

`.env` is gitignored and must never be committed.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the server with auto-reload |
| `npm start` | Start the server |
| `npm run build` | Build the React views with Vite into `public/dist` |

## Project structure

```
server.js          Express app: auth, profile, setup, recommendations, voting, itinerary API, Socket.io
routes/            group and user routes
config/            database, session, mailer (Brevo) and places (Geoapify + Pexels)
middleware/        validation and error handling
views/             EJS pages and partials
client/            React components: chat, chat overlay, voting, itinerary builder, tabs
public/            static CSS, icons and images (Vite outputs to public/dist)
data/              country list
railway.json       Railway build and start commands
```

## Deployment

The app is deployed on Railway. `railway.json` runs `npm install && npm run build`, then starts `node server.js`. Railway's container disk is wiped on every deploy, so uploads should point `UPLOAD_DIR` at a persistent volume. Email goes through Brevo's HTTPS API because Railway blocks outbound SMTP ports.

## Team

Built by Nashwa Hamido, Ryan Liu, Neesan O'Brien Shea, Anna Luczynski and Gabriel Ye Sun, with guidance from Joris Vreeke.

Nashwa Hamido was development lead and full-stack developer.
