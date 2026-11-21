# Where's my car

A personal web app (installable on your iPhone home screen) that remembers where you parked, for as long as it takes, and logs your rides.

- Your parking spot is saved **automatically** when your phone disconnects from the car (iPhone Shortcuts automation), or **manually** from the app (current location, tap on the map, or paste coordinates / a map link).
- The spot stays until the car connects again (you're driving) or you press **I took the car**. Past spots and rides are kept in history.
- One small Node server, no dependencies, one JSON file for data. Single user, protected by a secret token.

## Why Shortcuts?

A web page can't run in the background on iPhone, so it can't notice by itself that you parked. The Shortcuts app can: it runs when your car's Bluetooth/CarPlay connects or disconnects and calls this app's API.

---

## 1. Run it locally (optional)

```bash
export API_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
echo $API_TOKEN          # keep this, you'll type it into the app
node server.js           # http://localhost:3000
npm test                 # end-to-end tests
```

Note: "use my location" and installing to the home screen only work over **HTTPS**, so for real use deploy it (next step). `localhost` also works for testing on a computer.

## 2. Deploy (Fly.io example)

The server needs a small **persistent disk** (the JSON file), so avoid hosts with ephemeral storage and no volumes. Fly.io works well; at the time of writing a 256 MB machine is about $2/month and a 1 GB volume about $0.15/month (check [fly.io/pricing](https://fly.io/pricing) for current prices). Any host that can run a Docker container with a mounted volume and gives you HTTPS will do.

```bash
# one-time: install flyctl and sign in
curl -L https://fly.io/install.sh | sh
fly auth login

# 1. edit `app = "..."` in fly.toml to a unique name, then:
fly apps create YOUR-APP-NAME
fly volumes create data --size 1 --region fra
fly secrets set API_TOKEN=PASTE_YOUR_LONG_RANDOM_TOKEN
fly deploy
fly scale count 1          # the volume lives on one machine, keep exactly one
```

Your app is then at `https://YOUR-APP-NAME.fly.dev`. The machine sleeps when idle and wakes on the first request, so the first call after a long idle can take a couple of seconds (fine for Shortcuts). To keep it always on, set `min_machines_running = 1` in `fly.toml`.

**Back up** `/data/db.json` occasionally: `fly ssh sftp get /data/db.json`.

## 3. Install on your iPhone

1. Open `https://YOUR-APP-NAME.fly.dev` in **Safari**, enter your token.
2. Share button > **Add to Home Screen**.
3. Try **Save parking manually > Use my current location** and allow location access.

## 4. Automatic detection with Shortcuts

Create **two** automations. In the Shortcuts app: **Automation** tab > **+** > **Create Personal Automation**.

### A) Car disconnects: save the parking spot

1. Choose **Bluetooth** (your car's stereo/hands-free) or **CarPlay**. Select your car, tick **Is Disconnected**, tap **Next**.
2. Add action **Get Current Location**.
3. Add action **Get Contents of URL** and set:
   - URL: `https://YOUR-APP-NAME.fly.dev/api/event`
   - Tap **Show More**: Method **POST**
   - Headers: add `Authorization` = `Bearer PASTE_YOUR_TOKEN`
   - Request Body: **JSON**, then add fields:
     - Text: `type` = `disconnect`
     - Number: `latitude` = tap the field, choose variable **Current Location**, tap it again and pick **Latitude**
     - Number: `longitude` = same, pick **Longitude**
     - Number (optional): `accuracy` = **Horizontal Accuracy**
4. Tap **Next**, set **Run Immediately** (turn off "Ask Before Running"), **Done**.

### B) Car connects: you're driving, start a ride

Same as above, but tick **Is Connected** and use `type` = `connect`. You can leave out the location fields, but including them gives the ride a start point (used for the distance).

### Good to know

- The first time it runs, iOS asks to let Shortcuts use your location: allow it. If saved spots look wrong or missing, check Settings > Privacy & Security > Location Services > Shortcuts, and keep **Precise Location** on.
- The trigger fires when the phone disconnects from the car, so you're still standing next to it: the saved location is the parking spot.
- Test it: connect to the car, disconnect, open the app. If nothing shows up, open the Shortcuts app, run the automation by hand once, and read any error.
- Ride distance is **a straight line** between start and end (only two points are sent), so it understates real distance. Duration is accurate.
- Very short blips (under 30 s) aren't logged as rides; a repeated disconnect within 5 minutes just updates the same spot.
- If you re-pair the car or change phones, redo the automations.

## API (for your own automations)

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

- Everything is protected by one secret token; keep it long and random. Ten wrong guesses lock an IP out for 10 minutes.
- Your location history is stored as plain JSON on the server's volume. HTTPS is provided by the host.
- The map uses OpenStreetMap tiles and Leaflet from unpkg.com; if they can't load, the rest of the app still works.

## Files

```
server.js          API + static server (no dependencies)
public/            the web app (PWA): index.html, app.js, style.css, sw.js, geo.js, icons
test/run.js        end-to-end tests (npm test)
Dockerfile, fly.toml
```
