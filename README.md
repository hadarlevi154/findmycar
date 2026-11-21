# Where's my car (Vercel + Prisma + Postgres)

A personal web app (installable on your iPhone home screen) that remembers where you parked until you move the car, and logs your rides.

- Parking is saved **automatically** when your phone disconnects from the car (iPhone Shortcuts automation) or **manually** in the app (current location, tap the map, or paste coordinates / a map link).
- The spot stays until the car connects again or you press **I took the car**. Past spots and rides are kept in history.
- Data lives in a Postgres database (so it survives for weeks, unlike files on Vercel).

```
public/      the web app (static): index.html, app.js, style.css, sw.js, icons
api/         Vercel serverless functions (state, event, parked, moved, parkings/[id], rides/[id])
lib/         auth, http helpers, business logic, Prisma client
prisma/      database schema (Parking, Ride)
test/        npm test: logic tests against an in-memory stand-in for Prisma
```

## Deploy

### 1. Put the code on Vercel
Push this folder to a GitHub repo and import it in Vercel (replace the contents of your earlier project if you reuse it), or run `npx vercel` from this folder. Framework preset: **Other**. `vercel.json` already sets the build command and output folder.

### 2. Add a database
Vercel project > **Storage** > **Create Database** > **Neon (Postgres)**, and connect it to the project for all environments. This adds environment variables such as `DATABASE_URL` and `DATABASE_URL_UNPOOLED`. (Another Postgres provider works too; you just need `DATABASE_URL` set to its connection string.)

### 3. Add your secret token
Project > **Settings** > **Environment Variables**: add `API_TOKEN` with a long random value, for all environments. Generate one with:

```bash
openssl rand -hex 24
```

Keep a copy: you type it into the app once, and into the Shortcuts automations.

### 4. Deploy
Trigger a deployment (push a commit or **Redeploy**). The build runs `prisma db push`, which creates the two tables in your database. If the build fails, read the log: the usual cause is a missing database variable.

### 5. Install on your iPhone
Open `https://YOUR-PROJECT.vercel.app` in **Safari**, enter your token, then Share > **Add to Home Screen**. Try *Save parking manually > Use my current location*.

Use your project's main address (`your-project.vercel.app`), not the long per-deployment links, which can sit behind Vercel's login protection. If Shortcuts ever receives an HTML login page instead of JSON, check **Settings > Deployment Protection**.

## Automatic detection with Shortcuts

Create **two** automations in the Shortcuts app: **Automation** tab > **+** > **Create Personal Automation**.

### A) Car disconnects: save the parking spot
1. Choose **Bluetooth** (your car) or **CarPlay**, tick **Is Disconnected**, **Next**.
2. Add **Get Current Location**.
3. Add **Get Contents of URL**:
   - URL: `https://YOUR-PROJECT.vercel.app/api/event`
   - **Show More**: Method **POST**
   - Headers: `Authorization` = `Bearer YOUR_TOKEN`
   - Request Body: **JSON**, with fields
     - Text `type` = `disconnect`
     - Number `latitude` = variable **Current Location**, then pick **Latitude**
     - Number `longitude` = **Current Location** > **Longitude**
     - Number (optional) `accuracy` = **Horizontal Accuracy**
4. **Next**, choose **Run Immediately**, **Done**.

### B) Car connects: start a ride
Same, but **Is Connected** and `type` = `connect`. Location fields are optional here (they give the ride a start point for the distance).

### Notes
- The first run asks for Shortcuts location access: allow it, and keep Precise Location on (Settings > Privacy & Security > Location Services > Shortcuts).
- The trigger fires when the phone disconnects, while you're still next to the car, so the location is your parking spot.
- Test it with a real connect/disconnect. If nothing shows up, run the automation by hand in Shortcuts and read the error.
- Ride distance is a **straight line** from start to end, so it understates the real distance. Duration is accurate.
- Blips under 30 s aren't logged as rides; a second disconnect within 5 minutes updates the same spot.
- The first request after a quiet period can take a second or two while the serverless function and the database wake up.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `500 ... missing API_TOKEN` | Add `API_TOKEN` (16+ chars) in Vercel env vars, then redeploy |
| `Server error (is the database connected...)` | Database not connected, or tables not created: check Storage tab and the build log; see **Functions** logs in Vercel |
| Build fails at `prisma db push` | `DATABASE_URL` / `DATABASE_URL_UNPOOLED` missing in the Build environment |
| `401 Unauthorized` | Token typed wrong, or the `Authorization: Bearer ...` header is missing in Shortcuts |

## API

All requests need `Authorization: Bearer <token>`.

| Method | Path | Body |
|---|---|---|
| GET | `/api/state` | current spot, active ride, history |
| POST | `/api/event` | `{type: "connect"\|"disconnect", latitude, longitude, accuracy?}` |
| POST | `/api/parked` | `{lat, lng, accuracy?, note?}` manual spot |
| PATCH | `/api/parked` | `{note}` |
| POST | `/api/moved` | clears the current spot |
| DELETE | `/api/parkings/:id`, `/api/rides/:id` | remove a history entry |

## Security notes
- One shared secret token protects everything. Keep it long and random; there is no lockout after wrong guesses (the token's length is the protection).
- Your location history is stored in your Postgres database.
- The map uses OpenStreetMap tiles and Leaflet from unpkg.com; if they can't load, the rest of the app still works.
